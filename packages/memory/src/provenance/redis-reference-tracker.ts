/**
 * RedisReferenceTracker — durable, cross-process reference counter for the
 * memory auto-promotion worker.
 *
 * Mirrors the public surface of {@link InMemoryReferenceTracker} in
 * `../shared/reference-tracker.ts`, so the two are drop-in interchangeable.
 *
 * Storage model
 * ─────────────
 *   - Per-entry run set:     `{ns}:runs:{entryId}`          (Redis SET of runIds)
 *   - Per-entry metadata:    `{ns}:meta:{entryId}`          (Redis HASH { namespace })
 *   - Namespace index:       `{ns}:ns:{namespace|__none__}` (Redis SET of entryIds)
 *
 * Every key is written with a TTL (default 7 days) so abandoned entries are
 * reaped by Redis itself without a sweeper process. Each `trackReference`
 * call extends the TTL for that entry's keys — this is the "sliding window"
 * behaviour normally expected of reference counts.
 *
 * Failure policy
 * ──────────────
 * All operations are wrapped in try/catch. If a Redis operation fails, the
 * error is routed to `onError` (if provided) and the tracker:
 *   - returns an empty list from read paths (`listEntriesAboveThreshold`),
 *   - silently no-ops on write paths (`trackReference`).
 *
 * Callers are expected to treat the tracker as best-effort — a failure here
 * must never block memory reads/writes. See also `createReferenceTracker`,
 * which degrades to `InMemoryReferenceTracker` when `REDIS_URL` is unset.
 *
 * Pipeline batching
 * ─────────────────
 * `trackReference` issues three writes (SADD runs, HSET meta, SADD ns index)
 * plus three EXPIRE calls in a single pipeline, so a full round-trip costs
 * one RTT irrespective of how many operations are batched. ioredis' implicit
 * auto-pipelining handles multiple concurrent `trackReference` calls at the
 * socket level; we additionally batch the per-call operations into a single
 * `multi().exec()`.
 */

import {
  InMemoryReferenceTracker,
  type ReferenceCountEntry,
} from '../shared/reference-tracker.js'

// ---------------------------------------------------------------------------
// Minimal ioredis-compatible surface
// ---------------------------------------------------------------------------

/**
 * Minimal subset of the ioredis `Redis` API we actually need. Declared as a
 * structural type so callers can pass real ioredis clients, ioredis-mock
 * instances, or hand-rolled fakes interchangeably.
 */
export interface RedisPipelineLike {
  sadd(key: string, ...members: string[]): RedisPipelineLike
  hset(key: string, field: string, value: string): RedisPipelineLike
  expire(key: string, seconds: number): RedisPipelineLike
  exec(): Promise<unknown>
}

