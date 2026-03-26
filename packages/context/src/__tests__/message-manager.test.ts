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
  type MessageManagerConfig,
} from '../message-manager.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockModel(response: string): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue(new AIMessage(response)),
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
    msgs.push(new HumanMessage(`Question ${i}`))
    msgs.push(new AIMessage(`Answer ${i}`))
  }
  return msgs
}

function makeAIWithToolCalls(content: string, ...callIds: string[]): AIMessage {
  return new AIMessage({
    content,
    tool_calls: callIds.map(id => ({ id, name: 'test_tool', args: {} })),
  })
}

function makeToolMessage(callId: string, content: string): ToolMessage {
  return new ToolMessage({ content, tool_call_id: callId, name: 'test_tool' })
}

// ---------------------------------------------------------------------------
// shouldSummarize
// ---------------------------------------------------------------------------

describe('shouldSummarize', () => {
  it('returns false when message count and tokens are under limits', () => {
    const msgs = makeConversation(3) // 6 messages, default max is 30
    expect(shouldSummarize(msgs)).toBe(false)
  })

  it('returns true when message count exceeds maxMessages', () => {
    const msgs = makeConversation(16) // 32 messages > default 30
    expect(shouldSummarize(msgs)).toBe(true)
  })

  it('returns true when estimated tokens exceed maxMessageTokens', () => {
    // Default: charsPerToken=4, maxMessageTokens=12000 => charThreshold=48000
    const longContent = 'x'.repeat(50_000)
    const msgs = [new HumanMessage(longContent)]
    expect(shouldSummarize(msgs)).toBe(true)
  })

  it('returns false when tokens are just under the limit', () => {
    // 47000 chars / 4 = 11750 tokens < 12000
    const msgs = [new HumanMessage('x'.repeat(47_000))]
    expect(shouldSummarize(msgs)).toBe(false)
  })

  it('respects custom maxMessages config', () => {
    const msgs = makeConversation(3) // 6 messages
    expect(shouldSummarize(msgs, { maxMessages: 5 })).toBe(true)
    expect(shouldSummarize(msgs, { maxMessages: 10 })).toBe(false)
  })

  it('respects custom maxMessageTokens and charsPerToken', () => {
    // 100 chars / 2 charsPerToken = 50 tokens
    const msgs = [new HumanMessage('x'.repeat(100))]
    expect(shouldSummarize(msgs, { maxMessageTokens: 40, charsPerToken: 2 })).toBe(true)
    expect(shouldSummarize(msgs, { maxMessageTokens: 60, charsPerToken: 2 })).toBe(false)
  })

  it('returns false for empty messages', () => {
    expect(shouldSummarize([])).toBe(false)
  })

  it('handles messages with non-string content', () => {
    const msg = new HumanMessage({
      content: [{ type: 'text' as const, text: 'x'.repeat(50_000) }],
    })
    // JSON.stringify of content array will be longer, pushing over token limit
    expect(shouldSummarize([msg])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// pruneToolResults
// ---------------------------------------------------------------------------

describe('pruneToolResults', () => {
  it('does nothing when there are no tool messages', () => {
    const msgs = makeConversation(3)
    const result = pruneToolResults(msgs)
    expect(result).toBe(msgs) // no change => returns original array reference? Actually returns new mapped array
    expect(result).toEqual(msgs)
  })

  it('preserves recent tool results within preserveRecentToolResults limit', () => {
    // Default preserveRecentToolResults=6
    const msgs: BaseMessage[] = []
    for (let i = 0; i < 5; i++) {
      msgs.push(makeAIWithToolCalls(`call ${i}`, `tc-${i}`))
      msgs.push(makeToolMessage(`tc-${i}`, `result ${i}`))
    }
    // 5 tool messages, all within default preserve limit of 6
    const result = pruneToolResults(msgs)
    // All should be preserved (no pruning)
    const prunedCount = result.filter(m => {
      const c = typeof m.content === 'string' ? m.content : ''
      return c.includes('[Tool result pruned]')
    }).length
    expect(prunedCount).toBe(0)
  })

  it('prunes old tool results beyond preserveRecentToolResults limit', () => {
    const msgs: BaseMessage[] = []
    for (let i = 0; i < 10; i++) {
      msgs.push(makeAIWithToolCalls(`call ${i}`, `tc-${i}`))
      msgs.push(makeToolMessage(`tc-${i}`, 'A'.repeat(200)))
    }
    // 10 tool messages, default preserve=6, so first 4 should be pruned
    const result = pruneToolResults(msgs)
    const prunedMsgs = result.filter(m => {
      const c = typeof m.content === 'string' ? m.content : ''
      return c.includes('[Tool result pruned]')
    })
    expect(prunedMsgs.length).toBe(4)
  })

  it('truncates long tool result content with preview', () => {
    const msgs: BaseMessage[] = [
      makeAIWithToolCalls('call', 'tc-old'),
      makeToolMessage('tc-old', 'Z'.repeat(300)),
      // Need 6 more tool messages to push tc-old out of preserve window
      ...Array.from({ length: 6 }, (_, i) => [
        makeAIWithToolCalls(`call-${i}`, `tc-new-${i}`),
        makeToolMessage(`tc-new-${i}`, `result ${i}`),
      ]).flat(),
    ]

    const result = pruneToolResults(msgs)
    const prunedMsg = result[1] as ToolMessage
    const content = prunedMsg.content as string
    expect(content).toContain('[Tool result pruned]')
    expect(content).toContain('...[pruned]')
    // Default prunedToolResultMaxChars=120, so preview is truncated
    expect(content.length).toBeLessThan(300)
  })

  it('keeps short tool results as-is (just adds prefix)', () => {
    const msgs: BaseMessage[] = [
      makeAIWithToolCalls('call', 'tc-old'),
      makeToolMessage('tc-old', 'short'),
      ...Array.from({ length: 6 }, (_, i) => [
        makeAIWithToolCalls(`call-${i}`, `tc-new-${i}`),
        makeToolMessage(`tc-new-${i}`, `result ${i}`),
      ]).flat(),
    ]

    const result = pruneToolResults(msgs)
    const prunedMsg = result[1] as ToolMessage
    const content = prunedMsg.content as string
    expect(content).toBe('[Tool result pruned] short')
    expect(content).not.toContain('...[pruned]')
  })

  it('preserves tool_call_id and name on pruned messages', () => {
    const msgs: BaseMessage[] = [
      makeAIWithToolCalls('call', 'tc-preserve-id'),
      new ToolMessage({ content: 'x'.repeat(200), tool_call_id: 'tc-preserve-id', name: 'my_tool' }),
      ...Array.from({ length: 6 }, (_, i) => [
        makeAIWithToolCalls(`c-${i}`, `tc-r-${i}`),
        makeToolMessage(`tc-r-${i}`, `r-${i}`),
      ]).flat(),
    ]

    const result = pruneToolResults(msgs)
    const pruned = result[1] as ToolMessage
    expect(pruned.tool_call_id).toBe('tc-preserve-id')
    expect(pruned.name).toBe('my_tool')
  })

  it('respects custom preserveRecentToolResults', () => {
    const msgs: BaseMessage[] = []
    for (let i = 0; i < 5; i++) {
      msgs.push(makeAIWithToolCalls(`c-${i}`, `tc-${i}`))
      msgs.push(makeToolMessage(`tc-${i}`, 'A'.repeat(200)))
    }
    // preserve only 2 => prune 3
    const result = pruneToolResults(msgs, { preserveRecentToolResults: 2 })
    const prunedCount = result.filter(m => {
      const c = typeof m.content === 'string' ? m.content : ''
      return c.includes('[Tool result pruned]')
    }).length
    expect(prunedCount).toBe(3)
  })

  it('respects custom prunedToolResultMaxChars', () => {
    const msgs: BaseMessage[] = [
      makeAIWithToolCalls('call', 'tc-old'),
      makeToolMessage('tc-old', 'Z'.repeat(200)),
      ...Array.from({ length: 6 }, (_, i) => [
        makeAIWithToolCalls(`c-${i}`, `tc-n-${i}`),
        makeToolMessage(`tc-n-${i}`, `r-${i}`),
      ]).flat(),
    ]

    const result = pruneToolResults(msgs, { prunedToolResultMaxChars: 50 })
    const pruned = result[1] as ToolMessage
    const content = pruned.content as string
    // Preview should be limited to 50 chars + "...[pruned]"
    expect(content).toContain('...[pruned]')
  })

  it('returns same array reference when no tool messages need pruning', () => {
    const msgs = makeConversation(3) // no tool messages at all
    const result = pruneToolResults(msgs)
    // indicesToPrune.size === 0, so returns msgs directly
    expect(result).toBe(msgs)
  })
})

// ---------------------------------------------------------------------------
// repairOrphanedToolPairs
// ---------------------------------------------------------------------------

describe('repairOrphanedToolPairs', () => {
  it('removes orphaned tool messages with no matching AI tool_call', () => {
    const msgs: BaseMessage[] = [
      new HumanMessage('start'),
      new ToolMessage({ content: 'orphan', tool_call_id: 'no-match', name: 'ghost' }),
      new AIMessage('end'),
    ]

    const result = repairOrphanedToolPairs(msgs)
    const toolMsgs = result.filter(m => m._getType() === 'tool')
    expect(toolMsgs.length).toBe(0)
  })

  it('inserts stub for unanswered tool calls', () => {
    const msgs: BaseMessage[] = [
      new HumanMessage('start'),
      makeAIWithToolCalls('calling', 'unanswered-1'),
      new AIMessage('moving on'),
    ]

    const result = repairOrphanedToolPairs(msgs)
    const toolMsgs = result.filter(m => m._getType() === 'tool')
    expect(toolMsgs.length).toBe(1)
    const stub = toolMsgs[0] as ToolMessage
    expect(stub.tool_call_id).toBe('unanswered-1')
    expect((stub.content as string)).toContain('unavailable')
  })

  it('does not duplicate stubs for the same unanswered call', () => {
    const msgs: BaseMessage[] = [
      makeAIWithToolCalls('call', 'dup-test'),
      new AIMessage('continue'),
    ]

    const result = repairOrphanedToolPairs(msgs)
    const stubs = result.filter(m => {
      if (m._getType() !== 'tool') return false
      return (m as ToolMessage).tool_call_id === 'dup-test'
    })
    expect(stubs.length).toBe(1)
  })

  it('preserves properly paired tool call/result', () => {
    const msgs: BaseMessage[] = [
      new HumanMessage('go'),
      makeAIWithToolCalls('calling', 'paired-1'),
      makeToolMessage('paired-1', 'result here'),
      new AIMessage('done'),
    ]

    const result = repairOrphanedToolPairs(msgs)
    expect(result.length).toBe(msgs.length)
    const tool = result.find(m => m._getType() === 'tool') as ToolMessage
    expect(tool.tool_call_id).toBe('paired-1')
    expect(tool.content).toBe('result here')
  })

  it('handles AI message with multiple tool calls, some answered some not', () => {
    const msgs: BaseMessage[] = [
      makeAIWithToolCalls('multi-call', 'answered-1', 'unanswered-2'),
      makeToolMessage('answered-1', 'got it'),
      new AIMessage('next'),
    ]

    const result = repairOrphanedToolPairs(msgs)
    const toolMsgs = result.filter(m => m._getType() === 'tool')
    expect(toolMsgs.length).toBe(2)
    const ids = toolMsgs.map(m => (m as ToolMessage).tool_call_id)
    expect(ids).toContain('answered-1')
    expect(ids).toContain('unanswered-2')
  })

  it('handles empty messages', () => {
    expect(repairOrphanedToolPairs([])).toEqual([])
  })

  it('handles messages with no tool interactions', () => {
    const msgs = makeConversation(3)
    const result = repairOrphanedToolPairs(msgs)
    expect(result.length).toBe(msgs.length)
  })

  it('uses tool name from tool_call for stub when available', () => {
    const ai = new AIMessage({
      content: 'calling',
      tool_calls: [{ id: 'stub-name-test', name: 'my_special_tool', args: {} }],
    })
    const msgs: BaseMessage[] = [ai]

    const result = repairOrphanedToolPairs(msgs)
    const stub = result.find(m => m._getType() === 'tool') as ToolMessage
    expect(stub.name).toBe('my_special_tool')
  })
})

// ---------------------------------------------------------------------------
// summarizeAndTrim
// ---------------------------------------------------------------------------

describe('summarizeAndTrim', () => {
  it('returns messages unchanged when count <= keepRecentMessages', async () => {
    const msgs = makeConversation(3) // 6 messages, default keep=10
    const model = createMockModel('should not be called')

    const result = await summarizeAndTrim(msgs, null, model)

    expect(result.trimmedMessages).toBe(msgs)
    expect(result.summary).toBe('')
    expect((model.invoke as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('preserves existing summary when messages are short enough', async () => {
    const msgs = makeConversation(3)
    const model = createMockModel('unused')

    const result = await summarizeAndTrim(msgs, 'prior context', model)

    expect(result.summary).toBe('prior context')
  })

  it('summarizes old messages and keeps recent ones', async () => {
    const summaryText = '## Goal\nBuild auth module'
    const model = createMockModel(summaryText)
    const msgs = makeConversation(10) // 20 messages, keep default=10

    const result = await summarizeAndTrim(msgs, null, model)

    expect(result.summary).toBe(summaryText)
    expect(result.trimmedMessages.length).toBeLessThanOrEqual(10)
    expect((model.invoke as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
  })

  it('includes existing summary in the update prompt', async () => {
    const model = createMockModel('updated summary')
    const msgs = makeConversation(10)

    await summarizeAndTrim(msgs, 'old context here', model)

    const call = (model.invoke as ReturnType<typeof vi.fn>).mock.calls[0]
    const invokeMessages = call[0] as BaseMessage[]
    const humanPrompt = invokeMessages[1].content as string
    expect(humanPrompt).toContain('Existing summary to UPDATE')
    expect(humanPrompt).toContain('old context here')
  })

  it('sends a fresh summarization prompt when no existing summary', async () => {
    const model = createMockModel('new summary')
    const msgs = makeConversation(10)

    await summarizeAndTrim(msgs, null, model)

    const call = (model.invoke as ReturnType<typeof vi.fn>).mock.calls[0]
    const invokeMessages = call[0] as BaseMessage[]
    const humanPrompt = invokeMessages[1].content as string
    expect(humanPrompt).toContain('Conversation to summarize')
    expect(humanPrompt).not.toContain('Existing summary')
  })

  it('falls back gracefully on LLM failure', async () => {
    const model = createFailingModel('network error')
    const msgs = makeConversation(10)

    const result = await summarizeAndTrim(msgs, 'fallback context', model)

    expect(result.summary).toBe('fallback context')
    expect(result.trimmedMessages.length).toBeLessThanOrEqual(10)
  })

  it('returns empty summary on LLM failure with no existing summary', async () => {
    const model = createFailingModel('timeout')
    const msgs = makeConversation(10)

    const result = await summarizeAndTrim(msgs, null, model)

    expect(result.summary).toBe('')
  })

  it('respects custom keepRecentMessages', async () => {
    const model = createMockModel('summary')
    const msgs = makeConversation(10) // 20 messages

    const result = await summarizeAndTrim(msgs, null, model, { keepRecentMessages: 5 })

    expect(result.trimmedMessages.length).toBeLessThanOrEqual(5 + 2) // some tolerance for boundary alignment
  })

  it('runs tool result pruning before summarization', async () => {
    const model = createMockModel('summary')
    const msgs: BaseMessage[] = [
      // Old tool results (should get pruned)
      ...Array.from({ length: 10 }, (_, i) => [
        makeAIWithToolCalls(`call ${i}`, `tc-${i}`),
        makeToolMessage(`tc-${i}`, 'X'.repeat(500)),
      ]).flat(),
      // Recent messages (within keep window)
      ...makeConversation(5),
    ]

    const result = await summarizeAndTrim(msgs, null, model, { keepRecentMessages: 10 })

    // Should complete without error and produce trimmed output
    expect(result.trimmedMessages.length).toBeLessThanOrEqual(12)
    expect(result.summary).toBe('summary')
  })

  it('repairs orphaned tool pairs in the recent section', async () => {
    const model = createMockModel('summary')
    // Build messages where splitting will orphan a tool message
    const msgs: BaseMessage[] = [
      ...makeConversation(8), // 16 old messages
      // Recent section has a tool message whose AI parent is in the old section
      makeAIWithToolCalls('recent call', 'tc-recent'),
      makeToolMessage('tc-recent', 'recent result'),
      new HumanMessage('final'),
      new AIMessage('done'),
    ]

    const result = await summarizeAndTrim(msgs, null, model, { keepRecentMessages: 4 })

    // Should not crash, orphaned pairs should be handled
    expect(result.trimmedMessages.length).toBeGreaterThan(0)
  })

  it('handles messages with non-string content during formatting', async () => {
    const model = createMockModel('summary')
    const msgs: BaseMessage[] = [
      ...makeConversation(8),
      new HumanMessage({
        content: [{ type: 'text' as const, text: 'complex content' }],
      }),
      ...makeConversation(3),
    ]

    const result = await summarizeAndTrim(msgs, null, model, { keepRecentMessages: 6 })

    expect(result.summary).toBe('summary')
  })

  it('truncates old message content to 500 chars in the summary prompt', async () => {
    const model = createMockModel('summary')
    const msgs: BaseMessage[] = [
      new HumanMessage('A'.repeat(1000)),
      new AIMessage('B'.repeat(1000)),
      ...makeConversation(8), // pad to exceed keepRecentMessages
    ]

    await summarizeAndTrim(msgs, null, model, { keepRecentMessages: 10 })

    const call = (model.invoke as ReturnType<typeof vi.fn>).mock.calls[0]
    const invokeMessages = call[0] as BaseMessage[]
    const humanPrompt = invokeMessages[1].content as string
    // Each old message content should be truncated to 500 chars max
    expect(humanPrompt).not.toContain('A'.repeat(600))
  })
})

// ---------------------------------------------------------------------------
// formatSummaryContext
// ---------------------------------------------------------------------------

describe('formatSummaryContext', () => {
  it('returns empty string for null summary', () => {
    expect(formatSummaryContext(null)).toBe('')
  })

  it('returns empty string for empty summary', () => {
    expect(formatSummaryContext('')).toBe('')
  })

  it('returns empty string for whitespace-only summary', () => {
    expect(formatSummaryContext('   \n  ')).toBe('')
  })

  it('formats a valid summary with header', () => {
    const result = formatSummaryContext('Build auth with JWT')
    expect(result).toBe('## Prior Conversation Context\n\nBuild auth with JWT')
  })

  it('preserves multi-line summaries', () => {
    const summary = '## Goal\nBuild auth\n\n## Progress\n- Done: JWT'
    const result = formatSummaryContext(summary)
    expect(result).toContain(summary)
    expect(result).toContain('## Prior Conversation Context')
  })
})
