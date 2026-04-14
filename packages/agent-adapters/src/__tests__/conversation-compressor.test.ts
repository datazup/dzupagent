import { describe, expect, it, vi } from 'vitest'

import { ConversationCompressor } from '../session/conversation-compressor.js'
import type { AgentEvent } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts() {
  return Date.now()
}

function startedEvent(prompt: string): AgentEvent {
  return {
    type: 'adapter:started',
    providerId: 'claude',
    sessionId: 's1',
    prompt,
    isResume: false,
    timestamp: ts(),
  }
}

function msgEvent(content: string): AgentEvent {
  return { type: 'adapter:message', providerId: 'claude', sessionId: 's1', content, timestamp: ts() }
}

function toolCallEvent(toolName: string): AgentEvent {
  return {
    type: 'adapter:tool_call',
    providerId: 'claude',
    sessionId: 's1',
    toolName,
    input: {},
    timestamp: ts(),
  }
}

function toolResultEvent(toolName: string, output = 'ok'): AgentEvent {
  return {
    type: 'adapter:tool_result',
    providerId: 'claude',
    sessionId: 's1',
    toolName,
    output,
    durationMs: 5,
    timestamp: ts(),
  }
}

function completedEvent(): AgentEvent {
  return {
    type: 'adapter:completed',
    providerId: 'claude',
    sessionId: 's1',
    result: 'done',
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0,
    durationMs: 100,
    timestamp: ts(),
  }
}

function failedEvent(): AgentEvent {
  return {
    type: 'adapter:failed',
    providerId: 'claude',
    sessionId: 's1',
    error: 'timeout',
    recoverable: true,
    timestamp: ts(),
  }
}

