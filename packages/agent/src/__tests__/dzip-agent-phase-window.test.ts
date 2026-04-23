/**
 * Tests for DzupAgent phase-aware message windowing.
 *
 * Verifies that:
 *   - When `messagePhase` is unset, prepareMessages() passes all messages through
 *     unchanged (the default path is untouched).
 *   - When `messagePhase` is set, PhaseAwareWindowManager.findRetentionSplit()
 *     is consulted and the retained tail is passed forward.
 *   - When the computed split is 0 (short conversations), messages pass through.
 *   - The phase value is accepted for every ConversationPhase (incl. `'general'`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

// ---------------------------------------------------------------------------
// Mock @dzupagent/context so we can observe PhaseAwareWindowManager usage.
// ---------------------------------------------------------------------------

const phaseWindowState = vi.hoisted(() => ({
  findRetentionSplit: vi.fn<(messages: unknown[], targetKeep: number) => number>(
    () => 0,
  ),
  constructed: 0,
}))

vi.mock('@dzupagent/context', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@dzupagent/context')
  class MockPhaseAwareWindowManager {
    constructor() {
      phaseWindowState.constructed++
    }

    findRetentionSplit(messages: unknown[], targetKeep: number): number {
      return phaseWindowState.findRetentionSplit(messages, targetKeep)
    }

    // scoreMessages is not used by DzupAgent but included for completeness.
    scoreMessages(): unknown[] {
      return []
    }

    detectPhase(): { phase: string; confidence: number } {
      return { phase: 'general', confidence: 0 }
    }
  }

  return {
    ...actual,
    PhaseAwareWindowManager: MockPhaseAwareWindowManager,
  }
})

// Import the SUT after the mock is registered.
import { DzupAgent } from '../agent/dzip-agent.js'
import type { DzupAgentConfig } from '../agent/agent-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCapturingModel(): {
  model: BaseChatModel
  invokedWith: BaseMessage[][]
} {
  const invokedWith: BaseMessage[][] = []
  const invoke = vi.fn(async (msgs: BaseMessage[]) => {
    invokedWith.push([...msgs])
    return new AIMessage('done')
  })
  const model = { invoke } as unknown as BaseChatModel
  return { model, invokedWith }
}

function nonSystemCount(messages: BaseMessage[]): number {
  return messages.filter(m => m._getType() !== 'system').length
}

function makeConversation(length: number): BaseMessage[] {
  const msgs: BaseMessage[] = []
  for (let i = 0; i < length; i++) {
    if (i % 2 === 0) {
      msgs.push(new HumanMessage(`user message ${i}`))
    } else {
      msgs.push(new AIMessage(`assistant message ${i}`))
    }
  }
  return msgs
}

function baseConfig(overrides: Partial<DzupAgentConfig>): DzupAgentConfig {
  return {
    id: 'phase-window-test',
    instructions: 'Test instructions',
    model: overrides.model as BaseChatModel,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DzupAgent phase-aware windowing', () => {
  beforeEach(() => {
    phaseWindowState.findRetentionSplit.mockReset()
    phaseWindowState.findRetentionSplit.mockReturnValue(0)
    phaseWindowState.constructed = 0
  })

  it('does not invoke PhaseAwareWindowManager when messagePhase is unset', async () => {
    const { model, invokedWith } = createCapturingModel()
    const agent = new DzupAgent(baseConfig({ model }))

    const input = makeConversation(20)
    await agent.generate(input)

    expect(phaseWindowState.constructed).toBe(0)
    expect(phaseWindowState.findRetentionSplit).not.toHaveBeenCalled()

    // All 20 user/AI messages reached the model (plus the system message).
    expect(invokedWith).toHaveLength(1)
    expect(nonSystemCount(invokedWith[0]!)).toBe(20)
  })

  it('trims messages using findRetentionSplit when messagePhase is set', async () => {
    const { model, invokedWith } = createCapturingModel()

    // Simulate PhaseAwareWindowManager asking us to drop the first 12 messages.
    phaseWindowState.findRetentionSplit.mockReturnValue(12)

    const agent = new DzupAgent(
      baseConfig({
        model,
        messagePhase: 'debugging',
        messageConfig: { keepRecentMessages: 8 },
      }),
    )

    const input = makeConversation(20)
    await agent.generate(input)

    expect(phaseWindowState.findRetentionSplit).toHaveBeenCalledTimes(1)
    const [passedMessages, targetKeep] =
      phaseWindowState.findRetentionSplit.mock.calls[0]!
    expect(passedMessages).toHaveLength(20)
    expect(targetKeep).toBe(8)

    // 20 input messages - 12 trimmed = 8 retained (plus system).
    expect(invokedWith).toHaveLength(1)
    expect(nonSystemCount(invokedWith[0]!)).toBe(8)
  })

  it('uses default keepRecentMessages=10 when messageConfig is not provided', async () => {
    const { model } = createCapturingModel()
    phaseWindowState.findRetentionSplit.mockReturnValue(0)

    const agent = new DzupAgent(
      baseConfig({
        model,
        messagePhase: 'planning',
      }),
    )

    await agent.generate(makeConversation(15))

    expect(phaseWindowState.findRetentionSplit).toHaveBeenCalledTimes(1)
    const [, targetKeep] = phaseWindowState.findRetentionSplit.mock.calls[0]!
    expect(targetKeep).toBe(10)
  })

  it('passes messages through unchanged when splitIdx is 0 (short conversation)', async () => {
    const { model, invokedWith } = createCapturingModel()

    // Short-conversation signal: findRetentionSplit returns 0 → no trim.
    phaseWindowState.findRetentionSplit.mockReturnValue(0)

    const agent = new DzupAgent(
      baseConfig({
        model,
        messagePhase: 'coding',
        messageConfig: { keepRecentMessages: 10 },
      }),
    )

    const input = makeConversation(4)
    await agent.generate(input)

    expect(phaseWindowState.findRetentionSplit).toHaveBeenCalledTimes(1)
    expect(invokedWith).toHaveLength(1)
    // All 4 messages reached the model unchanged.
    expect(nonSystemCount(invokedWith[0]!)).toBe(4)
  })

  it('runs the phase window for the `general` phase as well', async () => {
    const { model, invokedWith } = createCapturingModel()
    phaseWindowState.findRetentionSplit.mockReturnValue(3)

    const agent = new DzupAgent(
      baseConfig({
        model,
        messagePhase: 'general',
        messageConfig: { keepRecentMessages: 5 },
      }),
    )

    await agent.generate(makeConversation(8))

    expect(phaseWindowState.findRetentionSplit).toHaveBeenCalledTimes(1)
    const [, targetKeep] = phaseWindowState.findRetentionSplit.mock.calls[0]!
    expect(targetKeep).toBe(5)

    // 8 - 3 = 5 retained.
    expect(nonSystemCount(invokedWith[0]!)).toBe(5)
  })
})
