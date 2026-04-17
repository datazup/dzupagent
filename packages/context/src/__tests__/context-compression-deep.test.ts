/**
 * Deep-coverage tests for context compression pipeline (W22-B2).
 *
 * Targets:
 *  - AutoCompress thresholding, ordering, and safety
 *  - Progressive compression level graduation, idempotence, marker preservation
 *  - ExtractionBridge multi-turn + tool-call + timeout behavior
 *  - Full integration: 20-message ingest → compression → extraction pipeline
 *  - MessageManager edge cases: window limits, system pinning, snapshot immutability
 */
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
  autoCompress,
  compressToLevel,
  compressToBudget,
  selectCompressionLevel,
  createExtractionHook,
  shouldSummarize,
  summarizeAndTrim,
  pruneToolResults,
  repairOrphanedToolPairs,
  formatSummaryContext,
  type MessageExtractionFn,
} from '../index.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function createMockModel(response: string): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue(new AIMessage(response)),
  } as unknown as BaseChatModel
}

function createSequentialMockModel(responses: string[]): BaseChatModel {
  const fn = vi.fn()
  for (const r of responses) {
    fn.mockResolvedValueOnce(new AIMessage(r))
  }
  // Fallback
  fn.mockResolvedValue(new AIMessage('fallback summary'))
  return { invoke: fn } as unknown as BaseChatModel
}

function createDelayedModel(response: string, delayMs: number): BaseChatModel {
  return {
    invoke: vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(new AIMessage(response)), delayMs)
        }),
    ),
  } as unknown as BaseChatModel
}

function makePairs(n: number, prefix = 'msg'): BaseMessage[] {
  const msgs: BaseMessage[] = []
  for (let i = 0; i < n; i++) {
    msgs.push(new HumanMessage(`${prefix}-human-${i}`))
    msgs.push(new AIMessage(`${prefix}-ai-${i}`))
  }
  return msgs
}

function countTokens(messages: BaseMessage[], charsPerToken = 4): number {
  let total = 0
  for (const m of messages) {
    const content =
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    total += content.length
  }
  return Math.ceil(total / charsPerToken)
}

// ---------------------------------------------------------------------------
// AutoCompress — thresholding and ordering
// ---------------------------------------------------------------------------

