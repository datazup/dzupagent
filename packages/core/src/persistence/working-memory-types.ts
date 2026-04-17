/**
 * Working Memory — typed, in-process key-value store that persists state across
 * tool calls within an agent session.
 *
 * Working memory is intentionally ephemeral: it lives for the lifetime of the
 * `WorkingMemory` instance (typically scoped to a single agent run/session) and
 * is NOT persisted to disk. For long-term recall, use `MemoryService` instead.
 */

/**
 * Configuration options for {@link WorkingMemory}.
 */
export interface WorkingMemoryConfig {
  /**
   * Maximum number of keys retained before LRU eviction kicks in.
   * Leave `undefined` for unbounded (only safe in short-lived sessions).
   */
  maxKeys?: number

  /**
   * Default time-to-live applied to every key (in milliseconds).
   * A per-call TTL passed to `set()` overrides this default.
   * Leave `undefined` for keys that never expire.
   */
  defaultTtlMs?: number

  /**
   * Optional change listener. Invoked AFTER each mutation with the key,
   * the new value, and the previous value (or `undefined` if the key was new).
   * The listener is also invoked for `delete()` (with `value=undefined`)
   * and for every key replaced by `restore()`.
   */
  onChange?: (key: string, value: unknown, prev: unknown) => void
}

/**
 * Immutable point-in-time copy of working memory contents.
 *
 * Returned by {@link WorkingMemory.snapshot} and consumed by
 * {@link WorkingMemory.restore}. The `data` field is a deep clone of the
 * memory state at `capturedAt`, so it is safe to JSON-serialize and to keep
 * around without worrying about future mutations.
 */
export interface WorkingMemorySnapshot<T> {
  /** Deep clone of the working-memory contents at capture time. */
  data: T
  /** `Date.now()` at the moment the snapshot was produced. */
  capturedAt: number
}
