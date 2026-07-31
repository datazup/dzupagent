import { describe, expect, it, vi } from 'vitest'
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { createEventBus, type DzupEvent } from '@dzupagent/core/events'
import { DzupAgent } from '../agent/dzip-agent.js'
import {
  RUNTIME_HARD_BUDGET_MARKER,
  RuntimeHardBudgetAdoptionError,
  applyRuntimeHardBudget,
  enforceAgentHardBudget,
  type AgentHardBudgetConfig,
} from '../agent/runtime-hard-budget.js'

const exactCharacterCounter = {
  count: (text: string) => text.length,
  countDetailed: (text: string) => ({
    tokens: text.length,
    method: 'exact' as const,
    model: 'exact-character-test',
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
})
