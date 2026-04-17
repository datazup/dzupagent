/**
 * Wave 19 — Claude adapter deep coverage tests.
 *
 * Focus areas not heavily covered by existing claude-adapter.test.ts:
 *   - Cache token metadata propagation (cached_input_tokens / cost_cents)
 *   - Mixed content blocks (text + tool_use + image-like blocks)
 *   - Long/multi-turn assistant content with many blocks
 *   - Stream delta accumulation across many events
 *   - Tool progress timing (multiple tool calls back-to-back)
 *   - Large system prompt handling (>10KB)
 *   - Combined event sequencing under realistic SDK output
 *   - Error subtypes other than success
 *   - SDK forking edge cases
 *
 * The Claude SDK is mocked via vi.mock so we never spawn a real process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { collectEvents } from './test-helpers.js'
import type { AgentEvent } from '../types.js'

// ── SDK mock setup ────────────────────────────────────────

function asyncIterableOf<T>(items: T[]): AsyncIterable<T> & { interrupt: ReturnType<typeof vi.fn> } {
  const interruptFn = vi.fn()
  return {
    interrupt: interruptFn,
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        async next() {
          if (index < items.length) {
            return { value: items[index++], done: false as const }
          }
          return { value: undefined, done: true as const }
        },
      }
    },
  }
}

const mockQuery = vi.fn()
const mockListSessions = vi.fn()
const mockGetSessionInfo = vi.fn()

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
  listSessions: mockListSessions,
  getSessionInfo: mockGetSessionInfo,
}))

const { ClaudeAgentAdapter } = await import('../claude/claude-adapter.js')

// ── Fixtures ──────────────────────────────────────────────

function sysMsg(sessionId = 'sess-deep', model = 'claude-sonnet-4-20250514') {
  return { type: 'system' as const, session_id: sessionId, model, tools: [] }
}

function resultSuccess(opts: {
  result?: string
  sessionId?: string
  usage?: Record<string, unknown>
  durationMs?: number
} = {}) {
  return {
    type: 'result' as const,
    subtype: 'success',
    result: opts.result ?? 'ok',
    session_id: opts.sessionId,
    usage: opts.usage,
    duration_ms: opts.durationMs,
  }
}

function resultError(subtype = 'error_max_turns', error?: string) {
  return {
    type: 'result' as const,
    subtype,
    error,
  }
}

// ──────────────────────────────────────────────────────────

describe('ClaudeAgentAdapter — deep coverage', () => {
  let adapter: InstanceType<typeof ClaudeAgentAdapter>

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new ClaudeAgentAdapter()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Token usage / cache propagation ──────────────────────

  describe('token usage extraction', () => {
    it('propagates cached_input_tokens when present', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([
          sysMsg(),
          resultSuccess({
            usage: { input_tokens: 1000, output_tokens: 200, cached_input_tokens: 800 },
          }),
        ]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const completed = events.find(e => e.type === 'adapter:completed') as Extract<
        AgentEvent,
        { type: 'adapter:completed' }
      >
      expect(completed.usage).toMatchObject({
        inputTokens: 1000,
        outputTokens: 200,
        cachedInputTokens: 800,
      })
    })

    it('omits cachedInputTokens when not provided', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([
          sysMsg(),
          resultSuccess({ usage: { input_tokens: 50, output_tokens: 25 } }),
        ]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const completed = events.find(e => e.type === 'adapter:completed') as Extract<
        AgentEvent,
        { type: 'adapter:completed' }
      >
      expect(completed.usage).toMatchObject({ inputTokens: 50, outputTokens: 25 })
      expect(completed.usage?.cachedInputTokens).toBeUndefined()
    })

    it('propagates cost_cents when SDK provides it', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([
          sysMsg(),
          resultSuccess({
            usage: { input_tokens: 100, output_tokens: 50, cost_cents: 12.5 },
          }),
        ]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const completed = events.find(e => e.type === 'adapter:completed') as Extract<
        AgentEvent,
        { type: 'adapter:completed' }
      >
      expect(completed.usage?.costCents).toBe(12.5)
    })

    it('coerces missing input_tokens to 0', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([
          sysMsg(),
          resultSuccess({ usage: { output_tokens: 25 } }),
        ]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const completed = events.find(e => e.type === 'adapter:completed') as Extract<
        AgentEvent,
        { type: 'adapter:completed' }
      >
      expect(completed.usage?.inputTokens).toBe(0)
      expect(completed.usage?.outputTokens).toBe(25)
    })

    it('coerces missing output_tokens to 0', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([
          sysMsg(),
          resultSuccess({ usage: { input_tokens: 10 } }),
        ]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const completed = events.find(e => e.type === 'adapter:completed') as Extract<
        AgentEvent,
        { type: 'adapter:completed' }
      >
      expect(completed.usage?.outputTokens).toBe(0)
    })

    it('treats non-numeric usage values as 0', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([
          sysMsg(),
          resultSuccess({
            usage: { input_tokens: 'lots' as unknown as number, output_tokens: null as unknown as number },
          }),
        ]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const completed = events.find(e => e.type === 'adapter:completed') as Extract<
        AgentEvent,
        { type: 'adapter:completed' }
      >
      expect(completed.usage?.inputTokens).toBe(0)
      expect(completed.usage?.outputTokens).toBe(0)
    })
  })

  // ── Content block handling ─────────────────────────────

  describe('mixed content blocks', () => {
    it('extracts only text blocks from assistant content (skips tool_use)', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([
          sysMsg(),
          {
            type: 'assistant' as const,
            content: [
              { type: 'text', text: 'Let me look at that.' },
              { type: 'tool_use', tool_use: { name: 'read_file', input: { path: 'a.ts' } } },
              { type: 'text', text: 'Done.' },
            ],
          },
          resultSuccess(),
        ]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const msg = events.find(e => e.type === 'adapter:message') as Extract<
        AgentEvent,
        { type: 'adapter:message' }
      >
      expect(msg.content).toBe('Let me look at that.\nDone.')
    })

    it('skips assistant messages that contain only non-text blocks', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([
          sysMsg(),
          {
            type: 'assistant' as const,
            content: [
              { type: 'tool_use', tool_use: { name: 'x', input: {} } },
              { type: 'image' },
            ],
          },
          resultSuccess(),
        ]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      expect(events.find(e => e.type === 'adapter:message')).toBeUndefined()
    })

    it('handles content blocks with non-string text fields', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([
          sysMsg(),
          {
            type: 'assistant' as const,
            content: [
              { type: 'text', text: 42 as unknown as string },
              { type: 'text', text: 'real text' },
            ],
          },
          resultSuccess(),
        ]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const msg = events.find(e => e.type === 'adapter:message') as Extract<
        AgentEvent,
        { type: 'adapter:message' }
      >
      expect(msg.content).toBe('real text')
    })

    it('joins many text blocks correctly', async () => {
      const blocks = Array.from({ length: 20 }, (_, i) => ({ type: 'text', text: `line ${i}` }))
      mockQuery.mockReturnValue(
        asyncIterableOf([
          sysMsg(),
          { type: 'assistant' as const, content: blocks },
          resultSuccess(),
        ]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const msg = events.find(e => e.type === 'adapter:message') as Extract<
        AgentEvent,
        { type: 'adapter:message' }
      >
      expect(msg.content.split('\n')).toHaveLength(20)
      expect(msg.content).toContain('line 0')
      expect(msg.content).toContain('line 19')
    })
  })

  // ── Stream delta handling ───────────────────────────────

  describe('stream events', () => {
    it('emits one stream_delta per non-empty delta', async () => {
      const deltas = ['He', 'llo', ' wo', 'rld']
      mockQuery.mockReturnValue(
        asyncIterableOf([
          sysMsg(),
          ...deltas.map(d => ({ type: 'stream_event' as const, delta: d })),
          resultSuccess({ result: 'Hello world' }),
        ]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const streamEvents = events.filter(e => e.type === 'adapter:stream_delta')
      expect(streamEvents).toHaveLength(4)
      expect(streamEvents.map(e => (e as Extract<AgentEvent, { type: 'adapter:stream_delta' }>).content))
        .toEqual(deltas)
    })

    it('skips stream_event without a delta string', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([
          sysMsg(),
          { type: 'stream_event' as const, delta: null as unknown as string },
          { type: 'stream_event' as const, delta: '' },
          { type: 'stream_event' as const, delta: 'real' },
          resultSuccess(),
        ]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const streamEvents = events.filter(e => e.type === 'adapter:stream_delta')
      expect(streamEvents).toHaveLength(1)
    })
  })

  // ── Tool timing ─────────────────────────────────────────

  describe('multiple back-to-back tool calls', () => {
    it('emits a tool_call/tool_result pair per tool', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([
          sysMsg(),
          { type: 'tool_progress' as const, tool_name: 'read', input: { p: 'a' }, status: 'started' },
          { type: 'tool_progress' as const, tool_name: 'read', output: 'A', status: 'completed', duration_ms: 5 },
          { type: 'tool_progress' as const, tool_name: 'read', input: { p: 'b' }, status: 'started' },
          { type: 'tool_progress' as const, tool_name: 'read', output: 'B', status: 'completed', duration_ms: 7 },
          { type: 'tool_progress' as const, tool_name: 'write', input: { content: 'X' }, status: 'started' },
          { type: 'tool_progress' as const, tool_name: 'write', output: 'wrote', status: 'completed' },
          resultSuccess(),
        ]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const calls = events.filter(e => e.type === 'adapter:tool_call')
      const results = events.filter(e => e.type === 'adapter:tool_result')
      expect(calls).toHaveLength(3)
      expect(results).toHaveLength(3)
      const call0 = calls[0] as Extract<AgentEvent, { type: 'adapter:tool_call' }>
      const call2 = calls[2] as Extract<AgentEvent, { type: 'adapter:tool_call' }>
      expect(call0.toolName).toBe('read')
      expect(call2.toolName).toBe('write')
    })

    it('uses provided duration_ms when present, otherwise computes from start time', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([
          sysMsg(),
          { type: 'tool_progress' as const, tool_name: 'a', input: {}, status: 'started' },
          { type: 'tool_progress' as const, tool_name: 'a', output: 'x', status: 'completed', duration_ms: 999 },
          resultSuccess(),
        ]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const result = events.find(e => e.type === 'adapter:tool_result') as Extract<
        AgentEvent,
        { type: 'adapter:tool_result' }
      >
      expect(result.durationMs).toBe(999)
    })

    it('uses empty string for missing tool output', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([
          sysMsg(),
          { type: 'tool_progress' as const, tool_name: 'x', status: 'completed' },
          resultSuccess(),
        ]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const result = events.find(e => e.type === 'adapter:tool_result') as Extract<
        AgentEvent,
        { type: 'adapter:tool_result' }
      >
      expect(result.output).toBe('')
    })
  })

  // ── Large system prompt handling ────────────────────────

  describe('large system prompt', () => {
    it('passes a 10KB+ system prompt to SDK without truncation', async () => {
      const big = 'X'.repeat(10_000)
      mockQuery.mockReturnValue(asyncIterableOf([sysMsg(), resultSuccess()]))
      await collectEvents(adapter.execute({ prompt: 'p', systemPrompt: big }))
      const call = mockQuery.mock.calls[0]![0] as Record<string, unknown>
      const opts = call['options'] as Record<string, unknown>
      // The builder may wrap into an object, but the prompt content must appear somewhere
      const serialized = JSON.stringify(opts['systemPrompt'])
      expect(serialized.length).toBeGreaterThanOrEqual(10_000)
    })

    it('emits started event with the original (un-truncated) systemPrompt field', async () => {
      const big = 'Y'.repeat(5_000)
      mockQuery.mockReturnValue(asyncIterableOf([sysMsg(), resultSuccess()]))
      const events = await collectEvents(adapter.execute({ prompt: 'p', systemPrompt: big }))
      const started = events.find(e => e.type === 'adapter:started') as Extract<
        AgentEvent,
        { type: 'adapter:started' }
      >
      expect(started.systemPrompt).toBe(big)
    })
  })

  // ── Failed result subtypes ──────────────────────────────

  describe('failed result subtypes', () => {
    it('emits failed with code "error_max_turns"', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([sysMsg(), resultError('error_max_turns', 'Max turns reached')]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const failed = events.find(e => e.type === 'adapter:failed') as Extract<
        AgentEvent,
        { type: 'adapter:failed' }
      >
      expect(failed.code).toBe('error_max_turns')
      expect(failed.error).toBe('Max turns reached')
    })

    it('emits failed with code "error_during_execution"', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([sysMsg(), resultError('error_during_execution', 'Tool crashed')]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const failed = events.find(e => e.type === 'adapter:failed') as Extract<
        AgentEvent,
        { type: 'adapter:failed' }
      >
      expect(failed.code).toBe('error_during_execution')
    })

    it('synthesizes default error message when SDK omits one', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([sysMsg(), { type: 'result' as const, subtype: 'error_unknown' }]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const failed = events.find(e => e.type === 'adapter:failed') as Extract<
        AgentEvent,
        { type: 'adapter:failed' }
      >
      expect(failed.error).toContain('error_unknown')
    })
  })

  // ── Correlation ID propagation ──────────────────────────

  describe('correlationId propagation', () => {
    it('attaches correlationId to every emitted event', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([
          sysMsg(),
          { type: 'assistant' as const, content: [{ type: 'text', text: 'hi' }] },
          { type: 'tool_progress' as const, tool_name: 'x', input: {}, status: 'started' },
          { type: 'tool_progress' as const, tool_name: 'x', output: 'r', status: 'completed' },
          { type: 'stream_event' as const, delta: '!' },
          resultSuccess(),
        ]),
      )
      const events = await collectEvents(
        adapter.execute({ prompt: 'p', correlationId: 'corr-xyz' }),
      )
      for (const e of events) {
        const rec = e as unknown as Record<string, unknown>
        expect(rec['correlationId']).toBe('corr-xyz')
      }
    })

    it('omits correlationId when not provided', async () => {
      mockQuery.mockReturnValue(asyncIterableOf([sysMsg(), resultSuccess()]))
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      for (const e of events) {
        const rec = e as unknown as Record<string, unknown>
        expect(rec['correlationId']).toBeUndefined()
      }
    })
  })

  // ── Realistic full conversation ─────────────────────────

  describe('realistic full conversation flow', () => {
    it('produces correctly ordered event types across system/assistant/tool/result', async () => {
      mockQuery.mockReturnValue(
        asyncIterableOf([
          sysMsg('sess-final', 'claude-sonnet-4-20250514'),
          { type: 'assistant' as const, content: [{ type: 'text', text: 'Reading file.' }] },
          { type: 'tool_progress' as const, tool_name: 'read_file', input: { path: 'a.ts' }, status: 'started' },
          { type: 'tool_progress' as const, tool_name: 'read_file', output: 'export const x = 1', status: 'completed', duration_ms: 12 },
          { type: 'assistant' as const, content: [{ type: 'text', text: 'Found it.' }] },
          { type: 'stream_event' as const, delta: 'Final ' },
          { type: 'stream_event' as const, delta: 'thoughts.' },
          resultSuccess({
            result: 'Found it.\nFinal thoughts.',
            sessionId: 'sess-final',
            usage: { input_tokens: 75, output_tokens: 30, cached_input_tokens: 50 },
            durationMs: 1234,
          }),
        ]),
      )
      const events = await collectEvents(adapter.execute({ prompt: 'find x' }))
      expect(events.map(e => e.type)).toEqual([
        'adapter:started',
        'adapter:message',
        'adapter:tool_call',
        'adapter:tool_result',
        'adapter:message',
        'adapter:stream_delta',
        'adapter:stream_delta',
        'adapter:completed',
      ])
      const completed = events.at(-1) as Extract<AgentEvent, { type: 'adapter:completed' }>
      expect(completed.sessionId).toBe('sess-final')
      expect(completed.durationMs).toBe(1234)
      expect(completed.usage?.cachedInputTokens).toBe(50)
    })
  })
})
