import { test, expect } from 'vitest'
import type { RuntimeToolHandlerInput } from '../pipeline/pipeline-runtime-types.js'
import * as requests from '../pipeline/tool-handlers/requests.js'
import { validateScopedGraphCheckpointFrame } from '../pipeline/scoped-graph/validate-scoped-graph-frame.js'
import type { ScopedGraphCheckpointDefinition, ScopedGraphCheckpointFrame } from '../pipeline/scoped-graph/contract.js'
import { assertAgentRunnerStructuredOutputRequest, selectAgentRunnerStructuredOutput, invokeAgentRunnerModel, prepareAgentRunnerModelTurn } from '../runner/model-port-values.js'
import { digestRunnerJson } from '../runner/runner-durable-json.js'
import type { AgentRunnerModelRequest, AgentRunnerModelInvocationResult, AgentRunnerModelPort } from '../runner/runner-ports.js'
import { AGENT_RUNNER_STRUCTURED_OUTPUT_CAPABILITY_SCHEMA, AGENT_RUNNER_STRUCTURED_OUTPUT_EVIDENCE_SCHEMA, AGENT_RUNNER_STRUCTURED_OUTPUT_BLOCK_NAMESPACE } from '../runner/runner-ports.js'
import { AGENT_STRUCTURED_OUTPUT_REQUEST_SCHEMA, type AgentStructuredOutputRequest } from '@dzupagent/agent-types/run'
import { createReleaseAndReconcile, type ItemBudgetLifecycleDeps } from '../pipeline/loop-executor/for-each-item-budget-release.js'
import type { LoopBudgetReconcileOutcome } from '../pipeline/loop-executor/types.js'

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

test('graph restore binds normal, terminal and suspended outcomes to declared continuations', () => {
  const result = { nodeId: 'node', durationMs: 1, output: null }
  const completed: ScopedGraphCheckpointFrame = { completed: true, completedNodeIds: ['node'], nodeResults: { node: result }, nodeIdempotencyKeys: { node: 'key' }, outcome: { kind: 'normal', exitNodeId: 'node' } }
  expect(() => validateScopedGraphCheckpointFrame(definition, completed)).not.toThrow()
  for (const change of [{ outcome: null }, { outcome: { kind: 'normal', exitNodeId: '' } }, { nodeResults: {} }, { nodeResults: { node: { ...result, nodeId: 'foreign' } } }, { completedNodeIds: [] }, { nextNodeId: 'node' }, { forkState: { one: {}, two: {} } }, { forkState: { missing: { branches: {} } } }]) {
    expect(() => validateScopedGraphCheckpointFrame(definition, { ...completed, ...change } as ScopedGraphCheckpointFrame)).toThrow()
  }
  for (const change of [{ nodeIdempotencyKeys: { node: 'key' } }, { nodeResults: { node: result } }, { completedNodeIds: ['node'], nodeResults: { node: result } }]) {
    expect(() => validateScopedGraphCheckpointFrame(definition, { ...frame(), ...change } as ScopedGraphCheckpointFrame)).toThrow()
  }
  expect(() => validateScopedGraphCheckpointFrame({ ...definition, boundary: { ...definition.boundary, normalExitNodeIds: [] } }, { ...completed, outcome: undefined })).toThrow(/normal exit/)
  const terminalDefinition: ScopedGraphCheckpointDefinition = { ...definition, boundary: { ...definition.boundary, normalExitNodeIds: [], terminalExitNodeIds: ['node'], suspendedExitNodeIds: ['node'] }, nodes: [{ id: 'node', type: 'suspend', reason: 'fixture' } as never] }
  const terminal: ScopedGraphCheckpointFrame = { completed: true, completedNodeIds: [], nodeResults: {}, nodeIdempotencyKeys: {}, outcome: { kind: 'terminal', exitNodeId: 'node' } }
  expect(() => validateScopedGraphCheckpointFrame(terminalDefinition, terminal)).not.toThrow()
  expect(() => validateScopedGraphCheckpointFrame({ ...terminalDefinition, nodes: definition.nodes }, terminal)).toThrow(/suspend node/)
  const edge = { type: 'normal' as const, sourceNodeId: 'node', targetNodeId: 'node' }
  expect(() => validateScopedGraphCheckpointFrame({ ...terminalDefinition, outgoingEdges: new Map([['node', [edge]]]) }, terminal)).toThrow(/continuation/)
  const suspended: ScopedGraphCheckpointFrame = { ...terminal, completed: false, outcome: { kind: 'suspended', exitNodeId: 'node' } }
  expect(() => validateScopedGraphCheckpointFrame(terminalDefinition, suspended)).toThrow(/continuation/)
  expect(() => validateScopedGraphCheckpointFrame({ ...terminalDefinition, outgoingEdges: new Map([['node', [edge]]]) }, suspended)).not.toThrow()
  expect(() => validateScopedGraphCheckpointFrame({ ...terminalDefinition, outgoingEdges: new Map([['node', [edge, edge]]]) }, suspended)).toThrow(/multiple/)
  expect(() => validateScopedGraphCheckpointFrame(terminalDefinition, { ...suspended, completed: true })).toThrow(/completed=false/)
})

