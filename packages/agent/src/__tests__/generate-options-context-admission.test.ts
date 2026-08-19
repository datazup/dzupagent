import { describe, expect, it, vi } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import {
  InMemoryRunStateStore,
  type DzupEvent,
  type RunJournalEntry,
} from '@dzupagent/core'
import { createEventBus } from '@dzupagent/core/events'
import { z } from 'zod'
import { DzupAgent } from '../agent/dzip-agent.js'
import type {
  AgentStreamEvent,
  DzupAgentConfig,
  GenerateOptions,
} from '../agent/agent-types.js'
import { estimateConversationTokensForMessages } from '../agent/message-utils.js'
import { prepareRunState } from '../agent/run-engine.js'
import { RuntimeHardBudgetAdoptionError } from '../agent/runtime-hard-budget.js'
import type { AgentLoopPlugin } from '../token-lifecycle-wiring.js'

const CONTEXT = 'CONTEXT_SENTINEL preserve\n  spacing  '
const Schema = z.object({ name: z.string() })

function exactContextCount(messages: readonly BaseMessage[], context = CONTEXT): number {
  return messages.filter(
    message => {
      if (message._getType() !== 'system') return false
      if (message.content === context) return true
      const block = Array.isArray(message.content) && message.content.length === 1
        ? message.content[0]
        : undefined
      return (
        typeof block === 'object'
        && block !== null
        && 'text' in block
        && block.text === context
      )
    },
  ).length
}

function hasCacheControl(messages: readonly BaseMessage[]): boolean {
  return messages.some(message => (
    message.additional_kwargs as { cache_control?: unknown }
  ).cache_control !== undefined)
}

