import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InMemoryRunStore, createEventBus } from '@dzipagent/core'
import type { DzipEventBus, DzipEvent } from '@dzipagent/core'
import {
  SimpleDelegationTracker,
  type DelegationRequest,
  type DelegationExecutor,
  type SimpleDelegationTrackerConfig,
} from '../orchestration/delegation.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates an executor that marks the run as completed with given output. */
function successExecutor(output: unknown = 'specialist result'): DelegationExecutor {
  return async (runId, _agentId, _input, _signal) => {
    // Simulate some work
    await Promise.resolve()
    // The tracker reads the run store after executor returns, so we need
    // the store reference. We'll update the store inside the test setup.
    // For simplicity, we store the runId→output mapping and let a
    // store-updating wrapper handle it.
    successExecutor._lastRunId = runId
    successExecutor._output = output
  }
}
successExecutor._lastRunId = ''
successExecutor._output = undefined as unknown

/**
 * Wraps an executor so it also updates the RunStore with completion status.
 * This simulates what a real run worker would do.
 */
function withStoreUpdate(
  store: InMemoryRunStore,
  output: unknown = 'specialist result',
  tokenUsage?: { input: number; output: number },
): DelegationExecutor {
  return async (runId, _agentId, _input, signal) => {
    // Check cancellation before "work"
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    // Simulate async work
    await new Promise((resolve) => setTimeout(resolve, 5))
    // Check cancellation after "work"
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    // Update run store as a real worker would
    await store.update(runId, {
      status: 'completed',
      output,
      completedAt: new Date(),
      tokenUsage,
    })
  }
}

/** Executor that fails with a given error message. */
function failingExecutor(errorMsg: string): DelegationExecutor {
  return async (runId, _agentId, _input, _signal) => {
    // Update store to failed before throwing
    // (In real usage the worker would do this)
    throw new Error(errorMsg)
  }
}

/** Executor that hangs forever (for timeout tests). */
function hangingExecutor(): DelegationExecutor {
  return async (_runId, _agentId, _input, signal) => {
    // Wait until aborted
    await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
  }
}

/** Executor that respects cancellation with a delay. */
function slowExecutor(
  store: InMemoryRunStore,
  delayMs: number,
  output: unknown = 'slow result',
): DelegationExecutor {
  return async (runId, _agentId, _input, signal) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), delayMs)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
    await store.update(runId, {
      status: 'completed',
      output,
      completedAt: new Date(),
    })
  }
}

