/**
 * InMemoryReferenceTracker — a lightweight, Map-backed cross-run reference
 * counter used by the memory auto-promotion worker.
 *
 * Semantics
 * ─────────
 *   - `trackReference(runId, entryId, namespace?)` records that `runId`
 *     cited `entryId`. Run IDs are deduplicated with a `Set`, so the same
 *     run tracking the same entry twice counts once.
 *   - `listEntriesAboveThreshold(namespace, min)` returns every entry whose
 *     distinct-run count is `>= min`, optionally filtered by namespace.
 *   - `promoteEntry(entryId, fromTier, toTier)` is a no-op stub — the
 *     worker calls this to signal a promotion, but the in-memory tracker
 *     does not own the actual memory records. It simply resolves.
 *
 * Scope
 * ─────
 * This is the *zero-config* default tracker. It is suitable for tests,
 * single-process deployments, and as a reference implementation. Production
 * deployments that need durable cross-process reference tracking should
 * provide their own implementation backed by Redis or the database.
 *
 * Thread-safety: Node.js is single-threaded per isolate, so `Map`/`Set`
 * mutation is safe. Do not share an instance across Workers without
 * synchronization.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A per-entry summary returned by `listEntriesAboveThreshold`.
 */
export interface ReferenceCountEntry {
  /** The memory entry identifier. */
  entryId: string
  /** Number of distinct run IDs that have cited this entry. */
  runCount: number
}

// ---------------------------------------------------------------------------
// Internal record
// ---------------------------------------------------------------------------

interface TrackedEntry {
  /** Distinct run IDs that cited this entry. */
  runs: Set<string>
  /** Namespace last associated with this entry (most recent trackReference call). */
  namespace: string | undefined
}

// ---------------------------------------------------------------------------
// InMemoryReferenceTracker
// ---------------------------------------------------------------------------

/**
 * Map-backed cross-run reference tracker. Zero dependencies; deterministic.
 *
 * @example
 * ```ts
 * const tracker = new InMemoryReferenceTracker()
 * await tracker.trackReference('run-1', 'entry-A', 'session')
 * await tracker.trackReference('run-2', 'entry-A', 'session')
 * await tracker.trackReference('run-2', 'entry-A', 'session') // deduped
 *
 * const hot = await tracker.listEntriesAboveThreshold('session', 2)
 * // → [{ entryId: 'entry-A', runCount: 2 }]
 * ```
 */
export class InMemoryReferenceTracker {
  private readonly entries = new Map<string, TrackedEntry>()

  /**
   * Record that `runId` cited `entryId`. Subsequent calls with the same
   * `(runId, entryId)` pair are deduplicated by the internal `Set<string>`.
   *
   * The optional `namespace` parameter lets callers tag the entry for later
   * filtering in `listEntriesAboveThreshold`. If omitted, the entry is
   * treated as namespace-agnostic (matches any or no namespace filter).
   */
  async trackReference(
    runId: string,
    entryId: string,
    namespace?: string,
  ): Promise<void> {
    if (!runId || !entryId) return

    const existing = this.entries.get(entryId)
    if (existing) {
      existing.runs.add(runId)
      // Preserve the most-recent namespace. Callers passing a fresh
      // namespace override an older value; passing undefined leaves it.
      if (namespace !== undefined) {
        existing.namespace = namespace
      }
      return
    }

    this.entries.set(entryId, {
      runs: new Set<string>([runId]),
      namespace,
    })
  }

  /**
   * List every entry whose distinct-run count is `>= min`, sorted by
   * descending `runCount`. When `namespace` is provided, only entries
   * tagged with that namespace are returned. Entries with no recorded
   * namespace are excluded from namespace-filtered queries.
   *
   * Returns an empty array when no entry meets the threshold.
   */
  async listEntriesAboveThreshold(
    namespace: string | undefined,
    min: number,
  ): Promise<ReferenceCountEntry[]> {
    const results: ReferenceCountEntry[] = []
    for (const [entryId, tracked] of this.entries) {
      if (tracked.runs.size < min) continue
      if (namespace !== undefined && tracked.namespace !== namespace) continue
      results.push({ entryId, runCount: tracked.runs.size })
    }
    results.sort((a, b) => b.runCount - a.runCount)
    return results
  }

  /**
   * Stub promotion hook. The in-memory tracker does not own the underlying
   * memory records — it only tracks reference counts. Worker code calls
   * this after a successful promotion so durable implementations can
   * persist the new tier. In-memory mode is a no-op.
   */
  async promoteEntry(
    _entryId: string,
    _fromTier: string,
    _toTier: string,
  ): Promise<void> {
    // Intentional no-op. See class docstring.
  }
}
