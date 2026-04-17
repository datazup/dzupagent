/**
 * Branch coverage tests for InMemoryRunQueue.
 *
 * Targets: stop when not running, stop with no active jobs, cancel while not started,
 * cancel unknown, enqueue after stop, dead-letter non-Error values, scheduleRetry cancellation on stop,
 * start without processor, processNext with empty queue.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { InMemoryRunQueue } from '../queue/run-queue.js'

describe('InMemoryRunQueue branch coverage', () => {
  let queue: InMemoryRunQueue

  afterEach(async () => {
    if (queue) await queue.stop(false).catch(() => {})
  })

  it('stop() is a no-op when nothing is running', async () => {
    queue = new InMemoryRunQueue({ concurrency: 1 })
    await queue.stop(false)
    await queue.stop(true)
  })

  it('cancel returns false on empty queue', () => {
    queue = new InMemoryRunQueue({ concurrency: 1 })
    expect(queue.cancel('anything')).toBe(false)
  })

  it('stats returns zeros initially', () => {
    queue = new InMemoryRunQueue({ concurrency: 1 })
    const s = queue.stats()
    expect(s.pending).toBe(0)
    expect(s.active).toBe(0)
    expect(s.completed).toBe(0)
    expect(s.failed).toBe(0)
    expect(s.deadLetter).toBe(0)
  })

  it('stringifies non-Error throw in dead letter entry', async () => {
    queue = new InMemoryRunQueue({ concurrency: 1, maxRetries: 0 })
    queue.start(async () => {
      // Simulates a non-Error rejection value (e.g., bad library throwing a string)
      return Promise.reject('raw string rejection')
    })

    await queue.enqueue({ runId: 'r1', agentId: 'a', input: {}, priority: 1 })
    await new Promise((r) => setTimeout(r, 50))

    const dl = queue.getDeadLetter()
    expect(dl).toHaveLength(1)
    expect(dl[0]?.error).toBe('raw string rejection')
  })

  it('stringifies number throw in dead letter entry', async () => {
    queue = new InMemoryRunQueue({ concurrency: 1, maxRetries: 0 })
    queue.start(async () => {
      // Simulates a non-Error rejection value (e.g., numeric exit code)
      return Promise.reject(42)
    })

    await queue.enqueue({ runId: 'r1', agentId: 'a', input: {}, priority: 1 })
    await new Promise((r) => setTimeout(r, 50))

    const dl = queue.getDeadLetter()
    expect(dl).toHaveLength(1)
    expect(dl[0]?.error).toBe('42')
  })

  it('start() without a processor does nothing when called with enqueue', async () => {
    queue = new InMemoryRunQueue({ concurrency: 1 })

    // Enqueue without starting — job should sit in pending
    await queue.enqueue({ runId: 'r1', agentId: 'a', input: {}, priority: 1 })
    expect(queue.stats().pending).toBe(1)
    expect(queue.stats().active).toBe(0)
  })

  it('stop clears scheduled retry timers', async () => {
    queue = new InMemoryRunQueue({ concurrency: 1, maxRetries: 3, retryBackoffMs: 10_000 })

    queue.start(async () => { throw new Error('retry me') })
    await queue.enqueue({ runId: 'r1', agentId: 'a', input: {}, priority: 1 })
    await new Promise((r) => setTimeout(r, 30))

    await queue.stop(false)
    // No pending timers should cause test to hang; this just confirms clean stop.
  })

  it('cancel falls through when neither pending nor active', () => {
    queue = new InMemoryRunQueue({ concurrency: 1 })
    queue.start(async () => { await new Promise(() => {}) })

    expect(queue.cancel('ghost-run')).toBe(false)
  })

  it('processNext short-circuits with concurrency at 0', async () => {
    queue = new InMemoryRunQueue({ concurrency: 0 })
    queue.start(async () => {})
    await queue.enqueue({ runId: 'r1', agentId: 'a', input: {}, priority: 1 })

    await new Promise((r) => setTimeout(r, 20))
    // No job should be processed since concurrency is 0
    expect(queue.stats().active).toBe(0)
    expect(queue.stats().pending).toBe(1)
  })

  it('getDeadLetter returns a defensive copy', async () => {
    queue = new InMemoryRunQueue({ concurrency: 1, maxRetries: 0 })
    queue.start(async () => { throw new Error('boom') })
    await queue.enqueue({ runId: 'r1', agentId: 'a', input: {}, priority: 1 })
    await new Promise((r) => setTimeout(r, 50))

    const a = queue.getDeadLetter()
    a.pop()
    const b = queue.getDeadLetter()
    expect(b).toHaveLength(1)
  })

  it('clearDeadLetter on empty list does not throw', () => {
    queue = new InMemoryRunQueue({ concurrency: 1 })
    expect(() => queue.clearDeadLetter()).not.toThrow()
  })

  it('multiple enqueues trigger processNext chain until concurrency reached', async () => {
    queue = new InMemoryRunQueue({ concurrency: 3 })
    let concurrent = 0
    let maxSeen = 0

    queue.start(async () => {
      concurrent++
      maxSeen = Math.max(maxSeen, concurrent)
      await new Promise((r) => setTimeout(r, 30))
      concurrent--
    })

    await queue.enqueue({ runId: 'r1', agentId: 'a', input: {}, priority: 1 })
    await queue.enqueue({ runId: 'r2', agentId: 'a', input: {}, priority: 1 })
    await queue.enqueue({ runId: 'r3', agentId: 'a', input: {}, priority: 1 })
    await queue.enqueue({ runId: 'r4', agentId: 'a', input: {}, priority: 1 })

    await new Promise((r) => setTimeout(r, 150))

    expect(maxSeen).toBe(3)
  })

  it('retry backoff is applied when job fails and retries remain', async () => {
    queue = new InMemoryRunQueue({ concurrency: 1, maxRetries: 1, retryBackoffMs: 25 })
    const timestamps: number[] = []

    queue.start(async () => {
      timestamps.push(Date.now())
      throw new Error('retry me')
    })

    await queue.enqueue({ runId: 'r1', agentId: 'a', input: {}, priority: 1 })
    await new Promise((r) => setTimeout(r, 100))

    expect(timestamps.length).toBe(2)
    const delta = timestamps[1]! - timestamps[0]!
    expect(delta).toBeGreaterThanOrEqual(20)
  })
})
