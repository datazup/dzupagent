import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PipelineEdge, PipelineNode } from '@dzupagent/core'
import type { NodeResult } from '../pipeline/pipeline-runtime-types.js'
import { valuesEqual } from '../pipeline/pipeline-runtime/state-utils.js'
import {
  findJoinNode,
  getErrorTarget,
  getForkBranchStartIds,
  getNextNodeIds,
} from '../pipeline/pipeline-runtime/edge-resolution.js'
import { createPipelineCheckpoint } from '../pipeline/pipeline-runtime/checkpoint-helpers.js'
import {
  collectStateDelta,
  mergeBranchExecutionResult,
  type BranchExecutionResult,
} from '../pipeline/pipeline-runtime/branch-merge.js'
import {
  calibrationSuboptimalEvent,
  checkpointSavedEvent,
  iterationBudgetWarningEvent,
  nodeCompletedEvent,
  nodeFailedEvent,
  nodeOutputRecordedEvent,
  nodeRetryEvent,
  nodeStartedEvent,
  pipelineCompletedEvent,
  pipelineFailedEvent,
  pipelineStartedEvent,
  pipelineSuspendedEvent,
  recoveryAttemptedEvent,
  recoveryFailedEvent,
  recoverySucceededEvent,
  stuckDetectedEvent,
} from '../pipeline/pipeline-runtime/runtime-events.js'
import { generateRunId } from '../pipeline/pipeline-runtime/run-id.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('pipeline runtime helper modules', () => {
  it('compares state values by structure for nested objects and arrays', () => {
    expect(valuesEqual(3, 3)).toBe(true)
    expect(valuesEqual({ a: 1, nested: ['x', { y: true }] }, { a: 1, nested: ['x', { y: true }] })).toBe(true)
    expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(valuesEqual({ a: 1 }, null)).toBe(false)
  })

  it('routes edges and resolves joins/errors from runtime graphs', () => {
    const nodes: PipelineNode[] = [
      { id: 'fork', type: 'fork', forkId: 'fork-1' },
      { id: 'branch-a', type: 'agent', agentId: 'agent-a', timeoutMs: 1000 },
      { id: 'branch-b', type: 'agent', agentId: 'agent-b', timeoutMs: 1000 },
      { id: 'join', type: 'join', forkId: 'fork-1' },
    ]
    const outgoingEdges = new Map<string, PipelineEdge[]>([
      ['start', [
        { type: 'sequential', sourceNodeId: 'start', targetNodeId: 'seq-next' },
        {
          type: 'conditional',
          sourceNodeId: 'start',
          predicateName: 'isReady',
          branches: { true: 'branch-a', false: 'branch-b' },
        },
      ]],
      ['fork', [
        { type: 'sequential', sourceNodeId: 'fork', targetNodeId: 'branch-a' },
        { type: 'sequential', sourceNodeId: 'fork', targetNodeId: 'branch-b' },
      ]],
    ])
    const errorEdges = new Map<string, PipelineEdge[]>([
      ['start', [
        { type: 'error', sourceNodeId: 'start', targetNodeId: 'error-handler' },
        { type: 'error', sourceNodeId: 'start', targetNodeId: 'timeout-handler', errorCodes: ['TIMEOUT'] },
      ]],
    ])

    expect(getNextNodeIds('start', outgoingEdges, { isReady: () => true }, {})).toEqual(['seq-next', 'branch-a'])
    expect(getNextNodeIds('start', outgoingEdges, { isReady: () => false }, {})).toEqual(['seq-next', 'branch-b'])
    expect(getErrorTarget('start', errorEdges)).toBe('error-handler')
    expect(getErrorTarget('missing', errorEdges)).toBeUndefined()
    expect(findJoinNode('fork-1', nodes)).toEqual({ id: 'join', type: 'join', forkId: 'fork-1' })
    expect(getForkBranchStartIds(outgoingEdges.get('fork') ?? [])).toEqual(['branch-a', 'branch-b'])
  })

  it('prefers a generic error edge when no error code is provided, even if a coded edge comes first', () => {
    const errorEdges = new Map<string, PipelineEdge[]>([
      ['start', [
        { type: 'error', sourceNodeId: 'start', targetNodeId: 'timeout-handler', errorCodes: ['TIMEOUT'] },
        { type: 'error', sourceNodeId: 'start', targetNodeId: 'error-handler' },
      ]],
    ])

    expect(getErrorTarget('start', errorEdges)).toBe('error-handler')
  })

  it('creates isolated checkpoints with cloned state and a stable schema version', () => {
    const state = {
      nested: { count: 1 },
      list: ['a', 'b'],
    }
    const completedNodeIds = ['n1', 'n2']

    const checkpoint = createPipelineCheckpoint({
      pipelineRunId: 'run-1',
      pipelineId: 'pipe-1',
      version: 7,
      completedNodeIds,
      state,
      suspendedAtNodeId: 'pause',
    })

    expect(checkpoint).toMatchObject({
      pipelineRunId: 'run-1',
      pipelineId: 'pipe-1',
      version: 7,
      schemaVersion: '1.0.0',
      completedNodeIds: ['n1', 'n2'],
      suspendedAtNodeId: 'pause',
    })
    expect(checkpoint.state).toEqual(state)
    expect(checkpoint.state).not.toBe(state)
    expect(checkpoint.completedNodeIds).not.toBe(completedNodeIds)
    expect(checkpoint.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(new Date(checkpoint.createdAt).toISOString()).toBe(checkpoint.createdAt)

    state.nested.count = 99
    state.list.push('c')
    completedNodeIds.push('n3')
    expect(checkpoint.state).toEqual({ nested: { count: 1 }, list: ['a', 'b'] })
    expect(checkpoint.completedNodeIds).toEqual(['n1', 'n2'])
  })

  it('tracks branch state deltas and merges branch results with additive state semantics', () => {
    const baseline = {
      keep: 'same',
      nested: { count: 1 },
      items: ['x'],
      removed: 'stays until explicitly deleted',
    }
    const next = {
      keep: 'same',
      nested: { count: 2 },
      items: ['x'],
      added: true,
    }

    expect(collectStateDelta(baseline, next)).toEqual({
      nested: { count: 2 },
      added: true,
    })
    expect(collectStateDelta(baseline, next)).not.toHaveProperty('removed')

    const nodeResults = new Map<string, NodeResult>([
      ['existing', { nodeId: 'existing', output: 'old', durationMs: 1 }],
    ])
    const branchResult: BranchExecutionResult = {
      state: 'completed',
      stateDelta: { nested: { count: 2 }, added: true },
      nodeResults: new Map<string, NodeResult>([
        ['branch-a', { nodeId: 'branch-a', output: 'a', durationMs: 2 }],
        ['branch-b', { nodeId: 'branch-b', output: 'b', durationMs: 3 }],
      ]),
      completedNodeIds: ['branch-a', 'branch-b'],
    }
    const completedNodeIds = ['existing']
    const runState = { keep: 'same', nested: { count: 1 }, removed: 'stays until explicitly deleted' }

    mergeBranchExecutionResult(nodeResults, completedNodeIds, runState, branchResult)

    expect([...nodeResults.keys()]).toEqual(['existing', 'branch-a', 'branch-b'])
    expect(completedNodeIds).toEqual(['existing', 'branch-a', 'branch-b'])
    expect(runState).toEqual({
      keep: 'same',
      nested: { count: 2 },
      added: true,
      removed: 'stays until explicitly deleted',
    })
  })

  it('builds runtime events with the expected payload shape', () => {
    expect(pipelineStartedEvent('pipe-1', 'run-1')).toEqual({
      type: 'pipeline:started',
      pipelineId: 'pipe-1',
      runId: 'run-1',
    })
    expect(pipelineSuspendedEvent('node-1')).toEqual({ type: 'pipeline:suspended', nodeId: 'node-1' })
    expect(pipelineCompletedEvent('run-1', 250)).toEqual({
      type: 'pipeline:completed',
      runId: 'run-1',
      totalDurationMs: 250,
    })
    expect(pipelineFailedEvent('run-1', 'boom')).toEqual({ type: 'pipeline:failed', runId: 'run-1', error: 'boom' })
    expect(checkpointSavedEvent('run-1', 3)).toEqual({ type: 'pipeline:checkpoint_saved', runId: 'run-1', version: 3 })
    expect(nodeStartedEvent('node-1', 'agent')).toEqual({ type: 'pipeline:node_started', nodeId: 'node-1', nodeType: 'agent' })
    expect(nodeCompletedEvent('node-1', 12)).toEqual({ type: 'pipeline:node_completed', nodeId: 'node-1', durationMs: 12 })
    expect(nodeFailedEvent('node-1', 'bad')).toEqual({ type: 'pipeline:node_failed', nodeId: 'node-1', error: 'bad' })
    expect(nodeRetryEvent('node-1', 2, 4, 'bad', 500)).toEqual({
      type: 'pipeline:node_retry',
      nodeId: 'node-1',
      attempt: 2,
      maxAttempts: 4,
      error: 'bad',
      backoffMs: 500,
    })
    expect(recoveryAttemptedEvent('node-1', 1, 3, 'bad')).toEqual({
      type: 'pipeline:recovery_attempted',
      nodeId: 'node-1',
      attempt: 1,
      maxAttempts: 3,
      error: 'bad',
    })
    expect(recoverySucceededEvent('node-1', 2, 'fixed')).toEqual({
      type: 'pipeline:recovery_succeeded',
      nodeId: 'node-1',
      attempt: 2,
      summary: 'fixed',
    })
    expect(recoveryFailedEvent('node-1', 2, 'still bad')).toEqual({
      type: 'pipeline:recovery_failed',
      nodeId: 'node-1',
      attempt: 2,
      error: 'still bad',
    })
    expect(stuckDetectedEvent('node-1', 'loop', 'abort')).toEqual({
      type: 'pipeline:stuck_detected',
      nodeId: 'node-1',
      reason: 'loop',
      suggestedAction: 'abort',
    })
    expect(nodeOutputRecordedEvent('node-1', 'hash')).toEqual({
      type: 'pipeline:node_output_recorded',
      nodeId: 'node-1',
      outputHash: 'hash',
    })
    expect(calibrationSuboptimalEvent('node-1', 0.8, 0.5, 0.3, 'adjust')).toEqual({
      type: 'pipeline:calibration_suboptimal',
      nodeId: 'node-1',
      baseline: 0.8,
      currentScore: 0.5,
      deviation: 0.3,
      suggestion: 'adjust',
    })
    expect(iterationBudgetWarningEvent('warn_90', 90, 100, 12)).toEqual({
      type: 'pipeline:iteration_budget_warning',
      level: 'warn_90',
      totalCost: 90,
      budgetCents: 100,
      iteration: 12,
    })
  })

  it('generates monotonic run ids with the expected prefix', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234567890)

    const first = generateRunId()
    const second = generateRunId()

    expect(first).toMatch(/^run_1234567890_\d+$/)
    expect(second).toMatch(/^run_1234567890_\d+$/)
    expect(first).not.toBe(second)
  })
})