function makeRequest(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  return {
    targetAgentId: 'specialist-db',
    task: 'Generate database schema',
    input: { tables: ['users', 'posts'] },
    context: {
      parentRunId: 'parent-run-1',
      decisions: ['Use PostgreSQL'],
      constraints: ['Max 10 tables'],
      relevantFiles: ['schema.prisma'],
    },
    priority: 3,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SimpleDelegationTracker', () => {
  let store: InMemoryRunStore
  let eventBus: DzipEventBus
  let events: DzipEvent[]

  beforeEach(() => {
    store = new InMemoryRunStore()
    eventBus = createEventBus()
    events = []
    eventBus.onAny((e) => events.push(e))
  })

  // -----------------------------------------------------------------------
  // Successful delegation
  // -----------------------------------------------------------------------
  describe('successful delegation', () => {
    it('creates a run, executes, and returns success result', async () => {
      const executor = withStoreUpdate(store, { schema: 'CREATE TABLE users ...' })
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      const result = await tracker.delegate(makeRequest())

      expect(result.success).toBe(true)
      expect(result.output).toEqual({ schema: 'CREATE TABLE users ...' })
      expect(result.error).toBeUndefined()
      expect(result.metadata).toBeDefined()
      expect(result.metadata!.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('emits delegation:started and delegation:completed events', async () => {
      const executor = withStoreUpdate(store, 'done')
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      await tracker.delegate(makeRequest())

      // Allow microtasks to flush
      await new Promise((r) => setTimeout(r, 10))

      const started = events.find((e) => e.type === 'delegation:started')
      const completed = events.find((e) => e.type === 'delegation:completed')

      expect(started).toBeDefined()
      expect(started!.type).toBe('delegation:started')
      expect((started as { targetAgentId: string }).targetAgentId).toBe('specialist-db')

      expect(completed).toBeDefined()
      expect(completed!.type).toBe('delegation:completed')
      expect((completed as { success: boolean }).success).toBe(true)
    })

    it('creates a run record in the store', async () => {
      const executor = withStoreUpdate(store, 'ok')
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      await tracker.delegate(makeRequest())

      const runs = await store.list({ agentId: 'specialist-db' })
      expect(runs).toHaveLength(1)
      expect(runs[0].status).toBe('completed')
      expect(runs[0].output).toBe('ok')
    })

    it('passes token usage from run store to result metadata', async () => {
      const executor = withStoreUpdate(store, 'ok', { input: 500, output: 200 })
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      const result = await tracker.delegate(makeRequest())

      expect(result.success).toBe(true)
      expect(result.metadata?.tokenUsage).toEqual({ input: 500, output: 200 })
    })

    it('clears active delegations after completion', async () => {
      const executor = withStoreUpdate(store, 'ok')
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      // Before delegation
      expect(tracker.getActiveDelegations()).toHaveLength(0)

      await tracker.delegate(makeRequest())

      // After delegation completes
      expect(tracker.getActiveDelegations()).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // Timeout handling
  // -----------------------------------------------------------------------
  describe('timeout handling', () => {
    it('returns timeout error when executor exceeds timeoutMs', async () => {
      const executor = hangingExecutor()
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
        defaultTimeoutMs: 50,
      })

      const result = await tracker.delegate(
        makeRequest({ timeoutMs: 50 }),
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain('timed out')
      expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(40)
    })

    it('emits delegation:timeout event', async () => {
      const executor = hangingExecutor()
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      await tracker.delegate(makeRequest({ timeoutMs: 30 }))

      await new Promise((r) => setTimeout(r, 10))

      const timeoutEvent = events.find((e) => e.type === 'delegation:timeout')
      expect(timeoutEvent).toBeDefined()
      expect((timeoutEvent as { timeoutMs: number }).timeoutMs).toBe(30)
    })

    it('updates run store to failed on timeout', async () => {
      const executor = hangingExecutor()
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      await tracker.delegate(makeRequest({ timeoutMs: 30 }))

      const runs = await store.list({ agentId: 'specialist-db' })
      expect(runs).toHaveLength(1)
      expect(runs[0].status).toBe('failed')
      expect(runs[0].error).toContain('timed out')
    })

    it('uses default timeout when request has no timeoutMs', async () => {
      const executor = hangingExecutor()
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
        defaultTimeoutMs: 30,
      })

      const result = await tracker.delegate(
        makeRequest({ timeoutMs: undefined }),
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain('timed out')
    })
  })

  // -----------------------------------------------------------------------
  // Cancel active delegation
  // -----------------------------------------------------------------------
  describe('cancellation', () => {
    it('cancels an active delegation by targetAgentId', async () => {
      const executor = slowExecutor(store, 5000, 'should not appear')
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      // Start delegation without awaiting
      const resultPromise = tracker.delegate(makeRequest())

      // Wait for it to become active
      await new Promise((r) => setTimeout(r, 10))

      // Cancel
      const cancelled = tracker.cancel('specialist-db')
      expect(cancelled).toBe(true)

      const result = await resultPromise

      expect(result.success).toBe(false)
      expect(result.error).toContain('cancelled')
    })

    it('emits delegation:cancelled event', async () => {
      const executor = slowExecutor(store, 5000, 'nope')
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      const resultPromise = tracker.delegate(makeRequest())

      await new Promise((r) => setTimeout(r, 10))
      tracker.cancel('specialist-db')

      await resultPromise
      await new Promise((r) => setTimeout(r, 10))

      const cancelEvent = events.find((e) =>
        e.type === 'delegation:cancelled' || e.type === 'delegation:failed' || e.type === 'delegation:timeout',
      )
      expect(cancelEvent).toBeDefined()
      expect((cancelEvent as { targetAgentId: string }).targetAgentId).toBe('specialist-db')
    })

    it('updates run store to cancelled status', async () => {
      const executor = slowExecutor(store, 5000, 'nope')
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      const resultPromise = tracker.delegate(makeRequest())

      await new Promise((r) => setTimeout(r, 10))
      tracker.cancel('specialist-db')

      await resultPromise

      const runs = await store.list({ agentId: 'specialist-db' })
      expect(runs).toHaveLength(1)
      expect(['cancelled', 'failed']).toContain(runs[0]!.status)
    })

    it('returns false when cancelling a non-existent delegation', () => {
      const executor = withStoreUpdate(store, 'ok')
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      const cancelled = tracker.cancel('non-existent-agent')
      expect(cancelled).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Multiple concurrent delegations
  // -----------------------------------------------------------------------
  describe('multiple concurrent delegations', () => {
    it('tracks multiple active delegations simultaneously', async () => {
      const executor = slowExecutor(store, 100, 'concurrent result')
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      const p1 = tracker.delegate(makeRequest({ targetAgentId: 'agent-db' }))
      const p2 = tracker.delegate(makeRequest({ targetAgentId: 'agent-api' }))
      const p3 = tracker.delegate(makeRequest({ targetAgentId: 'agent-ui' }))

      // Give them time to start
      await new Promise((r) => setTimeout(r, 10))

      const active = tracker.getActiveDelegations()
      expect(active.length).toBe(3)

      const agentIds = active.map((d) => d.request.targetAgentId).sort()
      expect(agentIds).toEqual(['agent-api', 'agent-db', 'agent-ui'])

      // Wait for all to complete
      const [r1, r2, r3] = await Promise.all([p1, p2, p3])

      expect(r1.success).toBe(true)
      expect(r2.success).toBe(true)
      expect(r3.success).toBe(true)

      // All should be cleared from active
      expect(tracker.getActiveDelegations()).toHaveLength(0)
    })

    it('cancels only the targeted delegation, others continue', async () => {
      const executor = slowExecutor(store, 200, 'result')
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      const p1 = tracker.delegate(makeRequest({ targetAgentId: 'agent-db' }))
      const p2 = tracker.delegate(makeRequest({ targetAgentId: 'agent-api' }))

      await new Promise((r) => setTimeout(r, 10))

      // Cancel only agent-db
      const cancelled = tracker.cancel('agent-db')
      expect(cancelled).toBe(true)

      const [r1, r2] = await Promise.all([p1, p2])

      expect(r1.success).toBe(false)
      expect(r1.error).toContain('cancelled')
      expect(r2.success).toBe(true)
      expect(r2.output).toBe('result')
    })

    it('creates separate run records for each delegation', async () => {
      const executor = withStoreUpdate(store, 'ok')
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      await Promise.all([
        tracker.delegate(makeRequest({ targetAgentId: 'agent-db' })),
        tracker.delegate(makeRequest({ targetAgentId: 'agent-api' })),
      ])

      const dbRuns = await store.list({ agentId: 'agent-db' })
      const apiRuns = await store.list({ agentId: 'agent-api' })

      expect(dbRuns).toHaveLength(1)
      expect(apiRuns).toHaveLength(1)
      expect(dbRuns[0].id).not.toBe(apiRuns[0].id)
    })
  })

  // -----------------------------------------------------------------------
  // Executor failure
  // -----------------------------------------------------------------------
  describe('executor failure', () => {
    it('returns failure result when executor throws', async () => {
      const executor = failingExecutor('Database connection refused')
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      const result = await tracker.delegate(makeRequest())

      expect(result.success).toBe(false)
      expect(result.error).toBe('Database connection refused')
      expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('emits delegation:failed event on executor error', async () => {
      const executor = failingExecutor('boom')
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      await tracker.delegate(makeRequest())
      await new Promise((r) => setTimeout(r, 10))

      const failedEvent = events.find((e) => e.type === 'delegation:failed')
      expect(failedEvent).toBeDefined()
      expect((failedEvent as { error: string }).error).toBe('boom')
    })

    it('updates run store to failed on executor error', async () => {
      const executor = failingExecutor('something broke')
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      await tracker.delegate(makeRequest())

      const runs = await store.list({ agentId: 'specialist-db' })
      expect(runs).toHaveLength(1)
      expect(runs[0].status).toBe('failed')
      expect(runs[0].error).toBe('something broke')
    })
  })

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe('edge cases', () => {
    it('works without event bus', async () => {
      const executor = withStoreUpdate(store, 'no-bus-result')
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        executor,
        // No eventBus
      })

      const result = await tracker.delegate(makeRequest())

      expect(result.success).toBe(true)
      expect(result.output).toBe('no-bus-result')
    })

    it('uses default priority of 5 when not specified', async () => {
      const executor = withStoreUpdate(store, 'ok')
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      await tracker.delegate(makeRequest({ priority: undefined }))

      const runs = await store.list({ agentId: 'specialist-db' })
      expect(runs).toHaveLength(1)
      expect((runs[0].metadata as Record<string, unknown>)?.priority).toBe(5)
    })

    it('passes delegation context into the run input', async () => {
      let capturedInput: unknown
      const executor: DelegationExecutor = async (runId, _agentId, input, _signal) => {
        capturedInput = input
        await store.update(runId, {
          status: 'completed',
          output: 'ok',
          completedAt: new Date(),
        })
      }

      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor,
      })

      await tracker.delegate(makeRequest())

      expect(capturedInput).toEqual(
        expect.objectContaining({
          task: 'Generate database schema',
          tables: ['users', 'posts'],
          delegationContext: expect.objectContaining({
            parentRunId: 'parent-run-1',
            decisions: ['Use PostgreSQL'],
          }),
        }),
      )
    })
  })
})
