import { Semaphore } from './semaphore.js'

/**
 * Configuration for ConcurrencyPool.
 */
export interface PoolConfig {
  /** Maximum concurrent operations (default: 10). */
  maxConcurrent: number
  /** Per-key concurrency limit (default: unlimited). */
  maxPerKey?: number
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
  private readonly activeCounts: Map<string, number> = new Map()
  private completed = 0
  private failed = 0
  private queued = 0

  constructor(config?: Partial<PoolConfig>) {
    const maxConcurrent = config?.maxConcurrent ?? 10
    this.maxPerKey = config?.maxPerKey
    this.globalSem = new Semaphore(maxConcurrent)
  }

  /** Execute fn with concurrency control. Key is used for per-key limits and tracking. */
  async execute<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const keySem = this.getKeySemaphore(key)

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
    // Poll until no active operations remain.
    // Each iteration yields to the event loop so in-flight promises can settle.
    while (this.stats().active > 0 || this.queued > 0) {
      await new Promise<void>((r) => setTimeout(r, 10))
    }
  }

  private getKeySemaphore(key: string): Semaphore | undefined {
    if (this.maxPerKey === undefined) return undefined
    let sem = this.keySems.get(key)
    if (!sem) {
      sem = new Semaphore(this.maxPerKey)
      this.keySems.set(key, sem)
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
}
