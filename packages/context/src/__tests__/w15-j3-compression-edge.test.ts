import { describe, it, expect, vi } from 'vitest'
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { autoCompress, FrozenSnapshot } from '../auto-compress.js'
import {
  compressToLevel,
  compressToBudget,
  selectCompressionLevel,
} from '../progressive-compress.js'

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
    msgs.push(new HumanMessage(`Q${i}`))
    msgs.push(new AIMessage(`A${i}`))
  }
  return msgs
}

describe('autoCompress empty and boundary conditions', () => {
  it('handles empty message array (below threshold, no compression)', async () => {
    const model = createMockModel('unused')
    const result = await autoCompress([], null, model)
    expect(result.compressed).toBe(false)
    expect(result.messages).toEqual([])
    expect(result.summary).toBeNull()
  })

  it('handles only system messages (no compression triggered)', async () => {
    const msgs: BaseMessage[] = [
      new SystemMessage('one'),
      new SystemMessage('two'),
    ]
    const model = createMockModel('unused')
    const result = await autoCompress(msgs, null, model)
    expect(result.compressed).toBe(false)
    expect(result.messages).toBe(msgs)
  })

  it('skips onBeforeSummarize hook when threshold not reached', async () => {
    const hook = vi.fn().mockResolvedValue(undefined)
    const msgs = makeConversation(3)
    const model = createMockModel('unused')
    await autoCompress(msgs, null, model, { onBeforeSummarize: hook })
    expect(hook).not.toHaveBeenCalled()
  })

  it('invokes onBeforeSummarize hook when compression triggers', async () => {
    const hook = vi.fn().mockResolvedValue(undefined)
    const msgs = makeConversation(20)
    const model = createMockModel('summarized')
    await autoCompress(msgs, null, model, { onBeforeSummarize: hook, keepRecentMessages: 5 })
    expect(hook).toHaveBeenCalled()
  })

  it('swallows hook error and continues compression', async () => {
    const hook = vi.fn().mockRejectedValue(new Error('hook boom'))
    const msgs = makeConversation(20)
    const model = createMockModel('summarized anyway')
    const result = await autoCompress(msgs, null, model, { onBeforeSummarize: hook })
    expect(result.compressed).toBe(true)
  })

  it('swallows synchronous hook error', async () => {
    const hook = vi.fn(() => {
      throw new Error('sync boom')
    })
    const msgs = makeConversation(20)
    const model = createMockModel('ok')
    const result = await autoCompress(msgs, null, model, { onBeforeSummarize: hook })
    expect(result.compressed).toBe(true)
  })

  it('skips hook when messages.length <= keepRecentMessages', async () => {
    const hook = vi.fn()
    const msgs: BaseMessage[] = []
    for (let i = 0; i < 40; i++) {
      msgs.push(new HumanMessage('x'))
    }
    const model = createMockModel('ok')
    await autoCompress(msgs, null, model, {
      onBeforeSummarize: hook,
      keepRecentMessages: 40,
      maxMessages: 20,
    })
    expect(hook).not.toHaveBeenCalled()
  })
})

describe('FrozenSnapshot lifecycle', () => {
  it('starts inactive with null content', () => {
    const snap = new FrozenSnapshot()
    expect(snap.isActive()).toBe(false)
    expect(snap.get()).toBeNull()
  })

  it('becomes active after freezing', () => {
    const snap = new FrozenSnapshot()
    snap.freeze('frozen content')
    expect(snap.isActive()).toBe(true)
    expect(snap.get()).toBe('frozen content')
  })

  it('returns the most recently frozen content', () => {
    const snap = new FrozenSnapshot()
    snap.freeze('first')
    snap.freeze('second')
    expect(snap.get()).toBe('second')
  })

  it('resets to inactive after thaw', () => {
    const snap = new FrozenSnapshot()
    snap.freeze('to be thawed')
    snap.thaw()
    expect(snap.isActive()).toBe(false)
    expect(snap.get()).toBeNull()
  })

  it('allows re-freezing after thaw', () => {
    const snap = new FrozenSnapshot()
    snap.freeze('a')
    snap.thaw()
    snap.freeze('b')
    expect(snap.isActive()).toBe(true)
    expect(snap.get()).toBe('b')
  })

  it('thaw on never-frozen snapshot is a no-op', () => {
    const snap = new FrozenSnapshot()
    snap.thaw()
    expect(snap.isActive()).toBe(false)
    expect(snap.get()).toBeNull()
  })

  it('freezes empty string as valid content', () => {
    const snap = new FrozenSnapshot()
    snap.freeze('')
    expect(snap.isActive()).toBe(true)
    expect(snap.get()).toBe('')
  })
})

