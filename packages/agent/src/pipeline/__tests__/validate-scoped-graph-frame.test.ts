import { describe, expect, it } from 'vitest'
import { validateScopedGraphCheckpointFrame } from '../scoped-graph/validate-scoped-graph-frame.js'
import type { ScopedGraphCheckpointDefinition, ScopedGraphCheckpointFrame } from '../scoped-graph/contract.js'

const definition: ScopedGraphCheckpointDefinition = { boundary: { scopeId: 'scope', displayName: 'Fixture', sourceDefinitionId: 'source', scopedDefinitionId: 'scoped', nodeInventoryName: 'fixture nodes', entryNodeId: 'node', nodeIds: ['node'], normalExitNodeIds: ['node'], suspendedExitNodeIds: [], terminalExitNodeIds: [], errorExitNodeIds: [] }, nodes: [{ id: 'node', type: 'agent', agentId: 'fixture' }], outgoingEdges: new Map(), errorEdges: new Map() }
const frame = (): ScopedGraphCheckpointFrame => ({ completed: false, nextNodeId: 'node', completedNodeIds: [], nodeResults: {}, nodeIdempotencyKeys: {} })
const result = { nodeId: 'node', durationMs: 1, output: null }
const completed: ScopedGraphCheckpointFrame = { completed: true, completedNodeIds: ['node'], nodeResults: { node: result }, nodeIdempotencyKeys: { node: 'key' }, outcome: { kind: 'normal', exitNodeId: 'node' } }
const terminalDefinition: ScopedGraphCheckpointDefinition = { ...definition, boundary: { ...definition.boundary, normalExitNodeIds: [], terminalExitNodeIds: ['node'], suspendedExitNodeIds: ['node'] }, nodes: [{ id: 'node', type: 'suspend', reason: 'fixture' } as never] }
const terminal: ScopedGraphCheckpointFrame = { completed: true, completedNodeIds: [], nodeResults: {}, nodeIdempotencyKeys: {}, outcome: { kind: 'terminal', exitNodeId: 'node' } }
const suspended: ScopedGraphCheckpointFrame = { ...terminal, completed: false, outcome: { kind: 'suspended', exitNodeId: 'node' } }
const edge = { type: 'sequential' as const, sourceNodeId: 'node', targetNodeId: 'node' }

