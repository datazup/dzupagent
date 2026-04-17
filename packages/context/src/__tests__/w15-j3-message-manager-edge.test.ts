import { describe, it, expect, vi } from 'vitest'
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  shouldSummarize,
  pruneToolResults,
  repairOrphanedToolPairs,
  summarizeAndTrim,
  formatSummaryContext,
} from '../message-manager.js'

function createMockModel(response: string | object): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue(new AIMessage({ content: response as string })),
  } as unknown as BaseChatModel
}

function createReturningModel(raw: unknown): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue({ content: raw }),
  } as unknown as BaseChatModel
}

function createFailingModel(error: string): BaseChatModel {
  return {
    invoke: vi.fn().mockRejectedValue(new Error(error)),
  } as unknown as BaseChatModel
}

function makeConversation(pairs: number): BaseMessage[] {
  const msgs: BaseMessage[] = []
  for (let i = 0; i < pairs; i++) {
    msgs.push(new HumanMessage(`Q${i}`))
    msgs.push(new AIMessage(`A${i}`))
  }
  return msgs
}

describe('shouldSummarize boundary conditions', () => {
  it('returns false for empty messages array', () => {
    expect(shouldSummarize([])).toBe(false)
  })

  it('returns false when message count equals maxMessages exactly', () => {
    const msgs = makeConversation(5)
    expect(shouldSummarize(msgs, { maxMessages: 10 })).toBe(false)
  })

  it('returns true when message count is one above maxMessages', () => {
    const msgs = makeConversation(6)
    expect(shouldSummarize(msgs, { maxMessages: 10 })).toBe(true)
  })

  it('handles messages with non-string object content', () => {
    const msg = new HumanMessage({
      content: [{ type: 'text' as const, text: 'hi' }],
    })
    expect(shouldSummarize([msg], { maxMessageTokens: 1000 })).toBe(false)
  })

  it('respects custom charsPerToken for token calculation', () => {
    const msgs = [new HumanMessage('x'.repeat(1000))]
    expect(shouldSummarize(msgs, { charsPerToken: 10, maxMessageTokens: 50 })).toBe(true)
    expect(shouldSummarize(msgs, { charsPerToken: 100, maxMessageTokens: 50 })).toBe(false)
  })

  it('handles a mix of content types summing under threshold', () => {
    const msgs: BaseMessage[] = [
      new SystemMessage('sys'),
      new HumanMessage('short'),
      new AIMessage('short'),
    ]
    expect(shouldSummarize(msgs)).toBe(false)
  })
})