const modelRequest: AgentRunnerModelRequest = { runId: 'run', requestId: 'request', agentId: 'agent', turn: 1, attempt: 1, input: [], committedItems: [], tools: [{ toolId: 'lookup', toolRevision: 'v1', effectClass: 'read' }] }
const answer = { item: { type: 'message' as const, itemId: 'answer', role: 'assistant' as const, content: [] }, finishReason: 'stop' as const }
const model = (value: unknown): AgentRunnerModelPort => ({ adapterId: 'fixture', invoke: async () => value as AgentRunnerModelInvocationResult })
const structuredRequest = (): AgentStructuredOutputRequest => {
  const jsonSchema = { type: 'object' }
  return { schema: AGENT_STRUCTURED_OUTPUT_REQUEST_SCHEMA, schemaName: 'fixture', schemaDigest: digestRunnerJson(jsonSchema).slice(7, 23), jsonSchema, allowedStrategies: ['native-json-schema', 'json-text'], maxAttempts: 2 }
}

test('structured-output admission validates identity, strategy intersection and bounded attempts before model dispatch', () => {
  const request = structuredRequest()
  assertAgentRunnerStructuredOutputRequest(undefined)
  expect(selectAgentRunnerStructuredOutput(model(answer), undefined)).toBeUndefined()
  for (const change of [{ schema: 'foreign' }, { schemaName: ' ' }, { schemaDigest: 'foreign' }, { maxAttempts: 0 }, { maxAttempts: 11 }, { maxAttempts: 1.5 }, { allowedStrategies: [] }, { allowedStrategies: ['json-text', 'json-text'] }, { allowedStrategies: ['foreign'] }]) {
    expect(() => assertAgentRunnerStructuredOutputRequest({ ...request, ...change } as AgentStructuredOutputRequest)).toThrow()
  }
  for (const capability of [undefined, { schema: 'foreign', strategies: ['json-text'] }, { schema: AGENT_RUNNER_STRUCTURED_OUTPUT_CAPABILITY_SCHEMA, strategies: [] }]) {
    expect(() => selectAgentRunnerStructuredOutput({ ...model(answer), structuredOutputCapabilities: capability } as AgentRunnerModelPort, request)).toThrow(/unsupported/)
  }
  const supported = { ...model(answer), structuredOutputCapabilities: { schema: AGENT_RUNNER_STRUCTURED_OUTPUT_CAPABILITY_SCHEMA, strategies: ['json-text' as const] } }
  expect(selectAgentRunnerStructuredOutput(supported, request).selectedStrategy).toBe('json-text')
})

test('model failures retain dispatch certainty and reject contradictory retry or accounting evidence', async () => {
  const failure = { status: 'failed-before-dispatch', code: 'fixture-error', category: 'unavailable', retryClassification: 'retryable' }
  for (const change of [{ code: 'Bad code' }, { category: 'foreign' }, { retryClassification: 'foreign' }, { status: 'outcome-unknown' }, { retryClassification: 'reconciliation-required' }, { status: 'failed-after-dispatch', retryClassification: 'reconciliation-required' }, { structuredOutput: { failure: 'unsupported', attempts: 0 } }]) {
    await expect(invokeAgentRunnerModel(model({ ...failure, ...change }), modelRequest)).rejects.toThrow()
  }
  await expect(invokeAgentRunnerModel(model(failure), modelRequest)).rejects.toMatchObject({ failure })
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    await expect(invokeAgentRunnerModel(model({ ...answer, usage: { accountingSource: 'fixture', [field]: -1 } }), modelRequest)).rejects.toThrow(/usage/)
  }
  for (const usage of [{ accountingSource: '' }, { accountingSource: 'fixture', inputTokens: 2, outputTokens: 3, totalTokens: 4 }]) {
    await expect(invokeAgentRunnerModel(model({ ...answer, usage }), modelRequest)).rejects.toThrow(/usage/)
  }
})

