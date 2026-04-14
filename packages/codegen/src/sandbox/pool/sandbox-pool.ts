/**
 * Generic sandbox pool with pre-warming, idle eviction, and health checks.
 *
 * Manages a bounded pool of sandbox instances, reusing them across requests
 * to amortize creation cost. Supports configurable min-idle, max-size,
 * health-check-on-acquire, and idle eviction.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PooledSandbox {
  /** Unique identifier for the sandbox instance */
  id: string
  /** When this sandbox was first created */
  createdAt: Date
  /** When this sandbox was last returned from acquire() */
  lastUsedAt: Date
}

export interface SandboxPoolConfig {
  /** Minimum number of idle sandboxes to keep warm (default: 0) */
  minIdle?: number
  /** Maximum total sandboxes (active + idle) (default: 10) */
  maxSize?: number
  /** How long to wait (ms) for a sandbox before throwing PoolExhaustedError (default: 30_000) */
  maxWaitMs?: number
  /** Evict idle sandboxes older than this (ms). 0 = never evict. (default: 300_000) */
  idleEvictionMs?: number
  /** Run health check before returning sandbox from acquire()? (default: false) */
  healthCheckOnAcquire?: boolean
  /** Factory: create a new sandbox */
  createSandbox: () => Promise<PooledSandbox>
  /** Factory: destroy a sandbox */
  destroySandbox: (sb: PooledSandbox) => Promise<void>
  /** Optional health check — return true if sandbox is healthy */
  healthCheck?: (sb: PooledSandbox) => Promise<boolean>
}

