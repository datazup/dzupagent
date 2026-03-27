import { describe, it, expect, vi } from 'vitest'
import {
  HumanMessage,
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { autoCompress, FrozenSnapshot } from '../auto-compress.js'
import type { AutoCompressConfig } from '../auto-compress.js'

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

function makeAIWithToolCalls(content: string, callId: string): AIMessage {
  return new AIMessage({
    content,
    tool_calls: [{ id: callId, name: 'test_tool', args: {} }],
  })
}

function makeToolMessage(callId: string, content: string): ToolMessage {
  return new ToolMessage({ content, tool_call_id: callId, name: 'test_tool' })
}

// ---------------------------------------------------------------------------
// autoCompress
// ---------------------------------------------------------------------------

describe('autoCompress', () => {
  it('returns messages unchanged when below threshold', async () => {
    const msgs = makeConversation(3) // 6 messages, default max=30
    const model = createMockModel('unused')

    const result = await autoCompress(msgs, null, model)

    expect(result.compressed).toBe(false)
    expect(result.messages).toBe(msgs)
    expect(result.summary).toBeNull()
  })

  it('compresses when message count exceeds maxMessages', async () => {
    const model = createMockModel('## Goal\nSummarized content')
    const msgs = makeConversation(16) // 32 messages > default 30

    const result = await autoCompress(msgs, null, model)

    expect(result.compressed).toBe(true)
    expect(result.messages.length).toBeLessThan(msgs.length)
    expect(result.summary).toBe('## Goal\nSummarized content')
  })

  it('compresses when token budget is exceeded', async () => {
    const model = createMockModel('compressed summary')
    // Generate messages with enough content to exceed 12000 token budget
    const msgs: BaseMessage[] = []
    for (let i = 0; i < 10; i++) {
      msgs.push(new HumanMessage('x'.repeat(5000)))
      msgs.push(new AIMessage('y'.repeat(5000)))
    }

    const result = await autoCompress(msgs, null, model)

    expect(result.compressed).toBe(true)
    expect(result.summary).toBe('compressed summary')
  })

  it('preserves existing summary when no compression needed', async () => {
    const msgs = makeConversation(3)
    const model = createMockModel('unused')

    const result = await autoCompress(msgs, 'prior summary', model)

    expect(result.compressed).toBe(false)
    expect(result.summary).toBe('prior summary')
  })

  it('updates existing summary when compression triggers', async () => {
    const model = createMockModel('updated summary')
    const msgs = makeConversation(16) // exceed threshold

    const result = await autoCompress(msgs, 'old summary', model)

    expect(result.compressed).toBe(true)
    expect(result.summary).toBe('updated summary')
  })

  it('calls onBeforeSummarize hook with old messages before compression', async () => {
    const hook = vi.fn()
    const model = createMockModel('summary')
    const msgs = makeConversation(16)

    await autoCompress(msgs, null, model, { onBeforeSummarize: hook })

    expect(hook).toHaveBeenCalledTimes(1)
    const oldMsgs = hook.mock.calls[0]![0] as BaseMessage[]
    expect(oldMsgs.length).toBeGreaterThan(0)
    // old messages should be the first portion (messages.length - keepRecent)
    expect(oldMsgs.length).toBe(msgs.length - 10) // default keepRecentMessages=10
  })

  it('does not call onBeforeSummarize when messages <= keepRecentMessages', async () => {
    const hook = vi.fn()
    const model = createMockModel('summary')
    // 12 messages > maxMessages threshold of 5, but only 12 messages with keep=15
    const msgs = makeConversation(6) // 12 messages

    await autoCompress(msgs, null, model, {
      maxMessages: 5,
      keepRecentMessages: 15,
      onBeforeSummarize: hook,
    })

    // shouldSummarize triggers (12 > 5), but messages.length (12) <= keep (15)
    // so the hook is not called
    expect(hook).not.toHaveBeenCalled()
  })

  it('continues compression even if onBeforeSummarize throws', async () => {
    const hook = vi.fn().mockRejectedValue(new Error('hook failed'))
    const model = createMockModel('summary despite error')
    const msgs = makeConversation(16)

    const result = await autoCompress(msgs, null, model, { onBeforeSummarize: hook })

    expect(result.compressed).toBe(true)
    expect(result.summary).toBe('summary despite error')
  })

  it('handles LLM failure gracefully during compression', async () => {
    const model = createFailingModel('LLM down')
    const msgs = makeConversation(16)

    const result = await autoCompress(msgs, 'fallback summary', model)

    expect(result.compressed).toBe(true)
    expect(result.summary).toBe('fallback summary')
    expect(result.messages.length).toBeLessThan(msgs.length)
  })

  it('respects custom keepRecentMessages', async () => {
    const model = createMockModel('summary')
    const msgs = makeConversation(16)

    const result = await autoCompress(msgs, null, model, { keepRecentMessages: 5 })

    expect(result.compressed).toBe(true)
    expect(result.messages.length).toBeLessThanOrEqual(7) // 5 + tolerance for boundary alignment
  })

  it('respects custom maxMessages threshold', async () => {
    const model = createMockModel('summary')
    const msgs = makeConversation(5) // 10 messages

    // With maxMessages=8, 10 > 8 triggers compression
    const result = await autoCompress(msgs, null, model, { maxMessages: 8 })

    expect(result.compressed).toBe(true)
  })

  it('handles tool messages in the compression pipeline', async () => {
    const model = createMockModel('summary with tools')
    const msgs: BaseMessage[] = [
      ...Array.from({ length: 10 }, (_, i) => [
        makeAIWithToolCalls(`call ${i}`, `tc-${i}`),
        makeToolMessage(`tc-${i}`, 'X'.repeat(200)),
      ]).flat(),
      ...makeConversation(6),
    ]

    const result = await autoCompress(msgs, null, model, { maxMessages: 10 })

    expect(result.compressed).toBe(true)
    expect(result.messages.length).toBeLessThan(msgs.length)
  })

  it('handles empty messages without error', async () => {
    const model = createMockModel('unused')

    const result = await autoCompress([], null, model)

    expect(result.compressed).toBe(false)
    expect(result.messages).toEqual([])
  })

  it('returns compressed=true even when summary is empty on LLM failure', async () => {
    const model = createFailingModel('timeout')
    const msgs = makeConversation(16)

    const result = await autoCompress(msgs, null, model)

    expect(result.compressed).toBe(true)
    expect(result.summary).toBe('')
  })
})

// ---------------------------------------------------------------------------
// FrozenSnapshot
// ---------------------------------------------------------------------------

describe('FrozenSnapshot', () => {
  it('is not active by default', () => {
    const snapshot = new FrozenSnapshot()
    expect(snapshot.isActive()).toBe(false)
    expect(snapshot.get()).toBeNull()
  })

  it('captures context when frozen', () => {
    const snapshot = new FrozenSnapshot()
    snapshot.freeze('system prompt + memory context')

    expect(snapshot.isActive()).toBe(true)
    expect(snapshot.get()).toBe('system prompt + memory context')
  })

  it('returns frozen context on subsequent calls', () => {
    const snapshot = new FrozenSnapshot()
    snapshot.freeze('initial context')

    expect(snapshot.get()).toBe('initial context')
    expect(snapshot.get()).toBe('initial context')
    expect(snapshot.isActive()).toBe(true)
  })

  it('can be thawed to clear the snapshot', () => {
    const snapshot = new FrozenSnapshot()
    snapshot.freeze('context')
    expect(snapshot.isActive()).toBe(true)

    snapshot.thaw()

    expect(snapshot.isActive()).toBe(false)
    expect(snapshot.get()).toBeNull()
  })

  it('can be re-frozen after thawing', () => {
    const snapshot = new FrozenSnapshot()
    snapshot.freeze('first context')
    snapshot.thaw()
    snapshot.freeze('second context')

    expect(snapshot.isActive()).toBe(true)
    expect(snapshot.get()).toBe('second context')
  })

  it('overwrites previous frozen context when frozen again', () => {
    const snapshot = new FrozenSnapshot()
    snapshot.freeze('first')
    snapshot.freeze('second')

    expect(snapshot.get()).toBe('second')
    expect(snapshot.isActive()).toBe(true)
  })

  it('handles empty string context', () => {
    const snapshot = new FrozenSnapshot()
    snapshot.freeze('')

    expect(snapshot.isActive()).toBe(true)
    expect(snapshot.get()).toBe('')
  })
})
