/**
 * RunJournal — unified append-only execution + business state log per run.
 *
 * This is the single canonical store for:
 * - Run lifecycle events (started, paused, resumed, completed, failed)
 * - Step execution events (tool calls, completions, failures)
 * - Business state updates (typed state snapshots)
 *
 * Design decisions:
 * - Append-only: entries are never mutated or deleted
 * - Versioned: each entry carries `v: 1` for forward compatibility
 * - Generic: RunJournal<TState> constrains business state shape
 * - Schema-validated: optional Zod schema for TState at journal creation
 */

/** All possible journal entry types */
export type RunJournalEntryType =
  | 'run_started'
  | 'step_started'
  | 'step_completed'
  | 'step_failed'
  | 'state_updated'
  | 'run_completed'
  | 'run_failed'
  | 'run_paused'
  | 'run_resumed'
  | 'run_suspended'
  | 'run_cancelled'
  | 'snapshot'   // compaction snapshot entry
  | 'unknown'    // forward-compatibility: unknown future entry types

/** Base fields shared by all journal entries */
export interface RunJournalEntryBase {
  /** Schema version for forward compatibility — readers must handle unknown versions */
  v: 1
  /** Monotonically increasing sequence number within a run */
  seq: number
  /** ISO 8601 wall-clock timestamp */
  ts: string
  /** The run this entry belongs to */
  runId: string
}

// ─── Entry Types ─────────────────────────────────────────────────────────────

export interface RunStartedEntry extends RunJournalEntryBase {
  type: 'run_started'
  data: {
    input: unknown
    agentId?: string
    triggerId?: string
  }
}

export interface StepStartedEntry extends RunJournalEntryBase {
  type: 'step_started'
  data: {
    stepId: string
    toolName?: string
    toolArgs?: Record<string, unknown>
  }
}

export interface StepCompletedEntry extends RunJournalEntryBase {
  type: 'step_completed'
  data: {
    stepId: string
    toolName?: string
    output?: unknown
    durationMs?: number
    tokenCount?: number
    costCents?: number
  }
}

export interface StepFailedEntry extends RunJournalEntryBase {
  type: 'step_failed'
  data: {
    stepId: string
    toolName?: string
    error: string
    retryCount?: number
  }
}

export interface StateUpdatedEntry<TState = Record<string, unknown>> extends RunJournalEntryBase {
  type: 'state_updated'
  data: {
    /** The new business state snapshot after this update */
    state: TState
    /** Which step triggered this state update */
    stepId?: string
  }
}

export interface RunCompletedEntry extends RunJournalEntryBase {
  type: 'run_completed'
  data: {
    output: unknown
    durationMs?: number
    totalTokens?: number
    totalCostCents?: number
  }
}

export interface RunFailedEntry extends RunJournalEntryBase {
  type: 'run_failed'
  data: {
    error: string
    stepId?: string
  }
}

export interface RunPausedEntry extends RunJournalEntryBase {
  type: 'run_paused'
  data: {
    reason?: 'cooperative' | 'tool_timeout' | 'user_request'
    stepId?: string
  }
}

export interface RunResumedEntry extends RunJournalEntryBase {
  type: 'run_resumed'
  data: {
    resumeToken: string
    input?: unknown
  }
}

export interface RunSuspendedEntry extends RunJournalEntryBase {
  type: 'run_suspended'
  data: {
    stepId: string
    reason?: string
    /** Channel for human contact if suspended waiting for human */
    contactId?: string
  }
}

export interface RunCancelledEntry extends RunJournalEntryBase {
  type: 'run_cancelled'
  data: {
    reason?: string
  }
}

export interface SnapshotEntry<TState = Record<string, unknown>> extends RunJournalEntryBase {
  type: 'snapshot'
  data: {
    /** Aggregate state up to this point */
    state: TState
    /** Sequence number this snapshot covers through */
    throughSeq: number
    /** Number of entries compacted */
    compactedCount: number
  }
}

/** Forward-compatibility entry for unknown future types */
export interface UnknownEntry extends RunJournalEntryBase {
  type: 'unknown'
  /** Original type string preserved for debugging */
  originalType: string
  data: Record<string, unknown>
}

/** Discriminated union of all journal entry types */
export type RunJournalEntry<TState = Record<string, unknown>> =
  | RunStartedEntry
  | StepStartedEntry
  | StepCompletedEntry
  | StepFailedEntry
  | StateUpdatedEntry<TState>
  | RunCompletedEntry
  | RunFailedEntry
  | RunPausedEntry
  | RunResumedEntry
  | RunSuspendedEntry
  | RunCancelledEntry
  | SnapshotEntry<TState>
  | UnknownEntry

// ─── Query Types ──────────────────────────────────────────────────────────────

export interface RunJournalQuery {
  /** Filter to entries after this sequence number (exclusive) — for cursor pagination */
  afterSeq?: number
  /** Maximum number of entries to return */
  limit?: number
  /** Filter by entry type(s) */
  types?: RunJournalEntryType[]
  /** Include compacted entries (default: false) */
  includeCompacted?: boolean
}

export interface RunJournalPage<TState = Record<string, unknown>> {
  entries: RunJournalEntry<TState>[]
  /** Last sequence number in this page — use as afterSeq for next page */
  nextCursor?: number
  hasMore: boolean
}

// ─── Journal Interface ─────────────────────────────────────────────────────────

/**
 * RunJournal — the single canonical source of truth for run history.
 *
 * Implementations: InMemoryRunJournal (core), PostgresRunJournal (server)
 */
export interface RunJournal<TState = Record<string, unknown>> {
  /**
   * Append an entry to the journal.
   * Entries are assigned seq numbers by the journal implementation.
   * Returns the assigned sequence number.
   */
  append(
    runId: string,
    entry: Omit<RunJournalEntry<TState>, 'v' | 'seq' | 'ts' | 'runId'>,
  ): Promise<number>

  /**
   * Query journal entries for a run with cursor-based pagination.
   */
  query(runId: string, query?: RunJournalQuery): Promise<RunJournalPage<TState>>

  /**
   * Get all entries for a run (convenience method, no pagination).
   * Avoid for production use on long-running runs — use query() instead.
   */
  getAll(runId: string): Promise<RunJournalEntry<TState>[]>

  /**
   * Trigger compaction for a run.
   * Creates a snapshot entry and marks previous entries as compacted.
   * Called automatically when entry count exceeds threshold (default: 500).
   */
  compact(runId: string): Promise<void>

  /**
   * Check if compaction is needed for a run.
   */
  needsCompaction(runId: string): Promise<boolean>
}

/** Configuration for creating a journal instance */
export interface RunJournalConfig<TState = Record<string, unknown>> {
  /** Number of entries before auto-compaction triggers (default: 500) */
  compactionThreshold?: number
  /** Optional Zod schema for validating TState — violations emit warnings but do not reject writes */
  // Using unknown here to avoid mandatory zod dependency at the type level
  stateSchema?: { parse(data: unknown): TState }
}