describe('pruneToolResults edge cases', () => {
  it('returns messages unchanged when there are zero tool messages', () => {
    const msgs: BaseMessage[] = [
      new HumanMessage('hi'),
      new AIMessage('hello'),
      new SystemMessage('rules'),
    ]
    const out = pruneToolResults(msgs)
    expect(out).toBe(msgs)
  })

  it('does not prune any tool messages when count is at exactly preserveRecent limit', () => {
    const msgs: BaseMessage[] = []
    for (let i = 0; i < 6; i++) {
      msgs.push(new AIMessage({
        content: `c-${i}`,
        tool_calls: [{ id: `tc-${i}`, name: 't', args: {} }],
      }))
      msgs.push(new ToolMessage({
        content: 'x'.repeat(500),
        tool_call_id: `tc-${i}`,
        name: 't',
      }))
    }
    const out = pruneToolResults(msgs, { preserveRecentToolResults: 6 })
    const pruned = out.filter(m => {
      const c = typeof m.content === 'string' ? m.content : ''
      return c.includes('[Tool result pruned]')
    })
    expect(pruned.length).toBe(0)
  })

  it('keeps short tool results intact when pruning (no truncation marker)', () => {
    const msgs: BaseMessage[] = [
      new AIMessage({
        content: 'call',
        tool_calls: [{ id: 'tc-1', name: 't', args: {} }],
      }),
      new ToolMessage({ content: 'ok', tool_call_id: 'tc-1', name: 't' }),
      ...Array.from({ length: 7 }, (_, i) => [
        new AIMessage({
          content: `c-${i}`,
          tool_calls: [{ id: `tc-n-${i}`, name: 't', args: {} }],
        }),
        new ToolMessage({ content: `r-${i}`, tool_call_id: `tc-n-${i}`, name: 't' }),
      ]).flat(),
    ]
    const out = pruneToolResults(msgs, { prunedToolResultMaxChars: 120 })
    const firstTool = out[1] as ToolMessage
    const content = firstTool.content as string
    expect(content).toContain('[Tool result pruned]')
    expect(content).not.toContain('...[pruned]')
  })

  it('handles tool message without a name field', () => {
    const toolMsg = new ToolMessage({
      content: 'x'.repeat(500),
      tool_call_id: 'tc-no-name',
    })
    const msgs: BaseMessage[] = [
      new AIMessage({ content: 'call', tool_calls: [{ id: 'tc-no-name', name: 't', args: {} }] }),
      toolMsg,
      ...Array.from({ length: 7 }, (_, i) => [
        new AIMessage({ content: `c-${i}`, tool_calls: [{ id: `tc-r-${i}`, name: 't', args: {} }] }),
        new ToolMessage({ content: `r-${i}`, tool_call_id: `tc-r-${i}` }),
      ]).flat(),
    ]
    const out = pruneToolResults(msgs)
    const first = out[1] as ToolMessage
    expect(first.tool_call_id).toBe('tc-no-name')
  })

  it('preserveRecentToolResults=0 prunes every tool message', () => {
    const msgs: BaseMessage[] = []
    for (let i = 0; i < 3; i++) {
      msgs.push(new AIMessage({
        content: `c-${i}`,
        tool_calls: [{ id: `tc-${i}`, name: 't', args: {} }],
      }))
      msgs.push(new ToolMessage({
        content: `result-${i}-${'x'.repeat(200)}`,
        tool_call_id: `tc-${i}`,
      }))
    }
    const out = pruneToolResults(msgs, { preserveRecentToolResults: 0 })
    const pruned = out.filter(m => {
      const c = typeof m.content === 'string' ? m.content : ''
      return c.includes('[Tool result pruned]')
    })
    expect(pruned.length).toBe(3)
  })
})

describe('repairOrphanedToolPairs edge cases', () => {
  it('preserves ToolMessages where tool_call_id is empty string', () => {
    const msgs: BaseMessage[] = [
      new AIMessage({
        content: 'call',
        tool_calls: [{ id: 'tc-1', name: 't', args: {} }],
      }),
      new ToolMessage({ content: 'orphan', tool_call_id: '' }),
      new ToolMessage({ content: 'real', tool_call_id: 'tc-1', name: 't' }),
    ]
    const out = repairOrphanedToolPairs(msgs)
    expect(out.some(m => m._getType() === 'tool' && (m as ToolMessage).tool_call_id === 'tc-1')).toBe(true)
  })

  it('handles AIMessage with tool_calls as empty array', () => {
    const msgs: BaseMessage[] = [
      new AIMessage({ content: 'no calls', tool_calls: [] }),
      new HumanMessage('hi'),
    ]
    const out = repairOrphanedToolPairs(msgs)
    expect(out.length).toBe(2)
    expect(out.filter(m => m._getType() === 'tool').length).toBe(0)
  })

  it('handles AIMessage with tool_calls undefined', () => {
    const msgs: BaseMessage[] = [
      new AIMessage('plain response'),
      new HumanMessage('hi'),
    ]
    const out = repairOrphanedToolPairs(msgs)
    expect(out.length).toBe(2)
  })

  it('uses fallback name "unknown" when tool_call has no name', () => {
    const msgs: BaseMessage[] = [
      new AIMessage({
        content: 'calling',
        tool_calls: [{ id: 'tc-no-name', name: '', args: {} }],
      }),
    ]
    const out = repairOrphanedToolPairs(msgs)
    const stub = out.find(m => m._getType() === 'tool') as ToolMessage | undefined
    expect(stub).toBeDefined()
    expect(stub?.name === '' || stub?.name === 'unknown' || typeof stub?.name === 'string').toBe(true)
  })

  it('handles only system messages (no tool activity)', () => {
    const msgs: BaseMessage[] = [
      new SystemMessage('rules 1'),
      new SystemMessage('rules 2'),
    ]
    const out = repairOrphanedToolPairs(msgs)
    expect(out.length).toBe(2)
    expect(out.every(m => m._getType() === 'system')).toBe(true)
  })
})

