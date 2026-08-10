import { AIMessage } from '@langchain/core/messages'
import type { AgentItem } from '@dzupagent/agent-types/run'
import {
  InMemoryAgentRunner,
  InMemoryAgentRunnerPersistence,
  RunControl,
  type AgentRunnerIdentityKind,
  type AgentRunnerInput,
  type AgentRunnerModelInvocationResult,
  type AgentRunnerModelPort,
  type AgentRunnerModelRequest,
} from '@dzupagent/agent/runner'
import { describe, expect, it } from 'vitest'

import {
  agentRunnerItemsToLangChainMessages,
  langChainMessageToAgentRunnerModelResult,
  normalizeAgentRunnerProviderFailure,
} from '../integration/agent-runner-langchain-conversion.js'
import {
  ProviderFreeAgentRunnerModelAdapter,
  ProviderFreeAgentRunnerReadToolAdapter,
  type ProviderFreeAgentRunnerModelState,
  type ProviderFreeAgentRunnerReadToolState,
} from '../integration/agent-runner-provider-free.js'

const request: AgentRunnerModelRequest = {
  runId: 'run-1',
  requestId: 'request-1',
  attempt: 2,
  turn: 3,
  agentId: 'agent-1',
  input: [],
  committedItems: [],
  tools: [{
    toolId: 'read-record',
    toolRevision: '7',
    effectClass: 'read',
    description: 'Read one record',
    inputSchema: { type: 'object' },
  }],
}

const input: AgentRunnerInput = {
  agentId: 'agent-1',
  behaviorDigest: 'sha256:provider-free-r5g',
  items: [{
    type: 'message',
    itemId: 'input-1',
    role: 'user',
    content: [{ type: 'text', text: 'Read the deterministic fixture.' }],
  }],
}

function deterministicIds(): (kind: AgentRunnerIdentityKind) => string {
  const counters = new Map<AgentRunnerIdentityKind, number>()
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1
    counters.set(kind, next)
    return `${kind}-${next}`
  }
}

function modelState(
  steps: ProviderFreeAgentRunnerModelState['steps'],
  cursor = 0,
): ProviderFreeAgentRunnerModelState {
  return { schema: 'dzupagent.providerFreeAgentRunnerModel/v1', cursor, steps }
}

function toolState(
  steps: ProviderFreeAgentRunnerReadToolState['steps'],
): ProviderFreeAgentRunnerReadToolState {
  return { schema: 'dzupagent.providerFreeAgentRunnerReadTool/v1', cursor: 0, steps }
}

function createRunner(
  model: ProviderFreeAgentRunnerModelAdapter,
  tool: ProviderFreeAgentRunnerReadToolAdapter,
) {
  return new InMemoryAgentRunner({
    model,
    tools: [tool],
    persistence: new InMemoryAgentRunnerPersistence(),
    createId: deterministicIds(),
    now: () => '2026-08-09T22:00:00.000Z',
  })
}

