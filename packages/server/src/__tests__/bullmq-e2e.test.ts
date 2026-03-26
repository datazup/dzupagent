/**
 * E2E integration tests for BullMQRunQueue using testcontainers-node
 * with a real Redis instance.
 *
 * Prerequisites:
 * - Docker must be running
 * - `bullmq` and `testcontainers` must be installed as devDependencies
 *
 * These tests are skipped automatically when either dependency or Docker
 * is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { RunJob, JobProcessor } from '../queue/run-queue.js'

// ---------------------------------------------------------------------------
// Conditional imports — skip the entire suite when deps are missing
// ---------------------------------------------------------------------------

interface TestContainer {
  getMappedPort(port: number): number
  getHost(): string
  stop(): Promise<void>
}

interface GenericContainerCtor {
  new (image: string): {
    withExposedPorts(...ports: number[]): {
      start(): Promise<TestContainer>
    }
  }
}

let GenericContainer: GenericContainerCtor | undefined
let BullMQRunQueueClass: typeof import('../queue/bullmq-run-queue.js').BullMQRunQueue | undefined

try {
  const tc = await import('testcontainers')
  GenericContainer = tc.GenericContainer as unknown as GenericContainerCtor
} catch {
  // testcontainers not installed
}

try {
  const mod = await import('../queue/bullmq-run-queue.js')
  BullMQRunQueueClass = mod.BullMQRunQueue
} catch {
  // bullmq not installed — BullMQRunQueue will fail to create workers
}

const canRun = GenericContainer !== undefined && BullMQRunQueueClass !== undefined

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a deferred promise that can be resolved externally. */
function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Build a minimal RunJob input for testing. */
function jobInput(overrides: Partial<Omit<RunJob, 'id' | 'createdAt' | 'attempts'>> = {}): Omit<RunJob, 'id' | 'createdAt' | 'attempts'> {
  return {
    runId: overrides.runId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentId: overrides.agentId ?? 'agent-test',
    input: overrides.input ?? { msg: 'hello' },
    priority: overrides.priority ?? 0,
    metadata: overrides.metadata,
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)('BullMQRunQueue E2E (testcontainers)', () => {
  // Non-null assertions are safe here because the suite is skipped when these
  // are undefined.
  const Container = GenericContainer!
  const BullMQRunQueue = BullMQRunQueueClass!

  let container: TestContainer
  let redisHost: string
  let redisPort: number

  // Track queues created during tests so we can clean them all up.
  const queues: InstanceType<typeof BullMQRunQueue>[] = []

  function createQueue(
    overrides: Partial<{
      concurrency: number
      jobTimeoutMs: number
      maxRetries: number
      retryBackoffMs: number
      queueName: string
    }> = {},
  ): InstanceType<typeof BullMQRunQueue> {
    const q = new BullMQRunQueue({
      connection: { host: redisHost, port: redisPort },
      concurrency: overrides.concurrency ?? 5,
      jobTimeoutMs: overrides.jobTimeoutMs ?? 30_000,
      maxRetries: overrides.maxRetries ?? 0,
      retryBackoffMs: overrides.retryBackoffMs ?? 200,
      // Each test gets its own queue name to avoid cross-contamination.
      queueName: overrides.queueName ?? `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    })
    queues.push(q)
    return q
  }

  // -- Lifecycle -------------------------------------------------------------

  beforeAll(async () => {
    container = await new Container('redis:7-alpine')
      .withExposedPorts(6379)
      .start()
    redisHost = container.getHost()
    redisPort = container.getMappedPort(6379)
  }, 90_000) // Container pull + start can take a while on first run

  afterEach(async () => {
    // Stop all queues created during the test.
    const stopping = queues.splice(0).map(async (q) => {
      try { await q.stop(false) } catch { /* ignore */ }
    })
    await Promise.all(stopping)
  })

  afterAll(async () => {
    await container?.stop()
  }, 30_000)

  // -- Tests -----------------------------------------------------------------

  it('enqueues a job and processes it with correct data', async () => {
    const queue = createQueue()
    const received = deferred<RunJob>()

    const processor: JobProcessor = async (job) => {
      received.resolve(job)
    }

    queue.start(processor)

    const enqueued = await queue.enqueue(jobInput({
      runId: 'run-enqueue-test',
      agentId: 'agent-1',
      input: { question: 'what is 2+2?' },
    }))

    expect(enqueued.runId).toBe('run-enqueue-test')
    expect(enqueued.agentId).toBe('agent-1')
    expect(enqueued.id).toBeTruthy()

    const processed = await received.promise
    expect(processed.runId).toBe('run-enqueue-test')
    expect(processed.agentId).toBe('agent-1')
    expect(processed.input).toEqual({ question: 'what is 2+2?' })
  }, 15_000)

  it('tracks completed job count in local stats', async () => {
    const queue = createQueue()
    const done = deferred()

    queue.start(async () => {
      done.resolve()
    })

    await queue.enqueue(jobInput())
    await done.promise
    // BullMQ worker events fire asynchronously; give a brief window.
    await new Promise((r) => setTimeout(r, 300))

    const s = queue.stats()
    expect(s.completed).toBeGreaterThanOrEqual(1)
  }, 15_000)

  it('reports accurate counts from Redis via statsFromRedis()', async () => {
    const queue = createQueue({ concurrency: 1 })
    const gate = deferred()
    let jobsProcessed = 0

    queue.start(async () => {
      jobsProcessed++
      if (jobsProcessed === 1) {
        // Hold the first job to keep it "active" while we check stats.
        await gate.promise
      }
    })

    // Enqueue two jobs; concurrency=1 so one will be waiting while one is active.
    await queue.enqueue(jobInput({ runId: 'stats-1' }))
    await queue.enqueue(jobInput({ runId: 'stats-2' }))

    // Wait until the first job is picked up.
    await new Promise((r) => setTimeout(r, 500))

    const stats = await queue.statsFromRedis()
    // At least one waiting, exactly one active.
    expect(stats.active).toBeGreaterThanOrEqual(1)
    // The second job should be waiting (or possibly active if it was fast).
    expect(stats.pending + stats.active).toBeGreaterThanOrEqual(1)

    // Release the gate so cleanup completes.
    gate.resolve()
    await new Promise((r) => setTimeout(r, 500))
  }, 15_000)

  it('processes higher-priority jobs first', async () => {
    const queue = createQueue({ concurrency: 1 })
    const order: string[] = []
    const gate = deferred()
    let callCount = 0

    // Start the worker but hold the first job so the other two queue up.
    queue.start(async (job) => {
      callCount++
      if (callCount === 1) {
        // First job is a "blocker" — hold until we enqueue the priority jobs.
        await gate.promise
      }
      order.push(job.runId)
    })

    // Enqueue a blocker job.
    await queue.enqueue(jobInput({ runId: 'blocker', priority: 0 }))
    // Wait for it to be picked up.
    await new Promise((r) => setTimeout(r, 300))

    // Now enqueue two jobs: low priority (10) first, then high priority (1).
    // BullMQ lower priority number = higher priority.
    await queue.enqueue(jobInput({ runId: 'low-prio', priority: 10 }))
    await queue.enqueue(jobInput({ runId: 'high-prio', priority: 1 }))

    // Release the blocker so the queued jobs get processed.
    gate.resolve()

    // Wait for all three to complete.
    await new Promise((r) => setTimeout(r, 2000))

    // The blocker was first. After it, high-prio (1) should precede low-prio (10).
    expect(order[0]).toBe('blocker')
    expect(order[1]).toBe('high-prio')
    expect(order[2]).toBe('low-prio')
  }, 15_000)

  it('populates dead-letter queue after processor failure', async () => {
    // maxRetries=0 means the job fails on first attempt and goes to dead-letter.
    const queue = createQueue({ maxRetries: 0 })
    const failDone = deferred()

    queue.start(async () => {
      throw new Error('simulated failure')
    })

    await queue.enqueue(jobInput({ runId: 'fail-job' }))

    // Wait for the worker failed event to fire and populate dead-letter.
    await new Promise((r) => setTimeout(r, 1500))
    failDone.resolve()

    const dl = queue.getDeadLetter()
    expect(dl.length).toBeGreaterThanOrEqual(1)

    const entry = dl[0]!
    expect(entry.error).toContain('simulated failure')
    expect(entry.job.runId).toBe('fail-job')
    expect(entry.failedAt).toBeInstanceOf(Date)

    // Verify clearDeadLetter works.
    queue.clearDeadLetter()
    expect(queue.getDeadLetter()).toEqual([])
  }, 15_000)

  it('tracks failed count in local stats after processor failure', async () => {
    const queue = createQueue({ maxRetries: 0 })

    queue.start(async () => {
      throw new Error('boom')
    })

    await queue.enqueue(jobInput())

    // Wait for failure processing.
    await new Promise((r) => setTimeout(r, 1500))

    const s = queue.stats()
    expect(s.failed).toBeGreaterThanOrEqual(1)
    expect(s.deadLetter).toBeGreaterThanOrEqual(1)
  }, 15_000)

  it('stop() closes the worker gracefully', async () => {
    const queue = createQueue()
    const processed = deferred()

    queue.start(async () => {
      processed.resolve()
    })

    await queue.enqueue(jobInput())
    await processed.promise

    // Stopping with waitForActive=true should not throw.
    await expect(queue.stop(true)).resolves.toBeUndefined()

    // After stop, enqueuing still works (queue object persists) but
    // no new jobs should be processed since the worker is closed.
    const s = queue.stats()
    expect(s.completed).toBeGreaterThanOrEqual(1)
  }, 15_000)
})
