import { describe, it, expect } from 'vitest'
import { sanitizeContent, createContentSanitizerMiddleware } from '../middleware/content-sanitizer.js'
import type { AgentEvent } from '../types.js'

describe('sanitizeContent', () => {
  it('strips HTML tags', () => {
    expect(sanitizeContent('<script>alert("xss")</script>Hello')).toBe('alert("xss")Hello')
  })

  it('strips nested HTML', () => {
    expect(sanitizeContent('<div><b>bold</b></div>')).toBe('bold')
  })

  it('strips javascript: protocol', () => {
    expect(sanitizeContent('click javascript:alert(1)')).toBe('click alert(1)')
  })

  it('strips on* event handlers', () => {
    expect(sanitizeContent('img onerror=alert(1) src=x')).toBe('img alert(1) src=x')
  })

  it('strips data:text/html URIs', () => {
    expect(sanitizeContent('data:text/html,<script>x</script>')).toBe(',x')
  })

  it('truncates at maxContentLength', () => {
    expect(sanitizeContent('hello world', { maxContentLength: 5 })).toBe('hello')
  })

  it('applies custom sanitizer', () => {
    expect(sanitizeContent('hello', { customSanitizer: s => s.toUpperCase() })).toBe('HELLO')
  })

  it('preserves safe content', () => {
    expect(sanitizeContent('This is normal text with code: const x = 1')).toBe('This is normal text with code: const x = 1')
  })

  it('handles empty string', () => {
    expect(sanitizeContent('')).toBe('')
  })

  it('can disable HTML stripping', () => {
    expect(sanitizeContent('<b>bold</b>', { stripHtml: false })).toBe('<b>bold</b>')
  })
})

describe('createContentSanitizerMiddleware', () => {
  async function* mockSource(events: AgentEvent[]): AsyncGenerator<AgentEvent, void, undefined> {
    for (const e of events) yield e
  }

  it('sanitizes message content', async () => {
    const mw = createContentSanitizerMiddleware()
    const events: AgentEvent[] = [
      { type: 'adapter:message', providerId: 'claude', content: '<script>xss</script>Hello', role: 'assistant', timestamp: 1 },
    ]
    const result: AgentEvent[] = []
    for await (const e of mw(mockSource(events), { input: { prompt: '' }, providerId: 'claude' })) result.push(e)
    expect((result[0] as Extract<AgentEvent, { type: 'adapter:message' }>).content).toBe('xssHello')
  })

  it('sanitizes stream_delta content', async () => {
    const mw = createContentSanitizerMiddleware()
    const events: AgentEvent[] = [
      { type: 'adapter:stream_delta', providerId: 'claude', content: 'javascript:void(0)', timestamp: 1 },
    ]
    const result: AgentEvent[] = []
    for await (const e of mw(mockSource(events), { input: { prompt: '' }, providerId: 'claude' })) result.push(e)
    expect((result[0] as Extract<AgentEvent, { type: 'adapter:stream_delta' }>).content).toBe('void(0)')
  })

  it('sanitizes completed result', async () => {
    const mw = createContentSanitizerMiddleware()
    const events: AgentEvent[] = [
      { type: 'adapter:completed', providerId: 'claude', sessionId: 's1', result: '<img onerror=alert(1)>', durationMs: 100, timestamp: 1 },
    ]
    const result: AgentEvent[] = []
    for await (const e of mw(mockSource(events), { input: { prompt: '' }, providerId: 'claude' })) result.push(e)
    expect((result[0] as Extract<AgentEvent, { type: 'adapter:completed' }>).result).not.toContain('onerror')
  })

  it('passes non-content events through', async () => {
    const mw = createContentSanitizerMiddleware()
    const events: AgentEvent[] = [
      { type: 'adapter:started', providerId: 'claude', sessionId: 's1', timestamp: 1 },
    ]
    const result: AgentEvent[] = []
    for await (const e of mw(mockSource(events), { input: { prompt: '' }, providerId: 'claude' })) result.push(e)
    expect(result[0]).toEqual(events[0])
  })
})
