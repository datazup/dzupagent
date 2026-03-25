import { describe, it, expect } from 'vitest'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@forgeagent/core'
import { InMemoryRunQueue } from '../queue/run-queue.js'
import { startRunWorker } from '../runtime/run-worker.js'

async function waitForTerminalStatus(
  store: InMemoryRunStore,
  runId: string,
  timeoutMs = 3000,
): Promise<'completed' | 'failed' | 'rejected' | 'cancelled'> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const run = await store.get(runId)
    if (run?.status === 'completed' || run?.status === 'failed' || run?.status === 'rejected' || run?.status === 'cancelled') {
      return run.status
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for run ${runId} to reach terminal state`)
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

    let executorCalled = false

    // Block concurrency with a long-running job first
    const blocker = new Promise<void>((resolve) => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async ({ runId }) => {
          if (runId === 'block-run') {
            // Hold slot until we cancel the second job
            await new Promise((r) => setTimeout(r, 500))
            return { content: 'blocker done' }
          }
          executorCalled = true
          return { content: 'should not happen' }
        },
      })
    })

    // Create blocker run to fill concurrency
    const blockRun = await runStore.create({ agentId: 'a-cancel-q', input: {} })
    await runQueue.enqueue({
      runId: blockRun.id,
      agentId: 'a-cancel-q',
      input: {},
      priority: 1,
    })

    // Enqueue the run we'll cancel
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

    // The cancelled job should never reach the executor
    await new Promise((r) => setTimeout(r, 700))
    expect(executorCalled).toBe(false)

    await runQueue.stop(false)
  })

  it('cancels a running job and sets cancelled status', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 2 })
    const modelRegistry = new ModelRegistry()

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

    await runQueue.stop(false)
  })

  it('marks required-approval run as rejected when approval is denied', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

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

    await runQueue.stop(false)
  })
})
