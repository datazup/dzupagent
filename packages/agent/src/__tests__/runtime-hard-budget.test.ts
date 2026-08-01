import { describe, expect, it, vi } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { createEventBus, type DzupEvent } from '@dzupagent/core/events'
import { DzupAgent } from '../agent/dzip-agent.js'
import {
  PROTECTED_TRANSCRIPT_MARKER,
  RUNTIME_HARD_BUDGET_MARKER,
  RuntimeHardBudgetAdoptionError,
  applyRuntimeHardBudget,
  defineHardBudgetHostProfile,
  enforceAgentHardBudget,
  type AgentHardBudgetConfig,
  type HardBudgetHostProfile,
} from '../agent/runtime-hard-budget.js'

const exactCharacterCounter = {
  count: (text: string) => text.length,
  countDetailed: (text: string) => ({
    tokens: text.length,
    method: 'exact' as const,
    model: 'exact-character-test',
  }),
}

const PROFILE_MODEL = 'profile-character-model'
const PROFILE_ENCODING = 'character-v1'
const profiledCharacterCounter = {
  count: (text: string) => text.length,
  countDetailed: (text: string, model?: string) => ({
    tokens: text.length,
    method: 'exact' as const,
    model: model ?? PROFILE_MODEL,
    encoding: PROFILE_ENCODING,
  }),
}

function hardBudget(
  overrides: Partial<AgentHardBudgetConfig> = {},
): AgentHardBudgetConfig {
  return {
    contextWindowTokens: 180,
    reservedOutputTokens: 20,
    reservedSummaryTokens: 20,
    fixedEnvelopeTokens: 4,
    perMessageEnvelopeTokens: 2,
    tokenCounter: exactCharacterCounter,
    ...overrides,
  }
}

function hostProfile(
  overrides: Partial<HardBudgetHostProfile> = {},
): Readonly<HardBudgetHostProfile> {
  return defineHardBudgetHostProfile({
    contextWindowTokens: 180,
    reservedOutputTokens: 20,
    reservedSummaryTokens: 10,
    reservedToolTokens: 10,
    fixedEnvelopeTokens: 4,
    perMessageEnvelopeTokens: 2,
    tokenCounter: profiledCharacterCounter,
    model: PROFILE_MODEL,
    hostProfile: {
      schemaVersion: '1',
      id: 'test-chat-host',
      revision: '2026-08-01',
      provider: 'test-provider',
    },
    tokenizerProvenance: {
      id: 'character-tokenizer',
      revision: '1',
      model: PROFILE_MODEL,
      allowedMethods: ['exact'],
      encoding: PROFILE_ENCODING,
    },
    protectedTranscript: {
      preserveSystemMessages: true,
      preserveLatestUserMessages: 1,
      preserveRecentToolCallGroups: 1,
    },
    ...overrides,
  })
}

function mockModel(overrides: Record<string, unknown> = {}): BaseChatModel {
  return {
    invoke: vi.fn(async () => new AIMessage('done')),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
    ...overrides,
  } as unknown as BaseChatModel
}

