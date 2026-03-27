/**
 * BullMQ-backed run queue for production deployments.
 *
 * Requires `bullmq` and a Redis connection. Uses BullMQ's built-in
 * priority, retries, and dead-letter handling — mapping them to the
 * RunQueue interface so the rest of the server is queue-agnostic.
 *
 * Install: `npm i bullmq` and ensure Redis is available.
 *
 * @example
 * ```ts
 * import { BullMQRunQueue } from '@dzipagent/server'
 *
 * const queue = new BullMQRunQueue({
 *   connection: { host: 'localhost', port: 6379 },
 *   concurrency: 10,
 *   jobTimeoutMs: 300_000,
 *   maxRetries: 2,
 * })
 * ```
 */
import type {
  RunQueue,
  RunJob,
  RunQueueConfig,
  QueueStats,
  JobProcessor,
  DeadLetterEntry,
} from './run-queue.js'

// BullMQ types — imported dynamically to keep it an optional peer dep.
// These are structural types so the file compiles without bullmq installed.
interface BullMQConnection {
  host?: string
  port?: number
  password?: string
  db?: number
  url?: string
}

interface BullMQQueueLike {
  add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<{ id?: string | null }>
  getJobCounts(...statuses: string[]): Promise<Record<string, number>>
  getJobs(statuses: string[], start?: number, end?: number): Promise<Array<{ data: unknown; failedReason?: string; finishedOn?: number; attemptsMade?: number }>>
  obliterate(opts?: { force?: boolean }): Promise<void>
  close(): Promise<void>
}

interface BullMQWorkerLike {
  close(): Promise<void>
  on(event: string, cb: (...args: unknown[]) => void): void
}

export interface BullMQRunQueueConfig extends RunQueueConfig {
  /** Redis connection options */
  connection: BullMQConnection
  /** Queue name in Redis (default: 'dzipagent-runs') */
  queueName?: string
  /** Prefix for all Redis keys (default: 'forge') */
  prefix?: string
}

const QUEUE_NAME = 'dzipagent-runs'

export class BullMQRunQueue implements RunQueue {
  private queue: BullMQQueueLike | null = null
  private worker: BullMQWorkerLike | null = null
  private readonly config: Required<BullMQRunQueueConfig>
  private completedCount = 0
  private failedCount = 0
  private activeCount = 0
  private localDeadLetter: DeadLetterEntry[] = []

  constructor(config: BullMQRunQueueConfig) {
    this.config = {
      concurrency: config.concurrency ?? 5,
      jobTimeoutMs: config.jobTimeoutMs ?? 300_000,
      maxRetries: config.maxRetries ?? 0,
      retryBackoffMs: config.retryBackoffMs ?? 1000,
      connection: config.connection,
      queueName: config.queueName ?? QUEUE_NAME,
      prefix: config.prefix ?? 'forge',
    }
  }

  async enqueue(input: Omit<RunJob, 'id' | 'createdAt' | 'attempts'>): Promise<RunJob> {
    const queue = await this.getOrCreateQueue()

    const jobData: RunJob = {
      ...input,
      id: '', // BullMQ assigns its own ID
      attempts: 0,
      createdAt: new Date(),
    }

    const result = await queue.add(this.config.queueName, jobData, {
      priority: input.priority,
      attempts: this.config.maxRetries + 1,
      backoff: {
        type: 'exponential',
        delay: this.config.retryBackoffMs,
      },
      removeOnComplete: { count: 1000 },
      removeOnFail: false, // keep for dead-letter inspection
    })

    jobData.id = result.id ?? `bullmq_${Date.now()}`
    return jobData
  }

  start(processor: JobProcessor): void {
    // Dynamic import at start time, not at module load
    void this.createWorker(processor)
  }

  async stop(waitForActive = true): Promise<void> {
    if (this.worker) {
      await this.worker.close()
      this.worker = null
    }

    if (!waitForActive && this.queue) {
      await this.queue.close()
      this.queue = null
    }
  }

  cancel(runId: string): boolean {
    // BullMQ doesn't support direct job cancellation by custom field.
    // For production, use AbortSignal propagation via the event bus.
    // This returns false; callers should use the abort signal path.
    void runId
    return false
  }

  stats(): QueueStats {
    return {
      pending: 0, // Approximate; use getJobCounts for real counts
      active: this.activeCount,
      completed: this.completedCount,
      failed: this.failedCount,
      deadLetter: this.localDeadLetter.length,
    }
  }

  /** Get accurate stats from Redis (async, unlike the sync stats()) */
  async statsFromRedis(): Promise<QueueStats> {
    const queue = await this.getOrCreateQueue()
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed')
    return {
      pending: counts['waiting'] ?? 0,
      active: counts['active'] ?? 0,
      completed: counts['completed'] ?? 0,
      failed: counts['failed'] ?? 0,
      deadLetter: this.localDeadLetter.length,
    }
  }

  getDeadLetter(): DeadLetterEntry[] {
    return [...this.localDeadLetter]
  }

  clearDeadLetter(): void {
    this.localDeadLetter = []
  }

  private async getOrCreateQueue(): Promise<BullMQQueueLike> {
    if (this.queue) return this.queue
    const { Queue } = await import('bullmq')
    this.queue = new Queue(this.config.queueName, {
      connection: this.config.connection,
      prefix: this.config.prefix,
    }) as unknown as BullMQQueueLike
    return this.queue
  }

  private async createWorker(processor: JobProcessor): Promise<void> {
    const { Worker } = await import('bullmq')

    this.worker = new Worker(
      this.config.queueName,
      async (bullJob) => {
        this.activeCount++
        const jobData = bullJob.data as RunJob
        const abort = new AbortController()
        const timeout = setTimeout(() => abort.abort(), this.config.jobTimeoutMs)

        try {
          await processor(jobData, abort.signal)
        } finally {
          clearTimeout(timeout)
          this.activeCount--
        }
      },
      {
        connection: this.config.connection,
        prefix: this.config.prefix,
        concurrency: this.config.concurrency,
      },
    ) as unknown as BullMQWorkerLike

    this.worker.on('completed', () => { this.completedCount++ })
    this.worker.on('failed', (_job: unknown, err: unknown) => {
      this.failedCount++
      // BullMQ handles retries internally; after final failure, capture for dead-letter
      const jobData = (_job && typeof _job === 'object' && 'data' in _job)
        ? (_job as { data: RunJob }).data
        : null
      if (jobData) {
        this.localDeadLetter.push({
          job: jobData,
          error: err instanceof Error ? err.message : String(err),
          failedAt: new Date(),
          attempts: jobData.attempts + 1,
        })
      }
    })
  }
}