describe('validateScopedGraphCheckpointFrame', () => {
  it('refuses restored frames that bind foreign nodes, malformed cursors, results or idempotency keys', () => {
    expect(() => validateScopedGraphCheckpointFrame(definition, frame())).not.toThrow()
    const invalid: Array<Record<string, unknown>> = [
      { completed: null }, { completedNodeIds: null }, { nodeResults: [] }, { nodeIdempotencyKeys: [] }, { nextNodeId: '' }, { nextNodeId: 'foreign' }, { completed: true }, { completedNodeIds: ['foreign'] }, { completedNodeIds: ['node', 'node'] }, { nodeResults: { foreign: { nodeId: 'foreign', durationMs: 0 } } }, { nodeResults: { node: null } }, { nodeIdempotencyKeys: { foreign: 'key' } }, { nodeIdempotencyKeys: { node: '' } }, { outcome: { kind: 'unknown', exitNodeId: 'node' } }, { outcome: { kind: 'normal', exitNodeId: 'foreign' } }, { outcome: { kind: 'normal', exitNodeId: 'node' } }, { outcome: { kind: 'suspended', exitNodeId: 'node' } }, { forkState: [] },
    ]
    for (const extra of invalid) expect(() => validateScopedGraphCheckpointFrame(definition, { ...frame(), ...extra } as ScopedGraphCheckpointFrame), JSON.stringify(extra)).toThrow()
  })

  it('accepts a completed normal outcome and refuses completed frames whose results contradict it', () => {
    expect(() => validateScopedGraphCheckpointFrame(definition, completed)).not.toThrow()
    for (const change of [{ outcome: null }, { outcome: { kind: 'normal', exitNodeId: '' } }, { nodeResults: {} }, { nodeResults: { node: { ...result, nodeId: 'foreign' } } }, { completedNodeIds: [] }, { nextNodeId: 'node' }, { forkState: { one: {}, two: {} } }, { forkState: { missing: { branches: {} } } }]) {
      expect(() => validateScopedGraphCheckpointFrame(definition, { ...completed, ...change } as ScopedGraphCheckpointFrame)).toThrow()
    }
    for (const change of [{ nodeIdempotencyKeys: { node: 'key' } }, { nodeResults: { node: result } }, { completedNodeIds: ['node'], nodeResults: { node: result } }]) {
      expect(() => validateScopedGraphCheckpointFrame(definition, { ...frame(), ...change } as ScopedGraphCheckpointFrame)).toThrow()
    }
  })

  it('requires a declared normal exit when a completed frame omits its outcome', () => {
    const { outcome: _outcome, ...completedWithoutOutcome } = completed
    expect(() => validateScopedGraphCheckpointFrame({ ...definition, boundary: { ...definition.boundary, normalExitNodeIds: [] } }, completedWithoutOutcome)).toThrow(/normal exit/)
  })

  it('binds a terminal outcome to a suspend node without continuations', () => {
    expect(() => validateScopedGraphCheckpointFrame(terminalDefinition, terminal)).not.toThrow()
    expect(() => validateScopedGraphCheckpointFrame({ ...terminalDefinition, nodes: definition.nodes }, terminal)).toThrow(/suspend node/)
    expect(() => validateScopedGraphCheckpointFrame({ ...terminalDefinition, outgoingEdges: new Map([['node', [edge]]]) }, terminal)).toThrow(/continuation/)
  })

  it('binds a suspended outcome to exactly one declared continuation', () => {
    expect(() => validateScopedGraphCheckpointFrame(terminalDefinition, suspended)).toThrow(/continuation/)
    expect(() => validateScopedGraphCheckpointFrame({ ...terminalDefinition, outgoingEdges: new Map([['node', [edge]]]) }, suspended)).not.toThrow()
    expect(() => validateScopedGraphCheckpointFrame({ ...terminalDefinition, outgoingEdges: new Map([['node', [edge, edge]]]) }, suspended)).toThrow(/multiple/)
    expect(() => validateScopedGraphCheckpointFrame(terminalDefinition, { ...suspended, completed: true })).toThrow(/completed=false/)
  })

  it('accepts one retained fork branch and rejects missing, ambiguous or foreign ownership', () => {
    const forkDefinition: ScopedGraphCheckpointDefinition = { ...definition, boundary: { ...definition.boundary, entryNodeId: 'fork', nodeIds: ['fork', 'node'] }, nodes: [{ id: 'fork', type: 'fork', forkId: 'fork-one' }, ...definition.nodes], outgoingEdges: new Map([['fork', [{ type: 'sequential', sourceNodeId: 'fork', targetNodeId: 'node' }]]]) }
    const retained = { ...frame(), nextNodeId: 'fork', completedNodeIds: ['fork'], forkState: { 'fork-one': { branches: { node: { nodeResults: {} } } } } } as unknown as ScopedGraphCheckpointFrame
    expect(() => validateScopedGraphCheckpointFrame(forkDefinition, retained)).not.toThrow()
    const changes = [{ completedNodeIds: [] }, { completed: true }, { nextNodeId: 'node' }, { outcome: { kind: 'suspended', exitNodeId: 'node' }, nextNodeId: undefined }, { forkState: { 'fork-one': { branches: {} } } }, { forkState: { 'fork-one': null } }, { forkState: { 'fork-one': { branches: { foreign: { nodeResults: {} } } } } }, { forkState: { 'fork-one': { branches: { node: null } } } }, { forkState: { 'fork-one': { branches: { node: { nodeResults: null } } } } }, { forkState: { 'fork-one': { branches: { node: { nodeResults: { foreign: { nodeId: 'foreign' } } } } } } }]
    for (const change of changes) expect(() => validateScopedGraphCheckpointFrame(forkDefinition, { ...retained, ...change } as ScopedGraphCheckpointFrame)).toThrow()
    expect(() => validateScopedGraphCheckpointFrame({ ...forkDefinition, nodes: [...forkDefinition.nodes, { id: 'fork-second', type: 'fork', forkId: 'fork-one' }] }, retained)).toThrow(/unique body fork/)
  })
})
