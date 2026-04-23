/**
 * Unit tests for the unified `normalizeEvent()` dispatcher.
 *
 * Covers the happy-path mapping for every supported provider plus
 * defensive handling of invalid input.
 */
import { describe, it, expect } from 'vitest'
import { normalizeEvent } from '../normalize.js'

describe('normalizeEvent', () => {
  describe('defensive input handling', () => {
    it('returns null for null input', () => {
      expect(normalizeEvent(null, 'claude')).toBeNull()
    })

    it('returns null for undefined input', () => {
      expect(normalizeEvent(undefined, 'claude')).toBeNull()
    })

    it('returns null for non-object input', () => {
      expect(normalizeEvent('a string', 'claude')).toBeNull()
      expect(normalizeEvent(42, 'claude')).toBeNull()
      expect(normalizeEvent(true, 'claude')).toBeNull()
    })

    it('returns null for an empty object (no recognizable shape)', () => {
      expect(normalizeEvent({}, 'claude')).toBeNull()
    })
  })

  describe('claude', () => {
    it('maps system → adapter:started', () => {
      const evt = normalizeEvent(
        { type: 'system', session_id: 'sess-123', model: 'claude-sonnet-4-5' },
        'claude',
      )
      expect(evt).not.toBeNull()
      expect(evt).toMatchObject({
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 'sess-123',
        model: 'claude-sonnet-4-5',
      })
    })

    it('maps assistant text block → adapter:message', () => {
      const evt = normalizeEvent(
        {
          type: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
        },
        'claude',
      )
      expect(evt).toMatchObject({
        type: 'adapter:message',
        providerId: 'claude',
        content: 'Hello',
        role: 'assistant',
      })
    })

    it('maps assistant tool_use block → adapter:tool_call', () => {
      const evt = normalizeEvent(
        {
          type: 'assistant',
          content: [{ type: 'tool_use', name: 'bash', input: { cmd: 'ls' } }],
        },
        'claude',
      )
      expect(evt).toMatchObject({
        type: 'adapter:tool_call',
        providerId: 'claude',
        toolName: 'bash',
        input: { cmd: 'ls' },
      })
    })

    it('maps result → adapter:completed', () => {
      const evt = normalizeEvent(
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-1',
          result: 'done',
          duration_ms: 1234,
        },
        'claude',
      )
      expect(evt).toMatchObject({
        type: 'adapter:completed',
        providerId: 'claude',
        sessionId: 'sess-1',
        result: 'done',
        durationMs: 1234,
      })
    })

    it('maps stream_event → adapter:stream_delta', () => {
      const evt = normalizeEvent({ type: 'stream_event', delta: 'chunk' }, 'claude')
      expect(evt).toMatchObject({
        type: 'adapter:stream_delta',
        providerId: 'claude',
        content: 'chunk',
      })
    })

    it('maps result with error → adapter:failed', () => {
      const evt = normalizeEvent(
        { type: 'result', subtype: 'error', error: { message: 'boom' } },
        'claude',
      )
      expect(evt).toMatchObject({
        type: 'adapter:failed',
        providerId: 'claude',
        error: 'boom',
      })
    })
  })

  describe('codex', () => {
    it('maps thread_started → adapter:started', () => {
      const evt = normalizeEvent(
        { type: 'thread_started', thread_id: 'th-7' },
        'codex',
      )
      expect(evt).toMatchObject({
        type: 'adapter:started',
        providerId: 'codex',
        sessionId: 'th-7',
      })
    })

    it('maps agent_message → adapter:message', () => {
      const evt = normalizeEvent(
        { type: 'agent_message', text: 'Hello from Codex' },
        'codex',
      )
      expect(evt).toMatchObject({
        type: 'adapter:message',
        providerId: 'codex',
        content: 'Hello from Codex',
        role: 'assistant',
      })
    })

    it('maps command_execution started → adapter:tool_call', () => {
      const evt = normalizeEvent(
        { type: 'command_execution', status: 'in_progress', command: 'ls -la' },
        'codex',
      )
      expect(evt).toMatchObject({
        type: 'adapter:tool_call',
        providerId: 'codex',
        toolName: 'shell',
      })
    })

    it('maps command_execution completed → adapter:tool_result', () => {
      const evt = normalizeEvent(
        {
          type: 'command_execution',
          status: 'completed',
          aggregated_output: 'file.txt\n',
          duration_ms: 50,
        },
        'codex',
      )
      expect(evt).toMatchObject({
        type: 'adapter:tool_result',
        providerId: 'codex',
        toolName: 'shell',
        output: 'file.txt\n',
        durationMs: 50,
      })
    })

    it('maps turn_completed → adapter:completed', () => {
      const evt = normalizeEvent(
        { type: 'turn_completed', thread_id: 'th-1', result: 'ok', duration_ms: 10 },
        'codex',
      )
      expect(evt).toMatchObject({
        type: 'adapter:completed',
        providerId: 'codex',
        sessionId: 'th-1',
        result: 'ok',
      })
    })

    it('maps error → adapter:failed', () => {
      const evt = normalizeEvent(
        { type: 'error', thread_id: 'th-1', message: 'oops' },
        'codex',
      )
      expect(evt).toMatchObject({
        type: 'adapter:failed',
        providerId: 'codex',
        error: 'oops',
      })
    })
  })

  describe('gemini', () => {
    it('maps message → adapter:message', () => {
      const evt = normalizeEvent(
        { type: 'message', content: 'hello', role: 'assistant' },
        'gemini',
      )
      expect(evt).toMatchObject({
        type: 'adapter:message',
        providerId: 'gemini',
        content: 'hello',
        role: 'assistant',
      })
    })

    it('maps tool_call → adapter:tool_call', () => {
      const evt = normalizeEvent(
        { type: 'tool_call', name: 'read_file', arguments: { path: '/x' } },
        'gemini',
      )
      expect(evt).toMatchObject({
        type: 'adapter:tool_call',
        providerId: 'gemini',
        toolName: 'read_file',
      })
    })

    it('maps session_started → adapter:started', () => {
      const evt = normalizeEvent(
        { type: 'session_started', session_id: 'gs-1' },
        'gemini',
      )
      expect(evt).toMatchObject({
        type: 'adapter:started',
        providerId: 'gemini',
        sessionId: 'gs-1',
      })
    })
  })

  describe('goose', () => {
    it('maps message → adapter:message', () => {
      const evt = normalizeEvent(
        { type: 'message', content: 'goose-say' },
        'goose',
      )
      expect(evt).toMatchObject({
        type: 'adapter:message',
        providerId: 'goose',
        content: 'goose-say',
      })
    })

    it('maps tool_result → adapter:tool_result', () => {
      const evt = normalizeEvent(
        {
          type: 'tool_result',
          name: 'bash',
          output: 'ran',
          duration_ms: 12,
        },
        'goose',
      )
      expect(evt).toMatchObject({
        type: 'adapter:tool_result',
        providerId: 'goose',
        toolName: 'bash',
        output: 'ran',
        durationMs: 12,
      })
    })
  })

  describe('qwen', () => {
    it('maps response → adapter:message', () => {
      const evt = normalizeEvent(
        { type: 'response', content: 'qwen-reply' },
        'qwen',
      )
      expect(evt).toMatchObject({
        type: 'adapter:message',
        providerId: 'qwen',
        content: 'qwen-reply',
      })
    })

    it('maps function_call with `function` key (qwen-specific) → adapter:tool_call', () => {
      const evt = normalizeEvent(
        { type: 'function_call', function: 'search', arguments: { q: 'a' } },
        'qwen',
      )
      expect(evt).toMatchObject({
        type: 'adapter:tool_call',
        providerId: 'qwen',
        toolName: 'search',
      })
    })

    it('maps done → adapter:completed', () => {
      const evt = normalizeEvent(
        { type: 'done', result: 'final', duration_ms: 99 },
        'qwen',
      )
      expect(evt).toMatchObject({
        type: 'adapter:completed',
        providerId: 'qwen',
        result: 'final',
        durationMs: 99,
      })
    })
  })

  describe('crush', () => {
    it('maps stream_delta → adapter:stream_delta', () => {
      const evt = normalizeEvent(
        { type: 'stream_delta', content: 'partial' },
        'crush',
      )
      expect(evt).toMatchObject({
        type: 'adapter:stream_delta',
        providerId: 'crush',
        content: 'partial',
      })
    })

    it('maps error → adapter:failed', () => {
      const evt = normalizeEvent(
        { type: 'error', message: 'crash' },
        'crush',
      )
      expect(evt).toMatchObject({
        type: 'adapter:failed',
        providerId: 'crush',
        error: 'crash',
      })
    })
  })

  describe('openrouter', () => {
    it('maps message → adapter:message', () => {
      const evt = normalizeEvent(
        { type: 'message', content: 'or-reply' },
        'openrouter',
      )
      expect(evt).toMatchObject({
        type: 'adapter:message',
        providerId: 'openrouter',
        content: 'or-reply',
      })
    })
  })

  describe('gemini-sdk', () => {
    it('maps session_started → adapter:started', () => {
      const evt = normalizeEvent(
        { type: 'session_started', session_id: 'gsdk-1' },
        'gemini-sdk',
      )
      expect(evt).toMatchObject({
        type: 'adapter:started',
        providerId: 'gemini-sdk',
        sessionId: 'gsdk-1',
      })
    })
  })
})
