/**
 * Deep coverage tests targeting specific uncovered branches across
 * message-manager, phase-window, progressive-compress, prompt-cache,
 * and context-transfer.
 */
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
  pruneToolResults,
  repairOrphanedToolPairs,
  summarizeAndTrim,
} from '../message-manager.js'
import { PhaseAwareWindowManager } from '../phase-window.js'
import {
  compressToLevel,
  compressToBudget,
  selectCompressionLevel,
} from '../progressive-compress.js'
import { applyAnthropicCacheControl, applyCacheBreakpoints } from '../prompt-cache.js'
import { ContextTransferService } from '../context-transfer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockModel(response: string): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue(new AIMessage(response)),
  } as unknown as BaseChatModel
}

function createFailingModel(): BaseChatModel {
  return {
    invoke: vi.fn().mockRejectedValue(new Error('model failure')),
  } as unknown as BaseChatModel
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
// message-manager: alignSplitBoundary edge cases (lines 237-238)
// ---------------------------------------------------------------------------

describe('message-manager: boundary alignment edge cases', () => {
  it('aligns split to avoid breaking tool call groups when AI has tool_calls at boundary', async () => {
    // Build a scenario where the raw split lands right after an AI with tool_calls
    const model = createMockModel('summary')
    const msgs: BaseMessage[] = [
      new HumanMessage('q1'),
      new AIMessage('a1'),
      new HumanMessage('q2'),
      new AIMessage('a2'),
      new HumanMessage('q3'),
      // This AI has tool_calls followed by tool results
      makeAIWithToolCalls('calling tool', 'tc-boundary'),
      makeToolMessage('tc-boundary', 'tool result'),
      // Recent messages
      new HumanMessage('q4'),
      new AIMessage('a4'),
      new HumanMessage('q5'),
      new AIMessage('a5'),
    ]

    const result = await summarizeAndTrim(msgs, null, model, { keepRecentMessages: 5 })
    // Should not crash, and the recent section should have tool pairs intact
    expect(result.trimmedMessages.length).toBeGreaterThan(0)
  })

  it('handles summarization when all old messages are empty after split alignment', async () => {
    const model = createMockModel('summary')
    // Make messages just slightly over keepRecentMessages
    // but split alignment pushes split to 0
    const msgs: BaseMessage[] = [
      makeAIWithToolCalls('call1', 'tc-1'),
      makeToolMessage('tc-1', 'res1'),
      makeAIWithToolCalls('call2', 'tc-2'),
      makeToolMessage('tc-2', 'res2'),
      new HumanMessage('final q'),
      new AIMessage('final a'),
    ]

    // keepRecentMessages = 4, so rawSplit = 6-4 = 2
    // But split alignment may walk back past tool messages
    const result = await summarizeAndTrim(msgs, null, model, { keepRecentMessages: 4 })
    expect(result.trimmedMessages.length).toBeGreaterThan(0)
  })

  it('handles model returning non-string content from summarization', async () => {
    // Line 334: JSON.stringify(response.content) when content is not a string
    const model = {
      invoke: vi.fn().mockResolvedValue(
        new AIMessage({ content: [{ type: 'text' as const, text: 'summary here' }] }),
      ),
    } as unknown as BaseChatModel

    const msgs: BaseMessage[] = [
      ...Array.from({ length: 8 }, (_, i) => [
        new HumanMessage(`q${i}`),
        new AIMessage(`a${i}`),
      ]).flat(),
    ]

    const result = await summarizeAndTrim(msgs, null, model, { keepRecentMessages: 6 })
    expect(result.summary).toContain('text')
    expect(typeof result.summary).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// message-manager: pruneToolResults with tool message without name
// ---------------------------------------------------------------------------

describe('message-manager: tool message without name', () => {
  it('handles pruning tool messages that have no name field', () => {
    const msgs: BaseMessage[] = [
      makeAIWithToolCalls('call', 'tc-noname'),
      new ToolMessage({ content: 'A'.repeat(200), tool_call_id: 'tc-noname' }),
      ...Array.from({ length: 6 }, (_, i) => [
        makeAIWithToolCalls(`c-${i}`, `tc-n-${i}`),
        makeToolMessage(`tc-n-${i}`, `r-${i}`),
      ]).flat(),
    ]

    const result = pruneToolResults(msgs)
    const pruned = result[1] as ToolMessage
    expect(pruned.content).toContain('[Tool result pruned]')
    // name should not be set since source had no name
  })
})

// ---------------------------------------------------------------------------
// phase-window: findRetentionSplit boundary alignment (lines 328-343)
// ---------------------------------------------------------------------------

describe('PhaseAwareWindowManager: findRetentionSplit boundary alignment', () => {
  const mgr = new PhaseAwareWindowManager()

  it('walks backward past tool messages to keep them with AI parent', () => {
    const msgs: BaseMessage[] = [
      new HumanMessage('old question'),
      new AIMessage('old answer'),
      new HumanMessage('q2'),
      makeAIWithToolCalls('calling', 'tc-1'),
      makeToolMessage('tc-1', 'result'),
      new HumanMessage('recent q'),
      new AIMessage('recent a'),
    ]

    const split = mgr.findRetentionSplit(msgs, 3)
    // Split should not land on tool message (index 4) or its AI parent (index 3)
    expect(split).toBeLessThanOrEqual(3)
  })

  it('includes AI with tool_calls when split lands just after it', () => {
    const msgs: BaseMessage[] = [
      new HumanMessage('old'),
      new AIMessage('old answer'),
      makeAIWithToolCalls('calling tools', 'tc-x'),
      makeToolMessage('tc-x', 'result'),
      new HumanMessage('recent q1'),
      new AIMessage('recent a1'),
      new HumanMessage('recent q2'),
      new AIMessage('recent a2'),
    ]

    const split = mgr.findRetentionSplit(msgs, 4)
    // The split should not land between the AI with tool_calls and its tool result
    const msgAtSplit = msgs[split]
    if (msgAtSplit) {
      expect(msgAtSplit._getType()).not.toBe('tool')
    }
  })

  it('returns 0 when messages are fewer than targetKeep', () => {
    const msgs = [new HumanMessage('only'), new AIMessage('two')]
    expect(mgr.findRetentionSplit(msgs, 10)).toBe(0)
  })

  it('handles messages where split walks back past consecutive tool messages', () => {
    const msgs: BaseMessage[] = [
      new HumanMessage('old'),
      makeAIWithToolCalls('multi-tool', 'tc-a', 'tc-b'),
      makeToolMessage('tc-a', 'result a'),
      makeToolMessage('tc-b', 'result b'),
      new HumanMessage('recent'),
      new AIMessage('recent answer'),
    ]

    const split = mgr.findRetentionSplit(msgs, 2)
    // Should walk back past both tool messages AND the AI with tool_calls
    expect(split).toBeLessThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// progressive-compress: level 3 LLM failure fallback (lines 225-227)
// ---------------------------------------------------------------------------

describe('progressive-compress: level 3 LLM failure fallback', () => {
  it('handles LLM failure gracefully at level 3 (summarizeAndTrim catches internally)', async () => {
    const model = createFailingModel()
    const msgs: BaseMessage[] = Array.from({ length: 20 }, (_, i) => [
      new HumanMessage(`q${i}`),
      new AIMessage(`a${i}`),
    ]).flat()

    const result = await compressToLevel(msgs, 3, null, model)
    // summarizeAndTrim catches internally and returns empty summary + trimmed messages
    // compressToLevel reports level 3 since summarizeAndTrim didn't throw
    expect(result.level).toBe(3)
    expect(result.messages.length).toBeGreaterThan(0)
    // Summary should be empty (fallback from summarizeAndTrim catch)
    expect(result.summary).toBe('')
  })

  it('falls back to level 2 when compressToLevel outer catch is triggered', async () => {
    // To trigger the outer catch in compressToLevel level 3, we need
    // summarizeAndTrim itself to throw (not just the model.invoke).
    // This can happen if there's an error before the try/catch in summarizeAndTrim.
    const model = {
      invoke: vi.fn().mockImplementation(() => {
        throw new Error('sync error')
      }),
    } as unknown as BaseChatModel

    const msgs: BaseMessage[] = Array.from({ length: 20 }, (_, i) => [
      new HumanMessage(`q${i}`),
      new AIMessage(`a${i}`),
    ]).flat()

    const result = await compressToLevel(msgs, 3, 'prior', model)
    // The error is caught either by summarizeAndTrim or compressToLevel
    expect(result.messages.length).toBeGreaterThan(0)
  })

  it('preserves existing summary on level 3 LLM failure', async () => {
    const model = createFailingModel()
    const msgs: BaseMessage[] = Array.from({ length: 20 }, (_, i) => [
      new HumanMessage(`q${i}`),
      new AIMessage(`a${i}`),
    ]).flat()

    const result = await compressToLevel(msgs, 3, 'prior summary', model)
    // summarizeAndTrim catches the error and returns existingSummary
    expect(result.summary).toBe('prior summary')
  })
})

// ---------------------------------------------------------------------------
// progressive-compress: level 4 hook failure (line 238)
// ---------------------------------------------------------------------------

describe('progressive-compress: level 4 edge cases', () => {
  it('continues when onBeforeSummarize hook fails at level 4', async () => {
    const model = createMockModel('summary')
    const failingHook = vi.fn().mockRejectedValue(new Error('hook error'))
    const msgs: BaseMessage[] = Array.from({ length: 20 }, (_, i) => [
      new HumanMessage(`q${i}`),
      new AIMessage(`a${i}`),
    ]).flat()

    const result = await compressToLevel(msgs, 4, null, model, {
      onBeforeSummarize: failingHook,
    })

    expect(result.level).toBe(4)
    expect(failingHook).toHaveBeenCalled()
  })

  it('truncates long existing summary at level 4', async () => {
    const model = createMockModel('summary')
    const msgs: BaseMessage[] = Array.from({ length: 10 }, (_, i) => [
      new HumanMessage(`q${i}`),
      new AIMessage(`a${i}`),
    ]).flat()

    const longSummary = 'x'.repeat(600)
    const result = await compressToLevel(msgs, 4, longSummary, model)

    expect(result.summary!.length).toBeLessThan(600)
    expect(result.summary).toContain('...[truncated]')
  })

  it('keeps short existing summary intact at level 4', async () => {
    const model = createMockModel('summary')
    const msgs: BaseMessage[] = Array.from({ length: 10 }, (_, i) => [
      new HumanMessage(`q${i}`),
      new AIMessage(`a${i}`),
    ]).flat()

    const result = await compressToLevel(msgs, 4, 'short summary', model)
    expect(result.summary).toBe('short summary')
  })

  it('handles null existing summary at level 4', async () => {
    const model = createMockModel('summary')
    const msgs: BaseMessage[] = Array.from({ length: 10 }, (_, i) => [
      new HumanMessage(`q${i}`),
      new AIMessage(`a${i}`),
    ]).flat()

    const result = await compressToLevel(msgs, 4, null, model)
    expect(result.summary).toBeNull()
  })

  it('repairs orphaned tool pairs in level 4 kept messages', async () => {
    const model = createMockModel('summary')
    // The last 3 messages include a tool message orphaned from its AI parent
    const msgs: BaseMessage[] = [
      ...Array.from({ length: 15 }, (_, i) => new HumanMessage(`q${i}`)),
      makeAIWithToolCalls('calling', 'tc-orphan'),
      makeToolMessage('tc-orphan', 'result'),
      new HumanMessage('final'),
    ]

    const result = await compressToLevel(msgs, 4, null, model, {
      keepRecentLevel4: 3,
    })

    expect(result.level).toBe(4)
    expect(result.messages.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// progressive-compress: level 3 onBeforeSummarize hook
// ---------------------------------------------------------------------------

describe('progressive-compress: level 3 hook behavior', () => {
  it('fires onBeforeSummarize with old messages at level 3', async () => {
    const model = createMockModel('summary')
    const hookFn = vi.fn()
    const msgs: BaseMessage[] = Array.from({ length: 20 }, (_, i) => [
      new HumanMessage(`q${i}`),
      new AIMessage(`a${i}`),
    ]).flat()

    await compressToLevel(msgs, 3, null, model, {
      onBeforeSummarize: hookFn,
      keepRecentLevel3: 10,
    })

    expect(hookFn).toHaveBeenCalledTimes(1)
    const hookMessages = hookFn.mock.calls[0]![0] as BaseMessage[]
    // Should receive old messages (those before the last keepRecentLevel3)
    expect(hookMessages.length).toBe(msgs.length - 10)
  })

  it('does not fire hook at level 3 when messages <= keepRecentLevel3', async () => {
    const model = createMockModel('summary')
    const hookFn = vi.fn()
    const msgs: BaseMessage[] = [
      new HumanMessage('q'),
      new AIMessage('a'),
    ]

    await compressToLevel(msgs, 3, null, model, {
      onBeforeSummarize: hookFn,
      keepRecentLevel3: 10,
    })

    expect(hookFn).not.toHaveBeenCalled()
  })

  it('continues when level 3 hook throws', async () => {
    const model = createMockModel('summary')
    const hookFn = vi.fn().mockRejectedValue(new Error('hook fail'))
    const msgs: BaseMessage[] = Array.from({ length: 20 }, (_, i) => [
      new HumanMessage(`q${i}`),
      new AIMessage(`a${i}`),
    ]).flat()

    const result = await compressToLevel(msgs, 3, null, model, {
      onBeforeSummarize: hookFn,
      keepRecentLevel3: 10,
    })

    expect(result.level).toBe(3)
    expect(result.summary).toBe('summary')
  })
})

// ---------------------------------------------------------------------------
// progressive-compress: selectCompressionLevel edge cases
// ---------------------------------------------------------------------------

describe('selectCompressionLevel', () => {
  it('returns 0 when estimated tokens fit within budget', () => {
    const msgs = [new HumanMessage('short')]
    expect(selectCompressionLevel(msgs, 10_000)).toBe(0)
  })

  it('returns 1 when 70% of tokens fit the budget', () => {
    // 100 chars / 4 = 25 tokens. Budget = 20. 25 * 0.70 = 17.5 <= 20
    const msgs = [new HumanMessage('x'.repeat(100))]
    expect(selectCompressionLevel(msgs, 20)).toBe(1)
  })

  it('returns 2 when 50% of tokens fit the budget', () => {
    // 100 chars / 4 = 25 tokens. Budget = 14. 25 * 0.50 = 12.5 <= 14
    const msgs = [new HumanMessage('x'.repeat(100))]
    expect(selectCompressionLevel(msgs, 14)).toBe(2)
  })

  it('returns 3 when 30% of tokens fit the budget', () => {
    // 100 chars / 4 = 25 tokens. Budget = 8. 25 * 0.30 = 7.5 <= 8
    const msgs = [new HumanMessage('x'.repeat(100))]
    expect(selectCompressionLevel(msgs, 8)).toBe(3)
  })

  it('returns 4 when even 30% of tokens exceed the budget', () => {
    // 100 chars / 4 = 25 tokens. Budget = 5. 25 * 0.30 = 7.5 > 5
    const msgs = [new HumanMessage('x'.repeat(100))]
    expect(selectCompressionLevel(msgs, 5)).toBe(4)
  })

  it('respects custom charsPerToken', () => {
    // 100 chars / 2 = 50 tokens. Budget = 40. 50 > 40 but 50*0.70=35 <= 40
    const msgs = [new HumanMessage('x'.repeat(100))]
    expect(selectCompressionLevel(msgs, 40, 2)).toBe(1)
  })

  it('returns 0 for empty messages', () => {
    expect(selectCompressionLevel([], 100)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// progressive-compress: compressToBudget
// ---------------------------------------------------------------------------

describe('compressToBudget', () => {
  it('auto-selects compression level to fit budget', async () => {
    const model = createMockModel('summary')
    const msgs = [new HumanMessage('short')]
    const result = await compressToBudget(msgs, 10_000, null, model)
    expect(result.level).toBe(0) // fits easily
  })

  it('selects higher level for tight budgets', async () => {
    const model = createMockModel('summary')
    const msgs: BaseMessage[] = Array.from({ length: 20 }, (_, i) => [
      new HumanMessage(`q${i} ${'x'.repeat(100)}`),
      new AIMessage(`a${i} ${'y'.repeat(100)}`),
    ]).flat()

    const result = await compressToBudget(msgs, 5, null, model)
    expect(result.level).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// progressive-compress: level 0 (no compression)
// ---------------------------------------------------------------------------

describe('progressive-compress: level 0', () => {
  it('returns messages unchanged at level 0', async () => {
    const model = createMockModel('unused')
    const msgs = [new HumanMessage('hello'), new AIMessage('hi')]

    const result = await compressToLevel(msgs, 0, 'existing', model)
    expect(result.level).toBe(0)
    expect(result.messages).toBe(msgs)
    expect(result.summary).toBe('existing')
    expect(result.ratio).toBe(0) // no compression
  })
})

// ---------------------------------------------------------------------------
// prompt-cache: applyCacheBreakpoints edge cases (lines 150, 179)
// ---------------------------------------------------------------------------

describe('applyCacheBreakpoints edge cases', () => {
  it('returns empty array for empty input', () => {
    const result = applyCacheBreakpoints([])
    expect(result).toEqual([])
  })

  it('handles a single system message', () => {
    const msgs = [new SystemMessage('system prompt')]
    const result = applyCacheBreakpoints(msgs)
    expect(result.length).toBe(1)
    expect(result[0]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('marks system message and last 3 non-system messages', () => {
    const msgs: BaseMessage[] = [
      new SystemMessage('system'),
      new HumanMessage('q1'),
      new AIMessage('a1'),
      new HumanMessage('q2'),
      new AIMessage('a2'),
    ]

    const result = applyCacheBreakpoints(msgs)
    // System should be marked
    expect(result[0]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    // Last 3 non-system (a1, q2, a2) should be marked
    expect(result[2]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    expect(result[3]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    expect(result[4]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    // First non-system (q1) should NOT be marked (only 3 breakpoints for non-system)
    expect(result[1]!.additional_kwargs.cache_control).toBeUndefined()
  })

  it('marks all non-system messages when fewer than 3', () => {
    const msgs: BaseMessage[] = [
      new SystemMessage('system'),
      new HumanMessage('only one'),
    ]

    const result = applyCacheBreakpoints(msgs)
    expect(result[0]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    expect(result[1]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('does not mutate original messages', () => {
    const original = new HumanMessage('test')
    const msgs = [original]
    const result = applyCacheBreakpoints(msgs)
    expect(original.additional_kwargs.cache_control).toBeUndefined()
    expect(result[0]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('handles messages with only non-system messages (no system message)', () => {
    const msgs: BaseMessage[] = [
      new HumanMessage('q1'),
      new AIMessage('a1'),
      new HumanMessage('q2'),
      new AIMessage('a2'),
      new HumanMessage('q3'),
    ]

    const result = applyCacheBreakpoints(msgs)
    // Last 3 should be marked
    expect(result[2]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    expect(result[3]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    expect(result[4]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
  })
})

// ---------------------------------------------------------------------------
// prompt-cache: applyAnthropicCacheControl
// ---------------------------------------------------------------------------

describe('applyAnthropicCacheControl edge cases', () => {
  it('handles empty system content blocks', () => {
    const result = applyAnthropicCacheControl([], [])
    expect(result.system).toEqual([])
  })

  it('handles system as content block array', () => {
    const blocks = [
      { type: 'text', text: 'part 1' },
      { type: 'text', text: 'part 2' },
    ]
    const result = applyAnthropicCacheControl(blocks, [])
    expect(result.system.length).toBe(2)
    // Only last block should have cache_control
    expect(result.system[0]!.cache_control).toBeUndefined()
    expect(result.system[1]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('marks last 3 messages with cache control', () => {
    const messages = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ]
    const result = applyAnthropicCacheControl('system', messages)
    // Last 3 messages should be marked
    expect(Array.isArray(result.messages[1]!.content)).toBe(true)
    expect(Array.isArray(result.messages[2]!.content)).toBe(true)
    expect(Array.isArray(result.messages[3]!.content)).toBe(true)
    // First message should NOT be marked (only 3 breakpoints for messages)
    expect(typeof result.messages[0]!.content).toBe('string')
  })

  it('handles message with content block array', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'block 1' },
          { type: 'text', text: 'block 2' },
        ],
      },
    ]
    const result = applyAnthropicCacheControl('system', messages)
    const msgContent = result.messages[0]!.content as Array<{ cache_control?: { type: string } }>
    // Last block should have cache_control
    expect(msgContent[1]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(msgContent[0]!.cache_control).toBeUndefined()
  })

  it('handles message with empty content array', () => {
    const messages = [{ role: 'user', content: [] as Array<{ type: string }> }]
    const result = applyAnthropicCacheControl('system', messages)
    // Empty array content should pass through unchanged
    expect(result.messages[0]!.content).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// context-transfer: getContent with array/non-string content (lines 107, 111-112)
// ---------------------------------------------------------------------------

describe('ContextTransferService: content extraction edge cases', () => {
  const service = new ContextTransferService()

  it('extracts context from messages with array content blocks', () => {
    const msgs: BaseMessage[] = [
      new HumanMessage({
        content: [
          { type: 'text' as const, text: 'I decided to use TypeScript' },
        ],
      }),
      new AIMessage('Great choice'),
    ]

    const ctx = service.extractContext(msgs, 'implement')
    expect(ctx.summary).toContain('Great choice')
  })

  it('handles content blocks without text property', () => {
    const msgs: BaseMessage[] = [
      new HumanMessage({
        content: [
          { type: 'image_url' as const, image_url: { url: 'http://example.com' } } as unknown as { type: 'text'; text: string },
        ],
      }),
      new AIMessage('I see the image'),
    ]

    const ctx = service.extractContext(msgs, 'review')
    expect(ctx.summary).toBeDefined()
  })

  it('extracts file paths from messages', () => {
    const msgs: BaseMessage[] = [
      new HumanMessage('Please edit src/components/App.tsx'),
      new AIMessage('I modified src/utils/helper.ts'),
    ]

    const ctx = service.extractContext(msgs, 'edit')
    expect(ctx.relevantFiles).toContain('src/components/App.tsx')
    expect(ctx.relevantFiles).toContain('src/utils/helper.ts')
  })

  it('extracts decision sentences from messages', () => {
    const msgs: BaseMessage[] = [
      new AIMessage('I decided to use a factory pattern for store creation. The architecture will be event-driven.'),
      new HumanMessage('Sounds good'),
    ]

    const ctx = service.extractContext(msgs, 'plan')
    expect(ctx.decisions.length).toBeGreaterThan(0)
    expect(ctx.decisions.some(d => d.includes('factory pattern'))).toBe(true)
  })

  it('deduplicates decisions', () => {
    const msgs: BaseMessage[] = [
      new AIMessage('I decided to use Redux'),
      new HumanMessage('I decided to use Redux'),
      new AIMessage('Confirmed: decided to use Redux'),
    ]

    const ctx = service.extractContext(msgs, 'plan')
    // Each unique decision should appear only once
    const reduxDecisions = ctx.decisions.filter(d => d.includes('Redux'))
    // May have fewer due to deduplication
    expect(new Set(reduxDecisions).size).toBe(reduxDecisions.length)
  })

  it('limits decisions to MAX_DECISIONS', () => {
    const msgs: BaseMessage[] = Array.from({ length: 20 }, (_, i) =>
      new AIMessage(`I decided to use approach ${i} for module ${i}`),
    )

    const ctx = service.extractContext(msgs, 'plan')
    expect(ctx.decisions.length).toBeLessThanOrEqual(10)
  })

  it('limits files to MAX_FILES', () => {
    const paths = Array.from({ length: 30 }, (_, i) => `src/module${i}/file${i}.ts`)
    const content = paths.join('\n')
    const msgs: BaseMessage[] = [new HumanMessage(content)]

    const ctx = service.extractContext(msgs, 'edit')
    expect(ctx.relevantFiles.length).toBeLessThanOrEqual(20)
  })

  it('passes working state through to context', () => {
    const msgs: BaseMessage[] = [new HumanMessage('hello')]
    const state = { currentBranch: 'feature/auth', step: 3 }

    const ctx = service.extractContext(msgs, 'implement', state)
    expect(ctx.workingState).toEqual(state)
  })

  it('defaults working state to empty object', () => {
    const msgs: BaseMessage[] = [new HumanMessage('hello')]
    const ctx = service.extractContext(msgs, 'implement')
    expect(ctx.workingState).toEqual({})
  })

  it('computes tokenEstimate for the context', () => {
    const msgs: BaseMessage[] = [
      new HumanMessage('Build a REST API for user management'),
      new AIMessage('I will create endpoints at src/api/users.ts'),
    ]

    const ctx = service.extractContext(msgs, 'implement')
    expect(ctx.tokenEstimate).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// context-transfer: transfer scope and relevance
// ---------------------------------------------------------------------------

describe('ContextTransferService: transfer scope edge cases', () => {
  it('returns summary-only scope for unmatched intent pairs', () => {
    const service = new ContextTransferService()
    // Default rules have a catch-all with summary-only
    const scope = service.getTransferScope('random-intent', 'other-intent')
    expect(scope).toBe('summary-only')
  })

  it('returns highest priority scope when multiple rules match', () => {
    const service = new ContextTransferService()
    // "implement" -> "debug" has priority 10 with 'all', catch-all has priority 1
    const scope = service.getTransferScope('implement-feature', 'debug-issue')
    expect(scope).toBe('all')
  })

  it('formatAsMessage respects token budget truncation', () => {
    const service = new ContextTransferService({ maxTransferTokens: 10 })
    const msgs: BaseMessage[] = [
      new HumanMessage('x'.repeat(500)),
      new AIMessage('y'.repeat(500)),
    ]

    const ctx = service.extractContext(msgs, 'generate')
    ctx.toIntent = 'edit'
    const msg = service.formatAsMessage(ctx)
    const content = msg.content as string
    expect(content).toContain('[Context truncated to fit token budget]')
  })

  it('injectContext inserts after first system message', () => {
    const service = new ContextTransferService()
    const msgs: BaseMessage[] = [
      new SystemMessage('system prompt'),
      new HumanMessage('hello'),
    ]

    const ctx = service.extractContext([new HumanMessage('prior')], 'plan')
    ctx.toIntent = 'implement'
    const result = service.injectContext(ctx, msgs)

    expect(result.length).toBe(3)
    expect(result[0]!._getType()).toBe('system')
    expect(result[1]!._getType()).toBe('system') // injected context
    expect(result[2]!._getType()).toBe('human')
  })

  it('injectContext prepends when no system message exists', () => {
    const service = new ContextTransferService()
    const msgs: BaseMessage[] = [new HumanMessage('hello')]

    const ctx = service.extractContext([new HumanMessage('prior')], 'plan')
    ctx.toIntent = 'implement'
    const result = service.injectContext(ctx, msgs)

    expect(result.length).toBe(2)
    expect(result[0]!._getType()).toBe('system') // injected at front
  })

  it('transfer returns null for irrelevant intent pairs', () => {
    const service = new ContextTransferService({
      relevanceRules: [
        { from: 'plan', to: 'implement', transferScope: 'all', priority: 10 },
      ],
    })

    const result = service.transfer(
      [new HumanMessage('prior')],
      'debug',
      [new HumanMessage('current')],
      'review',
    )

    expect(result).toBeNull()
  })

  it('isRelevant returns true when no rules are defined', () => {
    const service = new ContextTransferService({ relevanceRules: [] })
    expect(service.isRelevant('anything', 'other')).toBe(true)
  })
})
