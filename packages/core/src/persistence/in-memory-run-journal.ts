/**
 * InMemoryRunJournal — in-memory implementation of RunJournal.
 *
 * Suitable for development, testing, and single-process deployments.
 * Not persistent across process restarts.
 *
 * Thread-safety note: JavaScript is single-threaded; concurrent async
 * writes are serialized naturally. The sequence number is assigned
 * synchronously before any await, ensuring monotonic ordering.
 */

import type {
  RunJournal,
  RunJournalConfig,
  RunJournalEntry,
  RunJournalPage,
  RunJournalQuery,
  RunJournalEntryType,
  SnapshotEntry,
  StateUpdatedEntry,
} from './run-journal-types.js'
import { createEntryBase } from './run-journal.js'

const DEFAULT_COMPACTION_THRESHOLD = 500

export class InMemoryRunJournal<TState = Record<string, unknown>>
  implements RunJournal<TState>
{
  private readonly entries = new Map<string, RunJournalEntry<TState>[]>()
  private readonly seqCounters = new Map<string, number>()
  private readonly compactedSeqs = new Map<string, number>()
  private readonly compactionThreshold: number
  private readonly stateSchema: { parse(data: unknown): TState } | null

  constructor(config: RunJournalConfig<TState> = {}) {
    this.compactionThreshold =
      config.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD
    this.stateSchema = config.stateSchema ?? null
  }

  async append(
    runId: string,
    entryData: Omit<RunJournalEntry<TState>, 'v' | 'seq' | 'ts' | 'runId'>,
  ): Promise<number> {
    // Assign seq synchronously (before any await) to ensure monotonic ordering
    const seq = (this.seqCounters.get(runId) ?? 0) + 1
    this.seqCounters.set(runId, seq)

    const base = createEntryBase(runId, seq)
    const entry = { ...base, ...entryData } as RunJournalEntry<TState>

    // Validate state schema if provided and this is a state_updated entry
    if (entry.type === 'state_updated' && this.stateSchema) {
      try {
        this.stateSchema.parse(
          (entry as StateUpdatedEntry<TState>).data.state,
        )
      } catch (err) {
        // Non-fatal: emit warning but do not reject write
        console.warn(
          `[RunJournal] state_updated schema validation warning for run ${runId}:`,
          err,
        )
      }
    }

    if (!this.entries.has(runId)) {
      this.entries.set(runId, [])
    }
    this.entries.get(runId)!.push(entry)

    // Auto-compaction check
    if (await this.needsCompaction(runId)) {
      await this.compact(runId)
    }

    return seq
  }

  async query(
    runId: string,
    query: RunJournalQuery = {},
  ): Promise<RunJournalPage<TState>> {
    const all = this.entries.get(runId) ?? []
    const lastCompactedSeq = this.compactedSeqs.get(runId) ?? 0

    let filtered = all

    // Exclude compacted entries unless requested
    if (!query.includeCompacted) {
      filtered = filtered.filter(
        (e) => e.type === 'snapshot' || e.seq > lastCompactedSeq,
      )
    }

    // Cursor pagination: afterSeq (exclusive)
    if (query.afterSeq !== undefined) {
      filtered = filtered.filter((e) => e.seq > query.afterSeq!)
    }

    // Type filter
    if (query.types && query.types.length > 0) {
      const typeSet = new Set<RunJournalEntryType>(query.types)
      filtered = filtered.filter((e) => typeSet.has(e.type))
    }

    // Limit
    const limit = query.limit
    const hasMore = limit !== undefined && filtered.length > limit
    const page = limit !== undefined ? filtered.slice(0, limit) : filtered

    const result: RunJournalPage<TState> = {
      entries: page,
      hasMore,
    }
    if (hasMore && page.length > 0) {
      const lastEntry = page[page.length - 1]
      if (lastEntry) {
        result.nextCursor = lastEntry.seq
      }
    }

    return result
  }

  async getAll(runId: string): Promise<RunJournalEntry<TState>[]> {
    return [...(this.entries.get(runId) ?? [])]
  }

  async compact(runId: string): Promise<void> {
    const all = this.entries.get(runId)
    if (!all || all.length === 0) return

    const threshold = this.compactionThreshold
    if (all.length < threshold) return

    // Find current aggregate state from the most recent state_updated entry
    let aggregateState: TState | undefined
    for (let i = all.length - 1; i >= 0; i--) {
      const entry = all[i]
      if (entry && entry.type === 'state_updated') {
        aggregateState = (entry as StateUpdatedEntry<TState>).data.state
        break
      }
    }
    if (aggregateState === undefined) {
      // Fall back to the most recent snapshot's state
      for (let i = all.length - 1; i >= 0; i--) {
        const entry = all[i]
        if (entry && entry.type === 'snapshot') {
          aggregateState = (entry as SnapshotEntry<TState>).data.state
          break
        }
      }
    }

    // Determine how many entries to compact (keep the last threshold/2 uncompacted)
    const keepCount = Math.floor(threshold / 2)
    const compactCount = all.length - keepCount
    const compactBoundary = all[compactCount - 1]
    if (!compactBoundary) return
    const compactThrough = compactBoundary.seq
    const compactedCount = compactCount

    // Create snapshot entry — use seq 0 relative to compacted range so it
    // sorts before the remaining entries. The snapshot's own seq is set to
    // compactThrough to maintain monotonic ordering in the stored array.
    const snapshot: SnapshotEntry<TState> = {
      ...createEntryBase(runId, compactThrough),
      type: 'snapshot',
      data: {
        state: aggregateState ?? ({} as TState),
        throughSeq: compactThrough,
        compactedCount,
      },
    }

    // Replace entries: snapshot + remaining uncompacted entries
    const remaining = all.slice(compactCount)
    this.entries.set(runId, [snapshot as RunJournalEntry<TState>, ...remaining])
    this.compactedSeqs.set(runId, compactThrough)
  }

  async needsCompaction(runId: string): Promise<boolean> {
    const all = this.entries.get(runId)
    if (!all) return false
    // Count only non-snapshot entries for the threshold check
    const nonSnapshotCount = all.filter((e) => e.type !== 'snapshot').length
    return nonSnapshotCount >= this.compactionThreshold
  }

  /** Test helper: get raw entry count for a run (including snapshots) */
  _entryCount(runId: string): number {
    return this.entries.get(runId)?.length ?? 0
  }

  /** Test helper: clear all data */
  _clear(): void {
    this.entries.clear()
    this.seqCounters.clear()
    this.compactedSeqs.clear()
  }
}
