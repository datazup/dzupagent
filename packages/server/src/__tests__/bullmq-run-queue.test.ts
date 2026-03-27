/**
 * Tests for BullMQRunQueue adapter.
 * Mocks bullmq to avoid Redis dependency in unit tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock bullmq module
const mockAdd = vi.fn(async () => ({ id: 'bull-job-1' }))
const mockGetJobCounts = vi.fn(async () => ({ waiting: 3, active: 1, completed: 10, failed: 2 }))
const mockGetJobs = vi.fn(async () => [])
const mockQueueClose = vi.fn(async () => {})
const mockQueueObliterate = vi.fn(async () => {})

const mockWorkerProcess = vi.fn()
const mockWorkerClose = vi.fn(async () => {})
const mockWorkerOn = vi.fn()

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: mockAdd,
    getJobCounts: mockGetJobCounts,
    getJobs: mockGetJobs,
    close: mockQueueClose,
    obliterate: mockQueueObliterate,
  })),
  Worker: vi.fn().mockImplementation((_name: string, processor: Function) => {
    mockWorkerProcess.mockImplementation(processor)
    return {
      close: mockWorkerClose,
      on: mockWorkerOn,
    }
  }),
}))

// Import after mocks
const { BullMQRunQueue } = await import('../queue/bullmq-run-queue.js')

describe('BullMQRunQueue', () => {
  let queue: InstanceType<typeof BullMQRunQueue>

  beforeEach(() => {
    vi.clearAllMocks()
    queue = new BullMQRunQueue({
      connection: { host: 'localhost', port: 6379 },
      concurrency: 5,
      jobTimeoutMs: 30_000,
      maxRetries: 2,
    })
  })

  describe('enqueue', () => {
    it('adds a job to the BullMQ queue with correct options', async () => {
      const job = await queue.enqueue({
        runId: 'run-1',
        agentId: 'agent-1',
        input: { message: 'hello' },
        priority: 1,
      })

      expect(mockAdd).toHaveBeenCalledOnce()
      const [name, , opts] = mockAdd.mock.calls[0]!
      expect(name).toBe('dzipagent-runs')
      expect(opts).toMatchObject({
        priority: 1,
        attempts: 3, // maxRetries(2) + 1
        backoff: { type: 'exponential', delay: 1000 },
      })
      expect(job.id).toBe('bull-job-1')
      expect(job.runId).toBe('run-1')
      expect(job.agentId).toBe('agent-1')
    })
  })

  describe('start', () => {
    it('creates a BullMQ worker with the processor', async () => {
      const processor = vi.fn(async () => {})
      queue.start(processor)
      // Wait for async worker creation
      await new Promise(r => setTimeout(r, 50))
      expect(mockWorkerOn).toHaveBeenCalledWith('completed', expect.any(Function))
      expect(mockWorkerOn).toHaveBeenCalledWith('failed', expect.any(Function))
    })
  })

  describe('stop', () => {
    it('closes the worker on stop', async () => {
      queue.start(vi.fn(async () => {}))
      // Wait for async worker creation to complete
      await vi.waitFor(() => {
        expect(mockWorkerOn).toHaveBeenCalled()
      }, { timeout: 500 })
      await queue.stop()
      expect(mockWorkerClose).toHaveBeenCalledOnce()
    })
  })

  describe('cancel', () => {
    it('returns false (BullMQ uses abort signal path)', () => {
      expect(queue.cancel('run-1')).toBe(false)
    })
  })

  describe('stats', () => {
    it('returns local stats', () => {
      const stats = queue.stats()
      expect(stats).toEqual({
        pending: 0,
        active: 0,
        completed: 0,
        failed: 0,
        deadLetter: 0,
      })
    })
  })

  describe('statsFromRedis', () => {
    it('returns accurate counts from Redis', async () => {
      // Enqueue first to initialize the queue
      await queue.enqueue({
        runId: 'run-1',
        agentId: 'agent-1',
        input: {},
        priority: 0,
      })

      const stats = await queue.statsFromRedis()
      expect(stats).toEqual({
        pending: 3,
        active: 1,
        completed: 10,
        failed: 2,
        deadLetter: 0,
      })
    })
  })

  describe('dead letter', () => {
    it('starts empty and can be cleared', () => {
      expect(queue.getDeadLetter()).toEqual([])
      queue.clearDeadLetter()
      expect(queue.getDeadLetter()).toEqual([])
    })
  })
})