export interface RedisClientLike {
  sadd(key: string, ...members: string[]): Promise<number>
  scard(key: string): Promise<number>
  smembers(key: string): Promise<string[]>
  hget(key: string, field: string): Promise<string | null>
  hset(key: string, field: string, value: string): Promise<number>
  expire(key: string, seconds: number): Promise<number>
  del(...keys: string[]): Promise<number>
  multi(): RedisPipelineLike
}

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface RedisReferenceTrackerOptions {
  /** Minimal ioredis-compatible client. */
  client: RedisClientLike
  /** Per-entry TTL. Refreshed on every trackReference. Default: 7 days. */
  ttlSeconds?: number
  /** Key prefix / namespace (default: 'dz:reftracker'). */
  namespace?: string
  /**
   * Error sink for Redis failures. Defaults to a no-op so tracker errors
   * never surface to memory read/write paths.
   */
  onError?: (operation: string, err: unknown) => void
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days
const DEFAULT_NAMESPACE = 'dz:reftracker'
const NO_NAMESPACE_SENTINEL = '__none__'
const META_FIELD_NAMESPACE = 'ns'

// ---------------------------------------------------------------------------
// RedisReferenceTracker
// ---------------------------------------------------------------------------

/**
 * Redis-backed reference tracker. Public surface mirrors
 * {@link InMemoryReferenceTracker}.
 */
export class RedisReferenceTracker {
  private readonly client: RedisClientLike
  private readonly ttlSeconds: number
  private readonly ns: string
  private readonly onError: (operation: string, err: unknown) => void

  constructor(options: RedisReferenceTrackerOptions) {
    this.client = options.client
    this.ttlSeconds =
      typeof options.ttlSeconds === 'number' && options.ttlSeconds > 0
        ? options.ttlSeconds
        : DEFAULT_TTL_SECONDS
    this.ns = options.namespace ?? DEFAULT_NAMESPACE
    this.onError = options.onError ?? (() => { /* swallow */ })
  }

  // ---- key builders --------------------------------------------------------

  private runsKey(entryId: string): string {
    return `${this.ns}:runs:${entryId}`
  }

  private metaKey(entryId: string): string {
    return `${this.ns}:meta:${entryId}`
  }

  private nsIndexKey(namespace: string | undefined): string {
    return `${this.ns}:ns:${namespace ?? NO_NAMESPACE_SENTINEL}`
  }

  private masterIndexKey(): string {
    return `${this.ns}:all`
  }

  // ---- write path ----------------------------------------------------------

  /**
   * Record that `runId` cited `entryId`. Duplicate `(runId, entryId)` pairs
   * are deduplicated by Redis SET semantics. Namespace tagging follows the
   * "most-recent wins" rule of the in-memory tracker.
   *
   * Issues 6 commands in a single `MULTI/EXEC` pipeline so the whole
   * operation costs one RTT.
   */
  async trackReference(
    runId: string,
    entryId: string,
    namespace?: string,
  ): Promise<void> {
    if (!runId || !entryId) return

    try {
      const runsKey = this.runsKey(entryId)
      const metaKey = this.metaKey(entryId)
      const masterKey = this.masterIndexKey()

      // Read the previous namespace so we can (a) scrub the old bucket when
      // the caller passes a fresh tag and (b) preserve the prior namespace
      // when the caller passes `undefined` (mirrors the in-memory tracker).
      let previousNamespace: string | null = null
      try {
        previousNamespace = await this.client.hget(metaKey, META_FIELD_NAMESPACE)
      } catch (err) {
        this.onError('trackReference:hget', err)
      }

      // Effective namespace bucket: explicit > previously-recorded > untagged.
      const effectiveNs =
        namespace !== undefined
          ? namespace
          : previousNamespace !== null
            ? previousNamespace
            : undefined
      const nsKey = this.nsIndexKey(effectiveNs)

      const pipeline = this.client
        .multi()
        .sadd(runsKey, runId)
        .expire(runsKey, this.ttlSeconds)
        .sadd(nsKey, entryId)
        .expire(nsKey, this.ttlSeconds)
        .sadd(masterKey, entryId)
        .expire(masterKey, this.ttlSeconds)
        .expire(metaKey, this.ttlSeconds)

      if (namespace !== undefined) {
        pipeline.hset(metaKey, META_FIELD_NAMESPACE, namespace)
      }

      await pipeline.exec()

      // Note: if the namespace changed (e.g. ns-A → ns-B), the entryId is
      // still a member of the ns-A bucket. That is fine because
      // listEntriesAboveThreshold re-validates each candidate against the
      // meta hash (source of truth), so stale bucket membership never
      // produces phantom results.
    } catch (err) {
      this.onError('trackReference', err)
    }
  }

  // ---- read path -----------------------------------------------------------

  /**
   * List every entry whose distinct-run count is `>= min`, filtered by
   * namespace (or all-namespaces when `namespace` is undefined).
   *
   * Returns the empty list on Redis failure.
   */
  async listEntriesAboveThreshold(
    namespace: string | undefined,
    min: number,
  ): Promise<ReferenceCountEntry[]> {
    try {
      const candidateIds = await this.collectCandidateIds(namespace)
      if (candidateIds.length === 0) return []

      const results: ReferenceCountEntry[] = []
      for (const entryId of candidateIds) {
        // Namespace source-of-truth is the meta hash. A candidate pulled
        // from a namespace bucket might have since been re-tagged; re-check
        // against meta before counting it. When `namespace` is undefined
        // (all namespaces) we accept any tag, including untagged entries.
        if (namespace !== undefined) {
          const storedNs = await this.client
            .hget(this.metaKey(entryId), META_FIELD_NAMESPACE)
            .catch(() => null)
          if (storedNs !== namespace) continue
        }

        const runCount = await this.client.scard(this.runsKey(entryId))
        if (runCount >= min) {
          results.push({ entryId, runCount })
        }
      }
      results.sort((a, b) => b.runCount - a.runCount)
      return results
    } catch (err) {
      this.onError('listEntriesAboveThreshold', err)
      return []
    }
  }

  /**
   * Aggregate candidate entryIds for a threshold query.
   *
   * - When `namespace` is provided, we restrict to that bucket; the caller
   *   re-validates each candidate via the meta hash before counting it.
   * - When undefined, we return every entry from the master index, matching
   *   the in-memory tracker's "return entries across every namespace"
   *   semantics.
   */
  private async collectCandidateIds(namespace: string | undefined): Promise<string[]> {
    if (namespace !== undefined) {
      return this.client.smembers(this.nsIndexKey(namespace))
    }

    try {
      return await this.client.smembers(this.masterIndexKey())
    } catch (err) {
      this.onError('collectCandidateIds', err)
      return []
    }
  }

  // ---- promotion hook ------------------------------------------------------

  /**
   * Promotion hook. The Redis tracker does not own memory records — it just
   * tracks reference counts — so this is a no-op parity with the in-memory
   * tracker. Durable promotions are handled by the memory service.
   */
  async promoteEntry(
    _entryId: string,
    _fromTier: string,
    _toTier: string,
  ): Promise<void> {
    // Intentional no-op.
  }
}

// ---------------------------------------------------------------------------
// Public tracker contract (covers both in-memory and Redis implementations)
// ---------------------------------------------------------------------------

/**
 * Shared contract implemented by both {@link InMemoryReferenceTracker} and
 * {@link RedisReferenceTracker}. Exposed so consumers can program against an
 * interface rather than the concrete class.
 */
export interface ReferenceTracker {
  trackReference(runId: string, entryId: string, namespace?: string): Promise<void>
  listEntriesAboveThreshold(
    namespace: string | undefined,
    min: number,
  ): Promise<ReferenceCountEntry[]>
  promoteEntry(entryId: string, fromTier: string, toTier: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateReferenceTrackerOptions {
  /**
   * If set, attempts to connect to Redis at this URL. If connection setup
   * fails OR the URL is unset, we fall back to the in-memory tracker.
   *
   * When unset, `process.env.REDIS_URL` is consulted.
   */
  redisUrl?: string | undefined
  /**
   * Pre-constructed Redis client. Useful for tests and for callers that
   * already own an ioredis instance. Takes precedence over `redisUrl`.
   */
  client?: RedisClientLike
  /** Forwarded to {@link RedisReferenceTracker}. */
  ttlSeconds?: number
  /** Forwarded to {@link RedisReferenceTracker}. */
  namespace?: string
  /** Forwarded to {@link RedisReferenceTracker}. */
  onError?: (operation: string, err: unknown) => void
  /**
   * Dynamic ioredis loader for test injection. Defaults to a dynamic
   * `import('ioredis')`. When omitted in environments without ioredis
   * installed, we fall back to the in-memory tracker.
   */
  loadIoredis?: () => Promise<{ default: new (url: string) => RedisClientLike } | { Redis: new (url: string) => RedisClientLike }>
}

/**
 * Build a reference tracker with the correct backing store.
 *
 * Resolution order:
 *   1. If `options.client` is given → RedisReferenceTracker.
 *   2. Else if `options.redisUrl` or `REDIS_URL` is set AND ioredis can be
 *      dynamically imported → RedisReferenceTracker.
 *   3. Otherwise → InMemoryReferenceTracker.
 *
 * Never throws. If Redis setup fails for any reason, the in-memory tracker
 * is returned and `onError('createReferenceTracker', err)` is invoked.
 */
export async function createReferenceTracker(
  options: CreateReferenceTrackerOptions = {},
): Promise<ReferenceTracker> {
  const onError = options.onError ?? (() => { /* swallow */ })

  // Path 1: explicit client
  if (options.client) {
    return new RedisReferenceTracker({
      client: options.client,
      ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
      ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
      onError,
    })
  }

  // Path 2: URL-driven dynamic import
  const url = options.redisUrl ?? process.env['REDIS_URL']
  if (url) {
    try {
      const loader =
        options.loadIoredis ??
        (async () => (await import('ioredis')) as unknown as {
          default: new (url: string) => RedisClientLike
        })
      const mod = await loader()
      const Ctor =
        'default' in mod ? mod.default : (mod as { Redis: new (url: string) => RedisClientLike }).Redis
      const client = new Ctor(url)
      return new RedisReferenceTracker({
        client,
        ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
        ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
        onError,
      })
    } catch (err) {
      onError('createReferenceTracker', err)
      // fall through to in-memory
    }
  }

  // Path 3: in-memory fallback
  return new InMemoryReferenceTracker()
}
