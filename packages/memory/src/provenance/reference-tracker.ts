/**
 * ReferenceTracker — records which memory entries were cited/used by which
 * agent runs, enabling bidirectional queries:
 *
 *   - "What memory informed run X?" → getReferencesForRun(runId)
 *   - "Where has memory Y been used?" → getRunsCitingMemory(entryId)
 *
 * Storage model (when backed by a CacheBackend with sorted-set support):
 *   - Sorted set per run:    {prefix}:run:{runId}     score=timestamp, member=`{entryId}@{ts}`
 *   - Sorted set per entry:  {prefix}:entry:{entryId} score=timestamp, member=`{runId}@{ts}`
 *   - Context value per pair: {prefix}:ctx:{runId}:{entryId}@{ts} → JSON(retrievalContext)
 *
 * The tracker is *fire-and-forget* from the caller's perspective — it exposes
 * `trackReference` as an async method but the memory-service hook invokes it
 * without awaiting, and it swallows its own errors internally. Memory read
 * paths MUST NOT be blocked by reference tracking.
 *
 * Two backends are provided:
 *   - InMemoryReferenceStore: default, zero-config, suitable for tests/dev.
 *   - RedisReferenceStore: accepts a `@dzupagent/cache` CacheBackend. Pass a
 *     RedisCacheBackend (or any other CacheBackend implementation) — the
 *     memory package does not depend on ioredis directly, only on the cache
 *     contract.
 */

import type { CacheBackend } from '@dzupagent/cache'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Context describing *why* a memory entry was retrieved by a run.
 */
export interface RetrievalContext {
  /** Free-form query string that triggered the retrieval (if any). */
  query?: string | undefined
  /** Namespace the entry was retrieved from. */
  namespace?: string | undefined
  /** Rank within the result set (0-based). */
  rank?: number | undefined
  /** Relevance/similarity score as surfaced by the retriever. */
  score?: number | undefined
  /** Arbitrary caller-supplied tags (e.g. phase, tool name). */
  tags?: Record<string, string> | undefined
}

/**
 * A single reference record — one (run, entry) citation event.
 */
export interface ReferenceRecord {
  runId: string
  memoryEntryId: string
  /** Unix epoch milliseconds when the entry was cited. */
  retrievedAt: number
  retrievalContext: RetrievalContext
}

/**
 * Options for querying reference history.
 */
export interface ReferenceQueryOptions {
  /** Max results to return (default: 100). */
  limit?: number | undefined
  /** Include only references at/after this epoch ms. */
  sinceMs?: number | undefined
  /** Include only references at/before this epoch ms. */
  untilMs?: number | undefined
}

/**
 * Backend-agnostic storage interface for reference tuples.
 * Implementations MUST be safe to call from fire-and-forget contexts.
 */
