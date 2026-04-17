/**
 * Branch-coverage tests for pipeline/pipeline-runtime helpers.
 */
import { describe, it, expect } from 'vitest'
import {
  getNextNodeIds,
  getErrorTarget,
  findJoinNode,
  getForkBranchStartIds,
} from '../pipeline/pipeline-runtime/edge-resolution.js'
import { valuesEqual } from '../pipeline/pipeline-runtime/state-utils.js'
import {
  collectStateDelta,
  mergeBranchExecutionResult,
  type BranchExecutionResult,
} from '../pipeline/pipeline-runtime/branch-merge.js'
import type { PipelineEdge, PipelineNode } from '@dzupagent/core'
import type { NodeResult } from '../pipeline/pipeline-runtime-types.js'

// ---------------------------------------------------------------------------
// getNextNodeIds
// ---------------------------------------------------------------------------
describe('getNextNodeIds — branch coverage', () => {
  it('returns empty when no edges are registered for the node', () => {
    const edges = new Map<string, PipelineEdge[]>()
    expect(getNextNodeIds('A', edges, undefined, {})).toEqual([])
  })

  it('follows sequential edges', () => {
    const edges = new Map<string, PipelineEdge[]>([
      ['A', [{ type: 'sequential', sourceNodeId: 'A', targetNodeId: 'B' }]],
    ])
    expect(getNextNodeIds('A', edges, undefined, {})).toEqual(['B'])
  })

  it('follows conditional edge using predicate-true branch key', () => {
    const edges = new Map<string, PipelineEdge[]>([
      ['A', [{
        type: 'conditional', sourceNodeId: 'A', predicateName: 'isReady',
        branches: { true: 'B', false: 'C' },
      }]],
    ])
    const result = getNextNodeIds('A', edges, { isReady: () => true }, {})
    expect(result).toEqual(['B'])
  })

  it('follows conditional edge using predicate-false branch key', () => {
    const edges = new Map<string, PipelineEdge[]>([
      ['A', [{
        type: 'conditional', sourceNodeId: 'A', predicateName: 'isReady',
        branches: { true: 'B', false: 'C' },
      }]],
    ])
    const result = getNextNodeIds('A', edges, { isReady: () => false }, {})
    expect(result).toEqual(['C'])
  })

  it('skips conditional edge when predicate is not registered', () => {
    const edges = new Map<string, PipelineEdge[]>([
      ['A', [{
        type: 'conditional', sourceNodeId: 'A', predicateName: 'missing',
        branches: { true: 'B' },
      }]],
    ])
    expect(getNextNodeIds('A', edges, {}, {})).toEqual([])
  })

  it('skips conditional edge when branch key has no target', () => {
    const edges = new Map<string, PipelineEdge[]>([
      ['A', [{
        type: 'conditional', sourceNodeId: 'A', predicateName: 'p',
        branches: {},
      }]],
    ])
    expect(getNextNodeIds('A', edges, { p: () => true }, {})).toEqual([])
  })

  it('supports non-boolean predicate result via branch key string', () => {
    const edges = new Map<string, PipelineEdge[]>([
      ['A', [{
        type: 'conditional', sourceNodeId: 'A', predicateName: 'bucket',
        branches: { red: 'R', blue: 'B' },
      }]],
    ])
    const result = getNextNodeIds(
      'A',
      edges,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { bucket: (() => 'red') as any },
      {},
    )
    expect(result).toEqual(['R'])
  })
})

// ---------------------------------------------------------------------------
// getErrorTarget
// ---------------------------------------------------------------------------
describe('getErrorTarget — branch coverage', () => {
  it('returns undefined for node with no error edges', () => {
    expect(getErrorTarget('A', new Map())).toBeUndefined()
  })

  it('returns undefined for empty edge list', () => {
    const m = new Map<string, PipelineEdge[]>([['A', []]])
    expect(getErrorTarget('A', m)).toBeUndefined()
  })

  it('returns code-specific target when errorCode matches', () => {
    const m = new Map<string, PipelineEdge[]>([
      ['A', [
        { type: 'error', sourceNodeId: 'A', targetNodeId: 'handleOOM', errorCodes: ['OOM'] },
        { type: 'error', sourceNodeId: 'A', targetNodeId: 'generic' },
      ]],
    ])
    expect(getErrorTarget('A', m, 'OOM')).toBe('handleOOM')
  })

  it('falls back to catch-all (no errorCodes) when errorCode is given but unmatched', () => {
    const m = new Map<string, PipelineEdge[]>([
      ['A', [
        { type: 'error', sourceNodeId: 'A', targetNodeId: 'oomHandler', errorCodes: ['OOM'] },
        { type: 'error', sourceNodeId: 'A', targetNodeId: 'fallback' },
      ]],
    ])
    expect(getErrorTarget('A', m, 'OTHER')).toBe('fallback')
  })

  it('returns undefined when errorCode given but no match and no catch-all', () => {
    const m = new Map<string, PipelineEdge[]>([
      ['A', [
        { type: 'error', sourceNodeId: 'A', targetNodeId: 'oomHandler', errorCodes: ['OOM'] },
      ]],
    ])
    expect(getErrorTarget('A', m, 'OTHER')).toBeUndefined()
  })

  it('returns catch-all when no errorCode is given', () => {
    const m = new Map<string, PipelineEdge[]>([
      ['A', [
        { type: 'error', sourceNodeId: 'A', targetNodeId: 'oomHandler', errorCodes: ['OOM'] },
        { type: 'error', sourceNodeId: 'A', targetNodeId: 'generic' },
      ]],
    ])
    expect(getErrorTarget('A', m)).toBe('generic')
  })

  it('returns first error target when no catch-all and no code given', () => {
    const m = new Map<string, PipelineEdge[]>([
      ['A', [
        { type: 'error', sourceNodeId: 'A', targetNodeId: 'oomHandler', errorCodes: ['OOM'] },
      ]],
    ])
    expect(getErrorTarget('A', m)).toBe('oomHandler')
  })
})