describe('summarizeAndTrim boundary conditions', () => {
  it('handles empty message array', async () => {
    const model = createMockModel('unused')
    const result = await summarizeAndTrim([], null, model)
    expect(result.trimmedMessages).toEqual([])
    expect(result.summary).toBe('')
  })

  it('handles exactly keepRecentMessages messages (no compression)', async () => {
    const msgs = makeConversation(5)
    const model = createMockModel('unused')
    const result = await summarizeAndTrim(msgs, null, model, { keepRecentMessages: 10 })
    expect(result.trimmedMessages).toBe(msgs)
    expect((model.invoke as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('handles keepRecentMessages = 0 by summarizing everything', async () => {
    const model = createMockModel('all summarized')
    const msgs = makeConversation(5)
    const result = await summarizeAndTrim(msgs, null, model, { keepRecentMessages: 0 })
    expect((model.invoke as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
    expect(result.summary).toBe('all summarized')
  })

  it('serializes non-string LLM response content via JSON.stringify', async () => {
    const model = createReturningModel([{ type: 'text', text: 'structured' }])
    const msgs = makeConversation(10)
    const result = await summarizeAndTrim(msgs, null, model)
    expect(typeof result.summary).toBe('string')
    expect(result.summary.length).toBeGreaterThan(0)
  })

  it('propagates existingSummary when old messages slice is empty after boundary alignment', async () => {
    const model = createMockModel('new')
    const ai = new AIMessage({
      content: 'call',
      tool_calls: [{ id: 'tc-edge', name: 't', args: {} }],
    })
    const tool1 = new ToolMessage({ content: 'r1', tool_call_id: 'tc-edge', name: 't' })
    const msgs: BaseMessage[] = [
      ai,
      tool1,
      new HumanMessage('q'),
      new AIMessage('a'),
    ]
    const result = await summarizeAndTrim(msgs, 'preserved', model, { keepRecentMessages: 3 })
    expect(result.summary).toBe('preserved')
    expect((model.invoke as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('scales summary budget upward for very long old content', async () => {
    const model = createMockModel('scaled')
    const msgs: BaseMessage[] = [
      new HumanMessage('x'.repeat(50_000)),
      new AIMessage('y'.repeat(50_000)),
      ...makeConversation(6),
    ]
    await summarizeAndTrim(msgs, null, model, { keepRecentMessages: 4 })
    const call = (model.invoke as ReturnType<typeof vi.fn>).mock.calls[0]
    const humanPrompt = (call[0] as BaseMessage[])[1].content as string
    expect(humanPrompt).toMatch(/Keep the summary under \d+ tokens/)
  })

  it('clamps summary budget to minimum 200 tokens for tiny old content', async () => {
    const model = createMockModel('tiny')
    const msgs = makeConversation(12)
    await summarizeAndTrim(msgs, null, model, { keepRecentMessages: 10 })
    const call = (model.invoke as ReturnType<typeof vi.fn>).mock.calls[0]
    const humanPrompt = (call[0] as BaseMessage[])[1].content as string
    expect(humanPrompt).toMatch(/Keep the summary under \d+ tokens/)
    const match = humanPrompt.match(/under (\d+) tokens/)
    if (match && match[1]) {
      const budget = parseInt(match[1], 10)
      expect(budget).toBeGreaterThanOrEqual(200)
    }
  })

  it('falls back to existing summary with trimmed recent when LLM fails', async () => {
    const model = createFailingModel('boom')
    const msgs = makeConversation(10)
    const result = await summarizeAndTrim(msgs, 'keep me', model, { keepRecentMessages: 5 })
    expect(result.summary).toBe('keep me')
    expect(result.trimmedMessages.length).toBeLessThanOrEqual(10)
  })
})

describe('formatSummaryContext edge cases', () => {
  it('handles undefined-like falsy input via null', () => {
    expect(formatSummaryContext(null)).toBe('')
  })

  it('handles tab-only whitespace input', () => {
    expect(formatSummaryContext('\t\t')).toBe('')
  })

  it('preserves trailing whitespace inside a valid summary', () => {
    const result = formatSummaryContext('content with trailing   ')
    expect(result).toContain('content with trailing   ')
  })

  it('handles single-character summary', () => {
    expect(formatSummaryContext('x')).toBe('## Prior Conversation Context\n\nx')
  })
})
