import { describe, it, expect } from 'vitest'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import { currentForgeContext } from '@dzupagent/otel'
import { waitForCondition } from '@dzupagent/test-utils'
import { InMemoryRunQueue } from '../queue/run-queue.js'
import { startRunWorker } from '../runtime/run-worker.js'
import { InMemoryRunTraceStore } from '../persistence/run-trace-store.js'

async function waitForTerminalStatus(
  store: InMemoryRunStore,
  runId: string,
  timeoutMs = 3000,
): Promise<'completed' | 'failed' | 'rejected' | 'cancelled'> {
  let terminalStatus: 'completed' | 'failed' | 'rejected' | 'cancelled' | undefined
  await waitForCondition(
    async () => {
      const run = await store.get(runId)
      if (run?.status === 'completed' || run?.status === 'failed' || run?.status === 'rejected' || run?.status === 'cancelled') {
        terminalStatus = run.status
        return true
      }
      return false
    },
    {
      timeoutMs,
      intervalMs: 25,
      description: `Timed out waiting for run ${runId} to reach terminal state`,
    },
  )
  return terminalStatus!
}

describe('run-worker', () => {
  it('processes queued jobs and completes runs', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'a1',
      name: 'Agent One',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    const seenEvents: string[] = []

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async ({ input }) => {
        const payload = input as { message?: string }
        return { content: `ok:${payload.message ?? ''}` }
      },
    })

    const run = await runStore.create({ agentId: 'a1', input: { message: 'hello' } })
    const unsub = eventBus.onAny((event) => {
      if ('runId' in event && event.runId === run.id) {
        seenEvents.push(event.type)
      }
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a1',
      input: { message: 'hello' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('completed')
    const completed = await runStore.get(run.id)
    expect(completed?.output).toEqual({ content: 'ok:hello' })
    expect(seenEvents).toContain('agent:started')
    expect(seenEvents).toContain('agent:completed')

    unsub()
    await runQueue.stop(false)
  })

  it('marks run as failed when executor throws', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()
    const traceStore = new InMemoryRunTraceStore()

    await agentStore.save({
      id: 'a2',
      name: 'Agent Two',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      traceStore,
      runExecutor: async () => {
        throw new Error('boom')
      },
    })

    const run = await runStore.create({ agentId: 'a2', input: { message: 'fail' } })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a2',
      input: { message: 'fail' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('failed')
    const failed = await runStore.get(run.id)
    expect(failed?.error).toContain('boom')
    const trace = traceStore.getTrace(run.id)
    expect(trace?.completedAt).toBeGreaterThan(0)
    expect(trace?.steps.some(step => step.type === 'system' && (step.content as { status?: string }).status === 'failed')).toBe(true)

    await runQueue.stop(false)
  })

  it('waits for approval when agent requires it and then executes', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'a3',
      name: 'Agent Three',
      instructions: 'test',
      modelTier: 'chat',
      approval: 'required',
      active: true,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async ({ input }) => {
        const payload = input as { message?: string }
        return { content: `approved:${payload.message ?? ''}` }
      },
    })

    const run = await runStore.create({
      agentId: 'a3',
      input: { message: 'hello' },
      metadata: { approvalTimeoutMs: 2000 },
    })

    // Approve shortly after request
    setTimeout(() => {
      eventBus.emit({ type: 'approval:granted', runId: run.id })
    }, 50)

    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a3',
      input: { message: 'hello' },
      metadata: { approvalTimeoutMs: 2000 },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id, 4000)
    expect(status).toBe('completed')

    const completed = await runStore.get(run.id)
    expect(completed?.output).toEqual({ content: 'approved:hello' })

    await runQueue.stop(false)
  })

  it('cancels a queued run before execution starts', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'a-cancel-q',
      name: 'Cancel Queue Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    let executorCallCount = 0
    let releaseBlocker: () => void

    const blockerHeld = new Promise<void>((resolve) => {
      releaseBlocker = resolve
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => {
        executorCallCount++
        // First call holds the concurrency slot until released
        if (executorCallCount === 1) {
          await blockerHeld
        }
        return { content: 'done' }
      },
    })

    // Create blocker run to fill the single concurrency slot
    const blockRun = await runStore.create({ agentId: 'a-cancel-q', input: {} })
    await runQueue.enqueue({
      runId: blockRun.id,
      agentId: 'a-cancel-q',
      input: {},
      priority: 1,
    })

    // Wait for blocker to start executing (fills slot)
    await new Promise((r) => setTimeout(r, 100))
    expect(executorCallCount).toBe(1)

    // Enqueue the run we'll cancel — it stays pending since slot is full
    const cancelRun = await runStore.create({ agentId: 'a-cancel-q', input: {} })
    await runQueue.enqueue({
      runId: cancelRun.id,
      agentId: 'a-cancel-q',
      input: {},
      priority: 5,
    })

    // Cancel while still pending in queue
    const cancelled = runQueue.cancel(cancelRun.id)
    expect(cancelled).toBe(true)

    // Release blocker and let queue drain
    releaseBlocker!()
    await new Promise((r) => setTimeout(r, 200))

    // Only the blocker should have called the executor
    expect(executorCallCount).toBe(1)

    await runQueue.stop(false)
  })

  it('cancels a running job and sets cancelled status', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 2 })
    const modelRegistry = new ModelRegistry()
    const traceStore = new InMemoryRunTraceStore()

    await agentStore.save({
      id: 'a-cancel-run',
      name: 'Cancel Running Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      traceStore,
      runExecutor: async ({ signal }) => {
        // Simulate long-running work that respects cancellation
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ content: 'done' }), 5000)
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new DOMException('Run cancelled', 'AbortError'))
          })
        })
      },
    })

    const run = await runStore.create({ agentId: 'a-cancel-run', input: { message: 'cancel-me' } })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a-cancel-run',
      input: { message: 'cancel-me' },
      priority: 1,
    })

    // Wait for it to start running
    await new Promise((r) => setTimeout(r, 100))

    // Cancel while running
    const cancelled = runQueue.cancel(run.id)
    expect(cancelled).toBe(true)

    // Wait for worker to process the cancellation
    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('cancelled')
    const updated = await runStore.get(run.id)
    expect(updated?.error).toContain('Cancelled')
    const trace = traceStore.getTrace(run.id)
    expect(trace?.completedAt).toBeGreaterThan(0)
    expect(trace?.steps.some(step => step.type === 'system' && (step.content as { status?: string }).status === 'cancelled')).toBe(true)

    await runQueue.stop(false)
  })

  it('marks required-approval run as rejected when approval is denied', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()
    const traceStore = new InMemoryRunTraceStore()

    await agentStore.save({
      id: 'a4',
      name: 'Agent Four',
      instructions: 'test',
      modelTier: 'chat',
      approval: 'required',
      active: true,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      traceStore,
      runExecutor: async () => ({ content: 'should-not-run' }),
    })

    const run = await runStore.create({
      agentId: 'a4',
      input: { message: 'reject-me' },
      metadata: { approvalTimeoutMs: 2000 },
    })

    setTimeout(() => {
      eventBus.emit({ type: 'approval:rejected', runId: run.id, reason: 'not safe' })
    }, 50)

    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a4',
      input: { message: 'reject-me' },
      metadata: { approvalTimeoutMs: 2000 },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id, 4000)
    expect(status).toBe('rejected')

    const rejected = await runStore.get(run.id)
    expect(rejected?.error).toContain('not safe')
    expect(rejected?.output).toBeUndefined()
    const trace = traceStore.getTrace(run.id)
    expect(trace?.completedAt).toBeGreaterThan(0)
    expect(trace?.steps.some(step => step.type === 'system' && (step.content as { status?: string }).status === 'rejected')).toBe(true)

    await runQueue.stop(false)
  })

  it('propagates forge trace context into run executor', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'a-trace',
      name: 'Trace Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => {
        const ctx = currentForgeContext()
        return {
          traceId: ctx?.traceId,
          spanId: ctx?.spanId,
          runId: ctx?.runId,
          agentId: ctx?.agentId,
        }
      },
    })

    const run = await runStore.create({
      agentId: 'a-trace',
      input: { message: 'trace' },
      metadata: {
        _trace: { traceparent: '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01' },
      },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a-trace',
      input: { message: 'trace' },
      metadata: {
        _trace: { traceparent: '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01' },
      },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id, 4000)
    expect(status).toBe('completed')
    const completed = await runStore.get(run.id)
    expect(completed?.output).toEqual({
      traceId: '1234567890abcdef1234567890abcdef',
      spanId: '1234567890abcdef',
      runId: run.id,
      agentId: 'a-trace',
    })

    await runQueue.stop(false)
  })
})