describe('compressToLevel level 0 no-op', () => {
  it('returns level 0 result unchanged for empty messages', async () => {
    const model = createMockModel('unused')
    const result = await compressToLevel([], 0, null, model)
    expect(result.level).toBe(0)
    expect(result.messages).toEqual([])
    expect(result.estimatedTokens).toBe(0)
    expect(result.ratio).toBe(0)
  })

  it('returns level 0 ratio 0 for a single short message', async () => {
    const model = createMockModel('unused')
    const msgs = [new HumanMessage('hi')]
    const result = await compressToLevel(msgs, 0, null, model)
    expect(result.level).toBe(0)
    expect(result.messages).toBe(msgs)
    expect(result.ratio).toBe(0)
  })

  it('preserves existingSummary at level 0', async () => {
    const model = createMockModel('unused')
    const result = await compressToLevel([], 0, 'prior', model)
    expect(result.summary).toBe('prior')
  })
})

describe('compressToLevel level 3 fallback on LLM failure', () => {
  it('returns level 3 with empty summary when LLM throws (inner swallow)', async () => {
    const model = createFailingModel('timeout')
    const msgs: BaseMessage[] = [
      new HumanMessage('Q'),
      new AIMessage('A'.repeat(2000)),
      ...makeConversation(15),
    ]
    const result = await compressToLevel(msgs, 3, null, model)
    expect(result.level).toBe(3)
    expect(result.summary).toBe('')
  })

  it('invokes onBeforeSummarize at level 3 with oldMessages slice', async () => {
    const hook = vi.fn().mockResolvedValue(undefined)
    const model = createMockModel('summary')
    const msgs = makeConversation(15)
    await compressToLevel(msgs, 3, null, model, {
      onBeforeSummarize: hook,
      keepRecentLevel3: 5,
    })
    expect(hook).toHaveBeenCalled()
  })

  it('skips onBeforeSummarize at level 3 when messages below keep threshold', async () => {
    const hook = vi.fn()
    const model = createMockModel('summary')
    const msgs = makeConversation(3)
    await compressToLevel(msgs, 3, null, model, {
      onBeforeSummarize: hook,
      keepRecentLevel3: 10,
    })
    expect(hook).not.toHaveBeenCalled()
  })

  it('swallows hook error at level 3', async () => {
    const hook = vi.fn().mockRejectedValue(new Error('hook err'))
    const model = createMockModel('summary')
    const msgs = makeConversation(15)
    const result = await compressToLevel(msgs, 3, null, model, {
      onBeforeSummarize: hook,
      keepRecentLevel3: 5,
    })
    expect(result.level).toBe(3)
  })
})

describe('compressToLevel level 4 ultra-compressed', () => {
  it('truncates summary longer than 500 chars', async () => {
    const model = createMockModel('unused')
    const longSummary = 'x'.repeat(800)
    const msgs = makeConversation(10)
    const result = await compressToLevel(msgs, 4, longSummary, model)
    expect(result.level).toBe(4)
    expect(result.summary?.length).toBeLessThanOrEqual(520)
    expect(result.summary).toContain('[truncated]')
  })

  it('preserves short summary at level 4', async () => {
    const model = createMockModel('unused')
    const shortSummary = 'short'
    const msgs = makeConversation(10)
    const result = await compressToLevel(msgs, 4, shortSummary, model)
    expect(result.summary).toBe('short')
  })

  it('passes through null summary at level 4', async () => {
    const model = createMockModel('unused')
    const msgs = makeConversation(10)
    const result = await compressToLevel(msgs, 4, null, model)
    expect(result.summary).toBeNull()
  })

  it('invokes onBeforeSummarize at level 4', async () => {
    const hook = vi.fn().mockResolvedValue(undefined)
    const model = createMockModel('ignored')
    const msgs = makeConversation(15)
    await compressToLevel(msgs, 4, null, model, {
      onBeforeSummarize: hook,
      keepRecentLevel4: 3,
    })
    expect(hook).toHaveBeenCalled()
  })

  it('swallows hook error at level 4', async () => {
    const hook = vi.fn().mockRejectedValue(new Error('err'))
    const model = createMockModel('unused')
    const msgs = makeConversation(10)
    const result = await compressToLevel(msgs, 4, null, model, {
      onBeforeSummarize: hook,
      keepRecentLevel4: 3,
    })
    expect(result.level).toBe(4)
  })

  it('reduces to keepRecentLevel4 messages', async () => {
    const model = createMockModel('unused')
    const msgs = makeConversation(20)
    const result = await compressToLevel(msgs, 4, null, model, { keepRecentLevel4: 3 })
    expect(result.messages.length).toBeLessThanOrEqual(4)
  })
})

describe('selectCompressionLevel thresholds', () => {
  it('returns 0 when tokens fit within budget', () => {
    const msgs = [new HumanMessage('x'.repeat(100))]
    expect(selectCompressionLevel(msgs, 10_000)).toBe(0)
  })

  it('returns 1 when slightly above budget but within level-1 threshold', () => {
    const msgs = [new HumanMessage('x'.repeat(5000))]
    const level = selectCompressionLevel(msgs, 1000)
    expect([1, 2, 3, 4]).toContain(level)
  })

  it('returns 4 for extremely large conversations', () => {
    const msgs = [new HumanMessage('x'.repeat(200_000))]
    expect(selectCompressionLevel(msgs, 100)).toBe(4)
  })

  it('handles empty messages as fitting any budget (level 0)', () => {
    expect(selectCompressionLevel([], 1000)).toBe(0)
  })

  it('respects custom charsPerToken', () => {
    const msgs = [new HumanMessage('x'.repeat(4000))]
    const level1 = selectCompressionLevel(msgs, 1000, 4)
    const level2 = selectCompressionLevel(msgs, 1000, 10)
    expect(level2).toBeLessThanOrEqual(level1)
  })
})

