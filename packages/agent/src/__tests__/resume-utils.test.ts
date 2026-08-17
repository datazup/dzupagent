import { describe, it, expect } from 'vitest'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import type { RunJournalEntry } from '@dzupagent/core'
import { rehydrateMessagesFromJournal } from '../agent/resume-utils.js'

// `Partial<RunJournalEntry> &` is load-bearing: `Partial<T>` distributes over
// the entry union, so intersecting it with a literal `type` narrows `data` to
// that entry's payload shape and every fixture below is checked against the
// real journal contract. Widening `data` to a bare `unknown` silently stops
// checking them.
function entry(partial: Partial<RunJournalEntry> & { type: RunJournalEntry['type']; seq: number; data: unknown }): RunJournalEntry {
  return {
    v: 1,
    seq: partial.seq,
    ts: '2026-04-20T00:00:00.000Z',
    runId: 'run-1',
    type: partial.type,
    data: partial.data,
  } as RunJournalEntry
}

function typeOf(m: unknown): string {
  const typed = m as { _getType?: () => string }
  return typeof typed._getType === 'function' ? typed._getType() : ''
}

describe('rehydrateMessagesFromJournal', () => {
  it('returns a single HumanMessage when no step_completed entries exist', () => {
    const messages = rehydrateMessagesFromJournal([], 'do task X')
    expect(messages).toHaveLength(1)
    expect(typeOf(messages[0])).toBe('human')
    expect(messages[0]).toBeInstanceOf(HumanMessage)
    expect(messages[0]!.content).toBe('do task X')
  })

  it('emits HumanMessage + AIMessage per step_completed in seq order', () => {
    const entries: RunJournalEntry[] = [
      entry({ type: 'step_completed', seq: 2, data: { stepId: 's1', toolName: 'search', output: 'found 3' } }),
      entry({ type: 'step_completed', seq: 3, data: { stepId: 's2', toolName: 'write_file', output: 'written' } }),
    ]
    const messages = rehydrateMessagesFromJournal(entries, 'original input')
    expect(messages).toHaveLength(3)
    expect(messages[0]).toBeInstanceOf(HumanMessage)
    expect(messages[0]!.content).toBe('original input')
    expect(messages[1]).toBeInstanceOf(AIMessage)
    expect(messages[2]).toBeInstanceOf(AIMessage)
    expect(String(messages[1]!.content)).toContain('search')
    expect(String(messages[1]!.content)).toContain('found 3')
    expect(String(messages[2]!.content)).toContain('write_file')
    expect(String(messages[2]!.content)).toContain('written')
  })

  it('sorts step_completed by seq even if provided out of order', () => {
    const entries: RunJournalEntry[] = [
      entry({ type: 'step_completed', seq: 5, data: { stepId: 'step-5', toolName: 'second', output: 'later' } }),
      entry({ type: 'step_completed', seq: 2, data: { stepId: 'step-2', toolName: 'first', output: 'earlier' } }),
    ]
    const messages = rehydrateMessagesFromJournal(entries, 'x')
    expect(String(messages[1]!.content)).toContain('first')
    expect(String(messages[2]!.content)).toContain('second')
  })

  it('uses toolName when present, falls back to stepId', () => {
    const entries: RunJournalEntry[] = [
      entry({ type: 'step_completed', seq: 1, data: { stepId: 'fallback-id' } }),
      entry({ type: 'step_completed', seq: 2, data: { stepId: 'ignored', toolName: 'preferred-name' } }),
    ]
    const messages = rehydrateMessagesFromJournal(entries, '')
    expect(String(messages[1]!.content)).toContain('fallback-id')
    expect(String(messages[2]!.content)).toContain('preferred-name')
    expect(String(messages[2]!.content)).not.toContain('ignored')
  })

  it('uses output when present, falls back to "[completed]"', () => {
    const entries: RunJournalEntry[] = [
      entry({ type: 'step_completed', seq: 1, data: { stepId: 's1', toolName: 't1' } }),
      entry({ type: 'step_completed', seq: 2, data: { stepId: 's2', toolName: 't2', output: 'value' } }),
    ]
    const messages = rehydrateMessagesFromJournal(entries, '')
    expect(String(messages[1]!.content)).toContain('[completed]')
    expect(String(messages[2]!.content)).toContain('value')
  })

  it('JSON-encodes a non-string output instead of rendering [object Object]', () => {
    const entries: RunJournalEntry[] = [
      entry({
        type: 'step_completed',
        seq: 1,
        data: { stepId: 's1', toolName: 'search', output: { hits: 3, top: 'readme' } },
      }),
    ]
    const messages = rehydrateMessagesFromJournal(entries, '')
    const rendered = String(messages[1]!.content)
    expect(rendered).toContain('"hits":3')
    expect(rendered).toContain('"top":"readme"')
    expect(rendered).not.toContain('[object Object]')
  })

  it('ignores non-step_completed entries', () => {
    const entries: RunJournalEntry[] = [
      entry({ type: 'run_started', seq: 1, data: { input: 'hello', agentId: 'a1' } }),
      entry({ type: 'step_started', seq: 2, data: { stepId: 's1', toolName: 'search' } }),
      entry({ type: 'step_completed', seq: 3, data: { stepId: 's2', toolName: 'search', output: 'ok' } }),
      entry({ type: 'run_paused', seq: 4, data: { reason: 'user_request' } }),
    ]
    const messages = rehydrateMessagesFromJournal(entries, 'hello')
    expect(messages).toHaveLength(2)
    expect(messages[0]).toBeInstanceOf(HumanMessage)
    expect(messages[1]).toBeInstanceOf(AIMessage)
    expect(String(messages[1]!.content)).toContain('search')
  })
})
