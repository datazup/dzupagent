import { test, expect } from 'vitest'
import type { RuntimeToolHandlerInput } from '../pipeline/pipeline-runtime-types.js'
import * as requests from '../pipeline/tool-handlers/requests.js'
import { validateScopedGraphCheckpointFrame } from '../pipeline/scoped-graph/validate-scoped-graph-frame.js'
import type { ScopedGraphCheckpointDefinition, ScopedGraphCheckpointFrame } from '../pipeline/scoped-graph/contract.js'

test('runtime tool requests retain execution context and validate required arguments before dispatch', () => {
  const input: RuntimeToolHandlerInput = { nodeId: 'node', node: { id: 'node', type: 'tool', toolName: 'fixture' }, arguments: { userPrompt: 'prompt', dispatchId: 'dispatch', provider: 'fixture', instructions: 'fixture', outputKey: 'output', command: 'fixture', output: 'output', source: 'source', schema: { type: 'object' }, providers: ['one', 'two'], goal: 'fixture', model: 'fixture', tools: false, input: { retained: true }, tags: ['tag'], specialists: ['worker'], commandAllowlist: ['fixture'], merge: 'all' }, context: { state: {}, previousResults: new Map(), idempotencyKey: 'stable' } }
  const prompt = requests.buildPromptRequest(input)
  expect(prompt.userPrompt).toBe('prompt')
  expect(prompt.tools).toBe(false)
  expect(prompt.context).toBe(input.context)
  expect(requests.buildWorkerDispatchRequest(input)).toMatchObject({ dispatchId: 'dispatch', commandAllowlist: ['fixture'], outputKey: 'output' })
  expect(requests.buildShellRunRequest(input)).toMatchObject({ command: 'fixture', output: 'output' })
  expect(requests.buildValidateSchemaRequest(input).schema).toEqual({ type: 'object' })
  expect(requests.buildAdapterRunRequest(input).tags).toEqual(['tag'])
  expect(requests.buildAdapterRaceRequest(input).providers).toEqual(['one', 'two'])
  expect(requests.buildAdapterParallelRequest(input).merge).toBe('all')
  expect(requests.buildAdapterSupervisorRequest(input).specialists).toEqual(['worker'])
  for (const build of [requests.buildPromptRequest, requests.buildWorkerDispatchRequest, requests.buildShellRunRequest, requests.buildValidateSchemaRequest, requests.buildAdapterRunRequest, requests.buildAdapterRaceRequest, requests.buildAdapterParallelRequest, requests.buildAdapterSupervisorRequest]) {
    expect(() => build({ ...input, arguments: {} })).toThrow(/must be/)
  }
})

const definition: ScopedGraphCheckpointDefinition = { boundary: { scopeId: 'scope', displayName: 'Fixture', sourceDefinitionId: 'source', scopedDefinitionId: 'scoped', nodeInventoryName: 'fixture nodes', entryNodeId: 'node', nodeIds: ['node'], normalExitNodeIds: ['node'], suspendedExitNodeIds: [], terminalExitNodeIds: [], errorExitNodeIds: [] }, nodes: [{ id: 'node', type: 'agent', agentId: 'fixture' }], outgoingEdges: new Map(), errorEdges: new Map() }
const frame = (): ScopedGraphCheckpointFrame => ({ completed: false, nextNodeId: 'node', completedNodeIds: [], nodeResults: {}, nodeIdempotencyKeys: {} })
test('restored graph frames cannot bind foreign nodes, malformed cursors, results or idempotency keys', () => {
  expect(() => validateScopedGraphCheckpointFrame(definition, frame())).not.toThrow()
  const invalid: Array<Record<string, unknown>> = [
    { completed: null }, { completedNodeIds: null }, { nodeResults: [] }, { nodeIdempotencyKeys: [] }, { nextNodeId: '' }, { nextNodeId: 'foreign' }, { completed: true }, { completedNodeIds: ['foreign'] }, { completedNodeIds: ['node', 'node'] }, { nodeResults: { foreign: { nodeId: 'foreign', durationMs: 0 } } }, { nodeResults: { node: null } }, { nodeIdempotencyKeys: { foreign: 'key' } }, { nodeIdempotencyKeys: { node: '' } }, { outcome: { kind: 'unknown', exitNodeId: 'node' } }, { outcome: { kind: 'normal', exitNodeId: 'foreign' } }, { outcome: { kind: 'normal', exitNodeId: 'node' } }, { outcome: { kind: 'suspended', exitNodeId: 'node' } }, { forkState: [] },
  ]
  for (const extra of invalid) expect(() => validateScopedGraphCheckpointFrame(definition, { ...frame(), ...extra } as ScopedGraphCheckpointFrame), JSON.stringify(extra)).toThrow()
})