describe('AgentRunner loss-aware LangChain conversion', () => {
  it('converts canonical roles and ordered supported blocks deterministically', () => {
    const items: AgentItem[] = [
      { type: 'message', itemId: 'system-1', role: 'system', content: [{ type: 'text', text: 'System' }] },
      {
        type: 'message',
        itemId: 'user-1',
        role: 'user',
        content: [{ type: 'text', text: 'First' }, { type: 'text', text: 'Second' }],
      },
      {
        type: 'message',
        itemId: 'assistant-1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Answer' },
          { type: 'reasoning-summary', text: 'Summary' },
        ],
      },
      {
        type: 'message',
        itemId: 'developer-1',
        role: 'developer',
        content: [{ type: 'text', text: 'Developer' }],
      },
    ]

    const first = agentRunnerItemsToLangChainMessages(items)
    const second = agentRunnerItemsToLangChainMessages(JSON.parse(JSON.stringify(items)))
    expect(first.status).toBe('converted')
    expect(second.status).toBe('converted')
    if (first.status !== 'converted' || second.status !== 'converted') return
    expect(first.losses).toEqual([])
    expect(first.value.map((message) => message.toDict())).toEqual(
      second.value.map((message) => message.toDict()),
    )
    expect(first.value.map((message) => message.type)).toEqual(['system', 'human', 'ai', 'generic'])
    expect(first.value[1]?.content).toEqual([
      { type: 'text', text: 'First' },
      { type: 'text', text: 'Second' },
    ])
  })

  it('retains multiple tool call IDs, names, exact arguments, order, and result linkage', () => {
    const items: AgentItem[] = [
      { type: 'message', itemId: 'assistant-1', role: 'assistant', content: [] },
      {
        type: 'tool-call',
        itemId: 'tool-call-1',
        callId: 'call-a',
        toolId: 'alpha',
        arguments: { nested: { value: 1 }, enabled: true },
      },
      {
        type: 'tool-call',
        itemId: 'tool-call-2',
        callId: 'call-b',
        toolId: 'beta',
        arguments: { values: [1, 2, 3] },
      },
      { type: 'tool-result', itemId: 'result-a', callId: 'call-a', output: { value: 'a' }, isError: false },
      { type: 'tool-result', itemId: 'result-b', callId: 'call-b', output: { code: 'b' }, isError: true },
    ]

    const result = agentRunnerItemsToLangChainMessages(items)
    expect(result.status).toBe('converted')
    if (result.status !== 'converted') return
    const assistant = result.value[0]
    expect(AIMessage.isInstance(assistant) ? assistant.tool_calls : undefined).toEqual([
      { id: 'call-a', name: 'alpha', args: { nested: { value: 1 }, enabled: true } },
      { id: 'call-b', name: 'beta', args: { values: [1, 2, 3] } },
    ])
    expect(result.value.slice(1).map((message) => ({
      callId: 'tool_call_id' in message ? message.tool_call_id : undefined,
      content: JSON.parse(String(message.content)),
      status: 'status' in message ? message.status : undefined,
    }))).toEqual([
      { callId: 'call-a', content: { value: 'a' }, status: 'success' },
      { callId: 'call-b', content: { code: 'b' }, status: 'error' },
    ])
  })

  it('fails closed for missing, duplicate, and malformed tool call linkage', () => {
    expect(agentRunnerItemsToLangChainMessages([
      { type: 'tool-result', itemId: 'result', callId: 'missing', output: null, isError: false },
    ])).toMatchObject({ status: 'rejected', issues: [{ code: 'missing-tool-call-id' }] })
    expect(agentRunnerItemsToLangChainMessages([
      { type: 'tool-call', itemId: 'one', callId: 'duplicate', toolId: 'a', arguments: {} },
      { type: 'tool-call', itemId: 'two', callId: 'duplicate', toolId: 'b', arguments: {} },
    ])).toMatchObject({ status: 'rejected', issues: [{ code: 'duplicate-tool-call-id' }] })
    expect(agentRunnerItemsToLangChainMessages([
      { type: 'tool-call', itemId: 'bad', callId: 'call', toolId: 'a', arguments: 'not-an-object' },
    ])).toMatchObject({ status: 'rejected', issues: [{ code: 'invalid-tool-arguments' }] })
    expect(agentRunnerItemsToLangChainMessages([
      { type: 'tool-call', itemId: 'call', callId: 'once', toolId: 'a', arguments: {} },
      { type: 'tool-result', itemId: 'result-1', callId: 'once', output: 1, isError: false },
      { type: 'tool-result', itemId: 'result-2', callId: 'once', output: 2, isError: false },
    ])).toMatchObject({ status: 'rejected', issues: [{ code: 'duplicate-tool-result' }] })
  })

  it('converts an assistant turn with multiple calls, usage, and finish reason', () => {
    const message = new AIMessage({
      content: [
        { type: 'text', text: 'Calling tools' },
        { type: 'reasoning', reasoning: 'Two independent reads' },
      ],
      tool_calls: [
        { id: 'call-a', name: 'alpha', args: { query: 'a' } },
        { id: 'call-b', name: 'beta', args: { query: 'b' } },
      ],
      usage_metadata: {
        input_tokens: 17,
        output_tokens: 9,
        total_tokens: 26,
        input_token_details: { cache_read: 5, cache_creation: 2 },
        output_token_details: { reasoning: 4 },
      },
      response_metadata: { finish_reason: 'tool_calls' },
    })

    const result = langChainMessageToAgentRunnerModelResult(message, {
      itemIdPrefix: 'turn-1',
      accountingSource: 'provider-free',
    })
    expect(result).toEqual({
      status: 'converted',
      losses: [],
      value: {
        status: 'completed',
        item: {
          type: 'message',
          itemId: 'turn-1-message',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Calling tools' },
            { type: 'reasoning-summary', text: 'Two independent reads' },
          ],
        },
        additionalItems: [
          { type: 'tool-call', itemId: 'turn-1-tool-call-1', callId: 'call-a', toolId: 'alpha', arguments: { query: 'a' } },
          { type: 'tool-call', itemId: 'turn-1-tool-call-2', callId: 'call-b', toolId: 'beta', arguments: { query: 'b' } },
        ],
        usage: {
          accountingSource: 'provider-free',
          inputTokens: 17,
          outputTokens: 9,
          totalTokens: 26,
          cacheReadTokens: 5,
          cacheWriteTokens: 2,
          reasoningTokens: 4,
        },
        finishReason: 'tool-calls',
      },
    })
  })

  it('returns explicit rejection for unsupported content and malformed calls', () => {
    const unsupported = new AIMessage({ content: [{ type: 'image', url: 'https://invalid.local/image' }] })
    expect(langChainMessageToAgentRunnerModelResult(unsupported, {
      itemIdPrefix: 'turn', accountingSource: 'fake',
    })).toMatchObject({ status: 'rejected', issues: [{ code: 'unsupported-content' }] })

    const missingId = new AIMessage({ content: [], tool_calls: [{ name: 'tool', args: {} }] })
    expect(langChainMessageToAgentRunnerModelResult(missingId, {
      itemIdPrefix: 'turn', accountingSource: 'fake',
    })).toMatchObject({ status: 'rejected', issues: [{ code: 'missing-tool-call-id' }] })

    const duplicate = new AIMessage({
      content: [],
      tool_calls: [
        { id: 'same', name: 'one', args: {} },
        { id: 'same', name: 'two', args: {} },
      ],
    })
    expect(langChainMessageToAgentRunnerModelResult(duplicate, {
      itemIdPrefix: 'turn', accountingSource: 'fake',
    })).toMatchObject({ status: 'rejected', issues: [{ code: 'duplicate-tool-call-id' }] })
  })

  it('omits provider-only metadata with typed loss evidence and no retained values', () => {
    const message = new AIMessage({
      id: 'provider-message-id',
      content: [{ type: 'text', text: 'safe' }],
      additional_kwargs: { vendorEnvelope: { opaque: 'discarded-value' } },
      response_metadata: { finish_reason: 'stop', vendorTrace: 'discarded-trace' },
    })
    const result = langChainMessageToAgentRunnerModelResult(message, {
      itemIdPrefix: 'host-turn', accountingSource: 'fake',
    })
    expect(result.status).toBe('converted')
    if (result.status !== 'converted') return
    expect(result.losses).toEqual([
      { code: 'provider-message-id-omitted', path: 'message.id' },
      { code: 'provider-metadata-omitted', path: 'message.additional_kwargs', omittedCount: 1 },
      { code: 'provider-metadata-omitted', path: 'message.response_metadata', omittedCount: 1 },
    ])
    expect(JSON.stringify(result.value)).not.toContain('provider-message-id')
    expect(JSON.stringify(result.value)).not.toContain('discarded-value')
    expect(JSON.stringify(result.value)).not.toContain('discarded-trace')
  })

  it('maps measured usage exactly and rejects non-finite or inconsistent totals', () => {
    for (const usage of [
      { input_tokens: Number.NaN, output_tokens: 1, total_tokens: 1 },
      { input_tokens: 1, output_tokens: 2, total_tokens: 4 },
    ]) {
      const result = langChainMessageToAgentRunnerModelResult(new AIMessage({
        content: 'bad usage', usage_metadata: usage,
      }), { itemIdPrefix: 'turn', accountingSource: 'fake' })
      expect(result).toMatchObject({ status: 'rejected', issues: [{ code: 'invalid-usage' }] })
    }
  })

  it('keeps finish reasons and normalized error/retry classes distinct', () => {
    const length = langChainMessageToAgentRunnerModelResult(new AIMessage({
      content: 'partial', response_metadata: { stop_reason: 'max_tokens' },
    }), { itemIdPrefix: 'turn', accountingSource: 'fake' })
    expect(length).toMatchObject({ status: 'converted', value: { finishReason: 'length' } })
    expect(langChainMessageToAgentRunnerModelResult(new AIMessage({
      content: 'unknown reason', response_metadata: { finish_reason: 'vendor_magic' },
    }), { itemIdPrefix: 'turn', accountingSource: 'fake' })).toMatchObject({
      status: 'rejected', issues: [{ code: 'invalid-finish-reason' }],
    })
    expect(normalizeAgentRunnerProviderFailure({ statusCode: 429 }, 'before-dispatch')).toEqual({
      status: 'failed-before-dispatch',
      code: 'provider-rate-limit-before-dispatch',
      category: 'rate-limit',
      retryClassification: 'retryable',
    })
    expect(normalizeAgentRunnerProviderFailure({ statusCode: 429 }, 'possible-dispatch')).toEqual({
      status: 'outcome-unknown',
      code: 'provider-outcome-unknown',
      category: 'rate-limit',
      retryClassification: 'reconciliation-required',
    })
    expect(normalizeAgentRunnerProviderFailure({ name: 'AuthorizationError' }, 'before-dispatch')).toMatchObject({
      category: 'authorization',
    })
  })

  it('preserves valid partial canonical usage instead of silently dropping it', async () => {
    const model = new ProviderFreeAgentRunnerModelAdapter(modelState([{
      status: 'completed',
      content: [{ type: 'text', text: 'partial accounting' }],
      usage: { accountingSource: 'provider-free', inputTokens: 7, cacheReadTokens: 3 },
      finishReason: 'stop',
    }]))
    await expect(model.invoke(request)).resolves.toMatchObject({
      status: 'completed',
      usage: { accountingSource: 'provider-free', inputTokens: 7, cacheReadTokens: 3 },
    })

    const invalid = new ProviderFreeAgentRunnerModelAdapter(modelState([{
      status: 'completed',
      content: [{ type: 'text', text: 'invalid accounting' }],
      usage: { accountingSource: 'provider-free', inputTokens: -1 },
      finishReason: 'stop',
    }]))
    await expect(invalid.invoke(request)).rejects.toThrow('Provider-free model usage is invalid')
  })

  it('round-trips canonical model results and reconstructs the fake without identity drift', async () => {
    const state = modelState([
      {
        status: 'completed',
        content: [],
        toolCalls: [
          { callId: 'call-a', toolId: 'alpha', arguments: { exact: 1 } },
          { callId: 'call-b', toolId: 'beta', arguments: { exact: 2 } },
        ],
        usage: { accountingSource: 'fake', inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        finishReason: 'tool-calls',
      },
      { status: 'completed', content: [{ type: 'text', text: 'done' }], finishReason: 'stop' },
    ])
    const firstAdapter = new ProviderFreeAgentRunnerModelAdapter(state)
    const first = await firstAdapter.invoke(request)
    expect(JSON.parse(JSON.stringify(first))).toEqual(first)

    const snapshot = JSON.parse(JSON.stringify(firstAdapter.snapshot()))
    const reconstructed = new ProviderFreeAgentRunnerModelAdapter(snapshot)
    const second = await reconstructed.invoke({ ...request, requestId: 'request-2', turn: 4 })
    expect(second).toMatchObject({
      status: 'completed',
      item: { type: 'message', content: [{ type: 'text', text: 'done' }] },
      finishReason: 'stop',
    })
    expect(reconstructed.invocations).toEqual([{
      runId: 'run-1', requestId: 'request-2', attempt: 2, turn: 4, agentId: 'agent-1', toolCount: 1,
    }])
  })

  it('allows a caller to retry a runner after an explicitly undispatched model failure', async () => {
    const model = new ProviderFreeAgentRunnerModelAdapter(modelState([
      {
        status: 'failed-before-dispatch',
        code: 'provider-timeout-before-dispatch',
        category: 'timeout',
        retryClassification: 'retryable',
      },
      { status: 'completed', content: [{ type: 'text', text: 'retried' }], finishReason: 'stop' },
    ]))
    const runner = createRunner(
      model,
      new ProviderFreeAgentRunnerReadToolAdapter('read-record', '7', toolState([])),
    )
    const first = await runner.run(input)
    expect(first.state.status).toBe('failed')
    expect(first.events).toContainEqual(expect.objectContaining({
      type: 'model.failed',
      payload: expect.objectContaining({
        outcome: 'failed-before-dispatch', retryClassification: 'retryable',
      }),
    }))
    await expect(runner.run(input)).resolves.toMatchObject({
      state: { status: 'completed' },
    })
    expect(model.invocations).toHaveLength(2)
  })

  it('rejects malformed model failure enums before they enter durable runner events', async () => {
    const malformed = {
      status: 'failed-before-dispatch',
      code: 'provider-invalid-enums',
      category: 'vendor-magic',
      retryClassification: 'try-later',
    } as unknown as AgentRunnerModelInvocationResult
    const model: AgentRunnerModelPort = {
      adapterId: 'malformed-provider-free-model/v1',
      invoke: async () => malformed,
    }
    const result = await new InMemoryAgentRunner({
      model,
      persistence: new InMemoryAgentRunnerPersistence(),
      createId: deterministicIds(),
      now: () => '2026-08-09T22:00:00.000Z',
    }).run(input)
    expect(result.state.status).toBe('failed')
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'model.failed',
      payload: expect.objectContaining({
        code: 'model-invocation-failed',
        category: 'unknown',
        outcome: 'outcome-unknown',
        retryClassification: 'reconciliation-required',
      }),
    }))
    expect(JSON.stringify(result.events)).not.toContain('vendor-magic')
    expect(JSON.stringify(result.events)).not.toContain('try-later')
  })

  it('retries only failed-before-effect read tools and never replays an unknown outcome', async () => {
    const modelSteps: ProviderFreeAgentRunnerModelState['steps'] = [
      {
        status: 'completed',
        content: [],
        toolCalls: [{ callId: 'call-read', toolId: 'read-record', arguments: { id: 'record-1' } }],
        finishReason: 'tool-calls',
      },
      { status: 'completed', content: [{ type: 'text', text: 'complete' }], finishReason: 'stop' },
    ]
    const retryTool = new ProviderFreeAgentRunnerReadToolAdapter(
      'read-record',
      '7',
      toolState([
        { status: 'failed-before-effect', code: 'fixture-not-ready', retryable: true },
        { status: 'completed', output: { value: 'record-1' } },
      ]),
    )
    const retried = await createRunner(
      new ProviderFreeAgentRunnerModelAdapter(modelState(modelSteps)),
      retryTool,
    ).run(input)
    expect(retried.state.status).toBe('completed')
    expect(retryTool.invocations).toBe(2)
    expect(retried.state.invocations).toMatchObject([{ attempt: 2, state: 'completed' }])

    const unknownTool = new ProviderFreeAgentRunnerReadToolAdapter(
      'read-record', '7', toolState([{ status: 'outcome-unknown' }]),
    )
    const unknown = await createRunner(
      new ProviderFreeAgentRunnerModelAdapter(modelState(modelSteps)),
      unknownTool,
    ).run(input)
    expect(unknown.state.status).toBe('failed')
    expect(unknownTool.invocations).toBe(1)
    expect(unknown.state.invocations).toMatchObject([{ attempt: 1, state: 'effect-unknown' }])
  })

  it('observes cancellation at the existing pre-dispatch safe point without claiming provider abort', async () => {
    const model = new ProviderFreeAgentRunnerModelAdapter(modelState([
      { status: 'completed', content: [{ type: 'text', text: 'must not dispatch' }], finishReason: 'stop' },
    ]))
    const tool = new ProviderFreeAgentRunnerReadToolAdapter('read-record', '7', toolState([]))
    const control = new RunControl()
    const acknowledgement = control.requestCancel()
    if (!acknowledgement.accepted) throw new Error('Expected accepted cancellation')
    const result = await createRunner(model, tool).run(input, { control })
    expect(result.state.status).toBe('cancelled')
    expect(model.invocations).toEqual([])
    expect(tool.invocations).toBe(0)
    await expect(control.waitForObservation(acknowledgement.requestId)).resolves.toMatchObject({
      kind: 'cancel', safePoint: 'before-model-dispatch',
    })
  })

  it('classifies possible model dispatch as unknown and does not retry it', async () => {
    const model = new ProviderFreeAgentRunnerModelAdapter(modelState([
      {
        status: 'outcome-unknown',
        code: 'provider-outcome-unknown',
        category: 'timeout',
        retryClassification: 'reconciliation-required',
      },
      { status: 'completed', content: [{ type: 'text', text: 'must not replay' }], finishReason: 'stop' },
    ]))
    const result = await createRunner(
      model,
      new ProviderFreeAgentRunnerReadToolAdapter('read-record', '7', toolState([])),
    ).run(input)
    expect(result.state.status).toBe('failed')
    expect(model.invocations).toHaveLength(1)
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'model.failed',
      payload: expect.objectContaining({
        outcome: 'outcome-unknown', retryClassification: 'reconciliation-required',
      }),
    }))
  })

  it('fails the current scheduler closed instead of dropping additional model items', async () => {
    const model = new ProviderFreeAgentRunnerModelAdapter(modelState([{
      status: 'completed',
      content: [],
      toolCalls: [
        { callId: 'call-a', toolId: 'read-record', arguments: { id: 'a' } },
        { callId: 'call-b', toolId: 'read-record', arguments: { id: 'b' } },
      ],
      finishReason: 'tool-calls',
    }]))
    const tool = new ProviderFreeAgentRunnerReadToolAdapter('read-record', '7', toolState([]))
    const result = await createRunner(model, tool).run(input)
    expect(result.state.status).toBe('failed')
    expect(tool.invocations).toBe(0)
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'model.failed',
      payload: expect.objectContaining({ code: 'model-multiple-items-not-admitted' }),
    }))
  })
})