test('model turns reject foreign calls, duplicate identities, wrong order and contradictory finish reasons', async () => {
  const call = { type: 'tool-call', itemId: 'call-item', callId: 'call', toolId: 'lookup', arguments: { query: 'fixture' } }
  const invalid = [
    { ...answer, status: 'foreign' }, { additionalItems: [] }, { ...answer, additionalItems: {} }, { ...answer, item: null }, { ...answer, item: { ...answer.item, itemId: ' ' } },
    { ...answer, additionalItems: [answer.item] }, { ...answer, item: { ...answer.item, role: 'user' } }, { ...answer, item: { ...answer.item, content: null } }, { ...answer, additionalItems: [{ ...answer.item, itemId: 'second' }] },
    { item: call, additionalItems: [answer.item], finishReason: 'tool-calls' }, { item: { ...call, type: 'foreign' } }, { item: { ...call, callId: '' } }, { item: { ...call, toolId: '' } }, { item: { ...call, toolId: 'foreign' } }, { item: call, additionalItems: [{ ...call, itemId: 'second' }] }, { item: call, finishReason: 'stop' }, { ...answer, finishReason: 'tool-calls' }, { ...answer, structuredOutput: {} },
  ]
  for (const result of invalid) await expect(invokeAgentRunnerModel(model(result), modelRequest), JSON.stringify(result)).rejects.toThrow()
  for (const tool of [{ toolId: '', toolRevision: 'v1', effectClass: 'read' }, { toolId: 'lookup', toolRevision: '', effectClass: 'read' }, { toolId: 'lookup', toolRevision: 'v1', effectClass: 'write' }]) {
    await expect(invokeAgentRunnerModel(model(answer), { ...modelRequest, tools: [tool] } as AgentRunnerModelRequest)).rejects.toThrow()
  }
  await expect(invokeAgentRunnerModel(model(answer), { ...modelRequest, tools: [...modelRequest.tools, ...modelRequest.tools] })).rejects.toThrow()
  await expect(invokeAgentRunnerModel(model(answer), { ...modelRequest, committedItems: [answer.item] })).rejects.toThrow()
  await expect(invokeAgentRunnerModel(model({ item: call }), { ...modelRequest, input: [call as never] })).rejects.toThrow()
  const result = await invokeAgentRunnerModel(model({ item: call, usage: { accountingSource: 'fixture', inputTokens: 2, outputTokens: 3, totalTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 1, reasoningTokens: 1 } }), modelRequest)
  const tool = { toolId: 'lookup', toolRevision: 'v1', effectClass: 'read' as const, execute: async () => ({ status: 'completed' as const, output: null }) }
  const prepared = prepareAgentRunnerModelTurn({ result, tools: new Map([['lookup', tool]]), createId: kind => kind + '-id', now: '2026-10-07T00:00:00.000Z' })
  expect(prepared.invocations[0]).toMatchObject({ invocationId: 'invocation-id', state: 'planned', effectClass: 'read' })
  expect(prepared.usage).toMatchObject({ totalTokens: 5, reasoningTokens: 1 })
  expect(() => prepareAgentRunnerModelTurn({ result, tools: new Map(), createId: kind => kind, now: 'fixture' })).toThrow(/unknown-tool/)
})

test('structured model evidence must bind the selected schema, attempts, fallback and returned value', async () => {
  const request = structuredRequest()
  const selection = { ...request, selectedStrategy: 'native-json-schema' as const, supportedStrategies: request.allowedStrategies }
  const invocation = { ...modelRequest, structuredOutput: selection }
  const evidence = { schema: AGENT_RUNNER_STRUCTURED_OUTPUT_EVIDENCE_SCHEMA, schemaName: request.schemaName, schemaDigest: request.schemaDigest, strategy: 'native-json-schema', attempts: 1, value: { ok: true } }
  const result = { ...answer, item: { ...answer.item, content: [{ type: 'extension', namespace: AGENT_RUNNER_STRUCTURED_OUTPUT_BLOCK_NAMESPACE, value: evidence.value }] }, structuredOutput: evidence }
  await expect(invokeAgentRunnerModel(model(result), invocation)).resolves.toEqual(result)
  for (const change of [{ schema: 'foreign' }, { schemaName: 'foreign' }, { schemaDigest: 'foreign' }, { attempts: 0 }, { attempts: 3 }, { attempts: 1.5 }, { strategy: 'foreign' }, { fallbackFrom: 'json-text' }, { strategy: 'json-text' }, { fallbackFrom: 'native-json-schema' }]) {
    await expect(invokeAgentRunnerModel(model({ ...result, structuredOutput: { ...evidence, ...change } }), invocation)).rejects.toThrow()
  }
  for (const change of [{ structuredOutput: undefined }, { finishReason: 'length' }, { item: { ...result.item, content: [] } }, { item: { ...result.item, content: [{ type: 'text', text: 'fixture' }] } }, { item: { ...result.item, content: [{ type: 'extension', namespace: 'foreign', value: evidence.value }] } }, { structuredOutput: { ...evidence, value: { ok: false } } }]) {
    await expect(invokeAgentRunnerModel(model({ ...result, ...change }), invocation)).rejects.toThrow()
  }
  const fallback = { ...result, structuredOutput: { ...evidence, strategy: 'json-text', fallbackFrom: 'native-json-schema' } }
  await expect(invokeAgentRunnerModel(model(fallback), invocation)).resolves.toEqual(fallback)
  for (const extra of [{}, { structuredOutput: { ...evidence, failure: 'unsupported', attempts: 1 } }]) {
    await expect(invokeAgentRunnerModel(model({ status: 'failed-after-dispatch', code: 'fixture-error', category: 'unavailable', retryClassification: 'retryable', ...extra }), invocation)).rejects.toThrow()
  }
})