function makeInvokeModel(responses: AIMessage[]) {
  const received: BaseMessage[][] = []
  let responseIndex = 0
  const model = {
    invoke: vi.fn(async (messages: BaseMessage[]) => {
      received.push([...messages])
      const response = responses[responseIndex] ?? responses.at(-1) ?? new AIMessage('done')
      responseIndex += 1
      return response
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'context-admission',
  } as unknown as BaseChatModel
  return { model, received }
}

function makeStreamModel() {
  const received: BaseMessage[][] = []
  const model = {
    invoke: vi.fn(async () => new AIMessage('fallback')),
    stream: vi.fn(async (messages: BaseMessage[]) => {
      received.push([...messages])
      return (async function* () {
        yield new AIMessage('streamed')
      })()
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    model: 'context-stream-model',
    _modelType: () => 'base_chat_model',
    _llmType: () => 'context-admission',
  } as unknown as BaseChatModel
  return { model, received }
}

function aiWithToolCall(name: string): AIMessage {
  const message = new AIMessage({ content: '' })
  const withToolCalls = message as AIMessage & { tool_calls: unknown[] }
  withToolCalls.tool_calls = [
    { id: 'context-call-0', name, args: {} },
  ]
  return message
}

function makeTool(name: string) {
  return {
    name,
    description: `Mock ${name}`,
    schema: { type: 'object', properties: {} } as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => 'tool-result'),
  } as never
}

function makeCompressingPlugin(): AgentLoopPlugin {
  let calls = 0
  return {
    onUsage: vi.fn(),
    trackPhase: vi.fn(),
    maybeCompress: vi.fn(async (messages: BaseMessage[]) => {
      calls += 1
      if (calls === 1) {
        return {
          messages: [new SystemMessage('compacted transcript')],
          summary: 'compacted transcript',
          compressed: true,
        }
      }
      return { messages, summary: null, compressed: false }
    }),
    shouldHalt: vi.fn(() => false),
    status: 'ok',
    hooks: null,
    manager: null,
    reset: vi.fn(),
    cleanup: vi.fn(),
  } as unknown as AgentLoopPlugin
}

function makeMultiTurnStreamModel() {
  const received: BaseMessage[][] = []
  let turn = 0
  const model = {
    invoke: vi.fn(async () => new AIMessage('fallback')),
    stream: vi.fn(async (messages: BaseMessage[]) => {
      received.push([...messages])
      const currentTurn = turn
      turn += 1
      return (async function* () {
        yield currentTurn === 0
          ? aiWithToolCall('echo')
          : new AIMessage('streamed final')
      })()
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    model: 'context-multi-turn-stream-model',
    _modelType: () => 'base_chat_model',
    _llmType: () => 'context-admission',
  } as unknown as BaseChatModel
  return { model, received }
}

function makeNativeStructuredModel(options: { reject?: boolean } = {}) {
  const nativeReceived: BaseMessage[][] = []
  const fallbackReceived: BaseMessage[][] = []
  const nativeInvoke = vi.fn(async (messages: BaseMessage[]) => {
    nativeReceived.push([...messages])
    if (options.reject) throw new Error('native schema rejected')
    return {
      raw: new AIMessage('{"name":"native"}'),
      parsed: { name: 'native' },
    }
  })
  const model = {
    invoke: vi.fn(async (messages: BaseMessage[]) => {
      fallbackReceived.push([...messages])
      return new AIMessage('{"name":"fallback"}')
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    withStructuredOutput: vi.fn(() => ({ invoke: nativeInvoke })),
    model: 'context-structured-model',
    _modelType: () => 'base_chat_model',
    _llmType: () => 'context-admission',
  } as unknown as BaseChatModel
  return { model, nativeReceived, fallbackReceived }
}

function makeAgent(model: BaseChatModel, overrides: Partial<DzupAgentConfig> = {}): DzupAgent {
  return new DzupAgent({
    id: 'context-agent',
    instructions: 'Base instructions.',
    model,
    guardrails: { maxIterations: 3 },
    ...overrides,
  })
}

async function drain(
  agent: DzupAgent,
  options?: GenerateOptions,
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const event of agent.stream([new HumanMessage('stream request')], options)) {
    events.push(event)
  }
  return events
}

function prepareParams(
  options?: GenerateOptions,
  configOverrides: Partial<DzupAgentConfig> = {},
  overrides: Partial<Parameters<typeof prepareRunState>[0]> = {},
): Parameters<typeof prepareRunState>[0] {
  const { model } = makeInvokeModel([new AIMessage('done')])
  const prepared = [
    new SystemMessage('Prepared base instructions and memory.'),
    new HumanMessage('prepared request'),
  ]
  return {
    config: {
      id: 'context-prepare-agent',
      instructions: 'Base instructions.',
      model: 'gpt-4',
      guardrails: { maxIterations: 3 },
      ...configOverrides,
    } as DzupAgentConfig,
    resolvedModel: model,
    messages: [new HumanMessage('caller request')],
    ...(options === undefined ? {} : { options }),
    prepareMessages: vi.fn(async () => ({ messages: prepared })),
    getTools: vi.fn(() => [] as StructuredToolInterface[]),
    bindTools: vi.fn((boundModel: BaseChatModel) => boundModel),
    runBeforeAgentHooks: vi.fn(async () => undefined),
    ...overrides,
  }
}

function journalEntry(
  type: RunJournalEntry['type'],
  seq: number,
  data: unknown,
): RunJournalEntry {
  return {
    v: 1,
    seq,
    ts: '2026-08-18T00:00:00.000Z',
    runId: 'context-resume-run',
    type,
    data,
  } as RunJournalEntry
}

describe('GenerateOptions.context exact-once admission', () => {
  it('injects exact non-empty context after preparation and before hooks, cache, and prompt accounting', async () => {
    const largeContext = `CACHE_CONTEXT_SENTINEL\n${'x '.repeat(3000)}`
    const hookMessages: BaseMessage[][] = []
    const trackPhase = vi.fn()
    const state = await prepareRunState(prepareParams(
      { context: largeContext },
      {
        model: 'claude-3-5-sonnet',
        hooks: {
          beforeModelCall: async (messages) => {
            hookMessages.push([...messages])
            return messages
          },
        },
        tokenLifecyclePlugin: { trackPhase } as never,
      },
    ))

    expect(hookMessages).toHaveLength(1)
    expect(hookMessages[0]!.at(-1)).toBeInstanceOf(SystemMessage)
    expect(hookMessages[0]!.at(-1)?.content).toBe(largeContext)
    expect(exactContextCount(hookMessages[0]!, largeContext)).toBe(1)
    expect(hasCacheControl(hookMessages[0]!)).toBe(false)
    expect(hasCacheControl(state.preparedMessages)).toBe(true)
    expect(exactContextCount(state.preparedMessages, largeContext)).toBe(1)
    expect(trackPhase).toHaveBeenCalledWith(
      'prompt',
      estimateConversationTokensForMessages(state.preparedMessages),
    )
  })

  it('treats undefined and empty context as no-ops while preserving whitespace exactly', async () => {
    const noContext = await prepareRunState(prepareParams())
    const emptyContext = await prepareRunState(prepareParams({ context: '' }))
    const whitespace = ' \n\t '
    const whitespaceContext = await prepareRunState(prepareParams({ context: whitespace }))

    expect(noContext.preparedMessages).toHaveLength(2)
    expect(emptyContext.preparedMessages).toHaveLength(2)
    expect(whitespaceContext.preparedMessages.at(-1)).toBeInstanceOf(SystemMessage)
    expect(whitespaceContext.preparedMessages.at(-1)?.content).toBe(whitespace)
    expect(exactContextCount(whitespaceContext.preparedMessages, whitespace)).toBe(1)
  })

  it('appends context once after resume rehydration without mutating caller messages', async () => {
    const callerMessages = [new HumanMessage('caller request')]
    const originalCallerMessage = callerMessages[0]
    const journal = {
      getAll: vi.fn(async () => [
        journalEntry('run_started', 1, { input: 'resumed request' }),
        journalEntry('step_completed', 2, {
          stepId: 'step-1',
          toolName: 'read',
          output: 'retained output',
        }),
      ]),
    }
    const state = await prepareRunState(prepareParams(
      { context: CONTEXT, _resume: { lastStateSeq: 2 } },
      {},
      {
        messages: callerMessages,
        journal,
        runId: 'context-resume-run',
      },
    ))

    expect(state.preparedMessages.at(-1)).toBeInstanceOf(SystemMessage)
    expect(state.preparedMessages.at(-1)?.content).toBe(CONTEXT)
    expect(exactContextCount(state.preparedMessages)).toBe(1)
    expect(String(state.preparedMessages[0]?.content)).toContain('resumed request')
    expect(callerMessages).toEqual([originalCallerMessage])
    expect(callerMessages[0]).toBe(originalCallerMessage)
  })

  it('passes one context suffix to generate without mutating caller input', async () => {
    const { model, received } = makeInvokeModel([new AIMessage('generated')])
    const agent = makeAgent(model)
    const callerMessages = [new HumanMessage('generate request')]
    const originalCallerMessage = callerMessages[0]

    const result = await agent.generate(callerMessages, { context: CONTEXT })

    expect(result.content).toBe('generated')
    expect(received).toHaveLength(1)
    expect(exactContextCount(received[0]!)).toBe(1)
    expect(received[0]!.at(-1)?.content).toBe(CONTEXT)
    expect(callerMessages).toEqual([originalCallerMessage])
    expect(callerMessages[0]).toBe(originalCallerMessage)
  })

  it('passes one context suffix to native stream and stream fallback', async () => {
    const native = makeStreamModel()
    await drain(makeAgent(native.model), { context: CONTEXT })

    const fallback = makeInvokeModel([new AIMessage('fallback streamed')])
    await drain(makeAgent(fallback.model), { context: CONTEXT })

    expect(native.received).toHaveLength(1)
    expect(exactContextCount(native.received[0]!)).toBe(1)
    expect(fallback.received).toHaveLength(1)
    expect(exactContextCount(fallback.received[0]!)).toBe(1)
  })

  it('restores one context suffix after generate and stream compression replaces history', async () => {
    const generate = makeInvokeModel([
      aiWithToolCall('echo'),
      new AIMessage('generated final'),
    ])
    await makeAgent(generate.model, {
      tools: [makeTool('echo')],
      tokenLifecyclePlugin: makeCompressingPlugin(),
    }).generate([new HumanMessage('generate compressed request')], {
      context: CONTEXT,
    })

    const stream = makeMultiTurnStreamModel()
    await drain(makeAgent(stream.model, {
      tools: [makeTool('echo')],
      tokenLifecyclePlugin: makeCompressingPlugin(),
    }), { context: CONTEXT })

    expect(generate.received).toHaveLength(2)
    generate.received.forEach(messages => {
      expect(exactContextCount(messages)).toBe(1)
    })
    expect(stream.received).toHaveLength(2)
    stream.received.forEach(messages => {
      expect(exactContextCount(messages)).toBe(1)
    })
  })

  it('passes one context suffix to native structured output before its hook seam', async () => {
    const native = makeNativeStructuredModel()
    const hookMessages: BaseMessage[][] = []
    const agent = makeAgent(native.model, {
      hooks: {
        beforeModelCall: async (messages) => {
          hookMessages.push([...messages])
          return messages
        },
      },
    })

    const result = await agent.generateStructured(
      [new HumanMessage('structured request')],
      Schema,
      { context: CONTEXT },
    )

    expect(result.data).toEqual({ name: 'native' })
    expect(native.nativeReceived).toHaveLength(1)
    expect(exactContextCount(native.nativeReceived[0]!)).toBe(1)
    expect(hookMessages).toHaveLength(1)
    expect(exactContextCount(hookMessages[0]!)).toBe(1)
  })

  it('does not accumulate context when native structured output falls back to text', async () => {
    const native = makeNativeStructuredModel({ reject: true })
    const agent = makeAgent(native.model)

    const result = await agent.generateStructured(
      [new HumanMessage('structured fallback request')],
      Schema,
      { context: CONTEXT },
    )

    expect(result.data).toEqual({ name: 'fallback' })
    expect(native.nativeReceived).toHaveLength(1)
    expect(exactContextCount(native.nativeReceived[0]!)).toBe(1)
    expect(native.fallbackReceived).toHaveLength(1)
    expect(exactContextCount(native.fallbackReceived[0]!)).toBe(1)
  })

  it('injects context once per structured parse retry without mutating retry state', async () => {
    const retryModel = makeInvokeModel([
      new AIMessage('not json'),
      new AIMessage('{"name":"retry-ok"}'),
    ])
    const callerMessages = [new HumanMessage('retry request')]
    const originalCallerMessage = callerMessages[0]
    const result = await makeAgent(retryModel.model).generateStructured(
      callerMessages,
      Schema,
      { context: CONTEXT },
    )

    expect(result.data).toEqual({ name: 'retry-ok' })
    expect(retryModel.received).toHaveLength(2)
    retryModel.received.forEach(messages => {
      expect(exactContextCount(messages)).toBe(1)
    })
    expect(callerMessages).toEqual([originalCallerMessage])
    expect(callerMessages[0]).toBe(originalCallerMessage)
  })

  it('includes context in hard-budget measurement before provider invocation', async () => {
    const measuredText: string[] = []
    const tokenCounter = {
      count: (text: string) => text.length,
      countDetailed: (text: string) => {
        measuredText.push(text)
        return {
          tokens: text.length,
          method: 'exact' as const,
          model: 'context-character-counter',
        }
      },
    }
    const { model, received } = makeInvokeModel([new AIMessage('budgeted')])
    const agent = makeAgent(model, {
      hardBudget: {
        contextWindowTokens: 500,
        reservedOutputTokens: 20,
        reservedSummaryTokens: 20,
        fixedEnvelopeTokens: 4,
        perMessageEnvelopeTokens: 2,
        tokenCounter,
      },
    })

    await agent.generate([new HumanMessage('budget request')], { context: CONTEXT })

    expect(measuredText.some(text => text.includes(CONTEXT))).toBe(true)
    expect(received).toHaveLength(1)
    expect(exactContextCount(received[0]!)).toBe(1)
  })

  it('fails closed before generate or stream invocation when context cannot fit the hard budget', async () => {
    const oversizedContext = `OVERSIZED_CONTEXT_SENTINEL:${'x'.repeat(400)}`
    const hardBudget: NonNullable<DzupAgentConfig['hardBudget']> = {
      contextWindowTokens: 100,
      reservedOutputTokens: 20,
      reservedSummaryTokens: 10,
      fixedEnvelopeTokens: 4,
      perMessageEnvelopeTokens: 2,
      tokenCounter: {
        count: (text: string) => text.length,
        countDetailed: (text: string) => ({
          tokens: text.length,
          method: 'exact' as const,
          model: 'context-character-counter',
        }),
      },
    }
    const generate = makeInvokeModel([new AIMessage('must not run')])
    const stream = makeStreamModel()

    await expect(makeAgent(generate.model, { hardBudget }).generate(
      [new HumanMessage('budget request')],
      { context: oversizedContext },
    )).rejects.toBeInstanceOf(RuntimeHardBudgetAdoptionError)
    await expect(drain(
      makeAgent(stream.model, { hardBudget }),
      { context: oversizedContext },
    )).rejects.toBeInstanceOf(RuntimeHardBudgetAdoptionError)

    expect(generate.model.invoke).not.toHaveBeenCalled()
    expect(stream.model.stream).not.toHaveBeenCalled()
  })

  it('retains context only through the existing full-transcript snapshot boundary', async () => {
    const store = new InMemoryRunStateStore()
    const bus = createEventBus()
    const events: DzupEvent[] = []
    bus.onAny(event => {
      events.push(event)
    })
    const { model } = makeInvokeModel([new AIMessage('snapshot result')])
    const agent = makeAgent(model, { runStateStore: store, eventBus: bus })

    const result = await agent.generate([new HumanMessage('snapshot request')], {
      runId: 'context-snapshot-run',
      context: CONTEXT,
    })
    await new Promise(resolve => setImmediate(resolve))

    const snapshot = await store.load('context-snapshot-run')
    expect(snapshot).toBeDefined()
    expect(exactContextCount(snapshot?.messages ?? [])).toBe(1)
    expect(result.content).toBe('snapshot result')
    expect(result.content).not.toContain(CONTEXT)
    expect(JSON.stringify(events)).not.toContain(CONTEXT)
  })
})