export interface SandboxPoolMetrics {
  totalCreated: number
  totalDestroyed: number
  currentActive: number
  currentIdle: number
  acquireWaitMs: number[]
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class PoolExhaustedError extends Error {
  constructor(maxWaitMs: number) {
    super(`Sandbox pool exhausted: no sandbox available within ${maxWaitMs}ms`)
    this.name = 'PoolExhaustedError'
  }
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

interface Waiter {
  resolve: (sb: PooledSandbox) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class SandboxPool {
  private readonly config: Required<
    Pick<SandboxPoolConfig, 'minIdle' | 'maxSize' | 'maxWaitMs' | 'idleEvictionMs' | 'healthCheckOnAcquire'>
  > & Pick<SandboxPoolConfig, 'createSandbox' | 'destroySandbox' | 'healthCheck'>

  private readonly idle: PooledSandbox[] = []
  private readonly active = new Set<string>()
  private readonly waiters: Waiter[] = []
  private evictionTimer: ReturnType<typeof setInterval> | null = null
  private draining = false

  private _totalCreated = 0
  private _totalDestroyed = 0
  private readonly _acquireWaitMs: number[] = []

  constructor(userConfig: SandboxPoolConfig) {
    const cfg: typeof this.config = {
      minIdle: userConfig.minIdle ?? 0,
      maxSize: userConfig.maxSize ?? 10,
      maxWaitMs: userConfig.maxWaitMs ?? 30_000,
      idleEvictionMs: userConfig.idleEvictionMs ?? 300_000,
      healthCheckOnAcquire: userConfig.healthCheckOnAcquire ?? false,
      createSandbox: userConfig.createSandbox,
      destroySandbox: userConfig.destroySandbox,
    }
    if (userConfig.healthCheck !== undefined) cfg.healthCheck = userConfig.healthCheck
    this.config = cfg
  }

  /** Pre-warm the pool to minIdle sandboxes and start eviction timer. */
  async start(): Promise<void> {
    const toCreate = Math.max(0, this.config.minIdle - this.idle.length)
    const promises: Promise<void>[] = []
    for (let i = 0; i < toCreate; i++) {
      promises.push(this.createAndPark())
    }
    await Promise.all(promises)

    if (this.config.idleEvictionMs > 0) {
      this.evictionTimer = setInterval(() => {
        void this.evictStale()
      }, Math.max(this.config.idleEvictionMs / 2, 5_000))
      // Allow the process to exit even if the timer is running
      if (typeof this.evictionTimer === 'object' && 'unref' in this.evictionTimer) {
        this.evictionTimer.unref()
      }
    }
  }

  /** Acquire a sandbox from the pool. Blocks up to maxWaitMs. */
  async acquire(): Promise<PooledSandbox> {
    if (this.draining) {
      throw new PoolExhaustedError(0)
    }

    const start = Date.now()

    // Try to get from idle
    const fromIdle = await this.tryAcquireIdle()
    if (fromIdle) {
      this._acquireWaitMs.push(Date.now() - start)
      return fromIdle
    }

    // Try to create a new one if under maxSize
    const totalCount = this.idle.length + this.active.size
    if (totalCount < this.config.maxSize) {
      const sb = await this.config.createSandbox()
      this._totalCreated++
      sb.lastUsedAt = new Date()
      this.active.add(sb.id)
      this._acquireWaitMs.push(Date.now() - start)
      return sb
    }

    // Block until one becomes available or timeout
    return new Promise<PooledSandbox>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve)
        if (idx >= 0) {
          this.waiters.splice(idx, 1)
        }
        reject(new PoolExhaustedError(this.config.maxWaitMs))
      }, this.config.maxWaitMs)

      this.waiters.push({
        resolve: (sb: PooledSandbox) => {
          clearTimeout(timer)
          this._acquireWaitMs.push(Date.now() - start)
          resolve(sb)
        },
        reject: (err: Error) => {
          clearTimeout(timer)
          reject(err)
        },
        timer,
      })
    })
  }

  /** Return a sandbox to the pool. */
  async release(sandbox: PooledSandbox): Promise<void> {
    this.active.delete(sandbox.id)
    sandbox.lastUsedAt = new Date()

    // If someone is waiting, hand it directly
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      waiter.resolve(sandbox)
      this.active.add(sandbox.id)
      return
    }

    // Otherwise park it
    if (!this.draining) {
      this.idle.push(sandbox)
    } else {
      await this.destroySandbox(sandbox)
    }
  }

  /** Graceful shutdown: reject waiters, destroy all sandboxes. */
  async drain(): Promise<void> {
    this.draining = true

    if (this.evictionTimer !== null) {
      clearInterval(this.evictionTimer)
      this.evictionTimer = null
    }

    // Reject all waiters
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new PoolExhaustedError(0))
    }
    this.waiters.length = 0

    // Destroy idle sandboxes
    const destroyPromises = this.idle.map((sb) => this.destroySandbox(sb))
    this.idle.length = 0
    await Promise.all(destroyPromises)
  }

  /** Return current metrics. */
  metrics(): SandboxPoolMetrics {
    return {
      totalCreated: this._totalCreated,
      totalDestroyed: this._totalDestroyed,
      currentActive: this.active.size,
      currentIdle: this.idle.length,
      acquireWaitMs: [...this._acquireWaitMs],
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async tryAcquireIdle(): Promise<PooledSandbox | null> {
    while (this.idle.length > 0) {
      const sb = this.idle.shift()!
      if (this.config.healthCheckOnAcquire && this.config.healthCheck) {
        const healthy = await this.config.healthCheck(sb)
        if (!healthy) {
          await this.destroySandbox(sb)
          continue
        }
      }
      sb.lastUsedAt = new Date()
      this.active.add(sb.id)
      return sb
    }
    return null
  }

  private async createAndPark(): Promise<void> {
    const sb = await this.config.createSandbox()
    this._totalCreated++
    this.idle.push(sb)
  }

  private async destroySandbox(sb: PooledSandbox): Promise<void> {
    this._totalDestroyed++
    await this.config.destroySandbox(sb)
  }

  private async evictStale(): Promise<void> {
    const now = Date.now()
    const cutoff = this.config.idleEvictionMs
    const toKeep: PooledSandbox[] = []
    const toEvict: PooledSandbox[] = []

    for (const sb of this.idle) {
      const idleMs = now - sb.lastUsedAt.getTime()
      if (idleMs > cutoff && toKeep.length >= this.config.minIdle) {
        toEvict.push(sb)
      } else {
        toKeep.push(sb)
      }
    }

    this.idle.length = 0
    this.idle.push(...toKeep)

    await Promise.all(toEvict.map((sb) => this.destroySandbox(sb)))
  }
}
