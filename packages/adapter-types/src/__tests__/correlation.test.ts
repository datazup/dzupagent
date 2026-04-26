import { describe, expect, it } from 'vitest'

import type {
  AgentCompletedEvent,
  AgentMessageEvent,
  AgentToolCallEvent,
} from '../contracts/events.js'
import { withCorrelationId } from '../utils/correlation.js'

describe('withCorrelationId', () => {
  const baseMessage: AgentMessageEvent = {
    type: 'adapter:message',
    providerId: 'claude',
    content: 'hello',
    role: 'assistant',
    timestamp: 123,
  }

  it('returns the original event unchanged when correlationId is undefined', () => {
    const result = withCorrelationId(baseMessage, undefined)
    expect(result).toBe(baseMessage)
    expect('correlationId' in result).toBe(false)
  })

  it('returns the original event unchanged when correlationId is an empty string', () => {
    // Empty string is falsy; helper treats it as "no correlation" so consumers
    // never observe a meaningless empty correlation id on the wire.
    const result = withCorrelationId(baseMessage, '')
    expect(result).toBe(baseMessage)
    expect('correlationId' in result).toBe(false)
  })

  it('returns a new event with correlationId set when provided', () => {
    const result = withCorrelationId(baseMessage, 'corr-1')
    expect(result).not.toBe(baseMessage)
    expect(result.correlationId).toBe('corr-1')
    // Original event must not be mutated
    expect(baseMessage.correlationId).toBeUndefined()
    // All other fields preserved
    expect(result).toEqual({ ...baseMessage, correlationId: 'corr-1' })
  })

  it('preserves the discriminated-union type of the event', () => {
    const completed: AgentCompletedEvent = {
      type: 'adapter:completed',
      providerId: 'codex',
      sessionId: 'sess-1',
      result: 'done',
      durationMs: 10,
      timestamp: 1,
    }
    const result = withCorrelationId(completed, 'corr-2')
    // Type narrows back to the input shape — the test verifies via field access
    expect(result.type).toBe('adapter:completed')
    expect(result.sessionId).toBe('sess-1')
    expect(result.correlationId).toBe('corr-2')
  })

  it('overwrites a pre-existing correlationId on the event', () => {
    const toolCall: AgentToolCallEvent = {
      type: 'adapter:tool_call',
      providerId: 'gemini',
      toolName: 'search',
      input: { q: 'x' },
      timestamp: 1,
      correlationId: 'old',
    }
    const result = withCorrelationId(toolCall, 'new')
    expect(result.correlationId).toBe('new')
    // Original is not mutated
    expect(toolCall.correlationId).toBe('old')
  })
})
