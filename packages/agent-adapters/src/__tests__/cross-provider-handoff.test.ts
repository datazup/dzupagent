import { describe, expect, it } from 'vitest'

import { CrossProviderHandoff } from '../recovery/cross-provider-handoff.js'
import type { AgentEvent } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts() {
  return Date.now()
}

function msgEvent(content: string): AgentEvent {
  return { type: 'adapter:message', providerId: 'claude', sessionId: 's1', content, timestamp: ts() }
}

function toolCallEvent(toolName: string, input: unknown = {}): AgentEvent {
  return { type: 'adapter:tool_call', providerId: 'claude', sessionId: 's1', toolName, input, timestamp: ts() }
}

function toolResultEvent(toolName: string, output: string): AgentEvent {
  return { type: 'adapter:tool_result', providerId: 'claude', sessionId: 's1', toolName, output, durationMs: 10, timestamp: ts() }
}

function startedEvent(): AgentEvent {
  return {
    type: 'adapter:started',
    providerId: 'claude',
    sessionId: 's1',
    prompt: 'test',
    isResume: false,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrossProviderHandoff', () => {
  describe('recordEvent and hasContent', () => {
    it('hasContent is false when no events recorded', () => {
      expect(new CrossProviderHandoff().hasContent).toBe(false)
    })

    it('becomes true after a message event', () => {
      const h = new CrossProviderHandoff()
      h.recordEvent(msgEvent('Hello'))
      expect(h.hasContent).toBe(true)
    })

    it('does not count empty message content', () => {
      const h = new CrossProviderHandoff()
      h.recordEvent(msgEvent('   '))
      expect(h.hasContent).toBe(false)
    })

    it('ignores adapter:started events', () => {
      const h = new CrossProviderHandoff()
      h.recordEvent(startedEvent())
      expect(h.hasContent).toBe(false)
    })

    it('ignores adapter:failed events', () => {
      const h = new CrossProviderHandoff()
      h.recordEvent(failedEvent())
      expect(h.hasContent).toBe(false)
    })

    it('records tool_call events', () => {
      const h = new CrossProviderHandoff()
      h.recordEvent(toolCallEvent('read_file', { path: '/tmp/x.ts' }))
      expect(h.hasContent).toBe(true)
    })

    it('records non-empty tool_result events', () => {
      const h = new CrossProviderHandoff()
      h.recordEvent(toolResultEvent('read_file', 'file contents here'))
      expect(h.hasContent).toBe(true)
    })

    it('does not record empty tool_result output', () => {
      const h = new CrossProviderHandoff()
      h.recordEvent(toolResultEvent('read_file', ''))
      expect(h.hasContent).toBe(false)
    })
  })

  describe('buildHandoffContext', () => {
    it('returns null when no content', () => {
      expect(new CrossProviderHandoff().buildHandoffContext()).toBeNull()
    })

    it('includes default header', () => {
      const h = new CrossProviderHandoff()
      h.recordEvent(msgEvent('Step 1 done.'))
      expect(h.buildHandoffContext()).toContain('## Partial progress from previous provider')
    })

    it('includes default footer', () => {
      const h = new CrossProviderHandoff()
      h.recordEvent(msgEvent('Step 1 done.'))
      expect(h.buildHandoffContext()).toContain('Continue the task from where the previous provider left off.')
    })

    it('formats message items with [assistant] prefix', () => {
      const h = new CrossProviderHandoff()
      h.recordEvent(msgEvent('I found the bug.'))
      expect(h.buildHandoffContext()).toContain('[assistant]: I found the bug.')
    })

    it('formats tool_call with tool name and JSON args', () => {
      const h = new CrossProviderHandoff()
      h.recordEvent(toolCallEvent('list_files', { dir: '/src' }))
      const ctx = h.buildHandoffContext() ?? ''
      expect(ctx).toContain('[tool_call]: list_files({"dir":"/src"})')
    })

    it('formats tool_result with tool name', () => {
      const h = new CrossProviderHandoff()
      h.recordEvent(toolResultEvent('grep', 'match found at line 42'))
      const ctx = h.buildHandoffContext() ?? ''
      expect(ctx).toContain('[tool_result:grep]: match found at line 42')
    })

    it('uses custom header and footer', () => {
      const h = new CrossProviderHandoff({ header: '## MY HEADER\n', footer: '\n## END\n' })
      h.recordEvent(msgEvent('Done.'))
      const ctx = h.buildHandoffContext() ?? ''
      expect(ctx).toContain('## MY HEADER')
      expect(ctx).toContain('## END')
    })

    it('truncates to maxItems (keeps newest)', () => {
      const h = new CrossProviderHandoff({ maxItems: 2 })
      h.recordEvent(msgEvent('First'))
      h.recordEvent(msgEvent('Second'))
      h.recordEvent(msgEvent('Third'))
      const ctx = h.buildHandoffContext() ?? ''
      expect(ctx).not.toContain('[assistant]: First')
      expect(ctx).toContain('[assistant]: Second')
      expect(ctx).toContain('[assistant]: Third')
    })
  })

  describe('recordEvents (batch)', () => {
    it('processes multiple events at once', () => {
      const h = new CrossProviderHandoff()
      h.recordEvents([msgEvent('A'), msgEvent('B'), startedEvent()])
      const ctx = h.buildHandoffContext() ?? ''
      expect(ctx).toContain('[assistant]: A')
      expect(ctx).toContain('[assistant]: B')
    })
  })

  describe('reset', () => {
    it('clears all captured items', () => {
      const h = new CrossProviderHandoff()
      h.recordEvent(msgEvent('X'))
      h.reset()
      expect(h.hasContent).toBe(false)
      expect(h.buildHandoffContext()).toBeNull()
    })
  })

  describe('CrossProviderHandoff.enrichInput', () => {
    it('returns original input when no events captured', () => {
      const input = { prompt: 'Test' }
      const result = CrossProviderHandoff.enrichInput(input, [])
      expect(result).toBe(input)
    })

    it('returns original input when only non-content events', () => {
      const input = { prompt: 'Test' }
      const result = CrossProviderHandoff.enrichInput(input, [startedEvent(), failedEvent()])
      expect(result).toBe(input)
    })

    it('prepends context to systemPrompt when content was captured', () => {
      const input = { prompt: 'Finish the task' }
      const events: AgentEvent[] = [msgEvent('Completed step 1.'), toolCallEvent('write_file', {})]
      const result = CrossProviderHandoff.enrichInput(input, events)
      expect(result.systemPrompt).toContain('Partial progress from previous provider')
      expect(result.systemPrompt).toContain('[assistant]: Completed step 1.')
    })

    it('appends to existing systemPrompt', () => {
      const input = { prompt: 'Go', systemPrompt: 'Be helpful.' }
      const result = CrossProviderHandoff.enrichInput(input, [msgEvent('Step A done.')])
      expect(result.systemPrompt).toContain('Be helpful.')
      expect(result.systemPrompt).toContain('Step A done.')
      // Handoff context comes first so model reads history before instructions
      const sp = result.systemPrompt ?? ''
      expect(sp.indexOf('Step A done.')).toBeLessThan(sp.indexOf('Be helpful.'))
    })

    it('accepts custom options', () => {
      const input = { prompt: 'Continue' }
      const result = CrossProviderHandoff.enrichInput(
        input,
        [msgEvent('Done A.')],
        { header: '## HISTORY\n', footer: '\n## /HISTORY\n' },
      )
      expect(result.systemPrompt).toContain('## HISTORY')
    })

    it('preserves other input fields', () => {
      const input = { prompt: 'Test', maxTurns: 5, workingDirectory: '/tmp' }
      const result = CrossProviderHandoff.enrichInput(input, [msgEvent('X')])
      expect(result.maxTurns).toBe(5)
      expect(result.workingDirectory).toBe('/tmp')
    })
  })
})
