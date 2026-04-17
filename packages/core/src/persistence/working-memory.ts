import type { WorkingMemoryConfig, WorkingMemorySnapshot } from './working-memory-types.js'

/**
 * Internal representation of a stored entry.
 */
interface Entry {
  value: unknown
  /** Absolute expiry timestamp in ms (Date.now()-relative). `undefined` means no expiry. */
  expiresAt?: number
}

/**
 * Best-effort deep clone implementation.
 *
 * Prefers the structured-clone algorithm (available on Node 17+ and modern
 * browsers) and falls back to a JSON round-trip if it is not present. The
 * fallback does not preserve `Map`, `Set`, `Date`, or functions, but is
 * sufficient for the JSON-shaped values that working memory typically holds.
 */
function deepClone<T>(value: T): T {
  if (value === undefined || value === null) {
    return value
  }
  // structuredClone is available in Node 17+ and all modern browsers.
  const sc = (globalThis as { structuredClone?: <V>(v: V) => V }).structuredClone
  if (typeof sc === 'function') {
    return sc(value)
  }
  // JSON fallback — adequate for plain-data values.
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Typed, session-scoped working memory.
 *
 * `WorkingMemory<T>` provides a generic map keyed by the keys of `T`, with
 * optional TTL per key and optional LRU eviction. It is designed to be created
 * once per agent session/run and shared across tool calls so the agent can
 * accumulate intermediate state (current task, in-flight plan, scratchpad,
 * counters) without round-tripping through the message history.
 *
 * Snapshots produced by {@link snapshot} are deep clones, so they can be
 * serialized to JSON or stored alongside checkpoints, then later replayed via
 * {@link restore}.
 *
 * The class is a thin in-process container — it does not perform any I/O and
 * has no external dependencies.
 *
 * @typeParam T - Shape of the working-memory store. Keys passed to `get`/`set`
 *   are constrained to `keyof T`, while `has`/`delete` accept arbitrary
 *   strings to support runtime introspection.
 */
export class WorkingMemory<T extends Record<string, unknown>> {
  private readonly entries = new Map<string, Entry>()
  /** LRU access order — most-recently-used is at the END of the array. */
  private readonly accessOrder: string[] = []
  private readonly config: WorkingMemoryConfig

  constructor(config: WorkingMemoryConfig = {}) {
    if (config.maxKeys !== undefined && (!Number.isFinite(config.maxKeys) || config.maxKeys <= 0)) {
      throw new Error(
        `WorkingMemory: maxKeys must be a positive finite number, received ${String(config.maxKeys)}`,
      )
    }
    if (
      config.defaultTtlMs !== undefined &&
      (!Number.isFinite(config.defaultTtlMs) || config.defaultTtlMs <= 0)
    ) {
      throw new Error(
        `WorkingMemory: defaultTtlMs must be a positive finite number, received ${String(config.defaultTtlMs)}`,
      )
    }
    this.config = config
  }

  /**
   * Store `value` under `key`.
   *
   * If `ttlMs` is provided it overrides the configured default TTL. If LRU
   * eviction would push the store past `maxKeys`, the least-recently-accessed
   * key is removed first (and emits an `onChange` event for the eviction).
   *
   * Fires the configured `onChange` callback AFTER the mutation, only if the
   * stored value actually changed (referential equality check).
   */
  set<K extends keyof T>(key: K, value: T[K], ttlMs?: number): void {
    const stringKey = String(key)
    const effectiveTtl = ttlMs ?? this.config.defaultTtlMs
    const expiresAt =
      effectiveTtl !== undefined && effectiveTtl > 0 ? Date.now() + effectiveTtl : undefined

    const previous = this.entries.get(stringKey)
    const isExpired = previous?.expiresAt !== undefined && previous.expiresAt <= Date.now()
    const prevValue = previous && !isExpired ? previous.value : undefined
    const valueChanged = !previous || isExpired || previous.value !== value

    const entry: Entry = expiresAt === undefined ? { value } : { value, expiresAt }
    this.entries.set(stringKey, entry)
    this.touch(stringKey)
    this.evictIfNeeded(stringKey)

    if (valueChanged) {
      this.fireChange(stringKey, value, prevValue)
    }
  }

  /**
   * Read the value stored under `key`, or `undefined` if the key is absent
   * or its TTL has elapsed. Reading a live key marks it as most-recently-used
   * for LRU purposes.
   */
  get<K extends keyof T>(key: K): T[K] | undefined {
    const stringKey = String(key)
    const entry = this.entries.get(stringKey)
    if (!entry) return undefined
    if (this.isExpired(entry)) {
      this.entries.delete(stringKey)
      this.removeFromAccessOrder(stringKey)
      return undefined
    }
    this.touch(stringKey)
    return entry.value as T[K]
  }

  /**
   * `true` if `key` is present and its TTL has not elapsed.
   * Accepts any string so callers can probe at runtime.
   */
  has(key: string): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    if (this.isExpired(entry)) {
      this.entries.delete(key)
      this.removeFromAccessOrder(key)
      return false
    }
    return true
  }

  /**
   * Remove `key` from working memory. Returns `true` if a live entry was
   * removed (expired entries count as already-absent and return `false`).
   * Fires `onChange(key, undefined, prevValue)` when a removal occurs.
   */
  delete(key: string): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    const wasExpired = this.isExpired(entry)
    this.entries.delete(key)
    this.removeFromAccessOrder(key)
    if (wasExpired) return false
    this.fireChange(key, undefined, entry.value)
    return true
  }

  /**
   * Drop ALL entries. Does NOT fire `onChange` for individual keys — clearing
   * is treated as a structural reset rather than a per-key mutation.
   */
  clear(): void {
    this.entries.clear()
    this.accessOrder.length = 0
  }

  /**
   * Capture a deep clone of the current memory contents. Expired keys are
   * pruned from the snapshot, so the caller never sees stale data. Future
   * mutations to the live store do NOT affect the returned snapshot.
   */
  snapshot(): WorkingMemorySnapshot<Readonly<T>> {
    const now = Date.now()
    const data: Record<string, unknown> = {}
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) continue
      data[key] = deepClone(entry.value)
    }
    return {
      data: Object.freeze(data) as Readonly<T>,
      capturedAt: now,
    }
  }

  /**
   * Replace ALL current state with the contents of `snapshot.data`.
   *
   * `onChange` fires once per key that ends up with a different value than it
   * had before the restore (including new keys and keys that disappear). The
   * snapshot data is deep-cloned on the way in so the caller can safely mutate
   * the snapshot afterwards.
   */
  restore(snapshot: WorkingMemorySnapshot<T>): void {
    const previousValues = new Map<string, unknown>()
    for (const [key, entry] of this.entries.entries()) {
      if (this.isExpired(entry)) continue
      previousValues.set(key, entry.value)
    }

    this.entries.clear()
    this.accessOrder.length = 0

    const incoming = snapshot.data ?? ({} as T)
    for (const key of Object.keys(incoming)) {
      const cloned = deepClone(incoming[key])
      this.entries.set(key, { value: cloned })
      this.accessOrder.push(key)
    }

    // Fire change events for every differing key (added, modified, removed).
    const allKeys = new Set<string>([...previousValues.keys(), ...Object.keys(incoming)])
    for (const key of allKeys) {
      const prev = previousValues.get(key)
      const next = this.entries.get(key)?.value
      if (prev !== next) {
        this.fireChange(key, next, prev)
      }
    }
  }

  /**
   * Snapshot of all live (non-expired) keys. Order matches LRU access order
   * with most-recently-used last.
   */
  keys(): string[] {
    this.pruneExpired()
    return [...this.accessOrder]
  }

  /** Number of live (non-expired) entries currently in working memory. */
  get size(): number {
    this.pruneExpired()
    return this.entries.size
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private isExpired(entry: Entry): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= Date.now()
  }

  private touch(key: string): void {
    this.removeFromAccessOrder(key)
    this.accessOrder.push(key)
  }

  private removeFromAccessOrder(key: string): void {
    const idx = this.accessOrder.indexOf(key)
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1)
    }
  }

  private evictIfNeeded(protectedKey: string): void {
    const max = this.config.maxKeys
    if (max === undefined) return
    while (this.entries.size > max && this.accessOrder.length > 0) {
      // Evict the LEAST recently used entry that isn't the key we just touched.
      let evictIndex = -1
      for (let i = 0; i < this.accessOrder.length; i++) {
        if (this.accessOrder[i] !== protectedKey) {
          evictIndex = i
          break
        }
      }
      if (evictIndex === -1) break
      const evictKey = this.accessOrder[evictIndex]!
      const evicted = this.entries.get(evictKey)
      this.entries.delete(evictKey)
      this.accessOrder.splice(evictIndex, 1)
      if (evicted && !this.isExpired(evicted)) {
        this.fireChange(evictKey, undefined, evicted.value)
      }
    }
  }

  private pruneExpired(): void {
    const now = Date.now()
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.entries.delete(key)
        this.removeFromAccessOrder(key)
      }
    }
  }

  private fireChange(key: string, value: unknown, prev: unknown): void {
    if (!this.config.onChange) return
    try {
      this.config.onChange(key, value, prev)
    } catch {
      // onChange listeners are best-effort — never let them break the store.
    }
  }
}

/**
 * Convenience factory for creating a typed {@link WorkingMemory} instance.
 *
 * @example
 * ```ts
 * interface SessionState { taskId: string; attempts: number }
 * const memory = createWorkingMemory<SessionState>({ maxKeys: 64 })
 * memory.set('taskId', 'abc-123')
 * memory.set('attempts', 0)
 * ```
 */
export function createWorkingMemory<T extends Record<string, unknown>>(
  config?: WorkingMemoryConfig,
): WorkingMemory<T> {
  return new WorkingMemory<T>(config)
}
