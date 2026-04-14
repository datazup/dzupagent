import { describe, it, expect, vi } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  PhaseAwareWindowManager,
  FrozenSnapshot,
  autoCompress,
  pruneToolResults,
} from '../index.js'

function createMockModel(response: string): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue(new AIMessage(response)),
  } as unknown as BaseChatModel
}

function buildCodingConversation(): BaseMessage[] {
  return [
    new SystemMessage('You are a coding assistant.'),
    new HumanMessage('Please implement the parser and keep the API stable.'),
    ...Array.from({ length: 7 }, (_, index) => [
      new AIMessage({
        content: `Inspecting file ${index}`,
        tool_calls: [
          {
            id: `tool-call-${index}`,
            name: 'inspect_file',
            args: { path: `src/file-${index}.ts` },
          },
        ],
      }),
      new ToolMessage({
        content: `src/file-${index}.ts\n${'x'.repeat(160)}`,
        tool_call_id: `tool-call-${index}`,
        name: 'inspect_file',
      }),
    ]).flat(),
    new HumanMessage('Refactor the parser implementation now.'),
    new AIMessage('I will keep the public interface intact.'),
  ]
}

describe('context integration', () => {
  it('coordinates phase detection, pruning, and compression on a coding conversation', async () => {
    const manager = new PhaseAwareWindowManager()
    const messages = buildCodingConversation()

    const phase = manager.detectPhase(messages)
    expect(phase.phase).toBe('coding')

    const pruned = pruneToolResults(messages)
    expect(
      pruned.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('[Tool result pruned]'),
      ),
    ).toBe(true)

    const hook = vi.fn()
    const model = createMockModel('## Goal\nKeep parser stable')

    const result = await autoCompress(messages, 'Prior summary', model, {
      maxMessages: 10,
      keepRecentMessages: 4,
      onBeforeSummarize: hook,
    })

    expect(result.compressed).toBe(true)
    expect(result.summary).toBe('## Goal\nKeep parser stable')
    expect(result.messages.length).toBeLessThan(messages.length)
    expect(hook).toHaveBeenCalledTimes(1)
  })

  it('freezes and thaws snapshot state across sessions', () => {
    const snapshot = new FrozenSnapshot()

    expect(snapshot.isActive()).toBe(false)
    expect(snapshot.get()).toBeNull()

    snapshot.freeze('system prompt + memory context')

    expect(snapshot.isActive()).toBe(true)
    expect(snapshot.get()).toBe('system prompt + memory context')

    snapshot.thaw()

    expect(snapshot.isActive()).toBe(false)
    expect(snapshot.get()).toBeNull()
  })
})