describe('compressToBudget end-to-end', () => {
  it('returns level 0 result when budget is generous', async () => {
    const model = createMockModel('unused')
    const msgs = makeConversation(3)
    const result = await compressToBudget(msgs, 100_000, null, model)
    expect(result.level).toBe(0)
  })

  it('compresses to level 4 when budget is tiny', async () => {
    const model = createMockModel('x')
    const msgs: BaseMessage[] = []
    for (let i = 0; i < 30; i++) {
      msgs.push(new HumanMessage('x'.repeat(1000)))
    }
    const result = await compressToBudget(msgs, 10, null, model)
    expect(result.level).toBeGreaterThanOrEqual(3)
  })

  it('handles empty messages at any budget', async () => {
    const model = createMockModel('unused')
    const result = await compressToBudget([], 1000, 'existing', model)
    expect(result.level).toBe(0)
    expect(result.messages).toEqual([])
  })
})

describe('compressToLevel level 2 AI trimming edge cases', () => {
  it('does not trim AI messages with tool_calls even if long', async () => {
    const model = createMockModel('unused')
    const longAiWithTools = new AIMessage({
      content: 'x'.repeat(2000),
      tool_calls: [{ id: 'tc-1', name: 't', args: {} }],
    })
    const tool = new ToolMessage({ content: 'r', tool_call_id: 'tc-1', name: 't' })
    const msgs: BaseMessage[] = [longAiWithTools, tool]
    const result = await compressToLevel(msgs, 2, null, model)
    expect((result.messages[0] as AIMessage).content).toBe('x'.repeat(2000))
  })

  it('leaves short AI messages untouched at level 2', async () => {
    const model = createMockModel('unused')
    const shortAi = new AIMessage('short response')
    const msgs: BaseMessage[] = [new HumanMessage('q'), shortAi]
    const result = await compressToLevel(msgs, 2, null, model)
    expect((result.messages[1] as AIMessage).content).toBe('short response')
  })

  it('trims very long AI responses at level 2', async () => {
    const model = createMockModel('unused')
    const longAi = new AIMessage('y'.repeat(3000))
    const msgs: BaseMessage[] = [new HumanMessage('q'), longAi]
    const result = await compressToLevel(msgs, 2, null, model, { aiResponseMaxChars: 500 })
    const trimmed = (result.messages[1] as AIMessage).content as string
    expect(trimmed).toContain('[trimmed]')
    expect(trimmed.length).toBeLessThan(3000)
  })

  it('preserves AI id and additional_kwargs when trimming', async () => {
    const model = createMockModel('unused')
    const longAi = new AIMessage({
      content: 'y'.repeat(3000),
      id: 'msg-id-1',
      additional_kwargs: { custom: 'value' },
    })
    const msgs: BaseMessage[] = [new HumanMessage('q'), longAi]
    const result = await compressToLevel(msgs, 2, null, model, { aiResponseMaxChars: 300 })
    const out = result.messages[1] as AIMessage
    expect(out.id).toBe('msg-id-1')
    expect(out.additional_kwargs.custom).toBe('value')
  })

  it('level 1 only (no AI trimming)', async () => {
    const model = createMockModel('unused')
    const longAi = new AIMessage('y'.repeat(3000))
    const result = await compressToLevel([longAi], 1, null, model)
    expect((result.messages[0] as AIMessage).content).toBe('y'.repeat(3000))
  })
})

describe('compressToLevel ratio computation', () => {
  it('reports ratio of 0 when compression did not reduce content', async () => {
    const model = createMockModel('unused')
    const msgs = [new HumanMessage('tiny')]
    const result = await compressToLevel(msgs, 1, null, model)
    expect(result.ratio).toBeGreaterThanOrEqual(0)
    expect(result.ratio).toBeLessThanOrEqual(1)
  })

  it('reports positive ratio after trimming long AI messages', async () => {
    const model = createMockModel('unused')
    const msgs: BaseMessage[] = [
      new AIMessage('y'.repeat(5000)),
      new AIMessage('z'.repeat(5000)),
    ]
    const result = await compressToLevel(msgs, 2, null, model, { aiResponseMaxChars: 200 })
    expect(result.ratio).toBeGreaterThan(0)
  })

  it('caps ratio at 1.0 for extreme compression', async () => {
    const model = createMockModel('x')
    const msgs: BaseMessage[] = []
    for (let i = 0; i < 20; i++) {
      msgs.push(new HumanMessage('x'.repeat(1000)))
    }
    const result = await compressToLevel(msgs, 4, null, model, { keepRecentLevel4: 1 })
    expect(result.ratio).toBeLessThanOrEqual(1)
    expect(result.ratio).toBeGreaterThanOrEqual(0)
  })
})
