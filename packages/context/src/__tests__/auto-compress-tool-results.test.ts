import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { describe, expect, it, vi } from 'vitest'

import { autoCompress, type AutoCompressConfig } from '../auto-compress.js'

const exactTokenizer = {
  model: 'test-exact',
  countTokens(text: string): number {
    return Math.ceil(text.length / 4)
  },
  countDetailed(text: string) {
    return {
      tokens: Math.ceil(text.length / 4),
      method: 'exact' as const,
      model: 'test-exact',
    }
  },
}

function toolPair(id: string, size = 800): BaseMessage[] {
  return [
    new AIMessage({
      content: 'calling lookup',
      tool_calls: [{ id, name: 'lookup', args: {} }],
    }),
    new ToolMessage({
      content: 'x'.repeat(size),
      tool_call_id: id,
      name: 'lookup',
    }),
  ]
}

function config(overrides: Partial<AutoCompressConfig> = {}): AutoCompressConfig {
  return {
    maxMessages: 30,
    tokenizer: exactTokenizer,
    completedToolCompaction: {
      schema: 'datazup.context.completed-tool-compaction-profile/v1',
      preserveRecentCompletedPairs: 0,
      minimumResultTokens: 8,
      maxCompactedResults: 8,
      measurement: 'require-tokenizer',
    },
    ...overrides,
  }
}

function model(response = 'summary'): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue(new AIMessage(response)),
  } as unknown as BaseChatModel
}

describe('autoCompress completed tool compaction', () => {
  it('reclaims completed tool output before thresholding without invoking a model', async () => {
    const messages = toolPair('call-1')
    const summarizer = model()

    const compressed = await autoCompress(messages, 'existing', summarizer, config())

    expect(compressed.compressed).toBe(true)
    expect(compressed.summary).toBe('existing')
    expect(compressed.completedToolCompaction).toMatchObject({
      status: 'completed',
      reason: 'compacted',
      compactedToolCallIds: ['call-1'],
    })
    expect(compressed.completedToolCompaction!.reclaimedTokens).toBeGreaterThan(0)
    expect((compressed.messages[1] as ToolMessage).content).toBe(
      '[Completed tool result compacted]',
    )
    expect(summarizer.invoke).not.toHaveBeenCalled()
    expect((messages[1] as ToolMessage).content).toBe('x'.repeat(800))
  })

  it('keeps incomplete pairs byte-for-byte unchanged', async () => {
    const messages: BaseMessage[] = [
      new AIMessage({
        content: 'calling lookup',
        tool_calls: [{ id: 'call-1', name: 'lookup', args: {} }],
      }),
    ]

    const compressed = await autoCompress(messages, null, model(), config())

    expect(compressed.compressed).toBe(false)
    expect(compressed.messages).toBe(messages)
    expect(compressed.completedToolCompaction).toMatchObject({
      status: 'unchanged',
      reason: 'no-eligible-results',
    })
  })

  it('reports invalid pairing as an adoption-safe degradation and continues unchanged', async () => {
    const messages: BaseMessage[] = [
      new ToolMessage({ content: 'orphan', tool_call_id: 'missing' }),
    ]

    const compressed = await autoCompress(messages, null, model(), config())

    expect(compressed.compressed).toBe(false)
    expect(compressed.messages).toBe(messages)
    expect(compressed.degradations).toEqual([{
      stage: 'completed-tool-compaction',
      reason: 'invalid-tool-pairing',
      adoptionSafe: true,
    }])
  })

  it('returns the original transcript when a later required summarization fails', async () => {
    const messages = [
      ...toolPair('call-1'),
      ...toolPair('call-2'),
    ]
    const failing = {
      invoke: vi.fn().mockRejectedValue(new Error('summary unavailable')),
    } as unknown as BaseChatModel

    const compressed = await autoCompress(messages, 'prior', failing, config({
      maxMessages: 1,
      keepRecentMessages: 2,
    }))

    expect(compressed.compressed).toBe(false)
    expect(compressed.messages).toBe(messages)
    expect(compressed.summary).toBe('prior')
    expect(compressed.completedToolCompaction?.status).toBe('completed')
    expect(compressed.degradations).toContainEqual({
      stage: 'summary-invocation',
      reason: 'summary unavailable',
      adoptionSafe: false,
    })
  })

  it('does not adopt heuristic compaction when strict hard-budget measurement is unproven', async () => {
    const messages = toolPair('call-1')
    const compressed = await autoCompress(messages, null, model(), {
      budget: 100,
      completedToolCompaction: {
        schema: 'datazup.context.completed-tool-compaction-profile/v1',
        preserveRecentCompletedPairs: 0,
        minimumResultTokens: 8,
        maxCompactedResults: 8,
        measurement: 'allow-heuristic',
      },
    })

    expect(compressed.compressed).toBe(false)
    expect(compressed.messages).toBe(messages)
    expect(compressed.fallbackReason).toContain('token-measurement')
    expect(compressed.degradations?.at(-1)).toMatchObject({
      stage: 'token-measurement',
      adoptionSafe: false,
    })
  })
})
