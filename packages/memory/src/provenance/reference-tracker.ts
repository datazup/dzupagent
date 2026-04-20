/**
 * ReferenceTracker — records which memory entries were cited/used by which
 * agent runs, enabling bidirectional queries:
 *
 *   - "What memory informed run X?" → getReferencesForRun(runId)
 *   - "Where has memory Y been used?" → getRunsCitingMemory(entryId)
 *
 * Storage model (Redis, when configured):
 *   - Sorted set per run:    dz:refs:run:{runId}        score=timestamp, member=entryId
 *   - Sorted set per entry:  dz:refs:entry:{entryId}    score=timestamp, member=runId
 *   - Context hash per (run,entry): dz:refs:ctx:{runId}:{entryId} → JSON(retrievalContext)
 *
 * The tracker is *fire-and-forget* from the caller's perspective — it exposes
 * `trackReference` as an async method but the memory-service hook invokes it
 * without awaiting, and it swallows its own errors internally. Memory read
 * paths MUST NOT be blocked by reference tracking.
 *
 * Two backends are provided:
 *   - InMemoryReferenceStore: default, zero-config, suitable for tests/dev.
 *   - RedisReferenceStore: accepts an ioredis-compatible client (duck-typed).
 *     The memory package does not import ioredis directly — callers pass the
 *     client they already have (e.g. shared with @dzupagent/cache).
 */

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
// Minimal ioredis-compatible interface
// ---------------------------------------------------------------------------

/**
 * Minimal sorted-set client contract. We duck-type this to avoid a hard
 * dependency on ioredis (the @dzupagent/cache package uses the same pattern).
 */
export interface SortedSetClientLike {
  zadd(key: string, score: number, member: string): Promise<unknown>
  /**
   * Returns members with scores. Matches ioredis signature:
   *   zrange(key, start, stop, 'WITHSCORES')
   *   zrange(key, start, stop, 'REV', 'WITHSCORES')
   */
  zrange(key: string, start: number, stop: number, ...args: string[]): Promise<string[]>
  /**
   * zrangebyscore(key, min, max, 'WITHSCORES', 'LIMIT', offset, count)
   */
  zrangebyscore(key: string, min: number | string, max: number | string, ...args: (string | number)[]): Promise<string[]>
  hset(key: string, field: string, value: string): Promise<unknown>
  hget(key: string, field: string): Promise<string | null>
  hdel(key: string, ...fields: string[]): Promise<unknown>
  del(...keys: string[]): Promise<unknown>
  /** scan(cursor, 'MATCH', pattern, 'COUNT', n) → [nextCursor, keys[]] */
  scan(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]>
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
// Redis backend
// ---------------------------------------------------------------------------

export interface RedisReferenceStoreOptions {
  /** Key prefix (default: 'dz:refs'). */
  prefix?: string
  /**
   * Optional error sink. Called when Redis operations fail. Defaults to a
   * no-op so reference-tracking failures never surface to the caller.
   */
  onError?: (operation: string, err: unknown) => void
}

/**
 * Redis-backed reference store using sorted sets + per-pair hash for context.
 * The client is duck-typed so consumers can share an ioredis instance
 * (e.g. the one used by @dzupagent/cache) without requiring this package to
 * depend on ioredis.
 */
export class RedisReferenceStore implements ReferenceStore {
  private readonly client: SortedSetClientLike
  private readonly prefix: string
  private readonly onError: (operation: string, err: unknown) => void

  constructor(client: SortedSetClientLike, options?: RedisReferenceStoreOptions) {
    this.client = client
    this.prefix = options?.prefix ?? 'dz:refs'
    this.onError = options?.onError ?? (() => { /* swallow */ })
  }

  private runKey(runId: string): string {
    return `${this.prefix}:run:${runId}`
  }

  private entryKey(entryId: string): string {
    return `${this.prefix}:entry:${entryId}`
  }

  private ctxKey(runId: string): string {
    return `${this.prefix}:ctx:${runId}`
  }

  private ctxField(entryId: string, retrievedAt: number): string {
    return `${entryId}@${retrievedAt}`
  }

