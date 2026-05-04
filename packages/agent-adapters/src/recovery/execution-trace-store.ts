/**
 * ExecutionTraceStore — per-entry TTL map used by `ExecutionTraceCapture`.
 *
 * Each entry is evicted by its own `setTimeout`, so there is no background
 * `setInterval` sweep that would otherwise keep the event loop alive (and
 * leak entries when no one is calling `clear()`/`dispose()`). This is a
 * deliberate replacement for the original interval-based sweep that ran
 * every 5 minutes regardless of activity.
 *
 * The store is generic over the value type so it can be reused for trace
 * payloads or any other short-lived per-run object.
 *
 * @module recovery/execution-trace-store
 */

import type { ExecutionTrace } from './execution-trace-types.js'

export interface ExecutionTraceStoreConfig {
  /** TTL per entry, in ms. */
  ttlMs: number
  /** Maximum number of entries kept in memory; older entries are evicted. */
  maxSize: number
}

interface StoreEntry<T> {
  value: T
  insertedAt: number
  timer: ReturnType<typeof setTimeout>
}

/**
 * Generic TTL-bounded store with per-entry timers and FIFO max-size eviction.
 *
 * Keys are strings (typically a runId / traceId). Storing a key that already
 * exists clears the previous timer and replaces the entry; the FIFO ordering
 * is recomputed from `insertedAt` on each `evictIfFull()` pass.
 */
export class ExecutionTraceStore<T = ExecutionTrace> {
  private readonly entries = new Map<string, StoreEntry<T>>()
  private readonly ttlMs: number
  private readonly maxSize: number

  constructor(config: ExecutionTraceStoreConfig) {
    if (!Number.isFinite(config.ttlMs) || config.ttlMs <= 0) {
      throw new Error(`ExecutionTraceStore: ttlMs must be > 0 (got ${config.ttlMs})`)
    }
    if (!Number.isFinite(config.maxSize) || config.maxSize <= 0) {
      throw new Error(`ExecutionTraceStore: maxSize must be > 0 (got ${config.maxSize})`)
    }
    this.ttlMs = config.ttlMs
    this.maxSize = config.maxSize
  }

  /**
   * Store `value` under `key`. Replaces any existing entry (clearing its
   * timer first). Schedules a `setTimeout` that removes the entry after
   * `ttlMs`. If `maxSize` is exceeded, the oldest entry by `insertedAt`
   * is evicted before the new entry is inserted.
   */
  store(key: string, value: T): void {
    const existing = this.entries.get(key)
    if (existing) {
      clearTimeout(existing.timer)
      this.entries.delete(key)
    }

    if (this.entries.size >= this.maxSize) {
      this.evictOldest()
    }

    const timer = setTimeout(() => {
      const current = this.entries.get(key)
      if (current && current.timer === timer) {
        this.entries.delete(key)
      }
    }, this.ttlMs)
    if (typeof timer.unref === 'function') timer.unref()

    this.entries.set(key, { value, insertedAt: Date.now(), timer })
  }

  /** Get the value for `key`, or `undefined` if absent or expired. */
  get(key: string): T | undefined {
    return this.entries.get(key)?.value
  }

  /** Whether a non-expired entry exists for `key`. */
  has(key: string): boolean {
    return this.entries.has(key)
  }

  /** Remove the entry for `key` and clear its TTL timer. */
  remove(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    this.entries.delete(key)
  }

  /** Snapshot of all live values (insertion order). */
  values(): T[] {
    const out: T[] = []
    for (const entry of this.entries.values()) out.push(entry.value)
    return out
  }

  /** Number of live entries. */
  get size(): number {
    return this.entries.size
  }

  /** Remove every entry, clearing each TTL timer. */
  clear(): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer)
    }
    this.entries.clear()
  }

  /**
   * Release every TTL timer and clear the store. Idempotent — safe to call
   * multiple times. This is what callers should invoke from a graceful
   * shutdown path so the event loop is not held open by pending timers.
   */
  dispose(): void {
    this.clear()
  }

  private evictOldest(): void {
    let oldestKey: string | undefined
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [key, entry] of this.entries) {
      if (entry.insertedAt < oldestAt) {
        oldestAt = entry.insertedAt
        oldestKey = key
      }
    }
    if (oldestKey !== undefined) {
      const entry = this.entries.get(oldestKey)!
      clearTimeout(entry.timer)
      this.entries.delete(oldestKey)
    }
  }
}