export interface ReferenceStore {
  /** Record a single citation event. */
  record(record: ReferenceRecord): Promise<void>
  /** List entries cited by a run (most recent first). */
  listByRun(runId: string, options?: ReferenceQueryOptions): Promise<ReferenceRecord[]>
  /** List runs that cited a given entry (most recent first). */
  listByEntry(entryId: string, options?: ReferenceQueryOptions): Promise<ReferenceRecord[]>
  /** Clear all records for a run (useful for tests / GDPR). */
  clearRun(runId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// In-memory backend (default)
// ---------------------------------------------------------------------------

interface InMemoryEntry {
  record: ReferenceRecord
}

/**
 * Process-local reference store. Zero dependencies; deterministic for tests.
 */
export class InMemoryReferenceStore implements ReferenceStore {
  private readonly byRun = new Map<string, InMemoryEntry[]>()
  private readonly byEntry = new Map<string, InMemoryEntry[]>()

  async record(record: ReferenceRecord): Promise<void> {
    const entry: InMemoryEntry = { record }

    const runList = this.byRun.get(record.runId) ?? []
    runList.push(entry)
    this.byRun.set(record.runId, runList)

    const entryList = this.byEntry.get(record.memoryEntryId) ?? []
    entryList.push(entry)
    this.byEntry.set(record.memoryEntryId, entryList)
  }

  async listByRun(runId: string, options?: ReferenceQueryOptions): Promise<ReferenceRecord[]> {
    return this.filterAndSort(this.byRun.get(runId) ?? [], options)
  }

  async listByEntry(entryId: string, options?: ReferenceQueryOptions): Promise<ReferenceRecord[]> {
    return this.filterAndSort(this.byEntry.get(entryId) ?? [], options)
  }

  async clearRun(runId: string): Promise<void> {
    const runList = this.byRun.get(runId)
    if (!runList) return
    for (const entry of runList) {
      const entryList = this.byEntry.get(entry.record.memoryEntryId)
      if (!entryList) continue
      const remaining = entryList.filter(e => e.record.runId !== runId)
      if (remaining.length === 0) {
        this.byEntry.delete(entry.record.memoryEntryId)
      } else {
        this.byEntry.set(entry.record.memoryEntryId, remaining)
      }
    }
    this.byRun.delete(runId)
  }

  private filterAndSort(
    entries: InMemoryEntry[],
    options?: ReferenceQueryOptions,
  ): ReferenceRecord[] {
    const limit = options?.limit ?? 100
    const sinceMs = options?.sinceMs
    const untilMs = options?.untilMs

    const filtered = entries
      .map(e => e.record)
      .filter(r => {
        if (sinceMs !== undefined && r.retrievedAt < sinceMs) return false
        if (untilMs !== undefined && r.retrievedAt > untilMs) return false
        return true
      })
      .sort((a, b) => b.retrievedAt - a.retrievedAt)

    return filtered.slice(0, Math.max(0, limit))
  }
}

// ---------------------------------------------------------------------------
// Cache-backed (Redis) backend
// ---------------------------------------------------------------------------

export interface RedisReferenceStoreOptions {
  /** Key prefix (default: 'dz:refs'). */
  prefix?: string
  /**
   * Optional error sink. Called when backend operations fail. Defaults to a
   * no-op so reference-tracking failures never surface to the caller.
   */
  onError?: (operation: string, err: unknown) => void
}

/**
 * CacheBackend-backed reference store using sorted sets for the bidirectional
 * indexes and a regular cache value for per-citation retrieval context.
 *
 * Members are encoded as `{id}@{retrievedAt}` so a single sorted-set lookup
 * carries enough information to re-derive the timestamp without WITHSCORES
 * (which is intentionally outside the minimal CacheBackend contract).
 *
 * Pass any `CacheBackend` implementation — typically a `RedisCacheBackend`
 * from `@dzupagent/cache` for production, or `InMemoryCacheBackend` for tests.
 */
export class RedisReferenceStore implements ReferenceStore {
  private readonly cache: CacheBackend
  private readonly prefix: string
  private readonly onError: (operation: string, err: unknown) => void

  constructor(cache: CacheBackend, options?: RedisReferenceStoreOptions) {
    this.cache = cache
    this.prefix = options?.prefix ?? 'dz:refs'
    this.onError = options?.onError ?? (() => { /* swallow */ })
  }

  private runKey(runId: string): string {
    return `${this.prefix}:run:${runId}`
  }

  private entryKey(entryId: string): string {
    return `${this.prefix}:entry:${entryId}`
  }

  private ctxKey(runId: string, entryId: string, retrievedAt: number): string {
    return `${this.prefix}:ctx:${runId}:${entryId}@${retrievedAt}`
  }

  private encodeMember(id: string, retrievedAt: number): string {
    return `${id}@${retrievedAt}`
  }

  /** Parse `{id}@{ts}` back into its parts; returns null on malformed input. */
  private decodeMember(member: string): { id: string; retrievedAt: number } | null {
    const at = member.lastIndexOf('@')
    if (at <= 0 || at === member.length - 1) return null
    const id = member.slice(0, at)
    const ts = Number(member.slice(at + 1))
    if (!Number.isFinite(ts)) return null
    return { id, retrievedAt: ts }
  }

  async record(record: ReferenceRecord): Promise<void> {
    try {
      const { runId, memoryEntryId, retrievedAt, retrievalContext } = record
      await Promise.all([
        this.cache.zadd(
          this.runKey(runId),
          retrievedAt,
          this.encodeMember(memoryEntryId, retrievedAt),
        ),
        this.cache.zadd(
          this.entryKey(memoryEntryId),
          retrievedAt,
          this.encodeMember(runId, retrievedAt),
        ),
        this.cache.set(
          this.ctxKey(runId, memoryEntryId, retrievedAt),
          JSON.stringify(retrievalContext),
        ),
      ])
    } catch (err) {
      this.onError('record', err)
    }
  }

  async listByRun(runId: string, options?: ReferenceQueryOptions): Promise<ReferenceRecord[]> {
    try {
      const members = await this.rangeMembers(this.runKey(runId), options)
      const results: ReferenceRecord[] = []
      for (const { id: memoryEntryId, retrievedAt } of members) {
        const ctxRaw = await this.cache
          .get(this.ctxKey(runId, memoryEntryId, retrievedAt))
          .catch(() => null)
        results.push({
          runId,
          memoryEntryId,
          retrievedAt,
          retrievalContext: parseContext(ctxRaw),
        })
      }
      return results
    } catch (err) {
      this.onError('listByRun', err)
      return []
    }
  }

  async listByEntry(entryId: string, options?: ReferenceQueryOptions): Promise<ReferenceRecord[]> {
    try {
      const members = await this.rangeMembers(this.entryKey(entryId), options)
      const results: ReferenceRecord[] = []
      for (const { id: runId, retrievedAt } of members) {
        const ctxRaw = await this.cache
          .get(this.ctxKey(runId, entryId, retrievedAt))
          .catch(() => null)
        results.push({
          runId,
          memoryEntryId: entryId,
          retrievedAt,
          retrievalContext: parseContext(ctxRaw),
        })
      }
      return results
    } catch (err) {
      this.onError('listByEntry', err)
      return []
    }
  }

  async clearRun(runId: string): Promise<void> {
    try {
      // Pull every member of the run sorted set so we can scrub the reverse
      // indexes and per-citation context entries.
      const runKey = this.runKey(runId)
      const rawMembers = await this.cache.zrangebyscore(runKey, -Infinity, Infinity)

      for (const member of rawMembers) {
        const decoded = this.decodeMember(member)
        if (!decoded) continue
        const { id: entryId, retrievedAt } = decoded

        // Remove (runId@ts) from the reverse entry-keyed sorted set
        await this.cache
          .zrem(this.entryKey(entryId), this.encodeMember(runId, retrievedAt))
          .catch(err => this.onError('clearRun:zrem', err))

        // Remove the per-citation context value
        await this.cache
          .delete(this.ctxKey(runId, entryId, retrievedAt))
          .catch(err => this.onError('clearRun:ctx-delete', err))

        // Remove the member from the run sorted set itself
        await this.cache
          .zrem(runKey, member)
          .catch(err => this.onError('clearRun:zrem-self', err))
      }
    } catch (err) {
      this.onError('clearRun', err)
    }
  }

  /**
   * Read a window of members from a sorted set, decode their embedded
   * timestamps, sort most-recent-first, and apply `limit`.
   */
  private async rangeMembers(
    key: string,
    options?: ReferenceQueryOptions,
  ): Promise<Array<{ id: string; retrievedAt: number }>> {
    const limit = options?.limit ?? 100
    const min = options?.sinceMs ?? -Infinity
    const max = options?.untilMs ?? Infinity

    const raw = await this.cache.zrangebyscore(key, min, max)
    const decoded: Array<{ id: string; retrievedAt: number }> = []
    for (const member of raw) {
      const d = this.decodeMember(member)
      if (d) decoded.push(d)
    }
    decoded.sort((a, b) => b.retrievedAt - a.retrievedAt)
    return decoded.slice(0, Math.max(0, limit))
  }
}

// ---------------------------------------------------------------------------
// ReferenceTracker — public facade
// ---------------------------------------------------------------------------

export interface ReferenceTrackerOptions {
  /** Storage backend (default: InMemoryReferenceStore). */
  store?: ReferenceStore
  /**
   * Optional clock for deterministic tests. Must return epoch ms.
   * Default: Date.now.
   */
  now?: () => number
  /**
   * Optional logger for tracker-internal errors. Tracker never throws to
   * callers; logging is best-effort.
   */
  onError?: (operation: string, err: unknown) => void
}

/**
 * Facade over a ReferenceStore. Provides the three public methods described
 * in the architecture spec: trackReference / getReferencesForRun /
 * getRunsCitingMemory. Safe to invoke from fire-and-forget contexts — all
 * methods swallow errors internally.
 */
export class ReferenceTracker {
  private readonly store: ReferenceStore
  private readonly now: () => number
  private readonly onError: (operation: string, err: unknown) => void

  constructor(options?: ReferenceTrackerOptions) {
    this.store = options?.store ?? new InMemoryReferenceStore()
    this.now = options?.now ?? (() => Date.now())
    this.onError = options?.onError ?? (() => { /* swallow */ })
  }

  /**
   * Record that `runId` cited `entryId`. Never throws.
   */
  async trackReference(
    runId: string,
    entryId: string,
    ctx: RetrievalContext = {},
  ): Promise<void> {
    if (!runId || !entryId) {
      // No-op: empty identifiers are meaningless but must not crash the caller.
      return
    }
    try {
      await this.store.record({
        runId,
        memoryEntryId: entryId,
        retrievedAt: this.now(),
        retrievalContext: ctx,
      })
    } catch (err) {
      this.onError('trackReference', err)
    }
  }

  /**
   * Record a batch of references for a single run. More efficient than
   * looping on the caller side because backends can parallelize.
   */
  async trackReferences(
    runId: string,
    entries: Array<{ entryId: string; ctx?: RetrievalContext }>,
  ): Promise<void> {
    if (!runId || entries.length === 0) return
    const ts = this.now()
    try {
      await Promise.all(
        entries
          .filter(e => !!e.entryId)
          .map(e =>
            this.store.record({
              runId,
              memoryEntryId: e.entryId,
              retrievedAt: ts,
              retrievalContext: e.ctx ?? {},
            }),
          ),
      )
    } catch (err) {
      this.onError('trackReferences', err)
    }
  }

  /**
   * List memory entries cited by `runId`, most recent first.
   */
  async getReferencesForRun(
    runId: string,
    options?: ReferenceQueryOptions,
  ): Promise<ReferenceRecord[]> {
    try {
      return await this.store.listByRun(runId, options)
    } catch (err) {
      this.onError('getReferencesForRun', err)
      return []
    }
  }

  /**
   * List runs that cited `entryId`, most recent first.
   */
  async getRunsCitingMemory(
    entryId: string,
    options?: ReferenceQueryOptions,
  ): Promise<ReferenceRecord[]> {
    try {
      return await this.store.listByEntry(entryId, options)
    } catch (err) {
      this.onError('getRunsCitingMemory', err)
      return []
    }
  }

  /**
   * Remove all references for a run.
   */
  async clearRun(runId: string): Promise<void> {
    try {
      await this.store.clearRun(runId)
    } catch (err) {
      this.onError('clearRun', err)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseContext(raw: string | null): RetrievalContext {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as RetrievalContext
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * Derive a stable memory entry ID from a record. Looks for common id fields
 * (`_key`, `id`, `key`) and falls back to a hash of the record's content
 * hash if present in provenance, else a synthetic `idx:{rank}` marker.
 */
export function deriveMemoryEntryId(
  record: Record<string, unknown>,
  fallbackRank: number,
): string {
  if (typeof record['_key'] === 'string' && record['_key']) return record['_key']
  if (typeof record['id'] === 'string' && record['id']) return record['id']
  if (typeof record['key'] === 'string' && record['key']) return record['key']

  const prov = record['_provenance']
  if (prov && typeof prov === 'object') {
    const hash = (prov as Record<string, unknown>)['contentHash']
    if (typeof hash === 'string' && hash) return `hash:${hash}`
  }

  return `idx:${fallbackRank}`
}
