/**
 * Counting semaphore for limiting concurrent operations.
 *
 * @example
 * ```ts
 * const sem = new Semaphore(5) // max 5 concurrent
 * await sem.acquire()
 * try {
 *   await doWork()
 * } finally {
 *   sem.release()
 * }
 * // Or with helper:
 * await sem.run(() => doWork())
 * ```
 */
export class Semaphore {
  private permits: number
  private readonly maxPermits: number
  private readonly waiting: Array<() => void> = []

  constructor(maxPermits: number) {
    if (maxPermits < 1) {
      throw new Error('Semaphore maxPermits must be >= 1')
    }
    this.maxPermits = maxPermits
    this.permits = maxPermits
  }

  /** Acquire a permit, blocking if none available. */
  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve)
    })
  }

  /** Release a permit, unblocking a waiter if any. */
  release(): void {
    const next = this.waiting.shift()
    if (next) {
      // Hand the permit directly to the next waiter
      next()
    } else {
      if (this.permits >= this.maxPermits) {
        throw new Error('Semaphore released more times than acquired')
      }
      this.permits++
    }
  }

  /** Run a function with automatic acquire/release. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  /** Current number of available permits. */
  get available(): number {
    return this.permits
  }

  /** Number of waiters in the queue. */
  get queueLength(): number {
    return this.waiting.length
  }
}