/** Simulate a single turn of events. */
function makeTurn(prompt: string, response: string, tools: string[] = []): AgentEvent[] {
  const events: AgentEvent[] = [startedEvent(prompt)]
  for (const tool of tools) {
    events.push(toolCallEvent(tool))
    events.push(toolResultEvent(tool))
  }
  events.push(msgEvent(response))
  events.push(completedEvent())
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConversationCompressor', () => {
  describe('initial state', () => {
    it('hasTurns is false before any events', () => {
      expect(new ConversationCompressor().hasTurns).toBe(false)
    })

    it('buildHistory returns null before any events', () => {
      expect(new ConversationCompressor().buildHistory()).toBeNull()
    })

    it('getTurns returns empty array', () => {
      expect(new ConversationCompressor().getTurns()).toHaveLength(0)
    })
  })

  describe('recordEvent — turn detection', () => {
    it('records a complete turn on completed event', () => {
      const c = new ConversationCompressor()
      c.recordEvents(makeTurn('Write a test.', 'Here is the test.'))
      expect(c.hasTurns).toBe(true)
      expect(c.getTurns()).toHaveLength(1)
    })

    it('records turn on failed event', () => {
      const c = new ConversationCompressor()
      c.recordEvents([startedEvent('Run something.'), failedEvent()])
      expect(c.hasTurns).toBe(true)
    })

    it('records multiple turns in sequence', () => {
      const c = new ConversationCompressor()
      c.recordEvents(makeTurn('Turn 1', 'Response 1'))
      c.recordEvents(makeTurn('Turn 2', 'Response 2'))
      expect(c.getTurns()).toHaveLength(2)
    })

    it('stores prompt from adapter:started', () => {
      const c = new ConversationCompressor()
      c.recordEvents(makeTurn('My question?', 'My answer.'))
      expect(c.getTurns()[0]?.prompt).toBe('My question?')
    })

    it('stores response from adapter:message events', () => {
      const c = new ConversationCompressor()
      c.recordEvents(makeTurn('Test', 'Response text here.'))
      expect(c.getTurns()[0]?.response).toContain('Response text here.')
    })

    it('joins multiple message events with newline', () => {
      const c = new ConversationCompressor()
      c.recordEvents([
        startedEvent('Q'),
        msgEvent('Part A.'),
        msgEvent('Part B.'),
        completedEvent(),
      ])
      expect(c.getTurns()[0]?.response).toBe('Part A.\nPart B.')
    })

    it('stores tool summary from tool_call and tool_result events', () => {
      const c = new ConversationCompressor()
      c.recordEvents(makeTurn('List files', 'Done.', ['list_files', 'read_file']))
      const turn = c.getTurns()[0]!
      expect(turn.toolSummary).toContain('call:list_files')
      expect(turn.toolSummary).toContain('result:list_files')
    })

    it('ignores stream_delta events', () => {
      const c = new ConversationCompressor()
      const deltaEvent: AgentEvent = {
        type: 'adapter:stream_delta',
        providerId: 'claude',
        sessionId: 's1',
        delta: 'partial',
        timestamp: ts(),
      }
      c.recordEvents([startedEvent('Q'), deltaEvent, completedEvent()])
      expect(c.hasTurns).toBe(true)
      // stream_delta should not inflate tool summary or response
      expect(c.getTurns()[0]?.toolSummary).toHaveLength(0)
    })
  })

  describe('buildHistory', () => {
    it('includes all turns in history', () => {
      const c = new ConversationCompressor()
      c.recordEvents(makeTurn('Q1', 'A1'))
      c.recordEvents(makeTurn('Q2', 'A2'))
      const h = c.buildHistory() ?? ''
      expect(h).toContain('[user]: Q1')
      expect(h).toContain('[user]: Q2')
    })

    it('includes tool summary in output', () => {
      const c = new ConversationCompressor()
      c.recordEvents(makeTurn('List files', 'Done.', ['list_files']))
      const h = c.buildHistory() ?? ''
      expect(h).toContain('[tools]: call:list_files, result:list_files')
    })

    it('includes default header', () => {
      const c = new ConversationCompressor()
      c.recordEvents(makeTurn('Q', 'A'))
      expect(c.buildHistory()).toContain('## Conversation history')
    })

    it('uses custom header', () => {
      const c = new ConversationCompressor({ header: '## MY HISTORY\n' })
      c.recordEvents(makeTurn('Q', 'A'))
      expect(c.buildHistory()).toContain('## MY HISTORY')
    })

    it('trims oldest turns when over token budget', () => {
      // Very tight budget: 50 tokens = 200 chars
      const c = new ConversationCompressor({ tokenBudget: 50 })
      // Add many turns
      for (let i = 0; i < 20; i++) {
        c.recordEvents(makeTurn(`Question number ${i}`, `Answer number ${i}`))
      }
      const h = c.buildHistory() ?? ''
      expect(h.length).toBeLessThanOrEqual(50 * 4 + 5) // small tolerance
      // Should contain the most recent turn
      expect(h).toContain('Question number 19')
      // Should NOT contain the oldest turn
      expect(h).not.toContain('Question number 0')
    })

    it('uses custom compress function when provided', () => {
      const compress = vi.fn().mockReturnValue('Custom output')
      const c = new ConversationCompressor({ compress })
      c.recordEvents(makeTurn('Q', 'A'))
      const h = c.buildHistory()
      expect(h).toBe('Custom output')
      expect(compress).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ prompt: 'Q' })]),
        expect.any(Number),
      )
    })
  })

  describe('estimateTokens', () => {
    it('returns 0 when no turns', () => {
      expect(new ConversationCompressor().estimateTokens()).toBe(0)
    })

    it('returns positive value after turns are added', () => {
      const c = new ConversationCompressor()
      c.recordEvents(makeTurn('Hello world', 'Hi there, how can I help?'))
      expect(c.estimateTokens()).toBeGreaterThan(0)
    })
  })

  describe('reset', () => {
    it('clears all turns', () => {
      const c = new ConversationCompressor()
      c.recordEvents(makeTurn('Q', 'A'))
      c.reset()
      expect(c.hasTurns).toBe(false)
      expect(c.buildHistory()).toBeNull()
    })
  })

  describe('getTurns', () => {
    it('returns a defensive copy (mutations do not affect internal state)', () => {
      const c = new ConversationCompressor()
      c.recordEvents(makeTurn('Q', 'A'))
      const copy = c.getTurns()
      copy.push({ prompt: 'injected', response: '', toolSummary: [] })
      expect(c.getTurns()).toHaveLength(1)
    })
  })
})
