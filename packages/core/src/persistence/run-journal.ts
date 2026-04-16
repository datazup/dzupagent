/**
 * RunJournal public API — re-exports types and provides utilities.
 */

import type { RunJournalEntry } from './run-journal-types.js'

export type {
  RunJournalEntryType,
  RunJournalEntryBase,
  RunJournalEntry,
  RunStartedEntry,
  StepStartedEntry,
  StepCompletedEntry,
  StepFailedEntry,
  StateUpdatedEntry,
  RunCompletedEntry,
  RunFailedEntry,
  RunPausedEntry,
  RunResumedEntry,
  RunSuspendedEntry,
  RunCancelledEntry,
  SnapshotEntry,
  UnknownEntry,
  RunJournalQuery,
  RunJournalPage,
  RunJournal,
  RunJournalConfig,
} from './run-journal-types.js'

/** Helper: create a journal entry base with current timestamp */
export function createEntryBase(
  runId: string,
  seq: number,
): { v: 1; seq: number; ts: string; runId: string } {
  return {
    v: 1,
    seq,
    ts: new Date().toISOString(),
    runId,
  }
}

/** Helper: check if an entry is a terminal entry (run is in a final state) */
export function isTerminalEntry(type: string): boolean {
  return ['run_completed', 'run_failed', 'run_cancelled'].includes(type)
}

/** Helper: safely deserialize a journal entry from unknown JSON — handles unknown types */
export function deserializeEntry<TState = Record<string, unknown>>(
  raw: unknown,
): RunJournalEntry<TState> | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  if (typeof entry['runId'] !== 'string') return null
  if (typeof entry['seq'] !== 'number') return null
  if (typeof entry['ts'] !== 'string') return null

  const knownTypes = [
    'run_started', 'step_started', 'step_completed', 'step_failed',
    'state_updated', 'run_completed', 'run_failed', 'run_paused',
    'run_resumed', 'run_suspended', 'run_cancelled', 'snapshot',
  ]

  if (!knownTypes.includes(entry['type'] as string)) {
    // Forward compatibility: wrap as unknown entry
    return {
      v: 1,
      seq: entry['seq'] as number,
      ts: entry['ts'] as string,
      runId: entry['runId'] as string,
      type: 'unknown',
      originalType: entry['type'] as string,
      data: (entry['data'] as Record<string, unknown>) ?? {},
    }
  }

  return raw as RunJournalEntry<TState>
}
