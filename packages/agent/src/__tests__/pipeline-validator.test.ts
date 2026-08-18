import { describe, it, expect } from 'vitest'
import { validatePipeline } from '../pipeline/pipeline-validator.js'
import type { PipelineDefinition, PipelineNode, PipelineEdge } from '@dzupagent/core'
import { createPipelineInteractionSpecV1 } from '@dzupagent/runtime-contracts'

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

  it.each([
    {
      name: 'nested fork',
      nodeId: 'innerFork',
      definition: makePipeline({
        entryNodeId: 'outerFork',
        nodes: [
          { id: 'outerFork', type: 'fork', forkId: 'outer' },
          { id: 'innerFork', type: 'fork', forkId: 'inner' },
          { id: 'innerLeft', type: 'agent', agentId: 'innerLeft' },
          { id: 'innerRight', type: 'agent', agentId: 'innerRight' },
          { id: 'innerJoin', type: 'join', forkId: 'inner' },
          { id: 'sibling', type: 'agent', agentId: 'sibling' },
          { id: 'outerJoin', type: 'join', forkId: 'outer' },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'outerFork', targetNodeId: 'innerFork' },
          { type: 'sequential', sourceNodeId: 'outerFork', targetNodeId: 'sibling' },
          { type: 'sequential', sourceNodeId: 'innerFork', targetNodeId: 'innerLeft' },
          { type: 'sequential', sourceNodeId: 'innerFork', targetNodeId: 'innerRight' },
          { type: 'sequential', sourceNodeId: 'innerLeft', targetNodeId: 'innerJoin' },
          { type: 'sequential', sourceNodeId: 'innerRight', targetNodeId: 'innerJoin' },
          { type: 'sequential', sourceNodeId: 'innerJoin', targetNodeId: 'outerJoin' },
          { type: 'sequential', sourceNodeId: 'sibling', targetNodeId: 'outerJoin' },
        ],
      }),
    },
    {
      name: 'loop',
      nodeId: 'nestedLoop',
      definition: makePipeline({
        entryNodeId: 'fork',
        nodes: [
          { id: 'fork', type: 'fork', forkId: 'parallel' },
          {
            id: 'nestedLoop',
            type: 'loop',
            bodyNodeIds: ['body'],
            maxIterations: 2,
            continuePredicateName: 'continue',
          },
          { id: 'body', type: 'agent', agentId: 'body' },
          { id: 'sibling', type: 'agent', agentId: 'sibling' },
          { id: 'join', type: 'join', forkId: 'parallel' },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'fork', targetNodeId: 'nestedLoop' },
          { type: 'sequential', sourceNodeId: 'fork', targetNodeId: 'sibling' },
          { type: 'sequential', sourceNodeId: 'nestedLoop', targetNodeId: 'join' },
          { type: 'sequential', sourceNodeId: 'sibling', targetNodeId: 'join' },
        ],
      }),
    },
    {
      name: 'suspension',
      nodeId: 'suspend',
      definition: makePipeline({
        entryNodeId: 'fork',
        nodes: [
          { id: 'fork', type: 'fork', forkId: 'parallel' },
          { id: 'suspend', type: 'suspend', resumeCondition: 'resume' },
          { id: 'sibling', type: 'agent', agentId: 'sibling' },
          { id: 'join', type: 'join', forkId: 'parallel' },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'fork', targetNodeId: 'suspend' },
          { type: 'sequential', sourceNodeId: 'fork', targetNodeId: 'sibling' },
          { type: 'sequential', sourceNodeId: 'suspend', targetNodeId: 'join' },
          { type: 'sequential', sourceNodeId: 'sibling', targetNodeId: 'join' },
        ],
      }),
    },
  ])('rejects $name inside a fork branch', ({ definition, nodeId }) => {
    const result = validatePipeline(definition)

    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'UNSUPPORTED_FORK_BRANCH_CONTROL',
        nodeId,
      }),
    )
  })

  it.each([
    {
      name: 'try/catch error edge',
      nodeId: 'work',
      branchEdges: [
        { type: 'sequential' as const, sourceNodeId: 'work', targetNodeId: 'join' },
        { type: 'error' as const, sourceNodeId: 'work', targetNodeId: 'catch' },
        { type: 'sequential' as const, sourceNodeId: 'catch', targetNodeId: 'join' },
      ],
      extraNodes: [
        { id: 'work', type: 'agent' as const, agentId: 'work' },
        { id: 'catch', type: 'agent' as const, agentId: 'catch' },
      ],
    },
  ])('rejects $name inside a fork branch', ({ nodeId, branchEdges, extraNodes }) => {
    const result = validatePipeline(
      makePipeline({
        entryNodeId: 'fork',
        nodes: [
          { id: 'fork', type: 'fork', forkId: 'parallel' },
          ...extraNodes,
          { id: 'sibling', type: 'agent', agentId: 'sibling' },
          { id: 'join', type: 'join', forkId: 'parallel' },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'fork', targetNodeId: nodeId },
          { type: 'sequential', sourceNodeId: 'fork', targetNodeId: 'sibling' },
          ...branchEdges,
          { type: 'sequential', sourceNodeId: 'sibling', targetNodeId: 'join' },
        ],
      }),
    )

    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'UNSUPPORTED_FORK_BRANCH_CONTROL',
        nodeId,
      }),
    )
  })

  it('accepts one direct two-arm conditional fork child', () => {
    const result = validatePipeline(
      makePipeline({
        entryNodeId: 'fork',
        nodes: [
          { id: 'fork', type: 'fork', forkId: 'parallel' },
          { id: 'decision', type: 'gate', gateType: 'quality' },
          { id: 'left', type: 'agent', agentId: 'left' },
          { id: 'right', type: 'agent', agentId: 'right' },
          { id: 'sibling', type: 'agent', agentId: 'sibling' },
          { id: 'join', type: 'join', forkId: 'parallel' },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'fork', targetNodeId: 'decision' },
          { type: 'sequential', sourceNodeId: 'fork', targetNodeId: 'sibling' },
          {
            type: 'conditional',
            sourceNodeId: 'decision',
            predicateName: 'choose',
            branches: { true: 'left', false: 'right' },
          },
          { type: 'sequential', sourceNodeId: 'left', targetNodeId: 'join' },
          { type: 'sequential', sourceNodeId: 'right', targetNodeId: 'join' },
          { type: 'sequential', sourceNodeId: 'sibling', targetNodeId: 'join' },
        ],
      }),
    )

    expect(result.errors).not.toContainEqual(
      expect.objectContaining({ code: 'UNSUPPORTED_FORK_BRANCH_CONTROL' }),
    )
    expect(result.valid).toBe(true)
  })

  it('accepts disjoint leaf-only fork branches with sequential leaf chains', () => {
    const result = validatePipeline(
      makePipeline({
        entryNodeId: 'fork',
        nodes: [
          { id: 'fork', type: 'fork', forkId: 'parallel' },
          { id: 'leftA', type: 'agent', agentId: 'leftA' },
          { id: 'leftB', type: 'transform', transformName: 'leftB' },
          { id: 'rightA', type: 'agent', agentId: 'rightA' },
          { id: 'rightB', type: 'gate', gateType: 'quality' },
          { id: 'join', type: 'join', forkId: 'parallel' },
          { id: 'done', type: 'agent', agentId: 'done' },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'fork', targetNodeId: 'leftA' },
          { type: 'sequential', sourceNodeId: 'fork', targetNodeId: 'rightA' },
          { type: 'sequential', sourceNodeId: 'leftA', targetNodeId: 'leftB' },
          { type: 'sequential', sourceNodeId: 'leftB', targetNodeId: 'join' },
          { type: 'sequential', sourceNodeId: 'rightA', targetNodeId: 'rightB' },
          { type: 'sequential', sourceNodeId: 'rightB', targetNodeId: 'join' },
          { type: 'sequential', sourceNodeId: 'join', targetNodeId: 'done' },
        ],
      }),
    )

    expect(result.errors).not.toContainEqual(
      expect.objectContaining({ code: 'UNSUPPORTED_FORK_BRANCH_CONTROL' }),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects conditional branch starts directly on a fork', () => {
    const result = validatePipeline(
      makePipeline({
        entryNodeId: 'fork',
        nodes: [
          { id: 'fork', type: 'fork', forkId: 'parallel' },
          { id: 'left', type: 'agent', agentId: 'left' },
          { id: 'right', type: 'agent', agentId: 'right' },
          { id: 'join', type: 'join', forkId: 'parallel' },
        ],
        edges: [
          {
            type: 'conditional',
            sourceNodeId: 'fork',
            predicateName: 'choose',
            branches: { left: 'left', right: 'right' },
          },
          { type: 'sequential', sourceNodeId: 'left', targetNodeId: 'join' },
          { type: 'sequential', sourceNodeId: 'right', targetNodeId: 'join' },
        ],
      }),
    )

    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'UNSUPPORTED_FORK_BRANCH_CONTROL',
        nodeId: 'fork',
      }),
    )
  })

  it('rejects multiple sequential successors inside one fork branch', () => {
    const result = validatePipeline(
      makePipeline({
        entryNodeId: 'fork',
        nodes: [
          { id: 'fork', type: 'fork', forkId: 'parallel' },
          { id: 'ambiguous', type: 'agent', agentId: 'ambiguous' },
          { id: 'left', type: 'agent', agentId: 'left' },
          { id: 'right', type: 'agent', agentId: 'right' },
          { id: 'sibling', type: 'agent', agentId: 'sibling' },
          { id: 'join', type: 'join', forkId: 'parallel' },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'fork', targetNodeId: 'ambiguous' },
          { type: 'sequential', sourceNodeId: 'fork', targetNodeId: 'sibling' },
          { type: 'sequential', sourceNodeId: 'ambiguous', targetNodeId: 'left' },
          { type: 'sequential', sourceNodeId: 'ambiguous', targetNodeId: 'right' },
          { type: 'sequential', sourceNodeId: 'left', targetNodeId: 'join' },
          { type: 'sequential', sourceNodeId: 'right', targetNodeId: 'join' },
          { type: 'sequential', sourceNodeId: 'sibling', targetNodeId: 'join' },
        ],
      }),
    )

    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'UNSUPPORTED_FORK_BRANCH_CONTROL',
        nodeId: 'ambiguous',
      }),
    )
  })

  it('rejects a fork branch that dead-ends before its owning join', () => {
    const result = validatePipeline(
      makePipeline({
        entryNodeId: 'fork',
        nodes: [
          { id: 'fork', type: 'fork', forkId: 'parallel' },
          { id: 'deadEnd', type: 'agent', agentId: 'deadEnd' },
          { id: 'sibling', type: 'agent', agentId: 'sibling' },
          { id: 'join', type: 'join', forkId: 'parallel' },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'fork', targetNodeId: 'deadEnd' },
          { type: 'sequential', sourceNodeId: 'fork', targetNodeId: 'sibling' },
          { type: 'sequential', sourceNodeId: 'sibling', targetNodeId: 'join' },
        ],
      }),
    )

    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'UNSUPPORTED_FORK_BRANCH_CONTROL',
        nodeId: 'deadEnd',
      }),
    )
  })

  it('rejects duplicate fork and join ownership identifiers', () => {
    const result = validatePipeline(
      makePipeline({
        entryNodeId: 'forkA',
        nodes: [
          { id: 'forkA', type: 'fork', forkId: 'parallel' },
          { id: 'forkB', type: 'fork', forkId: 'parallel' },
          { id: 'left', type: 'agent', agentId: 'left' },
          { id: 'right', type: 'agent', agentId: 'right' },
          { id: 'joinA', type: 'join', forkId: 'parallel' },
          { id: 'joinB', type: 'join', forkId: 'parallel' },
        ],
        edges: [
          { type: 'sequential', sourceNodeId: 'forkA', targetNodeId: 'left' },
          { type: 'sequential', sourceNodeId: 'left', targetNodeId: 'joinA' },
          { type: 'sequential', sourceNodeId: 'forkB', targetNodeId: 'right' },
          { type: 'sequential', sourceNodeId: 'right', targetNodeId: 'joinB' },
        ],
      }),
    )

    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'UNBALANCED_FORK_JOIN' }),
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

  it('reports a bodyGraph boundary outside the loop body inventory', () => {
    const result = validatePipeline(
      makePipeline({
        entryNodeId: 'loop1',
        nodes: [
          {
            id: 'loop1',
            type: 'loop',
            bodyNodeIds: ['body'],
            bodyGraph: {
              entryNodeId: 'outside',
              normalExitNodeIds: ['body'],
              suspendedExitNodeIds: [],
              terminalExitNodeIds: [],
              errorExitNodeIds: [],
            },
            maxIterations: 5,
            continuePredicateName: 'check',
            timeoutMs: 10000,
          },
          { id: 'body', type: 'agent', agentId: 'body', timeoutMs: 1000 },
          { id: 'outside', type: 'agent', agentId: 'outside', timeoutMs: 1000 },
        ],
        edges: [],
      }),
    )

    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_LOOP_BODY_GRAPH',
        nodeId: 'loop1',
      }),
    )
  })

  it('rejects an ambiguously classified structured loop outcome', () => {
    const result = validatePipeline(
      makePipeline({
        entryNodeId: 'loop1',
        nodes: [
          {
            id: 'loop1',
            type: 'loop',
            bodyNodeIds: ['boundary'],
            bodyGraph: {
              entryNodeId: 'boundary',
              normalExitNodeIds: ['boundary'],
              suspendedExitNodeIds: ['boundary'],
              terminalExitNodeIds: [],
              errorExitNodeIds: [],
            },
            maxIterations: 5,
            continuePredicateName: 'check',
            timeoutMs: 10000,
          },
          {
            id: 'boundary',
            type: 'suspend',
            resumeCondition: 'approved',
            timeoutMs: 1000,
          },
        ],
        edges: [],
      }),
    )

    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_LOOP_BODY_GRAPH',
        nodeId: 'loop1',
      }),
    )
    expect(result.errors).not.toHaveLength(0)
    expect(
      result.errors.filter(error => error.code === 'INVALID_LOOP_BODY_GRAPH'),
    ).toHaveLength(result.errors.length)
  })

  it('rejects a suspended exit with multiple continuation edges', () => {
    const result = validatePipeline(
      makePipeline({
        entryNodeId: 'loop1',
        nodes: [
          {
            id: 'loop1',
            type: 'loop',
            bodyNodeIds: ['approval', 'left', 'right'],
            bodyGraph: {
              entryNodeId: 'approval',
              normalExitNodeIds: ['left', 'right'],
              suspendedExitNodeIds: ['approval'],
              terminalExitNodeIds: [],
              errorExitNodeIds: [],
            },
            maxIterations: 5,
            continuePredicateName: 'check',
          },
          { id: 'approval', type: 'gate', gateType: 'approval' },
          { id: 'left', type: 'agent', agentId: 'left' },
          { id: 'right', type: 'agent', agentId: 'right' },
        ],
        edges: [
          {
            type: 'sequential',
            sourceNodeId: 'approval',
            targetNodeId: 'left',
          },
          {
            type: 'sequential',
            sourceNodeId: 'approval',
            targetNodeId: 'right',
          },
        ],
      }),
    )

    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_LOOP_BODY_GRAPH',
        message: expect.stringContaining('multiple body continuations'),
        nodeId: 'loop1',
      }),
    )
  })

  it.each([
    {
      name: 'suspended',
      bodyNodeIds: ['approval', 'work'],
      bodyGraph: {
        entryNodeId: 'approval',
        normalExitNodeIds: ['work'],
        suspendedExitNodeIds: ['approval'],
        terminalExitNodeIds: [],
        errorExitNodeIds: [],
      },
      bodyNodes: [
        { id: 'approval', type: 'gate', gateType: 'approval' } as const,
        { id: 'work', type: 'agent', agentId: 'work' } as const,
      ],
      edges: [
        {
          type: 'sequential',
          sourceNodeId: 'approval',
          targetNodeId: 'work',
        } as const,
      ],
    },
    {
      name: 'terminal',
      bodyNodeIds: ['complete'],
      bodyGraph: {
        entryNodeId: 'complete',
        normalExitNodeIds: [],
        suspendedExitNodeIds: [],
        terminalExitNodeIds: ['complete'],
        errorExitNodeIds: [],
      },
      bodyNodes: [{ id: 'complete', type: 'suspend' } as const],
      edges: [],
    },
  ])('accepts a well-classified $name loop outcome', ({ bodyNodeIds, bodyGraph, bodyNodes, edges }) => {
    const result = validatePipeline(
      makePipeline({
        entryNodeId: 'loop1',
        nodes: [
          {
            id: 'loop1',
            type: 'loop',
            bodyNodeIds,
            bodyGraph,
            maxIterations: 5,
            continuePredicateName: 'check',
          },
          ...bodyNodes,
        ],
        edges,
      }),
    )

    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
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

  it('rejects interaction nodes in a legacy loop without a bodyGraph', () => {
    const interaction = createPipelineInteractionSpecV1({
      kind: 'clarification',
      authoredNodeId: 'clarify',
      authoredPath: 'root.body[0]',
      question: 'Which item value?',
      choices: [],
      outputKey: 'itemValue',
      requestSchema: {
        kind: 'clarification',
        response: 'text',
        minLength: 1,
        maxLength: 16_384,
      },
    })
    const result = validatePipeline(
      makePipeline({
        schemaVersion: '1.1.0',
        entryNodeId: 'loop',
        nodes: [
          {
            id: 'loop',
            type: 'loop',
            bodyNodeIds: ['clarify'],
            maxIterations: 1,
            continuePredicateName: 'stop',
          },
          { id: 'clarify', type: 'suspend', interaction },
        ],
        edges: [],
      }),
    )

    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_LOOP_BODY_GRAPH',
        nodeId: 'loop',
      }),
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
