import { describe, expect, it } from 'vitest'
import { assertAgentRunnerStructuredOutputRequest, selectAgentRunnerStructuredOutput, invokeAgentRunnerModel, prepareAgentRunnerModelTurn } from '../model-port-values.js'
import { digestRunnerJson } from '../runner-durable-json.js'
import type { AgentRunnerModelRequest, AgentRunnerModelInvocationResult, AgentRunnerModelPort } from '../runner-ports.js'
import { AGENT_RUNNER_STRUCTURED_OUTPUT_CAPABILITY_SCHEMA, AGENT_RUNNER_STRUCTURED_OUTPUT_EVIDENCE_SCHEMA, AGENT_RUNNER_STRUCTURED_OUTPUT_BLOCK_NAMESPACE } from '../runner-ports.js'
import { AGENT_STRUCTURED_OUTPUT_REQUEST_SCHEMA, type AgentStructuredOutputRequest } from '@dzupagent/agent-types/run'

const modelRequest: AgentRunnerModelRequest = { runId: 'run', requestId: 'request', agentId: 'agent', turn: 1, attempt: 1, input: [], committedItems: [], tools: [{ toolId: 'lookup', toolRevision: 'v1', effectClass: 'read' }] }
const answer = { item: { type: 'message' as const, itemId: 'answer', role: 'assistant' as const, content: [] }, finishReason: 'stop' as const }
const model = (value: unknown): AgentRunnerModelPort => ({ adapterId: 'fixture', invoke: async () => value as AgentRunnerModelInvocationResult })
const structuredRequest = (): AgentStructuredOutputRequest => {
  const jsonSchema = { type: 'object' }
  return { schema: AGENT_STRUCTURED_OUTPUT_REQUEST_SCHEMA, schemaName: 'fixture', schemaDigest: digestRunnerJson(jsonSchema).slice(7, 23), jsonSchema, allowedStrategies: ['native-json-schema', 'json-text'], maxAttempts: 2 }
}

describe('structured-output admission', () => {
  it('validates identity, strategy intersection and bounded attempts before model dispatch', () => {
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
})

describe('invokeAgentRunnerModel and prepareAgentRunnerModelTurn', () => {
  it('retains dispatch certainty on model failures and reject contradictory retry or accounting evidence', async () => {
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

  const call = { type: 'tool-call', itemId: 'call-item', callId: 'call', toolId: 'lookup', arguments: { query: 'fixture' } }

  it('rejects foreign calls, duplicate identities, wrong order and contradictory finish reasons', async () => {
    const invalid = [
      { ...answer, status: 'foreign' }, { additionalItems: [] }, { ...answer, additionalItems: {} }, { ...answer, item: null }, { ...answer, item: { ...answer.item, itemId: ' ' } },
      { ...answer, additionalItems: [answer.item] }, { ...answer, item: { ...answer.item, role: 'user' } }, { ...answer, item: { ...answer.item, content: null } }, { ...answer, additionalItems: [{ ...answer.item, itemId: 'second' }] },
      { item: call, additionalItems: [answer.item], finishReason: 'tool-calls' }, { item: { ...call, type: 'foreign' } }, { item: { ...call, callId: '' } }, { item: { ...call, toolId: '' } }, { item: { ...call, toolId: 'foreign' } }, { item: call, additionalItems: [{ ...call, itemId: 'second' }] }, { item: call, finishReason: 'stop' }, { ...answer, finishReason: 'tool-calls' }, { ...answer, structuredOutput: {} },
    ]
    for (const result of invalid) await expect(invokeAgentRunnerModel(model(result), modelRequest), JSON.stringify(result)).rejects.toThrow()
  })

  it('refuses malformed or duplicate tool declarations and replayed input items', async () => {
    for (const tool of [{ toolId: '', toolRevision: 'v1', effectClass: 'read' }, { toolId: 'lookup', toolRevision: '', effectClass: 'read' }, { toolId: 'lookup', toolRevision: 'v1', effectClass: 'write' }]) {
      await expect(invokeAgentRunnerModel(model(answer), { ...modelRequest, tools: [tool] } as AgentRunnerModelRequest)).rejects.toThrow()
    }
    await expect(invokeAgentRunnerModel(model(answer), { ...modelRequest, tools: [...modelRequest.tools, ...modelRequest.tools] })).rejects.toThrow()
    await expect(invokeAgentRunnerModel(model(answer), { ...modelRequest, committedItems: [answer.item] })).rejects.toThrow()
    await expect(invokeAgentRunnerModel(model({ item: call }), { ...modelRequest, input: [call as never] })).rejects.toThrow()
  })

  it('prepares planned tool invocations and usage from a valid tool-call turn', async () => {
    const result = await invokeAgentRunnerModel(model({ item: call, usage: { accountingSource: 'fixture', inputTokens: 2, outputTokens: 3, totalTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 1, reasoningTokens: 1 } }), modelRequest)
    const tool = { toolId: 'lookup', toolRevision: 'v1', effectClass: 'read' as const, execute: async () => ({ status: 'completed' as const, output: null }) }
    const prepared = prepareAgentRunnerModelTurn({ result, tools: new Map([['lookup', tool]]), createId: kind => kind + '-id', now: '2026-10-07T00:00:00.000Z' })
    expect(prepared.invocations[0]).toMatchObject({ invocationId: 'invocation-id', state: 'planned', effectClass: 'read' })
    expect(prepared.usage).toMatchObject({ totalTokens: 5, reasoningTokens: 1 })
    expect(() => prepareAgentRunnerModelTurn({ result, tools: new Map(), createId: kind => kind, now: 'fixture' })).toThrow(/unknown-tool/)
  })

  it('requires structured evidence to bind the selected schema, attempts, fallback and returned value', async () => {
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
})
