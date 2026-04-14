import { describe, it, expect } from 'vitest'
import { validatePipeline } from '../pipeline/pipeline-validator.js'
import type { PipelineDefinition, PipelineNode, PipelineEdge } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePipeline(
  overrides: Partial<PipelineDefinition> & {
    nodes?: PipelineNode[]
    edges?: PipelineEdge[]
  } = {},
): PipelineDefinition {
  return {
    id: 'test-pipeline',
    name: 'Test',
    version: '1.0.0',
    schemaVersion: '1.0.0',
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
      { id: 'end', type: 'agent', agentId: 'a2', timeoutMs: 5000 },
    ],
    edges: [{ type: 'sequential', sourceNodeId: 'start', targetNodeId: 'end' }],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validatePipeline', () => {
  it('accepts a valid simple pipeline', () => {
    const result = validatePipeline(makePipeline())
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('reports missing entry node', () => {
    const result = validatePipeline(
      makePipeline({ entryNodeId: 'nonexistent' }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'MISSING_ENTRY_NODE' }),
    )
  })

  it('reports duplicate node IDs', () => {
    const result = validatePipeline(
      makePipeline({
        nodes: [
          { id: 'start', type: 'agent', agentId: 'a1', timeoutMs: 1000 },
          { id: 'start', type: 'agent', agentId: 'a2', timeoutMs: 1000 },
        ],
        edges: [],
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'DUPLICATE_NODE_ID', nodeId: 'start' }),
    )
  })

  it('reports dangling edge (nonexistent source)', () => {
    const result = validatePipeline(
      makePipeline({
        edges: [
          { type: 'sequential', sourceNodeId: 'ghost', targetNodeId: 'end' },
        ],
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'DANGLING_EDGE' }),
    )
  })

  it('reports dangling edge (nonexistent target)', () => {
    const result = validatePipeline(
      makePipeline({
        edges: [
          { type: 'sequential', sourceNodeId: 'start', targetNodeId: 'ghost' },
        ],
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'DANGLING_EDGE' }),
    )
  })

  it('warns on unreachable/orphan node (no edges)', () => {
    const result = validatePipeline(
      makePipeline({
        nodes: [
          { id: 'start', type: 'agent', agentId: 'a1', timeoutMs: 1000 },
          { id: 'end', type: 'agent', agentId: 'a2', timeoutMs: 1000 },
          { id: 'orphan', type: 'agent', agentId: 'a3', timeoutMs: 1000 },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'start', targetNodeId: 'end' },
        ],
      }),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'UNREACHABLE_NODE', nodeId: 'orphan' }),
    )
  })

  it('reports cycle (A -> B -> A)', () => {
    const result = validatePipeline(
      makePipeline({
        nodes: [
          { id: 'start', type: 'agent', agentId: 'a1', timeoutMs: 1000 },
          { id: 'B', type: 'agent', agentId: 'a2', timeoutMs: 1000 },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'start', targetNodeId: 'B' },
          { type: 'sequential', sourceNodeId: 'B', targetNodeId: 'start' },
        ],
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'UNBOUNDED_CYCLE' }),
    )
  })

  it('does NOT flag cycles inside a LoopNode body', () => {
    const result = validatePipeline(
      makePipeline({
        nodes: [
          { id: 'start', type: 'agent', agentId: 'a1', timeoutMs: 1000 },
          {
            id: 'loop1',
            type: 'loop',
            bodyNodeIds: ['bodyA', 'bodyB'],
            maxIterations: 10,
            continuePredicateName: 'shouldContinue',
            timeoutMs: 30000,
          },
          { id: 'bodyA', type: 'agent', agentId: 'a2', timeoutMs: 1000 },
          { id: 'bodyB', type: 'agent', agentId: 'a3', timeoutMs: 1000 },
          { id: 'end', type: 'agent', agentId: 'a4', timeoutMs: 1000 },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'start', targetNodeId: 'loop1' },
          { type: 'sequential', sourceNodeId: 'loop1', targetNodeId: 'bodyA' },
          { type: 'sequential', sourceNodeId: 'bodyA', targetNodeId: 'bodyB' },
          { type: 'sequential', sourceNodeId: 'bodyB', targetNodeId: 'loop1' },
          { type: 'sequential', sourceNodeId: 'loop1', targetNodeId: 'end' },
        ],
      }),
    )
    // The cycle loop1 -> bodyA -> bodyB -> loop1 is inside a loop body, so no error
    expect(result.errors.filter(e => e.code === 'UNBOUNDED_CYCLE')).toHaveLength(0)
  })

  it('reports unbalanced fork (no matching join)', () => {
    const result = validatePipeline(
      makePipeline({
        nodes: [
          { id: 'start', type: 'agent', agentId: 'a1', timeoutMs: 1000 },
          { id: 'f1', type: 'fork', forkId: 'parallel-1', timeoutMs: 1000 },
          { id: 'end', type: 'agent', agentId: 'a2', timeoutMs: 1000 },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'start', targetNodeId: 'f1' },
          { type: 'sequential', sourceNodeId: 'f1', targetNodeId: 'end' },
        ],
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'UNBALANCED_FORK_JOIN', nodeId: 'f1' }),
    )
  })

  it('reports unbalanced join (no matching fork)', () => {
    const result = validatePipeline(
      makePipeline({
        nodes: [
          { id: 'start', type: 'agent', agentId: 'a1', timeoutMs: 1000 },
          { id: 'j1', type: 'join', forkId: 'parallel-x', timeoutMs: 1000 },
          { id: 'end', type: 'agent', agentId: 'a2', timeoutMs: 1000 },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'start', targetNodeId: 'j1' },
          { type: 'sequential', sourceNodeId: 'j1', targetNodeId: 'end' },
        ],
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'UNBALANCED_FORK_JOIN', nodeId: 'j1' }),
    )
  })

  it('reports invalid loop body (missing node)', () => {
    const result = validatePipeline(
      makePipeline({
        nodes: [
          { id: 'start', type: 'agent', agentId: 'a1', timeoutMs: 1000 },
          {
            id: 'loop1',
            type: 'loop',
            bodyNodeIds: ['missing-node'],
            maxIterations: 5,
            continuePredicateName: 'check',
            timeoutMs: 10000,
          },
          { id: 'end', type: 'agent', agentId: 'a2', timeoutMs: 1000 },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'start', targetNodeId: 'loop1' },
          { type: 'sequential', sourceNodeId: 'loop1', targetNodeId: 'end' },
        ],
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID_LOOP_BODY', nodeId: 'loop1' }),
    )
  })

  it('warns on unreachable node (connected but not reachable from entry)', () => {
    const result = validatePipeline(
      makePipeline({
        nodes: [
          { id: 'start', type: 'agent', agentId: 'a1', timeoutMs: 1000 },
          { id: 'end', type: 'agent', agentId: 'a2', timeoutMs: 1000 },
          { id: 'island1', type: 'agent', agentId: 'a3', timeoutMs: 1000 },
          { id: 'island2', type: 'agent', agentId: 'a4', timeoutMs: 1000 },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'start', targetNodeId: 'end' },
          { type: 'sequential', sourceNodeId: 'island1', targetNodeId: 'island2' },
        ],
      }),
    )
    expect(result.valid).toBe(true)
    const unreachable = result.warnings.filter(w => w.code === 'UNREACHABLE_NODE')
    const unreachableIds = unreachable.map(w => w.nodeId)
    expect(unreachableIds).toContain('island1')
    expect(unreachableIds).toContain('island2')
  })

  it('warns when no error handlers exist', () => {
    const result = validatePipeline(makePipeline())
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'NO_ERROR_HANDLERS' }),
    )
  })

  it('does not warn about error handlers when error edges present', () => {
    const result = validatePipeline(
      makePipeline({
        nodes: [
          { id: 'start', type: 'agent', agentId: 'a1', timeoutMs: 1000 },
          { id: 'end', type: 'agent', agentId: 'a2', timeoutMs: 1000 },
          { id: 'errHandler', type: 'agent', agentId: 'err', timeoutMs: 1000 },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'start', targetNodeId: 'end' },
          { type: 'error', sourceNodeId: 'start', targetNodeId: 'errHandler' },
        ],
      }),
    )
    expect(result.warnings.filter(w => w.code === 'NO_ERROR_HANDLERS')).toHaveLength(0)
  })

  it('warns on high maxIterations (> 100)', () => {
    const result = validatePipeline(
      makePipeline({
        nodes: [
          { id: 'start', type: 'agent', agentId: 'a1', timeoutMs: 1000 },
          {
            id: 'bigLoop',
            type: 'loop',
            bodyNodeIds: [],
            maxIterations: 500,
            continuePredicateName: 'check',
            timeoutMs: 60000,
          },
          { id: 'end', type: 'agent', agentId: 'a2', timeoutMs: 1000 },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'start', targetNodeId: 'bigLoop' },
          { type: 'sequential', sourceNodeId: 'bigLoop', targetNodeId: 'end' },
        ],
      }),
    )
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'HIGH_MAX_ITERATIONS', nodeId: 'bigLoop' }),
    )
  })

  it('warns on missing timeouts', () => {
    const result = validatePipeline(
      makePipeline({
        nodes: [
          { id: 'start', type: 'agent', agentId: 'a1' }, // no timeoutMs
          { id: 'end', type: 'agent', agentId: 'a2', timeoutMs: 5000 },
        ],
      }),
    )
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'MISSING_TIMEOUT', nodeId: 'start' }),
    )
  })

  it('validates a complex pipeline with fork/join + loop', () => {
    const result = validatePipeline(
      makePipeline({
        nodes: [
          { id: 'start', type: 'agent', agentId: 'intake', timeoutMs: 5000 },
          { id: 'fork1', type: 'fork', forkId: 'p1', timeoutMs: 1000 },
          { id: 'branchA', type: 'agent', agentId: 'security', timeoutMs: 10000 },
          { id: 'branchB', type: 'agent', agentId: 'perf', timeoutMs: 10000 },
          { id: 'join1', type: 'join', forkId: 'p1', mergeStrategy: 'all', timeoutMs: 1000 },
          {
            id: 'retryLoop',
            type: 'loop',
            bodyNodeIds: ['fix', 'recheck'],
            maxIterations: 5,
            continuePredicateName: 'hasErrors',
            timeoutMs: 60000,
          },
          { id: 'fix', type: 'agent', agentId: 'fixer', timeoutMs: 15000 },
          { id: 'recheck', type: 'agent', agentId: 'checker', timeoutMs: 10000 },
          { id: 'end', type: 'agent', agentId: 'publish', timeoutMs: 5000 },
          { id: 'errHandler', type: 'agent', agentId: 'errLogger', timeoutMs: 3000 },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'start', targetNodeId: 'fork1' },
          { type: 'sequential', sourceNodeId: 'fork1', targetNodeId: 'branchA' },
          { type: 'sequential', sourceNodeId: 'fork1', targetNodeId: 'branchB' },
          { type: 'sequential', sourceNodeId: 'branchA', targetNodeId: 'join1' },
          { type: 'sequential', sourceNodeId: 'branchB', targetNodeId: 'join1' },
          { type: 'sequential', sourceNodeId: 'join1', targetNodeId: 'retryLoop' },
          { type: 'sequential', sourceNodeId: 'retryLoop', targetNodeId: 'fix' },
          { type: 'sequential', sourceNodeId: 'fix', targetNodeId: 'recheck' },
          { type: 'sequential', sourceNodeId: 'recheck', targetNodeId: 'retryLoop' },
          { type: 'sequential', sourceNodeId: 'retryLoop', targetNodeId: 'end' },
          { type: 'error', sourceNodeId: 'start', targetNodeId: 'errHandler' },
        ],
      }),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('handles conditional edges with dangling branches', () => {
    const result = validatePipeline(
      makePipeline({
        nodes: [
          { id: 'start', type: 'agent', agentId: 'router', timeoutMs: 1000 },
          { id: 'pathA', type: 'agent', agentId: 'a', timeoutMs: 1000 },
        ],
        edges: [
          {
            type: 'conditional',
            sourceNodeId: 'start',
            predicateName: 'route',
            branches: { a: 'pathA', b: 'missing' },
          },
        ],
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'DANGLING_EDGE' }),
    )
  })
})
