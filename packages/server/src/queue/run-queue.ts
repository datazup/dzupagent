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
  createdAt: Date
}

export interface RunQueueConfig {
  /** Max concurrent jobs to process (default: 5) */
  concurrency: number
  /** Job processing timeout in ms (default: 300_000 = 5 min) */
  jobTimeoutMs: number
}

export type JobProcessor = (job: RunJob, signal: AbortSignal) => Promise<void>

export interface RunQueue {
  /** Enqueue a new run for async processing */
  enqueue(job: Omit<RunJob, 'id' | 'createdAt'>): Promise<RunJob>
  /** Start processing jobs */
  start(processor: JobProcessor): void
  /** Stop processing (optionally wait for active jobs) */
  stop(waitForActive?: boolean): Promise<void>
  /** Cancel a specific run by runId. Returns true if found and cancelled. */
  cancel(runId: string): boolean
  /** Get queue stats */
  stats(): QueueStats
}

export interface QueueStats {
  pending: number
  active: number
  completed: number
  failed: number
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
  private readonly config: RunQueueConfig
  private processTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: Partial<RunQueueConfig>) {
    this.config = {
      concurrency: config?.concurrency ?? 5,
      jobTimeoutMs: config?.jobTimeoutMs ?? 300_000,
    }
  }

  async enqueue(input: Omit<RunJob, 'id' | 'createdAt'>): Promise<RunJob> {
    const job: RunJob = {
      ...input,
      id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date(),
    }

    this.pending.push(job)
    // Sort by priority (lower = higher priority)
    this.pending.sort((a, b) => a.priority - b.priority)

    // Trigger processing
    this.processNext()

    return job
  }

  start(processor: JobProcessor): void {
    this.processor = processor
    this.running = true
    // Poll for jobs every 500ms (in case processNext() misses an event)
    this.processTimer = setInterval(() => this.processNext(), 500)
    this.processNext()
  }

  async stop(waitForActive = true): Promise<void> {
    this.running = false
    if (this.processTimer) {
      clearInterval(this.processTimer)
      this.processTimer = null
    }

    if (waitForActive && this.activeJobs.size > 0) {
      // Wait up to drain timeout
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (this.activeJobs.size === 0) {
            clearInterval(check)
            resolve()
          }
        }, 200)
        // Safety: don't wait forever
        setTimeout(() => { clearInterval(check); resolve() }, this.config.jobTimeoutMs)
      })
    }

    // Abort remaining active jobs
    for (const { abort } of this.activeJobs.values()) {
      abort.abort()
    }
    this.activeJobs.clear()
  }

  cancel(runId: string): boolean {
    // Check pending queue first — remove without executing
    const pendingIdx = this.pending.findIndex((j) => j.runId === runId)
    if (pendingIdx !== -1) {
      this.pending.splice(pendingIdx, 1)
      return true
    }

    // Check active jobs — abort the signal
    for (const [jobId, entry] of this.activeJobs) {
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
    }
  }

  private processNext(): void {
    if (!this.running || !this.processor) return
    if (this.activeJobs.size >= this.config.concurrency) return
    if (this.pending.length === 0) return

    const job = this.pending.shift()!
    const abort = new AbortController()
    this.activeJobs.set(job.id, { job, abort })

    // Timeout safety
    const timeout = setTimeout(() => abort.abort(), this.config.jobTimeoutMs)

    void this.processor(job, abort.signal)
      .then(() => { this.completedCount++ })
      .catch(() => { this.failedCount++ })
      .finally(() => {
        clearTimeout(timeout)
        this.activeJobs.delete(job.id)
        this.processNext() // Process next job in queue
      })

    // Try to fill concurrency slots
    if (this.activeJobs.size < this.config.concurrency && this.pending.length > 0) {
      this.processNext()
    }
  }
}
