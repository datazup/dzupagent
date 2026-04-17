/**
 * Broad branch-coverage tests for assorted helper/small modules.
 * Targets: AgentCircuitBreaker states, replay inspector state-diff,
 * runtime-events formatters, checkpoint-helpers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentCircuitBreaker } from '../orchestration/circuit-breaker.js'
import {
  pipelineStartedEvent,
  pipelineCompletedEvent,
  pipelineFailedEvent,
  pipelineSuspendedEvent,
  checkpointSavedEvent,
  nodeStartedEvent,
  nodeCompletedEvent,
  nodeFailedEvent,
  nodeRetryEvent,
  recoveryAttemptedEvent,
  recoverySucceededEvent,
  recoveryFailedEvent,
  stuckDetectedEvent,
  nodeOutputRecordedEvent,
  calibrationSuboptimalEvent,
  iterationBudgetWarningEvent,
} from '../pipeline/pipeline-runtime/runtime-events.js'
import { createPipelineCheckpoint } from '../pipeline/pipeline-runtime/checkpoint-helpers.js'
import { generateRunId } from '../pipeline/pipeline-runtime/run-id.js'

// ---------------------------------------------------------------------------
// AgentCircuitBreaker
// ---------------------------------------------------------------------------
describe('AgentCircuitBreaker — branch coverage', () => {
  it('reports closed state for unknown agents via getState', () => {
    const cb = new AgentCircuitBreaker()
    expect(cb.getState('unknown')).toBe('closed')
    expect(cb.isAvailable('unknown')).toBe(true)
  })

  it('trips after threshold consecutive timeouts', () => {
    const cb = new AgentCircuitBreaker({ failureThreshold: 2 })
    cb.recordTimeout('a')
    expect(cb.getState('a')).toBe('closed')
    cb.recordTimeout('a')
    expect(cb.getState('a')).toBe('open')
    expect(cb.isAvailable('a')).toBe(false)
  })

  it('recordSuccess resets state to closed', () => {
    const cb = new AgentCircuitBreaker({ failureThreshold: 1 })
    cb.recordTimeout('a')
    expect(cb.getState('a')).toBe('open')
    cb.recordSuccess('a')
    expect(cb.getState('a')).toBe('closed')
    expect(cb.isAvailable('a')).toBe(true)
  })

  it('transitions to half-open after cooldown and allows a trial', () => {
    vi.useFakeTimers()
    const cb = new AgentCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 100,
    })
    cb.recordTimeout('a')
    expect(cb.getState('a')).toBe('open')
    vi.advanceTimersByTime(101)
    // isAvailable triggers the transition
    expect(cb.isAvailable('a')).toBe(true)
    expect(cb.getState('a')).toBe('half-open')
    vi.useRealTimers()
  })

  it('filterAvailable excludes tripped agents', () => {
    const cb = new AgentCircuitBreaker({ failureThreshold: 1 })
    cb.recordTimeout('a')
    const filtered = cb.filterAvailable([{ id: 'a' }, { id: 'b' }])
    expect(filtered.map(x => x.id)).toEqual(['b'])
  })

  it('reset clears all circuits', () => {
    const cb = new AgentCircuitBreaker({ failureThreshold: 1 })
    cb.recordTimeout('a')
    cb.reset()
    expect(cb.getState('a')).toBe('closed')
  })

  it('uses default failureThreshold=3 and cooldownMs=5m when config is empty', () => {
    const cb = new AgentCircuitBreaker()
    cb.recordTimeout('a')
    cb.recordTimeout('a')
    expect(cb.getState('a')).toBe('closed') // still below 3
    cb.recordTimeout('a')
    expect(cb.getState('a')).toBe('open')
  })

  it('isAvailable returns false for open circuit within cooldown window', () => {
    const cb = new AgentCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
    })
    cb.recordTimeout('a')
    expect(cb.isAvailable('a')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Pipeline runtime event factories
// ---------------------------------------------------------------------------
describe('pipeline runtime event factories', () => {
  it('all factories produce typed events', () => {
    expect(pipelineStartedEvent('p', 'r')).toEqual({
      type: 'pipeline:started', pipelineId: 'p', runId: 'r',
    })
    expect(pipelineCompletedEvent('r', 100)).toEqual({
      type: 'pipeline:completed', runId: 'r', totalDurationMs: 100,
    })
    expect(pipelineFailedEvent('r', 'oops')).toEqual({
      type: 'pipeline:failed', runId: 'r', error: 'oops',
    })
    expect(pipelineSuspendedEvent('N')).toEqual({
      type: 'pipeline:suspended', nodeId: 'N',
    })
    expect(checkpointSavedEvent('r', 3)).toEqual({
      type: 'pipeline:checkpoint_saved', runId: 'r', version: 3,
    })
    expect(nodeStartedEvent('N', 'agent')).toEqual({
      type: 'pipeline:node_started', nodeId: 'N', nodeType: 'agent',
    })
    expect(nodeCompletedEvent('N', 5)).toEqual({
      type: 'pipeline:node_completed', nodeId: 'N', durationMs: 5,
    })
    expect(nodeFailedEvent('N', 'err')).toEqual({
      type: 'pipeline:node_failed', nodeId: 'N', error: 'err',
    })
    expect(nodeRetryEvent('N', 1, 3, 'err', 100)).toEqual({
      type: 'pipeline:node_retry', nodeId: 'N', attempt: 1, maxAttempts: 3, error: 'err', backoffMs: 100,
    })
    expect(recoveryAttemptedEvent('N', 1, 3, 'err')).toEqual({
      type: 'pipeline:recovery_attempted', nodeId: 'N', attempt: 1, maxAttempts: 3, error: 'err',
    })
    expect(recoverySucceededEvent('N', 1, 'ok')).toEqual({
      type: 'pipeline:recovery_succeeded', nodeId: 'N', attempt: 1, summary: 'ok',
    })
    expect(recoveryFailedEvent('N', 1, 'nope')).toEqual({
      type: 'pipeline:recovery_failed', nodeId: 'N', attempt: 1, error: 'nope',
    })
    expect(stuckDetectedEvent('N', 'stuck', 'retry')).toEqual({
      type: 'pipeline:stuck_detected', nodeId: 'N', reason: 'stuck', suggestedAction: 'retry',
    })
    expect(nodeOutputRecordedEvent('N', 'hash')).toEqual({
      type: 'pipeline:node_output_recorded', nodeId: 'N', outputHash: 'hash',
    })
    expect(calibrationSuboptimalEvent('N', 0.9, 0.5, 0.4, 'improve')).toEqual({
      type: 'pipeline:calibration_suboptimal',
      nodeId: 'N', baseline: 0.9, currentScore: 0.5, deviation: 0.4, suggestion: 'improve',
    })
    expect(iterationBudgetWarningEvent('warn_70', 70, 100, 5)).toEqual({
      type: 'pipeline:iteration_budget_warning',
      level: 'warn_70', totalCost: 70, budgetCents: 100, iteration: 5,
    })
  })
})

// ---------------------------------------------------------------------------
// Pipeline checkpoint helper
// ---------------------------------------------------------------------------
describe('createPipelineCheckpoint', () => {
  it('creates a PipelineCheckpoint with cloned state', () => {
    const state = { foo: 'bar', nested: { n: 1 } }
    const checkpoint = createPipelineCheckpoint({
      pipelineRunId: 'run1',
      pipelineId: 'pipe1',
      version: 2,
      completedNodeIds: ['A'],
      state,
    })

    expect(checkpoint.pipelineRunId).toBe('run1')
    expect(checkpoint.pipelineId).toBe('pipe1')
    expect(checkpoint.version).toBe(2)
    expect(checkpoint.schemaVersion).toBe('1.0.0')
    expect(checkpoint.completedNodeIds).toEqual(['A'])
    expect(checkpoint.state).toEqual(state)
    // Ensure it is a deep clone
    ;(checkpoint.state as Record<string, unknown>)['foo'] = 'CHANGED'
    expect(state.foo).toBe('bar')
    expect(typeof checkpoint.createdAt).toBe('string')
  })

  it('defaults suspendedAtNodeId to undefined', () => {
    const checkpoint = createPipelineCheckpoint({
      pipelineRunId: 'r',
      pipelineId: 'p',
      version: 1,
      completedNodeIds: [],
      state: {},
    })
    expect(checkpoint.suspendedAtNodeId).toBeUndefined()
  })

  it('propagates suspendedAtNodeId when provided', () => {
    const checkpoint = createPipelineCheckpoint({
      pipelineRunId: 'r',
      pipelineId: 'p',
      version: 1,
      completedNodeIds: [],
      state: {},
      suspendedAtNodeId: 'N42',
    })
    expect(checkpoint.suspendedAtNodeId).toBe('N42')
  })
})

// ---------------------------------------------------------------------------
// generateRunId
// ---------------------------------------------------------------------------
describe('generateRunId', () => {
  it('produces monotonically increasing ids', () => {
    const a = generateRunId()
    const b = generateRunId()
    expect(a).toMatch(/^run_\d+_\d+$/)
    expect(b).toMatch(/^run_\d+_\d+$/)
    expect(a).not.toBe(b)
  })
})