test('budget recovery preserves unknown outcomes and only retries an authoritatively retained reservation', async () => {
  const held = { itemIndex: 0, attempt: 1, reservationId: 'fixture', reservedCostCents: 10 }
  const deps: ItemBudgetLifecycleDeps = { loopNode: { id: 'loop', type: 'loop', bodyNodeIds: [], maxIterations: 1, continuePredicateName: 'fixture' }, bodyNodes: [], itemBudgetCents: 10, resume: undefined }
  const absentHost = createReleaseAndReconcile(deps)
  expect(await absentHost.releaseItem(undefined, 'failed')).toBeUndefined()
  expect(await absentHost.reconcileUnknownReservation(0, 0, 'transport', 'reserve')).toMatchObject({ status: 'blocked' })
  const outcomes: LoopBudgetReconcileOutcome[] = [{ status: 'unknown' }, { status: 'conflict', heldBy: 'another-writer' }, { status: 'absent' }, { status: 'released' }, { status: 'reserved', reservedCostCents: 11 }, { status: 'reserved', reservedCostCents: 10 }, { status: 'settled', cost: { status: 'unknown' } }, { status: 'settled', cost: { status: 'known', costCents: -1 } }, { status: 'settled', cost: { status: 'known', costCents: 5 } }, { status: 'settled', cost: { status: 'known', costCents: 11 } }]
  for (const outcome of outcomes) {
    let released = 0
    let settled = 0
    const lifecycle = createReleaseAndReconcile({ ...deps, resume: { releaseIterationBudget: async () => { released++ }, settleIterationBudget: async () => { settled++ }, reconcileIterationBudget: async () => outcome } })
    const release = await lifecycle.resolveUnknownRelease(held, 'aborted', 'transport')
    const settlement = await lifecycle.resolveUnknownSettlement(held, 5, 'transport')
    if (outcome.status === 'absent' || outcome.status === 'released') {
      expect(release.status).toBe('released')
      expect(settlement.status).toBe('blocked')
    } else if (outcome.status === 'reserved' && outcome.reservedCostCents === 10) {
      expect(release.status).toBe('released')
      expect(settlement.status).toBe('settled')
      expect([released, settled]).toEqual([1, 1])
    } else if (outcome.status === 'settled' && outcome.cost.status === 'known' && outcome.cost.costCents >= 0) {
      expect(release.status).toBe('settled')
      expect(settlement).toMatchObject({ status: 'settled', settledCostCents: outcome.cost.costCents })
      if (outcome.cost.costCents > 10) expect(settlement).toHaveProperty('overrun')
    } else {
      expect(release.status).toBe('blocked')
      expect(settlement.status).toBe('blocked')
    }
    if (outcome.status !== 'reserved' || outcome.reservedCostCents !== 10) expect([released, settled]).toEqual([0, 0])
  }
  for (const thrown of [new Error('fixture transport'), 'fixture transport']) {
    const lifecycle = createReleaseAndReconcile({ ...deps, resume: { releaseIterationBudget: async () => { throw thrown }, settleIterationBudget: async () => { throw thrown }, reconcileIterationBudget: async () => { throw thrown } } })
    expect(await lifecycle.releaseItem(held, 'failed')).toEqual({ outcomeUnknown: 'fixture transport' })
    expect(await lifecycle.resolveUnknownRelease(held, 'failed', 'transport')).toMatchObject({ status: 'blocked' })
  }
  const retrying = createReleaseAndReconcile({ ...deps, resume: { releaseIterationBudget: async () => { throw new Error('uncertain') }, settleIterationBudget: async () => { throw new Error('uncertain') }, reconcileIterationBudget: async () => ({ status: 'reserved', reservedCostCents: 10 }) } })
  expect(await retrying.resolveUnknownRelease(held, 'failed', 'transport')).toMatchObject({ status: 'blocked' })
  expect(await retrying.resolveUnknownSettlement(held, 5, 'transport')).toMatchObject({ status: 'blocked' })
})
