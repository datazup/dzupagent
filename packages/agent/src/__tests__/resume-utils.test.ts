import { describe, it, expect } from 'vitest'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import type { RunJournalEntry } from '@dzupagent/core'
import { rehydrateMessagesFromJournal } from '../agent/resume-utils.js'

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
    expect(messages[0].content).toBe('do task X')
  })

  it('emits HumanMessage + AIMessage per step_completed in seq order', () => {
    const entries: RunJournalEntry[] = [
      entry({ type: 'step_completed', seq: 2, data: { stepId: 's1', toolName: 'search', result: 'found 3' } }),
      entry({ type: 'step_completed', seq: 3, data: { stepId: 's2', toolName: 'write_file', result: 'written' } }),
    ]
    const messages = rehydrateMessagesFromJournal(entries, 'original input')
    expect(messages).toHaveLength(3)
    expect(messages[0]).toBeInstanceOf(HumanMessage)
    expect(messages[0].content).toBe('original input')
    expect(messages[1]).toBeInstanceOf(AIMessage)
    expect(messages[2]).toBeInstanceOf(AIMessage)
    expect(String(messages[1].content)).toContain('search')
    expect(String(messages[1].content)).toContain('found 3')
    expect(String(messages[2].content)).toContain('write_file')
    expect(String(messages[2].content)).toContain('written')
  })

  it('sorts step_completed by seq even if provided out of order', () => {
    const entries: RunJournalEntry[] = [
      entry({ type: 'step_completed', seq: 5, data: { toolName: 'second', result: 'later' } }),
      entry({ type: 'step_completed', seq: 2, data: { toolName: 'first', result: 'earlier' } }),
    ]
    const messages = rehydrateMessagesFromJournal(entries, 'x')
    expect(String(messages[1].content)).toContain('first')
    expect(String(messages[2].content)).toContain('second')
  })

  it('uses toolName when present, falls back to stepId', () => {
    const entries: RunJournalEntry[] = [
      entry({ type: 'step_completed', seq: 1, data: { stepId: 'fallback-id' } }),
      entry({ type: 'step_completed', seq: 2, data: { stepId: 'ignored', toolName: 'preferred-name' } }),
    ]
    const messages = rehydrateMessagesFromJournal(entries, '')
    expect(String(messages[1].content)).toContain('fallback-id')
    expect(String(messages[2].content)).toContain('preferred-name')
    expect(String(messages[2].content)).not.toContain('ignored')
  })

  it('uses result when present, falls back to "[completed]"', () => {
    const entries: RunJournalEntry[] = [
      entry({ type: 'step_completed', seq: 1, data: { toolName: 't1' } }),
      entry({ type: 'step_completed', seq: 2, data: { toolName: 't2', result: 'value' } }),
    ]
    const messages = rehydrateMessagesFromJournal(entries, '')
    expect(String(messages[1].content)).toContain('[completed]')
    expect(String(messages[2].content)).toContain('value')
  })

  it('ignores non-step_completed entries', () => {
    const entries: RunJournalEntry[] = [
      entry({ type: 'run_started', seq: 1, data: { input: 'hello', agentId: 'a1' } }),
      entry({ type: 'step_started', seq: 2, data: { stepId: 's1', toolName: 'search' } }),
      entry({ type: 'step_completed', seq: 3, data: { toolName: 'search', result: 'ok' } }),
      entry({ type: 'run_paused', seq: 4, data: { reason: 'approval' } }),
    ]
    const messages = rehydrateMessagesFromJournal(entries, 'hello')
    expect(messages).toHaveLength(2)
    expect(messages[0]).toBeInstanceOf(HumanMessage)
    expect(messages[1]).toBeInstanceOf(AIMessage)
    expect(String(messages[1].content)).toContain('search')
  })
})