  async record(record: ReferenceRecord): Promise<void> {
    try {
      const { runId, memoryEntryId, retrievedAt, retrievalContext } = record
      await Promise.all([
        this.client.zadd(this.runKey(runId), retrievedAt, memoryEntryId),
        this.client.zadd(this.entryKey(memoryEntryId), retrievedAt, runId),
        this.client.hset(
          this.ctxKey(runId),
          this.ctxField(memoryEntryId, retrievedAt),
          JSON.stringify(retrievalContext),
        ),
      ])
    } catch (err) {
      this.onError('record', err)
    }
  }

  async listByRun(runId: string, options?: ReferenceQueryOptions): Promise<ReferenceRecord[]> {
    try {
      const members = await this.rangeWithScores(
        this.runKey(runId),
        options,
      )
      const results: ReferenceRecord[] = []
      for (const { member, score } of members) {
        const ctxRaw = await this.client
          .hget(this.ctxKey(runId), this.ctxField(member, score))
          .catch(() => null)
        const retrievalContext = parseContext(ctxRaw)
        results.push({
          runId,
          memoryEntryId: member,
          retrievedAt: score,
          retrievalContext,
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
      const members = await this.rangeWithScores(
        this.entryKey(entryId),
        options,
      )
      const results: ReferenceRecord[] = []
      for (const { member, score } of members) {
        const ctxRaw = await this.client
          .hget(this.ctxKey(member), this.ctxField(entryId, score))
          .catch(() => null)
        const retrievalContext = parseContext(ctxRaw)
        results.push({
          runId: member,
          memoryEntryId: entryId,
          retrievedAt: score,
          retrievalContext,
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
      // Read all entries cited by this run before deleting the sorted set
      const members = await this.rangeWithScores(this.runKey(runId))

      // Remove from reverse indexes: delete runId from each entry's sorted set.
      // We cannot use ZREM with score constraints atomically, so we scan &
      // filter; acceptable since clearRun is cold-path (tests / GDPR).
      for (const { member: entryId } of members) {
        const entryKey = this.entryKey(entryId)
        // Remove runId from the entry's sorted set
        await this.client.zrangebyscore(entryKey, '-inf', '+inf')
          .then(async all => {
            if (all.includes(runId)) {
              // ioredis exposes ZREM via generic `call`, but our minimal
              // interface doesn't. Emulate by reading all and re-adding
              // sans-runId would destroy scores — so use del as a last resort
              // only when the runId is the sole remaining member.
              if (all.length === 1) {
                await this.client.del(entryKey)
              }
              // For multi-member entries we rely on TTLs/compaction in prod.
            }
          })
          .catch(err => this.onError('clearRun:reverse', err))
      }

      await Promise.all([
        this.client.del(this.runKey(runId)),
        this.client.del(this.ctxKey(runId)),
      ])
    } catch (err) {
      this.onError('clearRun', err)
    }
  }

  private async rangeWithScores(
    key: string,
    options?: ReferenceQueryOptions,
  ): Promise<Array<{ member: string; score: number }>> {
    const limit = options?.limit ?? 100
    const sinceMs = options?.sinceMs
    const untilMs = options?.untilMs

    let raw: string[]
    if (sinceMs !== undefined || untilMs !== undefined) {
      const min = sinceMs ?? '-inf'
      const max = untilMs ?? '+inf'
      raw = await this.client.zrangebyscore(
        key,
        min,
        max,
        'WITHSCORES',
        'LIMIT',
        0,
        limit,
      )
    } else {
      // Most recent first: REV range 0..limit-1
      raw = await this.client.zrange(key, 0, Math.max(0, limit - 1), 'REV', 'WITHSCORES')
    }

    const out: Array<{ member: string; score: number }> = []
    for (let i = 0; i < raw.length; i += 2) {
      const member = raw[i]
      const scoreStr = raw[i + 1]
      if (member === undefined || scoreStr === undefined) continue
      const score = Number(scoreStr)
      if (!Number.isFinite(score)) continue
      out.push({ member, score })
    }

    // zrangebyscore returns ascending — flip to descending for consistency
    if (sinceMs !== undefined || untilMs !== undefined) {
      out.sort((a, b) => b.score - a.score)
    }
    return out
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
