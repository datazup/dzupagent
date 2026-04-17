import { describe, it, expect, vi, afterEach } from 'vitest'
import { InMemoryRunQueue } from '../queue/run-queue.js'

function createJobInput(overrides?: Record<string, unknown>) {
  return {
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    agentId: 'agent-1',
    input: { task: 'test' },
    priority: 5,
    ...overrides,
  }
}

describe('InMemoryRunQueue', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('enqueue returns a RunJob with id and createdAt', async () => {
    const queue = new InMemoryRunQueue()
    const job = await queue.enqueue(createJobInput())
    expect(job.id).toBeTruthy()
    expect(job.createdAt).toBeInstanceOf(Date)
    expect(job.attempts).toBe(0)
    await queue.stop(false)
  })

  it('stats reflect pending and completed counts', async () => {
    const queue = new InMemoryRunQueue({ concurrency: 1 })

    queue.start(async () => {})
    await queue.enqueue(createJobInput())

    // Wait briefly for job processing
    await new Promise((r) => setTimeout(r, 50))

    const stats = queue.stats()
    expect(stats.completed).toBeGreaterThanOrEqual(1)
    await queue.stop(false)
  })

  it('processes jobs in priority order (lower number = higher priority)', async () => {
    const queue = new InMemoryRunQueue({ concurrency: 1 })
    const processed: string[] = []

    // Don't start yet — enqueue first
    await queue.enqueue(createJobInput({ runId: 'low-priority', priority: 10 }))
    await queue.enqueue(createJobInput({ runId: 'high-priority', priority: 1 }))
    await queue.enqueue(createJobInput({ runId: 'mid-priority', priority: 5 }))

    queue.start(async (job) => {
      processed.push(job.runId)
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(processed[0]).toBe('high-priority')
    expect(processed[1]).toBe('mid-priority')
    expect(processed[2]).toBe('low-priority')
    await queue.stop(false)
  })

  it('cancel removes a pending job', async () => {
    const queue = new InMemoryRunQueue({ concurrency: 0 }) // concurrency 0 prevents processing
    await queue.enqueue(createJobInput({ runId: 'to-cancel' }))

    const cancelled = queue.cancel('to-cancel')
    expect(cancelled).toBe(true)
    expect(queue.stats().pending).toBe(0)
    await queue.stop(false)
  })

  it('cancel returns false when run is not found', async () => {
    const queue = new InMemoryRunQueue()
    const cancelled = queue.cancel('nonexistent')
    expect(cancelled).toBe(false)
    await queue.stop(false)
  })

  it('respects concurrency limit', async () => {
    const queue = new InMemoryRunQueue({ concurrency: 2 })
    let concurrent = 0
    let maxConcurrent = 0

    queue.start(async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 50))
      concurrent--
    })

    await queue.enqueue(createJobInput())
    await queue.enqueue(createJobInput())
    await queue.enqueue(createJobInput())
    await queue.enqueue(createJobInput())

    await new Promise((r) => setTimeout(r, 200))

    expect(maxConcurrent).toBeLessThanOrEqual(2)
    await queue.stop(false)
  })

  it('sends failed jobs to dead letter queue when maxRetries is 0', async () => {
    const queue = new InMemoryRunQueue({ concurrency: 1, maxRetries: 0 })

    queue.start(async () => {
      throw new Error('job failed')
    })

    await queue.enqueue(createJobInput({ runId: 'failing-job' }))
    await new Promise((r) => setTimeout(r, 100))

    const deadLetter = queue.getDeadLetter()
    expect(deadLetter).toHaveLength(1)
    expect(deadLetter[0]?.error).toBe('job failed')
    expect(deadLetter[0]?.job.runId).toBe('failing-job')

    expect(queue.stats().failed).toBe(1)
    expect(queue.stats().deadLetter).toBe(1)
    await queue.stop(false)
  })

  it('clearDeadLetter empties the dead letter queue', async () => {
    const queue = new InMemoryRunQueue({ concurrency: 1, maxRetries: 0 })

    queue.start(async () => { throw new Error('fail') })
    await queue.enqueue(createJobInput())
    await new Promise((r) => setTimeout(r, 100))

    expect(queue.getDeadLetter()).toHaveLength(1)
    queue.clearDeadLetter()
    expect(queue.getDeadLetter()).toHaveLength(0)
    await queue.stop(false)
  })

  it('retries jobs up to maxRetries with backoff', async () => {
    const queue = new InMemoryRunQueue({ concurrency: 1, maxRetries: 2, retryBackoffMs: 10 })
    let attempts = 0

    queue.start(async () => {
      attempts++
      throw new Error('retry me')
    })

    await queue.enqueue(createJobInput())
    // Wait for initial + 2 retries (backoff: 10ms, 20ms)
    await new Promise((r) => setTimeout(r, 200))

    // 1 initial + 2 retries = 3 total attempts
    expect(attempts).toBe(3)
    expect(queue.getDeadLetter()).toHaveLength(1)
    expect(queue.getDeadLetter()[0]?.attempts).toBe(3)
    await queue.stop(false)
  })

  it('stop with waitForActive waits for active jobs', async () => {
    const queue = new InMemoryRunQueue({ concurrency: 1 })
    let completed = false

    queue.start(async () => {
      await new Promise((r) => setTimeout(r, 50))
      completed = true
    })

    await queue.enqueue(createJobInput())
    await queue.stop(true)

    expect(completed).toBe(true)
  })

  it('stop without waiting aborts active jobs immediately', async () => {
    const queue = new InMemoryRunQueue({ concurrency: 1 })
    let signalAborted = false

    queue.start(async (_job, signal) => {
      signal.addEventListener('abort', () => { signalAborted = true })
      await new Promise((r) => setTimeout(r, 5000))
    })

    await queue.enqueue(createJobInput())
    await new Promise((r) => setTimeout(r, 20))
    await queue.stop(false)

    expect(signalAborted).toBe(true)
  })

  it('cancel aborts an active job', async () => {
    const queue = new InMemoryRunQueue({ concurrency: 1 })
    let aborted = false

    queue.start(async (_job, signal) => {
      signal.addEventListener('abort', () => { aborted = true })
      await new Promise((r) => setTimeout(r, 5000))
    })

    await queue.enqueue(createJobInput({ runId: 'active-job' }))
    await new Promise((r) => setTimeout(r, 20))

    const cancelled = queue.cancel('active-job')
    expect(cancelled).toBe(true)
    expect(aborted).toBe(true)
    await queue.stop(false)
  })

  it('getDeadLetter returns a copy (defensive)', async () => {
    const queue = new InMemoryRunQueue({ maxRetries: 0 })
    queue.start(async () => { throw new Error('fail') })
    await queue.enqueue(createJobInput())
    await new Promise((r) => setTimeout(r, 50))

    const dl1 = queue.getDeadLetter()
    const dl2 = queue.getDeadLetter()
    expect(dl1).toEqual(dl2)
    expect(dl1).not.toBe(dl2) // different array reference
    await queue.stop(false)
  })
})
