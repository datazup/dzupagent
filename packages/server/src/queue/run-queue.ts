/**
 * Abstract run queue for async agent execution.
 *
 * Decouples run creation (API request) from run execution (worker).
 * Provides an in-memory implementation for dev/test and a pluggable
 * interface for production (BullMQ, SQS, etc.).
 */

export interface RunJob {
  id: string
  runId: string
  agentId: string
  input: unknown
  metadata?: Record<string, unknown>
  priority: number // lower = higher priority
  attempts: number // starts at 0, incremented on each retry
  createdAt: Date
}

export interface RunQueueConfig {
  /** Max concurrent jobs to process (default: 5) */
  concurrency: number
  /** Job processing timeout in ms (default: 300_000 = 5 min) */
  jobTimeoutMs: number
  /** Max retry attempts for failed jobs (default: 0 = no retry) */
  maxRetries?: number
  /** Base backoff delay in ms, doubles each retry (default: 1000) */
  retryBackoffMs?: number
}

export type JobProcessor = (job: RunJob, signal: AbortSignal) => Promise<void>

export interface DeadLetterEntry {
  job: RunJob
  error: string
  failedAt: Date
  attempts: number
}

export interface RunQueue {
  /** Enqueue a new run for async processing */
  enqueue(job: Omit<RunJob, 'id' | 'createdAt' | 'attempts'>): Promise<RunJob>
  /** Start processing jobs */
  start(processor: JobProcessor): void
  /** Stop processing (optionally wait for active jobs) */
  stop(waitForActive?: boolean): Promise<void>
  /** Cancel a specific run by runId. Returns true if found and cancelled. */
  cancel(runId: string): boolean
  /** Get queue stats */
  stats(): QueueStats
  /** Get dead-letter entries */
  getDeadLetter(): DeadLetterEntry[]
  /** Clear dead-letter queue */
  clearDeadLetter(): void
}

export interface QueueStats {
  pending: number
  active: number
  completed: number
  failed: number
  deadLetter: number
}

/**
 * Binary search for insertion index in a priority-sorted array.
 * Returns the index where the job should be inserted to maintain
 * ascending priority order (lower priority value = higher priority).
 */
function binaryInsertIndex(arr: RunJob[], priority: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid]!.priority <= priority) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  return lo
}

/**
 * In-memory run queue for development and testing.
 * For production, use BullMQ or similar with Redis backing.
 */
export class InMemoryRunQueue implements RunQueue {
  private pending: RunJob[] = []
  private activeJobs = new Map<string, { job: RunJob; abort: AbortController }>()
  private processor: JobProcessor | null = null
  private running = false
  private completedCount = 0
  private failedCount = 0
  private readonly config: Required<RunQueueConfig>
  private deadLetterQueue: DeadLetterEntry[] = []
  private delayTimers = new Set<ReturnType<typeof setTimeout>>()

  constructor(config?: Partial<RunQueueConfig>) {
    this.config = {
      concurrency: config?.concurrency ?? 5,
      jobTimeoutMs: config?.jobTimeoutMs ?? 300_000,
      maxRetries: config?.maxRetries ?? 0,
      retryBackoffMs: config?.retryBackoffMs ?? 1000,
    }
  }

  async enqueue(input: Omit<RunJob, 'id' | 'createdAt' | 'attempts'>): Promise<RunJob> {
    const job: RunJob = {
      ...input,
      attempts: 0,
      id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date(),
    }

    this.insertByPriority(job)
    this.processNext()

    return job
  }

  start(processor: JobProcessor): void {
    this.processor = processor
    this.running = true
    // No polling interval — processNext() is called explicitly from
    // enqueue() and from the finally block of each job completion.
    this.processNext()
  }

  async stop(waitForActive = true): Promise<void> {
    this.running = false

    // Clear any pending delay timers for retries
    for (const timer of this.delayTimers) {
      clearTimeout(timer)
    }
    this.delayTimers.clear()

    if (waitForActive && this.activeJobs.size > 0) {
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (this.activeJobs.size === 0) {
            clearInterval(check)
            resolve()
          }
        }, 200)
        setTimeout(() => { clearInterval(check); resolve() }, this.config.jobTimeoutMs)
      })
    }

    for (const { abort } of this.activeJobs.values()) {
      abort.abort()
    }
    this.activeJobs.clear()
  }

  cancel(runId: string): boolean {
    const pendingIdx = this.pending.findIndex((j) => j.runId === runId)
    if (pendingIdx !== -1) {
      this.pending.splice(pendingIdx, 1)
      return true
    }

    for (const [, entry] of this.activeJobs) {
      if (entry.job.runId === runId) {
        entry.abort.abort()
        return true
      }
    }

    return false
  }

  stats(): QueueStats {
    return {
      pending: this.pending.length,
      active: this.activeJobs.size,
      completed: this.completedCount,
      failed: this.failedCount,
      deadLetter: this.deadLetterQueue.length,
    }
  }

  getDeadLetter(): DeadLetterEntry[] {
    return [...this.deadLetterQueue]
  }

  clearDeadLetter(): void {
    this.deadLetterQueue = []
  }

  private insertByPriority(job: RunJob): void {
    const index = binaryInsertIndex(this.pending, job.priority)
    this.pending.splice(index, 0, job)
  }

  private scheduleRetry(job: RunJob): void {
    const delay = this.config.retryBackoffMs * Math.pow(2, job.attempts - 1)
    const timer = setTimeout(() => {
      this.delayTimers.delete(timer)
      if (!this.running) return
      this.insertByPriority(job)
      this.processNext()
    }, delay)
    this.delayTimers.add(timer)
  }

  private processNext(): void {
    if (!this.running || !this.processor) return
    if (this.activeJobs.size >= this.config.concurrency) return
    if (this.pending.length === 0) return

    const job = this.pending.shift()!
    const abort = new AbortController()
    this.activeJobs.set(job.id, { job, abort })

    const timeout = setTimeout(() => abort.abort(), this.config.jobTimeoutMs)

    void this.processor(job, abort.signal)
      .then(() => { this.completedCount++ })
      .catch((error: unknown) => {
        job.attempts++
        if (job.attempts <= this.config.maxRetries) {
          this.scheduleRetry(job)
        } else {
          this.failedCount++
          this.deadLetterQueue.push({
            job,
            error: error instanceof Error ? error.message : String(error),
            failedAt: new Date(),
            attempts: job.attempts,
          })
        }
      })
      .finally(() => {
        clearTimeout(timeout)
        this.activeJobs.delete(job.id)
        this.processNext()
      })

    if (this.activeJobs.size < this.config.concurrency && this.pending.length > 0) {
      this.processNext()
    }
  }
}