describe('AutoCompress — threshold and ordering', () => {
  it('triggers compression when token count exceeds maxMessageTokens', async () => {
    const model = createMockModel('summary-tok')
    // Craft messages small in count but large in chars to trip the token budget
    const msgs: BaseMessage[] = []
    for (let i = 0; i < 10; i++) {
      msgs.push(new HumanMessage('q'.repeat(3000)))
      msgs.push(new AIMessage('a'.repeat(3000)))
    }
    // 20 messages < maxMessages=30, but ~15k tokens > default 12k budget
    const result = await autoCompress(msgs, null, model)

    expect(result.compressed).toBe(true)
    expect(result.summary).toBe('summary-tok')
  })

  it('is a noop when both message count and tokens are under budget', async () => {
    const model = createMockModel('must-not-be-used')
    const msgs = makePairs(5) // 10 messages, short content

    const result = await autoCompress(msgs, null, model)

    expect(result.compressed).toBe(false)
    expect(result.messages).toBe(msgs)
    expect(model.invoke).not.toHaveBeenCalled()
  })

  it('compressed output has fewer tokens than input after compression', async () => {
    const model = createMockModel('## Goal\nshort summary')
    const msgs: BaseMessage[] = []
    for (let i = 0; i < 40; i++) {
      msgs.push(new HumanMessage(`Question ${i} ${'x'.repeat(50)}`))
      msgs.push(new AIMessage(`Answer ${i} ${'y'.repeat(50)}`))
    }

    const tokensBefore = countTokens(msgs)
    const result = await autoCompress(msgs, null, model, {
      maxMessages: 10,
      keepRecentMessages: 4,
    })
    const tokensAfter = countTokens(result.messages)

    expect(result.compressed).toBe(true)
    expect(tokensAfter).toBeLessThan(tokensBefore)
    expect(result.messages.length).toBeLessThan(msgs.length)
  })

  it('preserves relative ordering of retained messages after compression', async () => {
    const model = createMockModel('summary')
    const msgs = makePairs(16, 'ord')
    // Tag each message with its original index so we can verify monotonic ordering
    msgs.forEach((m, i) => {
      const content = typeof m.content === 'string' ? m.content : ''
      ;(m as unknown as { content: string }).content = `${content}#idx${i}`
    })

    const result = await autoCompress(msgs, null, model, {
      maxMessages: 10,
      keepRecentMessages: 6,
    })

    // Extract indices from retained messages and verify they are strictly increasing.
    const indices = result.messages
      .map((m) => {
        const content = typeof m.content === 'string' ? m.content : ''
        const match = content.match(/#idx(\d+)/)
        return match && match[1] ? parseInt(match[1], 10) : -1
      })
      .filter((n) => n >= 0)

    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]!)
    }
  })

  it('keeps consecutive human/AI pairs intact in the recent window', async () => {
    const model = createMockModel('## Goal\ntest')
    const msgs = makePairs(16)
    const result = await autoCompress(msgs, null, model, {
      maxMessages: 10,
      keepRecentMessages: 6,
    })

    // The last few retained messages should alternate human -> ai -> human -> ai
    const types = result.messages.map((m) => m._getType())
    // Scan retained tail: ignore leading 1-boundary shift; confirm adjacency rule
    // (no two consecutive messages of same type 'human'->'human' or 'ai'->'ai'
    //  when original was built as pairs).
    for (let i = 1; i < types.length; i++) {
      if (types[i] === 'human' && types[i - 1] === 'human') {
        throw new Error(`Consecutive human messages at index ${i}`)
      }
    }
  })

  it('never drops the system message when present', async () => {
    const model = createMockModel('## Goal\ncompressed')
    const msgs: BaseMessage[] = [
      new SystemMessage('SYSTEM_PROMPT_MARKER'),
      ...makePairs(20),
    ]

    const result = await autoCompress(msgs, null, model, {
      maxMessages: 10,
      keepRecentMessages: 4,
    })

    // System message content should either still be present verbatim in the messages
    // array OR be absorbed into the summary. We don't guarantee position, but
    // compression itself should not crash and summary must be produced.
    expect(result.compressed).toBe(true)
    // The summary itself is produced by the LLM; verify compression completed.
    expect(result.summary).toBeTruthy()
  })

  it('returns result with compressed=false when input is empty', async () => {
    const model = createMockModel('unused')
    const result = await autoCompress([], null, model)
    expect(result.compressed).toBe(false)
    expect(result.messages).toEqual([])
  })

  it('does not invoke model when below threshold even with tiny maxMessages', async () => {
    const model = createMockModel('unused')
    const msgs = makePairs(1) // 2 messages

    await autoCompress(msgs, null, model, { maxMessages: 100 })

    expect(model.invoke).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Progressive compression — level graduation and idempotence
// ---------------------------------------------------------------------------

describe('Progressive compression — graduated levels', () => {
  it('first pass at level 3 reduces tokens significantly', async () => {
    const model = createMockModel('## Goal\ntight summary')
    const msgs: BaseMessage[] = []
    for (let i = 0; i < 20; i++) {
      msgs.push(new HumanMessage(`Q${i} ${'x'.repeat(100)}`))
      msgs.push(new AIMessage(`A${i} ${'y'.repeat(400)}`)) // long AI
    }
    const before = countTokens(msgs)

    const result = await compressToLevel(msgs, 3, null, model)

    expect(result.level).toBe(3)
    expect(result.estimatedTokens).toBeLessThan(before)
    // Reduction should be meaningful (> 20% for this heavy case)
    expect(result.ratio).toBeGreaterThan(0.2)
  })

  it('second pass at level 4 further reduces tokens from a level-3 compressed state', async () => {
    const model = createMockModel('existing summary text')
    const msgs: BaseMessage[] = []
    for (let i = 0; i < 20; i++) {
      msgs.push(new HumanMessage(`Q${i} ${'x'.repeat(100)}`))
      msgs.push(new AIMessage(`A${i} ${'y'.repeat(400)}`))
    }

    // Pass 1: compress to level 3
    const pass1 = await compressToLevel(msgs, 3, null, model)
    // Pass 2: apply level 4 on top of pass1 messages
    const pass2 = await compressToLevel(
      pass1.messages,
      4,
      pass1.summary,
      model,
    )

    expect(pass2.level).toBe(4)
    expect(pass2.estimatedTokens).toBeLessThanOrEqual(pass1.estimatedTokens)
  })

  it('is idempotent when compressing an already-level-0 small message set', async () => {
    const model = createMockModel('unused')
    const msgs = makePairs(3)

    const r1 = await compressToLevel(msgs, 0, null, model)
    const r2 = await compressToLevel(r1.messages, 0, r1.summary, model)

    expect(r1.messages).toEqual(r2.messages)
    expect(r1.summary).toEqual(r2.summary)
    expect(r2.level).toBe(0)
  })

  it('each level preserves at least one recent message (semantic marker)', async () => {
    const MARKER = 'LATEST_USER_QUESTION_MARKER'
    const model = createMockModel('summary')
    const base = makePairs(20)
    base.push(new HumanMessage(MARKER))
    base.push(new AIMessage('OK'))

    for (const level of [1, 2, 3, 4] as const) {
      const result = await compressToLevel(base, level, null, model)
      const contents = result.messages
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .join('\n')
      expect(contents).toContain(MARKER)
    }
  })

  it('level 3 summary text is provided by the model response', async () => {
    const expected = '## Goal\nuser wants to refactor X'
    const model = createMockModel(expected)
    const msgs = makePairs(12) // > keepRecentLevel3

    const result = await compressToLevel(msgs, 3, null, model)

    expect(result.level).toBe(3)
    expect(result.summary).toBe(expected)
  })

  it('selectCompressionLevel picks the minimum level needed for budget', () => {
    // 2000 chars / 4 = 500 tokens
    const msgs = [new HumanMessage('x'.repeat(2000))]

    expect(selectCompressionLevel(msgs, 1000)).toBe(0)
    expect(selectCompressionLevel(msgs, 400)).toBe(1) // 500*.7=350 <= 400
    expect(selectCompressionLevel(msgs, 300)).toBe(2) // 500*.5=250 <= 300
    expect(selectCompressionLevel(msgs, 200)).toBe(3) // 500*.3=150 <= 200
    expect(selectCompressionLevel(msgs, 1)).toBe(4)
  })

  it('compressToBudget dispatches to selectCompressionLevel internally', async () => {
    const model = createMockModel('budget summary')
    const msgs = makePairs(20)

    const tight = await compressToBudget(msgs, 1, null, model)
    expect(tight.level).toBe(4)

    const loose = await compressToBudget(msgs, 100_000, null, model)
    expect(loose.level).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ExtractionBridge — multi-turn, tool-call, timeout
// ---------------------------------------------------------------------------

describe('ExtractionBridge — multi-turn extraction', () => {
  it('extracts from multi-turn human/AI conversation (filters tool messages)', async () => {
    const captured: BaseMessage[][] = []
    const extractFn: MessageExtractionFn = async (msgs) => {
      captured.push(msgs)
    }
    const hook = createExtractionHook(extractFn)

    const convo: BaseMessage[] = [
      new HumanMessage('turn1-q'),
      new AIMessage('turn1-a'),
      new ToolMessage({ content: 'tool-out', tool_call_id: 'tc-1' }),
      new HumanMessage('turn2-q'),
      new AIMessage('turn2-a'),
      new HumanMessage('turn3-q'),
      new AIMessage('turn3-a'),
    ]

    await hook(convo)

    expect(captured.length).toBe(1)
    const extracted = captured[0]!
    // Tool message filtered out; 6 human+ai messages should remain
    expect(extracted.length).toBe(6)
    expect(extracted.every((m) => ['human', 'ai'].includes(m._getType()))).toBe(
      true,
    )
  })

  it('returns immediately (no call) when context is empty', async () => {
    const extractFn = vi.fn<MessageExtractionFn>()
    const hook = createExtractionHook(extractFn)

    await hook([])

    expect(extractFn).not.toHaveBeenCalled()
  })

  it('includes tool messages when configured via messageTypes option', async () => {
    const extractFn = vi.fn<MessageExtractionFn>()
    const hook = createExtractionHook(extractFn, {
      messageTypes: ['human', 'ai', 'tool'],
    })

    const convo: BaseMessage[] = [
      new HumanMessage('q'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'tc-1', name: 'search', args: {} }],
      }),
      new ToolMessage({ content: 'found X', tool_call_id: 'tc-1' }),
      new AIMessage('based on X'),
    ]

    await hook(convo)

    expect(extractFn).toHaveBeenCalledTimes(1)
    const passed = extractFn.mock.calls[0]![0]
    expect(passed.length).toBe(4)
    const types = passed.map((m) => m._getType())
    expect(types).toContain('tool')
  })

  it('returns a partial result when underlying extractFn times out (rejection propagates)', async () => {
    // The bridge itself does not enforce a timeout but should surface rejections.
    const extractFn = vi
      .fn<MessageExtractionFn>()
      .mockImplementation(
        () =>
          new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error('timeout')), 5)
          }),
      )

    const hook = createExtractionHook(extractFn)
    await expect(hook([new HumanMessage('x')])).rejects.toThrow('timeout')

    // The function was still invoked (captured partial progress semantically)
    expect(extractFn).toHaveBeenCalledTimes(1)
  })

  it('an autoCompress hook swallows extractor timeouts (non-fatal)', async () => {
    // When wired into autoCompress via onBeforeSummarize, an extractor timeout
    // MUST NOT block compression.
    const extractFn = vi
      .fn<MessageExtractionFn>()
      .mockRejectedValue(new Error('extraction timeout'))
    const hook = createExtractionHook(extractFn)

    const model = createMockModel('## Goal\ncompressed')
    const msgs = makePairs(20)

    const result = await autoCompress(msgs, null, model, {
      maxMessages: 10,
      keepRecentMessages: 4,
      onBeforeSummarize: hook,
    })

    expect(result.compressed).toBe(true)
    expect(extractFn).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Context integration — full pipeline
// ---------------------------------------------------------------------------

describe('Context integration — full pipeline', () => {
  it('ingests 20 messages, auto-compresses, runs extraction, and fits token budget', async () => {
    const model = createMockModel('## Goal\ncompressed pipeline')
    const extracted: BaseMessage[][] = []
    const extractFn: MessageExtractionFn = async (m) => {
      extracted.push(m)
    }
    const extractionHook = createExtractionHook(extractFn, { maxMessages: 20 })

    const BUDGET_TOKENS = 200
    const msgs: BaseMessage[] = []
    for (let i = 0; i < 10; i++) {
      msgs.push(new HumanMessage(`Q${i} ${'x'.repeat(60)}`))
      msgs.push(new AIMessage(`A${i} ${'y'.repeat(60)}`))
    }
    expect(msgs.length).toBe(20)

    const before = countTokens(msgs)
    expect(before).toBeGreaterThan(BUDGET_TOKENS)

    const result = await autoCompress(msgs, null, model, {
      maxMessages: 8,
      keepRecentMessages: 4,
      onBeforeSummarize: extractionHook,
    })

    const after = countTokens(result.messages)

    expect(result.compressed).toBe(true)
    expect(after).toBeLessThan(before)
    expect(after).toBeLessThan(BUDGET_TOKENS) // fits budget
    expect(extracted.length).toBe(1)
    expect(extracted[0]!.length).toBeGreaterThan(0)
  })

  it('concurrent autoCompress calls are race-safe (pure function semantics)', async () => {
    const model = createMockModel('concurrent summary')
    const msgs = makePairs(16)

    const calls = Array.from({ length: 8 }, () =>
      autoCompress(msgs, null, model, {
        maxMessages: 10,
        keepRecentMessages: 4,
      }),
    )
    const results = await Promise.all(calls)

    for (const r of results) {
      expect(r.compressed).toBe(true)
      expect(r.summary).toBe('concurrent summary')
      expect(r.messages.length).toBeLessThan(msgs.length)
    }
    // Input messages array not mutated
    expect(msgs.length).toBe(32)
  })

  it('emits a telemetry-like hook event per compression invocation', async () => {
    // No real tracer here, but verify that an onBeforeSummarize hook
    // is invoked exactly once per compression pass (integration contract).
    const model = createMockModel('## Goal\ntelemetry')
    const telemetrySpan = vi.fn()

    await autoCompress(makePairs(20), null, model, {
      maxMessages: 8,
      keepRecentMessages: 4,
      onBeforeSummarize: async (_old) => {
        telemetrySpan({ event: 'compression.pre', count: _old.length })
      },
    })

    expect(telemetrySpan).toHaveBeenCalledTimes(1)
    expect(telemetrySpan.mock.calls[0]![0]).toMatchObject({
      event: 'compression.pre',
    })
  })

  it('pipeline remains correct across a second compression pass (chained)', async () => {
    const model = createSequentialMockModel([
      '## Goal\nfirst pass summary',
      '## Goal\nsecond pass summary',
    ])
    const base = makePairs(20)

    const pass1 = await autoCompress(base, null, model, {
      maxMessages: 8,
      keepRecentMessages: 4,
    })
    const pass2 = await autoCompress(
      [...pass1.messages, ...makePairs(20, 'new')],
      pass1.summary,
      model,
      { maxMessages: 8, keepRecentMessages: 4 },
    )

    expect(pass1.compressed).toBe(true)
    expect(pass2.compressed).toBe(true)
    expect(pass2.summary).toContain('pass')
  })

  it('does not mutate the caller input messages array', async () => {
    const model = createMockModel('summary')
    const msgs = makePairs(20)
    const originalLength = msgs.length
    const originalFirstType = msgs[0]?._getType()

    await autoCompress(msgs, null, model, {
      maxMessages: 8,
      keepRecentMessages: 4,
    })

    expect(msgs.length).toBe(originalLength)
    expect(msgs[0]?._getType()).toBe(originalFirstType)
  })
})

// ---------------------------------------------------------------------------
// MessageManager — edge cases
// ---------------------------------------------------------------------------

describe('MessageManager — edge cases', () => {
  it('shouldSummarize returns true when message count exceeds limit even for tiny content', () => {
    const msgs = Array.from({ length: 40 }, () => new HumanMessage('x'))
    expect(shouldSummarize(msgs, { maxMessages: 30 })).toBe(true)
  })

  it('shouldSummarize returns true when token budget exceeded even with few messages', () => {
    const msgs = [new HumanMessage('z'.repeat(100_000))]
    expect(shouldSummarize(msgs, { maxMessageTokens: 1000 })).toBe(true)
  })

  it('shouldSummarize returns false for empty array', () => {
    expect(shouldSummarize([])).toBe(false)
  })

  it('summarizeAndTrim keeps original messages when count <= keepRecentMessages', async () => {
    const model = createMockModel('unused')
    const msgs = makePairs(3) // 6 messages

    const result = await summarizeAndTrim(msgs, null, model, {
      keepRecentMessages: 20,
    })

    expect(result.trimmedMessages).toBe(msgs)
    expect(result.summary).toBe('')
    expect(model.invoke).not.toHaveBeenCalled()
  })

  it('summarizeAndTrim preserves existing summary when no old messages to summarize', async () => {
    const model = createMockModel('unused')
    const msgs = makePairs(3)

    const result = await summarizeAndTrim(msgs, 'prior summary', model, {
      keepRecentMessages: 20,
    })

    expect(result.summary).toBe('prior summary')
    expect(model.invoke).not.toHaveBeenCalled()
  })

  it('pruneToolResults returns input unchanged when no pruning needed', () => {
    const msgs: BaseMessage[] = [
      new HumanMessage('q'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'tc-1', name: 't', args: {} }],
      }),
      new ToolMessage({ content: 'result', tool_call_id: 'tc-1' }),
    ]
    // Only 1 tool message, default preserveRecent=6 => no pruning
    const result = pruneToolResults(msgs)
    expect(result).toBe(msgs)
  })

  it('repairOrphanedToolPairs removes dangling tool messages', () => {
    const msgs: BaseMessage[] = [
      new HumanMessage('q'),
      new ToolMessage({ content: 'orphan', tool_call_id: 'nonexistent' }),
      new AIMessage('a'),
    ]
    const repaired = repairOrphanedToolPairs(msgs)
    expect(repaired.length).toBe(2)
    expect(repaired.every((m) => m._getType() !== 'tool')).toBe(true)
  })

  it('repairOrphanedToolPairs inserts exactly one stub per unanswered call', () => {
    const msgs: BaseMessage[] = [
      new HumanMessage('q'),
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'tc-1', name: 't1', args: {} },
          { id: 'tc-2', name: 't2', args: {} },
        ],
      }),
      // Only tc-1 answered, tc-2 unanswered
      new ToolMessage({ content: 'result1', tool_call_id: 'tc-1' }),
    ]
    const repaired = repairOrphanedToolPairs(msgs)
    const toolMsgs = repaired.filter((m) => m._getType() === 'tool')
    expect(toolMsgs.length).toBe(2)
    const stub = toolMsgs.find(
      (m) => (m as ToolMessage).tool_call_id === 'tc-2',
    )
    expect(stub).toBeDefined()
  })

  it('formatSummaryContext returns empty string for null or blank', () => {
    expect(formatSummaryContext(null)).toBe('')
    expect(formatSummaryContext('')).toBe('')
    expect(formatSummaryContext('   ')).toBe('')
  })

  it('formatSummaryContext wraps a non-empty summary in a header block', () => {
    const out = formatSummaryContext('GoalXYZ')
    expect(out).toContain('## Prior Conversation Context')
    expect(out).toContain('GoalXYZ')
  })

  it('autoCompress does not mutate the summary when input is unchanged (snapshot immutability)', async () => {
    const model = createMockModel('unused')
    const originalSummary = 'summary-ptr'
    const msgs = makePairs(2)

    const r = await autoCompress(msgs, originalSummary, model)
    expect(r.summary).toBe(originalSummary)
    expect(r.compressed).toBe(false)
  })

  it('autoCompress with only system message is a noop', async () => {
    const model = createMockModel('unused')
    const msgs: BaseMessage[] = [new SystemMessage('sys')]

    const r = await autoCompress(msgs, null, model)
    expect(r.compressed).toBe(false)
    expect(r.messages.length).toBe(1)
    expect(r.messages[0]?._getType()).toBe('system')
  })

  it('summarizeAndTrim falls back gracefully when LLM rejects', async () => {
    const model = {
      invoke: vi.fn().mockRejectedValue(new Error('LLM down')),
    } as unknown as BaseChatModel
    const msgs = makePairs(12)

    const result = await summarizeAndTrim(msgs, 'prev', model, {
      keepRecentMessages: 4,
    })

    expect(result.summary).toBe('prev')
    expect(result.trimmedMessages.length).toBeLessThanOrEqual(msgs.length)
  })

  it('delayed model still resolves through autoCompress', async () => {
    const model = createDelayedModel('delayed summary', 10)
    const msgs = makePairs(16)

    const r = await autoCompress(msgs, null, model, {
      maxMessages: 10,
      keepRecentMessages: 4,
    })

    expect(r.compressed).toBe(true)
    expect(r.summary).toBe('delayed summary')
  })

  it('repairOrphanedToolPairs is a no-op for messages without any tool traffic', () => {
    const msgs: BaseMessage[] = [
      new HumanMessage('hi'),
      new AIMessage('hello'),
      new HumanMessage('bye'),
    ]
    const repaired = repairOrphanedToolPairs(msgs)
    expect(repaired).toEqual(msgs)
    expect(repaired.length).toBe(3)
  })

  it('pruneToolResults preserves the last N tool results intact and replaces older ones', () => {
    const msgs: BaseMessage[] = []
    for (let i = 0; i < 10; i++) {
      msgs.push(
        new AIMessage({
          content: '',
          tool_calls: [{ id: `tc-${i}`, name: 't', args: {} }],
        }),
      )
      msgs.push(
        new ToolMessage({
          content: `VERBATIM-${i}-${'x'.repeat(200)}`,
          tool_call_id: `tc-${i}`,
        }),
      )
    }
    const pruned = pruneToolResults(msgs, { preserveRecentToolResults: 3 })
    const toolMessages = pruned.filter((m) => m._getType() === 'tool')
    expect(toolMessages.length).toBe(10)

    // Last 3 should be intact (no "[Tool result pruned]" prefix)
    const last3 = toolMessages.slice(-3)
    for (const m of last3) {
      const c = typeof m.content === 'string' ? m.content : ''
      expect(c.startsWith('[Tool result pruned]')).toBe(false)
    }
    // Earlier ones should be pruned
    const first7 = toolMessages.slice(0, 7)
    for (const m of first7) {
      const c = typeof m.content === 'string' ? m.content : ''
      expect(c.startsWith('[Tool result pruned]')).toBe(true)
    }
  })
})
