import { Semaphore } from './semaphore.js'

/**
 * Configuration for ConcurrencyPool.
 */
export interface PoolConfig {
  /** Maximum concurrent operations (default: 10). */
  maxConcurrent: number
  /** Per-key concurrency limit (default: unlimited). */
  maxPerKey?: number
  /** Evict per-key semaphores that have been idle beyond this duration (default: 300_000 ms). */
  maxIdleMsPerKey?: number
  /** Maximum number of tracked per-key semaphores before proactive eviction (default: 1000). */
  maxTrackedKeys?: number
}

/**
 * Snapshot of pool statistics.
 */
export interface PoolStats {
  active: number
  queued: number
  completed: number
  failed: number
  activeKeys: string[]
}

/**
 * Concurrency pool for limiting total parallel operations.
 * Tracks active operations by name for observability.
 *
 * @example
 * ```ts
 * const pool = new ConcurrencyPool({ maxConcurrent: 10 })
 * const result = await pool.execute('agent-1', () => agent.generate(...))
 * ```
 */
export class ConcurrencyPool {
  private readonly globalSem: Semaphore
  private readonly keySems: Map<string, Semaphore> = new Map()
  private readonly maxPerKey: number | undefined
  private readonly maxIdleMsPerKey: number
  private readonly maxTrackedKeys: number
  private readonly keyLastUsedAt: Map<string, number> = new Map()
  private readonly activeCounts: Map<string, number> = new Map()
  private completed = 0
  private failed = 0
  private queued = 0
  private drainResolvers: Array<() => void> = []

  constructor(config?: Partial<PoolConfig>) {
    const maxConcurrent = config?.maxConcurrent ?? 10
    this.maxPerKey = config?.maxPerKey
    this.maxIdleMsPerKey = config?.maxIdleMsPerKey ?? 300_000
    this.maxTrackedKeys = config?.maxTrackedKeys ?? 1000
    this.globalSem = new Semaphore(maxConcurrent)
  }

  /** Execute fn with concurrency control. Key is used for per-key limits and tracking. */
  async execute<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const keySem = this.getKeySemaphore(key)
    this.touchKey(key)

    this.queued++
    try {
      // Acquire both global and per-key permits (if configured)
      if (keySem) {
        await Promise.all([this.globalSem.acquire(), keySem.acquire()])
      } else {
        await this.globalSem.acquire()
      }
    } finally {
      this.queued--
    }

    this.incrementActive(key)
    try {
      const result = await fn()
      this.completed++
      return result
    } catch (err: unknown) {
      this.failed++
      throw err
    } finally {
      this.decrementActive(key)
      this.globalSem.release()
      keySem?.release()
      this.touchKey(key)
      this.evictIdleKeySemaphores()
      this.checkDrain()
    }
  }

  /** Get current pool stats. */
  stats(): PoolStats {
    let active = 0
    const activeKeys: string[] = []
    for (const [key, count] of this.activeCounts) {
      if (count > 0) {
        active += count
        activeKeys.push(key)
      }
    }
    return {
      active,
      queued: this.queued,
      completed: this.completed,
      failed: this.failed,
      activeKeys,
    }
  }

  /** Wait for all active operations to complete. */
  async drain(): Promise<void> {
    if (this.stats().active === 0 && this.queued === 0) {
      return // Already drained
    }
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve)
    })
  }

  /** Resolve pending drain() callers when the pool becomes idle. */
  private checkDrain(): void {
    if (this.stats().active === 0 && this.queued === 0 && this.drainResolvers.length > 0) {
      const resolvers = this.drainResolvers.splice(0)
      for (const resolve of resolvers) resolve()
    }
  }

  /** Returns the number of tracked per-key semaphores. */
  trackedKeyCount(): number {
    return this.keySems.size
  }

  private getKeySemaphore(key: string): Semaphore | undefined {
    if (this.maxPerKey === undefined) return undefined
    let sem = this.keySems.get(key)
    if (!sem) {
      sem = new Semaphore(this.maxPerKey)
      this.keySems.set(key, sem)
      this.touchKey(key)
      this.enforceTrackedKeyLimit()
    }
    return sem
  }

  private incrementActive(key: string): void {
    this.activeCounts.set(key, (this.activeCounts.get(key) ?? 0) + 1)
  }

  private decrementActive(key: string): void {
    const count = (this.activeCounts.get(key) ?? 1) - 1
    if (count <= 0) {
      this.activeCounts.delete(key)
    } else {
      this.activeCounts.set(key, count)
    }
  }

  private touchKey(key: string): void {
    this.keyLastUsedAt.set(key, Date.now())
  }

  private canEvictKey(key: string, sem: Semaphore): boolean {
    if (this.maxPerKey === undefined) return false
    const active = this.activeCounts.get(key) ?? 0
    return active === 0 && sem.queueLength === 0 && sem.available === this.maxPerKey
  }

  private evictIdleKeySemaphores(now = Date.now()): void {
    if (!Number.isFinite(this.maxIdleMsPerKey)) return
    for (const [key, sem] of this.keySems) {
      if (!this.canEvictKey(key, sem)) continue
      const lastUsed = this.keyLastUsedAt.get(key) ?? 0
      if (now - lastUsed < this.maxIdleMsPerKey) continue
      this.keySems.delete(key)
      this.keyLastUsedAt.delete(key)
    }
  }

  private enforceTrackedKeyLimit(): void {
    if (!Number.isFinite(this.maxTrackedKeys)) return
    if (this.keySems.size <= this.maxTrackedKeys) return

    const candidates = [...this.keySems.entries()]
      .filter(([key, sem]) => this.canEvictKey(key, sem))
      .sort((a, b) => (this.keyLastUsedAt.get(a[0]) ?? 0) - (this.keyLastUsedAt.get(b[0]) ?? 0))

    for (const [key] of candidates) {
      if (this.keySems.size <= this.maxTrackedKeys) break
      this.keySems.delete(key)
      this.keyLastUsedAt.delete(key)
    }
  }
}