// ---------------------------------------------------------------------------
// findJoinNode
// ---------------------------------------------------------------------------
describe('findJoinNode — branch coverage', () => {
  it('returns the matching join node for a fork id', () => {
    const nodes: PipelineNode[] = [
      { id: 'J1', type: 'join', forkId: 'F1' },
      { id: 'A', type: 'agent', agentId: 'a1' },
    ]
    expect(findJoinNode('F1', nodes)?.id).toBe('J1')
  })
  it('returns undefined when no join node matches', () => {
    const nodes: PipelineNode[] = [
      { id: 'J1', type: 'join', forkId: 'F-other' },
    ]
    expect(findJoinNode('F1', nodes)).toBeUndefined()
  })
  it('ignores non-join nodes with same id', () => {
    const nodes: PipelineNode[] = [
      { id: 'X', type: 'agent', agentId: 'a1' },
    ]
    expect(findJoinNode('F1', nodes)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// getForkBranchStartIds
// ---------------------------------------------------------------------------
describe('getForkBranchStartIds — branch coverage', () => {
  it('collects sequential targets', () => {
    const edges: PipelineEdge[] = [
      { type: 'sequential', sourceNodeId: 'F', targetNodeId: 'A' },
      { type: 'sequential', sourceNodeId: 'F', targetNodeId: 'B' },
    ]
    expect(getForkBranchStartIds(edges)).toEqual(['A', 'B'])
  })
  it('flattens conditional branches into start ids', () => {
    const edges: PipelineEdge[] = [
      {
        type: 'conditional', sourceNodeId: 'F', predicateName: 'p',
        branches: { a: 'X', b: 'Y' },
      },
    ]
    const ids = getForkBranchStartIds(edges)
    expect(ids.sort()).toEqual(['X', 'Y'])
  })
  it('returns empty for unsupported edge types', () => {
    const edges: PipelineEdge[] = [
      { type: 'error', sourceNodeId: 'F', targetNodeId: 'ignored' },
    ]
    expect(getForkBranchStartIds(edges)).toEqual([])
  })
  it('returns empty for empty edge list', () => {
    expect(getForkBranchStartIds([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// valuesEqual
// ---------------------------------------------------------------------------
describe('valuesEqual — branch coverage', () => {
  it('returns true for identical primitives', () => {
    expect(valuesEqual(1, 1)).toBe(true)
    expect(valuesEqual('x', 'x')).toBe(true)
    expect(valuesEqual(null, null)).toBe(true)
    expect(valuesEqual(undefined, undefined)).toBe(true)
  })
  it('returns false for different primitives', () => {
    expect(valuesEqual(1, 2)).toBe(false)
    expect(valuesEqual('x', 'y')).toBe(false)
  })
  it('returns false when one side is null and other is object', () => {
    expect(valuesEqual(null, {})).toBe(false)
    expect(valuesEqual({}, null)).toBe(false)
  })
  it('returns false when types differ', () => {
    expect(valuesEqual(1, '1')).toBe(false)
    expect(valuesEqual({ a: 1 }, 'not-object')).toBe(false)
  })
  it('returns true for deeply equal objects via JSON comparison', () => {
    expect(valuesEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toBe(true)
  })
  it('returns false for structurally different objects', () => {
    expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false)
  })
  it('handles circular references by returning false (catches JSON error)', () => {
    const o: Record<string, unknown> = { a: 1 }
    o['self'] = o
    expect(valuesEqual(o, o)).toBe(true) // Object.is catches identity
    const p: Record<string, unknown> = { a: 1 }
    p['self'] = p
    // Different instances, both with cycles
    expect(valuesEqual(o, p)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// collectStateDelta / mergeBranchExecutionResult
// ---------------------------------------------------------------------------
describe('collectStateDelta / mergeBranchExecutionResult — branch coverage', () => {
  it('records only changed keys as the delta', () => {
    const baseline = { a: 1, b: 2, c: { x: 1 } }
    const next = { a: 1, b: 3, c: { x: 1 }, d: 'new' }
    const delta = collectStateDelta(baseline, next)
    expect(delta).toEqual({ b: 3, d: 'new' })
  })

  it('records structurally-changed object values', () => {
    const baseline = { obj: { x: 1 } }
    const next = { obj: { x: 2 } }
    expect(collectStateDelta(baseline, next)).toEqual({ obj: { x: 2 } })
  })

  it('empty object when no changes', () => {
    expect(collectStateDelta({ a: 1 }, { a: 1 })).toEqual({})
  })

  it('mergeBranchExecutionResult copies node results, completedIds and applies stateDelta', () => {
    const nodeResults = new Map<string, NodeResult>()
    const completedIds: string[] = ['parent']
    const runState: Record<string, unknown> = { base: true }
    const branchResult: BranchExecutionResult = {
      state: 'completed',
      stateDelta: { branchKey: 42 },
      nodeResults: new Map([
        ['Bn', { nodeId: 'Bn', output: 'x', durationMs: 1 }],
      ]),
      completedNodeIds: ['Bn'],
    }

    mergeBranchExecutionResult(nodeResults, completedIds, runState, branchResult)

    expect(nodeResults.get('Bn')?.output).toBe('x')
    expect(completedIds).toEqual(['parent', 'Bn'])
    expect(runState).toEqual({ base: true, branchKey: 42 })
  })
})