describe('runtime hard-budget adoption', () => {
  it('retains the active transcript and fails before invocation on heuristic proof', async () => {
    const messages = [new HumanMessage('original transcript')]
    const original = [...messages]
    const model = mockModel()
    const countOnly = { count: (text: string) => text.length }

    await expect(enforceAgentHardBudget({
      messages,
      model,
      config: hardBudget({ tokenCounter: countOnly }),
      agentId: 'unsafe-agent',
      phase: 'tool-loop',
    })).rejects.toBeInstanceOf(RuntimeHardBudgetAdoptionError)

    expect(messages).toEqual(original)
    expect(messages[0]).toBe(original[0])
    expect(model.invoke).not.toHaveBeenCalled()
  })

  it('enforces the tool-loop input ceiling after explicit reservations', async () => {
    const events: DzupEvent[] = []
    const bus = createEventBus()
    bus.onAny((event) => {
      events.push(event)
    })
    const requests: BaseMessage[][] = []
    const model = mockModel({
      invoke: vi.fn(async (messages: BaseMessage[]) => {
        requests.push([...messages])
        return new AIMessage('done')
      }),
    })
    const agent = new DzupAgent({
      id: 'budgeted-generate',
      instructions: 'Follow the task.',
      model,
      eventBus: bus,
      hardBudget: hardBudget(),
    })

    await agent.generate([new HumanMessage('A'.repeat(400))])
    await Promise.resolve()

    expect(requests).toHaveLength(1)
    const serialized = requests[0]!.map((message) => String(message.content)).join('')
    expect(serialized.length).toBeLessThanOrEqual(150)
    expect(serialized).toContain('truncated')
    expect(events).toContainEqual(expect.objectContaining({
      type: 'context:hard_budget_evaluated',
      phase: 'tool-loop',
      contentTokenLimit: 150,
      adoptionSafe: true,
      satisfied: true,
      truncated: true,
      markerIncluded: true,
    }))
  })

  it('reserves summary space without opening an ungoverned summarizer call', async () => {
    const messages = Array.from(
      { length: 10 },
      (_, index) => new HumanMessage(`${index}:${'C'.repeat(38)}`),
    )
    const model = mockModel({
      invoke: vi.fn(async () => new AIMessage('compact summary')),
    })

    const result = await applyRuntimeHardBudget({
      messages,
      model,
      config: hardBudget({
        contextWindowTokens: 300,
        reservedSummaryTokens: 80,
        compression: { keepRecentLevel3: 2 },
      }),
    })

    expect(result.hardBudget).toMatchObject({
      satisfied: true,
      adoptionSafe: true,
    })
    expect(result.reservation.summaryTokens).toBe(80)
    expect(result.reservation.transcriptTokenLimit).toBe(
      result.reservation.contentTokenLimit - 80,
    )
    expect(result.tokenMeasurement.tokens).toBeLessThanOrEqual(
      result.reservation.contentTokenLimit,
    )
    expect(model.invoke).not.toHaveBeenCalled()
  })

  it('enforces the native stream boundary and reports stream telemetry', async () => {
    const events: DzupEvent[] = []
    const bus = createEventBus()
    bus.onAny((event) => {
      events.push(event)
    })
    const requests: BaseMessage[][] = []
    const model = mockModel({
      stream: vi.fn(async (messages: BaseMessage[]) => {
        requests.push([...messages])
        return (async function* () {
          yield new AIMessage('streamed')
        })()
      }),
    })
    const agent = new DzupAgent({
      id: 'budgeted-stream',
      instructions: 'Follow the task.',
      model,
      eventBus: bus,
      hardBudget: hardBudget(),
    })

    const output = []
    for await (const event of agent.stream([
      new HumanMessage('B'.repeat(400)),
    ])) {
      output.push(event)
    }
    await Promise.resolve()

    expect(requests).toHaveLength(1)
    const serialized = requests[0]!.map((message) => String(message.content)).join('')
    expect(serialized.length).toBeLessThanOrEqual(150)
    expect(serialized).toContain('truncated')
    expect(output.at(-1)).toMatchObject({
      type: 'done',
      data: { stopReason: 'complete' },
    })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'context:hard_budget_evaluated',
      phase: 'stream',
      adoptionSafe: true,
      satisfied: true,
    }))
  })

  it('keeps the complete runtime truncation marker for bounded text', () => {
    expect(RUNTIME_HARD_BUDGET_MARKER).toMatch(/^\n\n.*\.\.\.$/)
  })

  it('preserves system instructions and latest user intent by identity', async () => {
    const system = new SystemMessage('SYSTEM-LOCK')
    const oldUser = new HumanMessage('O'.repeat(100))
    const oldAssistant = new AIMessage('A'.repeat(80))
    const latestUser = new HumanMessage('LATEST-INTENT')

    const result = await applyRuntimeHardBudget({
      messages: [system, oldUser, oldAssistant, latestUser],
      model: mockModel(),
      config: hostProfile({ contextWindowTokens: 155 }),
    })

    expect(result.hardBudget).toMatchObject({
      satisfied: true,
      adoptionSafe: true,
      truncated: true,
      markerIncluded: true,
    })
    expect(result.messages).toContain(system)
    expect(result.messages).toContain(latestUser)
    expect(result.messages).not.toContain(oldUser)
    expect(result.messages).not.toContain(oldAssistant)
    expect(result.messages.find(
      (message) => message.content === PROTECTED_TRANSCRIPT_MARKER,
    )).toBeInstanceOf(SystemMessage)
    expect(result.protection).toEqual({
      protectedMessageCount: 2,
      protectedToolGroupCount: 0,
      droppedMessageCount: 2,
    })
  })

  it('keeps the recent tool-call and result group atomic', async () => {
    const oldCall = new AIMessage({
      content: 'C'.repeat(60),
      tool_calls: [{ id: 'old-call', name: 'old-tool', args: {} }],
    })
    const oldResult = new ToolMessage({
      content: 'R'.repeat(60),
      tool_call_id: 'old-call',
    })
    const recentCall = new AIMessage({
      content: 'recent-call',
      tool_calls: [{ id: 'recent-call', name: 'recent-tool', args: {} }],
    })
    const recentResult = new ToolMessage({
      content: 'recent-result',
      tool_call_id: 'recent-call',
    })
    const latestUser = new HumanMessage('latest')

    const result = await applyRuntimeHardBudget({
      messages: [oldCall, oldResult, recentCall, recentResult, latestUser],
      model: mockModel(),
      config: hostProfile({ contextWindowTokens: 160 }),
    })

    expect(result.hardBudget.adoptionSafe).toBe(true)
    expect(result.messages).not.toContain(oldCall)
    expect(result.messages).not.toContain(oldResult)
    expect(result.messages).toContain(recentCall)
    expect(result.messages).toContain(recentResult)
    expect(result.messages).toContain(latestUser)
    expect(result.protection).toEqual({
      protectedMessageCount: 3,
      protectedToolGroupCount: 1,
      droppedMessageCount: 2,
    })
  })

  it('keeps protected replay and resume fitting idempotent', async () => {
    const first = await applyRuntimeHardBudget({
      messages: [
        new SystemMessage('SYSTEM'),
        new HumanMessage('O'.repeat(120)),
        new HumanMessage('LATEST'),
      ],
      model: mockModel(),
      config: hostProfile({ contextWindowTokens: 150 }),
    })
    const resumed = await applyRuntimeHardBudget({
      messages: first.messages,
      model: mockModel(),
      config: hostProfile({ contextWindowTokens: 150 }),
    })

    expect(resumed.hardBudget).toMatchObject({
      adoptionSafe: true,
      truncated: false,
      markerIncluded: false,
    })
    expect(resumed.messages).toEqual(first.messages)
    resumed.messages.forEach((message, index) => {
      expect(message).toBe(first.messages[index])
    })
    expect(resumed.messages.filter(
      (message) => message.content === PROTECTED_TRANSCRIPT_MARKER,
    )).toHaveLength(1)
  })

  it('retains the original transcript when protected content cannot fit', async () => {
    const messages = [
      new SystemMessage('S'.repeat(100)),
      new HumanMessage('U'.repeat(100)),
    ]
    const original = [...messages]
    const model = mockModel()

    await expect(enforceAgentHardBudget({
      messages,
      model,
      config: hostProfile({ contextWindowTokens: 130 }),
      agentId: 'protected-overflow',
      phase: 'tool-loop',
    })).rejects.toBeInstanceOf(RuntimeHardBudgetAdoptionError)

    expect(messages).toEqual(original)
    expect(messages[0]).toBe(original[0])
    expect(messages[1]).toBe(original[1])
    expect(model.invoke).not.toHaveBeenCalled()
  })

  it('rejects measurements that do not match profile provenance', async () => {
    const result = await applyRuntimeHardBudget({
      messages: [new HumanMessage('bounded')],
      model: mockModel(),
      config: hostProfile({
        tokenCounter: {
          count: (text) => text.length,
          countDetailed: (text) => ({
            tokens: text.length,
            method: 'exact',
            model: 'different-model',
            encoding: PROFILE_ENCODING,
          }),
        },
      }),
    })

    expect(result.hardBudget).toMatchObject({
      satisfied: false,
      adoptionSafe: false,
    })
    expect(result.degradations?.[0]).toMatchObject({
      stage: 'token-measurement',
      adoptionSafe: false,
    })
  })

  it('emits bounded profile, reservation, and protection proof', async () => {
    const events: DzupEvent[] = []
    const bus = createEventBus()
    bus.onAny((event) => {
      events.push(event)
    })
    const messages = [
      new SystemMessage('SYSTEM'),
      new HumanMessage('O'.repeat(120)),
      new HumanMessage('LATEST'),
    ]

    await enforceAgentHardBudget({
      messages,
      model: mockModel(),
      config: hostProfile({ contextWindowTokens: 150 }),
      eventBus: bus,
      agentId: 'profiled-agent',
      phase: 'stream',
    })
    await Promise.resolve()

    expect(events).toContainEqual(expect.objectContaining({
      type: 'context:hard_budget_evaluated',
      profileSchemaVersion: '1',
      profileId: 'test-chat-host',
      profileRevision: '2026-08-01',
      provider: 'test-provider',
      model: PROFILE_MODEL,
      tokenizerId: 'character-tokenizer',
      tokenizerRevision: '1',
      tokenizerEncoding: PROFILE_ENCODING,
      outputReservedTokens: 20,
      summaryReservedTokens: 10,
      toolReservedTokens: 10,
      protectedMessageCount: 2,
      droppedMessageCount: 1,
    }))
  })

  it('requires complete protected semantics on versioned profiles', () => {
    expect(() => hostProfile({
      protectedTranscript: {
        preserveSystemMessages: false,
        preserveLatestUserMessages: 1,
        preserveRecentToolCallGroups: 1,
      },
    })).toThrow(/preserve system messages/)
  })
})
