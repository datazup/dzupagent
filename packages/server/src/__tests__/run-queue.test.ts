import { describe, it, expect, afterEach } from 'vitest'
import { waitForCondition } from '@dzupagent/test-utils'
import { InMemoryRunQueue } from '../queue/run-queue.js'
import type { RunJob } from '../queue/run-queue.js'

describe('InMemoryRunQueue', () => {
  let queue: InMemoryRunQueue

  afterEach(async () => {
    if (queue) {
      await queue.stop(false)
    }
  })

  describe('binary insert priority ordering', () => {
    it('maintains priority order on enqueue without sort', async () => {
      queue = new InMemoryRunQueue({ concurrency: 1 })

      const processed: string[] = []
      await queue.enqueue({ runId: 'r3', agentId: 'a', input: {}, priority: 3 })
      await queue.enqueue({ runId: 'r1', agentId: 'a', input: {}, priority: 1 })
      await queue.enqueue({ runId: 'r5', agentId: 'a', input: {}, priority: 5 })
      await queue.enqueue({ runId: 'r2', agentId: 'a', input: {}, priority: 2 })
      await queue.enqueue({ runId: 'r4', agentId: 'a', input: {}, priority: 4 })

      queue.start(async (job) => {
        processed.push(job.runId)
      })
      await waitForCondition(
        () => processed.length === 5,
        { description: 'timed out waiting for all priority jobs to process' },
      )

      expect(processed).toEqual(['r1', 'r2', 'r3', 'r4', 'r5'])
    })

    it('handles equal priorities with stable insertion (FIFO)', async () => {
      queue = new InMemoryRunQueue({ concurrency: 1 })

      const processed: string[] = []
      await queue.enqueue({ runId: 'first', agentId: 'a', input: {}, priority: 1 })
      await queue.enqueue({ runId: 'second', agentId: 'a', input: {}, priority: 1 })
      await queue.enqueue({ runId: 'third', agentId: 'a', input: {}, priority: 1 })

      queue.start(async (job) => {
        processed.push(job.runId)
      })
      await waitForCondition(
        () => processed.length === 3,
        { description: 'timed out waiting for FIFO jobs to process' },
      )

      expect(processed).toEqual(['first', 'second', 'third'])
    })
  })

  describe('no polling interval', () => {
    it('does not create a processTimer on start', () => {
      queue = new InMemoryRunQueue({ concurrency: 1 })
      queue.start(async () => {})

      const instance = queue as unknown as Record<string, unknown>
      expect(instance['processTimer']).toBeUndefined()
    })
  })

  describe('attempts tracking', () => {
    it('sets attempts to 0 on initial enqueue', async () => {
      queue = new InMemoryRunQueue({ concurrency: 1 })

      let capturedJob: RunJob | null = null
      queue.start(async (job) => { capturedJob = job })

      await queue.enqueue({ runId: 'r1', agentId: 'a', input: {}, priority: 1 })
      await waitForCondition(
        () => capturedJob !== null,
        { description: 'timed out waiting for initial job capture' },
      )

      expect(capturedJob).not.toBeNull()
      expect(capturedJob!.attempts).toBe(0)
    })
  })

  describe('retry with backoff', () => {
    it('retries a failed job when maxRetries > 0', async () => {
      queue = new InMemoryRunQueue({
        concurrency: 1,
        maxRetries: 2,
        retryBackoffMs: 50,
      })

      let attemptCount = 0
      queue.start(async () => {
        attemptCount++
        if (attemptCount < 3) {
          throw new Error(`fail-${attemptCount}`)
        }
      })

      await queue.enqueue({ runId: 'r1', agentId: 'a', input: {}, priority: 1 })
      await waitForCondition(
        () => attemptCount === 3 && queue.stats().completed === 1,
        { description: 'timed out waiting for retry success sequence' },
      )

      expect(attemptCount).toBe(3)
      expect(queue.stats().completed).toBe(1)
      expect(queue.stats().failed).toBe(0)
      expect(queue.stats().deadLetter).toBe(0)
    })

    it('moves job to dead-letter after max retries exhausted', async () => {
      queue = new InMemoryRunQueue({
        concurrency: 1,
        maxRetries: 2,
        retryBackoffMs: 20,
      })

      let attemptCount = 0
      queue.start(async () => {
        attemptCount++
        throw new Error(`fail-${attemptCount}`)
      })

      await queue.enqueue({ runId: 'r1', agentId: 'a', input: {}, priority: 1 })
      await waitForCondition(
        () => attemptCount === 3 && queue.stats().deadLetter === 1,
        { description: 'timed out waiting for dead-letter after retries' },
      )

      expect(attemptCount).toBe(3)
      expect(queue.stats().failed).toBe(1)
      expect(queue.stats().deadLetter).toBe(1)

      const deadLetter = queue.getDeadLetter()
      expect(deadLetter).toHaveLength(1)
      expect(deadLetter[0]!.job.runId).toBe('r1')
      expect(deadLetter[0]!.error).toBe('fail-3')
      expect(deadLetter[0]!.attempts).toBe(3)
      expect(deadLetter[0]!.failedAt).toBeInstanceOf(Date)
    })

    it('does not retry when maxRetries is 0 (default)', async () => {
      queue = new InMemoryRunQueue({ concurrency: 1 })

      let attemptCount = 0
      queue.start(async () => {
        attemptCount++
        throw new Error('always-fails')
      })

      await queue.enqueue({ runId: 'r1', agentId: 'a', input: {}, priority: 1 })
      await waitForCondition(
        () => attemptCount === 1 && queue.stats().failed === 1,
        { description: 'timed out waiting for single-attempt failure' },
      )

      expect(attemptCount).toBe(1)
      expect(queue.stats().failed).toBe(1)
      expect(queue.stats().deadLetter).toBe(1)
    })
  })

  describe('dead-letter tracking', () => {
    it('clearDeadLetter removes all entries', async () => {
      queue = new InMemoryRunQueue({ concurrency: 1, maxRetries: 0 })

      queue.start(async () => { throw new Error('boom') })

      await queue.enqueue({ runId: 'r1', agentId: 'a', input: {}, priority: 1 })
      await waitForCondition(
        () => queue.getDeadLetter().length === 1,
        { description: 'timed out waiting for dead-letter entry' },
      )

      expect(queue.getDeadLetter()).toHaveLength(1)
      expect(queue.stats().deadLetter).toBe(1)

      queue.clearDeadLetter()

      expect(queue.getDeadLetter()).toHaveLength(0)
      expect(queue.stats().deadLetter).toBe(0)
    })
  })

  describe('cancel', () => {
    it('cancels active jobs on stop', async () => {
      queue = new InMemoryRunQueue({ concurrency: 1 })

      let jobStarted = false
      queue.start(async () => {
        jobStarted = true
        await new Promise((resolve) => setTimeout(resolve, 10_000))
      })

      await queue.enqueue({ runId: 'r1', agentId: 'a', input: {}, priority: 1 })
      await waitForCondition(
        () => jobStarted && queue.stats().active === 1,
        { description: 'timed out waiting for active job start' },
      )

      expect(jobStarted).toBe(true)
      expect(queue.stats().active).toBe(1)

      await queue.stop(false)

      expect(queue.stats().active).toBe(0)
    })
  })
})
