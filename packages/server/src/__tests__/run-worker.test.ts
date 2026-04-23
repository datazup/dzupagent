import { describe, it, expect, vi } from 'vitest'
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
import type {
  RunReflectorLike,
  ReflectionScore,
  ReflectionInput,
  EscalationPolicyLike,
  EscalationResultLike,
} from '../runtime/run-worker.js'
import { InMemoryRunTraceStore } from '../persistence/run-trace-store.js'
import { InMemoryReflectionStore } from '@dzupagent/agent'
import type { RunReflectionStore, ReflectionSummary } from '@dzupagent/agent'
import type { ExecutableAgentResolver } from '../services/executable-agent-resolver.js'

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
  it('resolves queued jobs through executableAgentResolver when provided', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()
    const resolve = vi.fn<ExecutableAgentResolver['resolve']>().mockResolvedValue({
      id: 'resolved-a1',
      name: 'Resolved Agent',
      instructions: 'resolver-backed',
      modelTier: 'chat',
      active: true,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      executableAgentResolver: { resolve },
      eventBus,
      modelRegistry,
      runExecutor: async ({ input }) => {
        const payload = input as { message?: string }
        return { content: `ok:${payload.message ?? ''}` }
      },
    })

    const run = await runStore.create({ agentId: 'resolved-a1', input: { message: 'hello' } })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'resolved-a1',
      input: { message: 'hello' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('completed')
    expect(resolve).toHaveBeenCalledWith('resolved-a1')

    await runQueue.stop(false)
  })

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
    const trace = await traceStore.getTrace(run.id)
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
    const trace = await traceStore.getTrace(run.id)
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
    const trace = await traceStore.getTrace(run.id)
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

// ---------------------------------------------------------------------------
// Reflection store wiring tests
// ---------------------------------------------------------------------------

function createStubReflector(overrides?: Partial<ReflectionScore>): RunReflectorLike {
  return {
    score: () => ({
      overall: 0.85,
      dimensions: {
        completeness: 0.9,
        coherence: 0.8,
        toolSuccess: 0.85,
        conciseness: 0.8,
        reliability: 0.9,
      },
      flags: [],
      ...overrides,
    }),
  }
}

describe('run-worker — reflectionStore wiring', () => {
  it('calls reflectionStore.save() with correct summary after run completion', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()
    const reflectionStore = new InMemoryReflectionStore()
    const reflector = createStubReflector()

    await agentStore.save({
      id: 'a-refl',
      name: 'Reflection Agent',
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
      reflector,
      reflectionStore,
      runExecutor: async () => ({ content: 'done' }),
    })

    const run = await runStore.create({ agentId: 'a-refl', input: { message: 'hello' } })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a-refl',
      input: { message: 'hello' },
      priority: 1,
    })

    await waitForCondition(
      async () => {
        const r = await runStore.get(run.id)
        return r?.status === 'completed'
      },
      { timeoutMs: 3000, intervalMs: 25 },
    )

    const saved = await reflectionStore.get(run.id)
    expect(saved).toBeDefined()
    expect(saved!.runId).toBe(run.id)
    expect(saved!.qualityScore).toBe(0.85)
    expect(saved!.completedAt).toBeInstanceOf(Date)
    expect(saved!.durationMs).toBeGreaterThanOrEqual(0)
    expect(saved!.patterns).toEqual([])

    await runQueue.stop(false)
  })

  it('does not call reflectionStore when reflector is not configured', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()
    const saveSpy = vi.fn()
    const reflectionStore: RunReflectionStore = {
      save: saveSpy,
      get: async () => undefined,
      list: async () => [],
      getPatterns: async () => [],
    }

    await agentStore.save({
      id: 'a-no-refl',
      name: 'No Reflector Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    // No reflector provided, only reflectionStore
    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      reflectionStore,
      runExecutor: async () => ({ content: 'done' }),
    })

    const run = await runStore.create({ agentId: 'a-no-refl', input: { message: 'hello' } })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a-no-refl',
      input: { message: 'hello' },
      priority: 1,
    })

    await waitForCondition(
      async () => {
        const r = await runStore.get(run.id)
        return r?.status === 'completed'
      },
      { timeoutMs: 3000, intervalMs: 25 },
    )

    // reflectionStore.save should NOT have been called because there's no reflector
    expect(saveSpy).not.toHaveBeenCalled()

    await runQueue.stop(false)
  })

  it('does not call reflectionStore when reflectionStore is undefined', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()
    const reflector = createStubReflector()

    await agentStore.save({
      id: 'a-no-store',
      name: 'No Store Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    // No reflectionStore provided — run should complete without error
    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      reflector,
      runExecutor: async () => ({ content: 'done' }),
    })

    const run = await runStore.create({ agentId: 'a-no-store', input: { message: 'hello' } })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a-no-store',
      input: { message: 'hello' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('completed')

    await runQueue.stop(false)
  })

  it('reflectionStore failure is non-fatal — run still completes', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()
    const reflector = createStubReflector()

    const failingStore: RunReflectionStore = {
      save: async () => { throw new Error('DB connection lost') },
      get: async () => undefined,
      list: async () => [],
      getPatterns: async () => [],
    }

    await agentStore.save({
      id: 'a-fail-store',
      name: 'Failing Store Agent',
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
      reflector,
      reflectionStore: failingStore,
      runExecutor: async () => ({ content: 'done' }),
    })

    const run = await runStore.create({ agentId: 'a-fail-store', input: { message: 'hello' } })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a-fail-store',
      input: { message: 'hello' },
      priority: 1,
    })

    // The run should still complete despite reflectionStore.save() throwing
    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('completed')

    // Check that a warning log was created
    const logs = await runStore.getLogs(run.id)
    const warnLog = logs.find(
      (l) => l.phase === 'reflection' && l.message.includes('Failed to persist reflection summary'),
    )
    expect(warnLog).toBeDefined()
    expect(warnLog!.level).toBe('warn')

    await runQueue.stop(false)
  })

  it('reflectionStore receives correct toolCallCount and errorCount', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()
    const reflectionStore = new InMemoryReflectionStore()
    const reflector = createStubReflector()

    await agentStore.save({
      id: 'a-counts',
      name: 'Counts Agent',
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
      reflector,
      reflectionStore,
      runExecutor: async () => ({
        output: { message: 'done' },
        logs: [
          { level: 'info' as const, phase: 'tool_call', message: 'Tool called: search', data: { toolName: 'search', success: true } },
          { level: 'info' as const, phase: 'tool_call', message: 'Tool called: read', data: { toolName: 'read', success: true } },
          { level: 'error' as const, phase: 'agent', message: 'Something failed' },
        ],
      }),
    })

    const run = await runStore.create({ agentId: 'a-counts', input: { message: 'hello' } })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a-counts',
      input: { message: 'hello' },
      priority: 1,
    })

    await waitForCondition(
      async () => {
        const r = await runStore.get(run.id)
        return r?.status === 'completed'
      },
      { timeoutMs: 3000, intervalMs: 25 },
    )

    const saved = await reflectionStore.get(run.id)
    expect(saved).toBeDefined()
    expect(saved!.toolCallCount).toBe(2)
    expect(saved!.errorCount).toBe(1)
    expect(saved!.totalSteps).toBe(3)

    await runQueue.stop(false)
  })

  it('reflectionStore.save() is not called when run fails', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()
    const reflector = createStubReflector()
    const saveSpy = vi.fn()
    const reflectionStore: RunReflectionStore = {
      save: saveSpy,
      get: async () => undefined,
      list: async () => [],
      getPatterns: async () => [],
    }

    await agentStore.save({
      id: 'a-fail-exec',
      name: 'Failing Executor Agent',
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
      reflector,
      reflectionStore,
      runExecutor: async () => {
        throw new Error('executor boom')
      },
    })

    const run = await runStore.create({ agentId: 'a-fail-exec', input: { message: 'fail' } })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a-fail-exec',
      input: { message: 'fail' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('failed')

    // reflectionStore.save should NOT be called for failed runs
    expect(saveSpy).not.toHaveBeenCalled()

    await runQueue.stop(false)
  })

  it('reflectionStore receives qualityScore matching reflector.score().overall', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()
    const reflectionStore = new InMemoryReflectionStore()
    const reflector = createStubReflector({ overall: 0.42 })

    await agentStore.save({
      id: 'a-score',
      name: 'Score Agent',
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
      reflector,
      reflectionStore,
      runExecutor: async () => ({ content: 'done' }),
    })

    const run = await runStore.create({ agentId: 'a-score', input: { message: 'hello' } })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a-score',
      input: { message: 'hello' },
      priority: 1,
    })

    await waitForCondition(
      async () => {
        const r = await runStore.get(run.id)
        return r?.status === 'completed'
      },
      { timeoutMs: 3000, intervalMs: 25 },
    )

    const saved = await reflectionStore.get(run.id)
    expect(saved).toBeDefined()
    expect(saved!.qualityScore).toBe(0.42)

    await runQueue.stop(false)
  })

  it('reflectionStore is called after reflector scores even when escalation is configured', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()
    const reflectionStore = new InMemoryReflectionStore()
    const reflector = createStubReflector()

    await agentStore.save({
      id: 'a-esc-refl',
      name: 'Escalation Reflection Agent',
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
      reflector,
      reflectionStore,
      escalationPolicy: {
        recordScore: () => ({
          shouldEscalate: false,
          fromTier: 'chat',
          toTier: 'chat',
          reason: 'scores okay',
          consecutiveLowScores: 0,
        }),
      },
      runExecutor: async () => ({ content: 'done' }),
    })

    const run = await runStore.create({ agentId: 'a-esc-refl', input: { message: 'hello' } })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a-esc-refl',
      input: { message: 'hello' },
      priority: 1,
    })

    await waitForCondition(
      async () => {
        const r = await runStore.get(run.id)
        return r?.status === 'completed'
      },
      { timeoutMs: 3000, intervalMs: 25 },
    )

    const saved = await reflectionStore.get(run.id)
    expect(saved).toBeDefined()
    expect(saved!.runId).toBe(run.id)

    await runQueue.stop(false)
  })
})

// ---------------------------------------------------------------------------
// Escalation policy edge case tests
// ---------------------------------------------------------------------------

/** Creates a reflector that returns a fixed overall score. */
function createFixedScoreReflector(overall: number): RunReflectorLike {
  return {
    score(_input: ReflectionInput): ReflectionScore {
      return {
        overall,
        dimensions: {
          completeness: overall,
          coherence: overall,
          toolSuccess: overall,
          conciseness: overall,
          reliability: overall,
        },
        flags: overall < 0.5 ? ['low_quality'] : [],
      }
    },
  }
}

/** Creates a mock escalation policy that returns a fixed result. */
function createMockPolicy(
  result: EscalationResultLike,
): EscalationPolicyLike & { calls: Array<{ key: string; score: number; currentTier: string }> } {
  const calls: Array<{ key: string; score: number; currentTier: string }> = []
  return {
    calls,
    recordScore(key: string, score: number, currentTier: string): EscalationResultLike {
      calls.push({ key, score, currentTier })
      return result
    },
  }
}

describe('run-worker — escalation policy edge cases', () => {
  // -----------------------------------------------------------------------
  // 1. Escalation when agentStore has no save method
  // -----------------------------------------------------------------------
  it('skips escalation save when agentStore lacks save()', async () => {
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    const agentStoreNoSave = {
      async get(id: string) {
        if (id === 'no-save-agent') {
          return {
            id: 'no-save-agent',
            name: 'No Save Agent',
            instructions: 'test',
            modelTier: 'chat' as const,
            active: true,
            metadata: {},
          }
        }
        return null
      },
      // Deliberately no save() method
    }

    const policy = createMockPolicy({
      shouldEscalate: true,
      fromTier: 'chat',
      toTier: 'reasoning',
      reason: 'low scores',
      consecutiveLowScores: 3,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore: agentStoreNoSave,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.2),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'no-save-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'no-save-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('completed')

    // Policy was called but escalation save was skipped
    expect(policy.calls).toHaveLength(1)
    // No escalation log because the code checks `escalation.shouldEscalate && options.agentStore.save`
    const logs = await runStore.getLogs(run.id)
    const escalationLog = logs.find((l) => l.phase === 'escalation')
    expect(escalationLog).toBeUndefined()

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 2. Escalation when agentStore.get returns null during save phase
  // -----------------------------------------------------------------------
  it('handles agentStore.get returning null during escalation gracefully', async () => {
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    let getCallCount = 0
    const agentStoreNullOnSecond = {
      async get(id: string) {
        getCallCount++
        // First call (for run setup) returns agent, second call (during escalation) returns null
        if (id === 'vanish-agent' && getCallCount <= 1) {
          return {
            id: 'vanish-agent',
            name: 'Vanish Agent',
            instructions: 'test',
            modelTier: 'chat' as const,
            active: true,
            metadata: {},
          }
        }
        return null
      },
      async save(_agent: unknown) {
        // Should never be called because get() returns null
        throw new Error('save should not be called')
      },
    }

    const policy = createMockPolicy({
      shouldEscalate: true,
      fromTier: 'chat',
      toTier: 'codegen',
      reason: 'consecutive low',
      consecutiveLowScores: 3,
    })

    const seenEvents: Array<{ type: string }> = []
    eventBus.onAny((event) => seenEvents.push(event as { type: string }))

    startRunWorker({
      runQueue,
      runStore,
      agentStore: agentStoreNullOnSecond,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.2),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'vanish-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'vanish-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('completed')

    // registry:agent_updated is still emitted (the emit is outside the agentDef guard)
    const updateEvent = seenEvents.find((e) => e.type === 'registry:agent_updated')
    expect(updateEvent).toBeDefined()

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 3. Reflector throws — escalation and reflectionStore are both skipped
  // -----------------------------------------------------------------------
  it('skips escalation and reflectionStore when reflector.score() throws', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    const throwingReflector: RunReflectorLike = {
      score: () => { throw new Error('reflector crash') },
    }

    const policySpy = createMockPolicy({
      shouldEscalate: true,
      fromTier: 'chat',
      toTier: 'codegen',
      reason: 'should never fire',
      consecutiveLowScores: 5,
    })

    const reflectionSaveSpy = vi.fn()
    const reflectionStore: RunReflectionStore = {
      save: reflectionSaveSpy,
      get: async () => undefined,
      list: async () => [],
      getPatterns: async () => [],
    }

    await agentStore.save({
      id: 'refl-throw-agent',
      name: 'Reflector Throw Agent',
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
      runExecutor: async () => ({ content: 'done' }),
      reflector: throwingReflector,
      reflectionStore,
      escalationPolicy: policySpy,
    })

    const run = await runStore.create({
      agentId: 'refl-throw-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'refl-throw-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('completed')

    // Neither escalation nor reflection store should have been called
    expect(policySpy.calls).toHaveLength(0)
    expect(reflectionSaveSpy).not.toHaveBeenCalled()

    // Warning log about reflection failure should exist
    const logs = await runStore.getLogs(run.id)
    const warnLog = logs.find(
      (l) => l.phase === 'reflection' && l.message.includes('Failed to compute reflection score'),
    )
    expect(warnLog).toBeDefined()

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 4. escalationPolicy.recordScore() throws — run still completes
  // -----------------------------------------------------------------------
  it('completes run when escalationPolicy.recordScore() throws', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    const throwingPolicy: EscalationPolicyLike = {
      recordScore: () => { throw new Error('policy internal error') },
    }

    await agentStore.save({
      id: 'policy-throw-agent',
      name: 'Policy Throw Agent',
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
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.3),
      escalationPolicy: throwingPolicy,
    })

    const run = await runStore.create({
      agentId: 'policy-throw-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'policy-throw-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('completed')

    // Reflection score should still be in metadata
    const completed = await runStore.get(run.id)
    const meta = completed?.metadata as Record<string, unknown>
    expect(meta?.['reflectionScore']).toBeDefined()

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 5. Escalation preserves existing agent metadata fields
  // -----------------------------------------------------------------------
  it('preserves existing agent metadata when escalating modelTier', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'preserve-meta-agent',
      name: 'Preserve Meta Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
      metadata: { customField: 'keep-me', version: 42 },
    })

    const policy = createMockPolicy({
      shouldEscalate: true,
      fromTier: 'chat',
      toTier: 'reasoning',
      reason: 'consecutive low scores',
      consecutiveLowScores: 3,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.25),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'preserve-meta-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'preserve-meta-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('completed')

    const updated = await agentStore.get('preserve-meta-agent')
    expect(updated?.metadata?.['modelTier']).toBe('reasoning')
    expect(updated?.metadata?.['customField']).toBe('keep-me')
    expect(updated?.metadata?.['version']).toBe(42)

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 6. Escalation emits registry:agent_updated with fields array
  // -----------------------------------------------------------------------
  it('emits registry:agent_updated with metadata.modelTier in fields', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'emit-fields-agent',
      name: 'Emit Fields Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    const policy = createMockPolicy({
      shouldEscalate: true,
      fromTier: 'chat',
      toTier: 'codegen',
      reason: 'low scores',
      consecutiveLowScores: 3,
    })

    const seenEvents: Array<Record<string, unknown>> = []
    eventBus.onAny((event) => seenEvents.push(event as Record<string, unknown>))

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.2),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'emit-fields-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'emit-fields-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    await waitForTerminalStatus(runStore, run.id)

    const updateEvent = seenEvents.find((e) => e['type'] === 'registry:agent_updated')
    expect(updateEvent).toBeDefined()
    expect(updateEvent!['fields']).toEqual(['metadata.modelTier'])
    expect(updateEvent!['agentId']).toBe('emit-fields-agent')

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 7. Escalation log data contains correct consecutiveLowScores and key
  // -----------------------------------------------------------------------
  it('escalation log includes consecutiveLowScores and escalationKey', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'log-data-agent',
      name: 'Log Data Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
      metadata: { intent: 'summarize' },
    })

    const policy = createMockPolicy({
      shouldEscalate: true,
      fromTier: 'chat',
      toTier: 'reasoning',
      reason: '5 consecutive below threshold',
      consecutiveLowScores: 5,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.1),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'log-data-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat', intent: 'summarize' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'log-data-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat', intent: 'summarize' },
      priority: 1,
    })

    await waitForTerminalStatus(runStore, run.id)

    const logs = await runStore.getLogs(run.id)
    const escalationLog = logs.find((l) => l.phase === 'escalation' && l.level === 'info')
    expect(escalationLog).toBeDefined()
    const data = escalationLog!.data as Record<string, unknown>
    expect(data['consecutiveLowScores']).toBe(5)
    expect(data['escalationKey']).toBe('log-data-agent:summarize')
    expect(data['fromTier']).toBe('chat')
    expect(data['toTier']).toBe('reasoning')

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 8. agent:completed event fires after escalation
  // -----------------------------------------------------------------------
  it('emits agent:completed even after escalation occurs', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'complete-after-esc',
      name: 'Complete After Esc Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    const policy = createMockPolicy({
      shouldEscalate: true,
      fromTier: 'chat',
      toTier: 'codegen',
      reason: 'low',
      consecutiveLowScores: 3,
    })

    const seenEvents: string[] = []
    eventBus.onAny((event) => {
      const e = event as { type: string; runId?: string }
      seenEvents.push(e.type)
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.2),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'complete-after-esc',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'complete-after-esc',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    await waitForTerminalStatus(runStore, run.id)

    // Both escalation update and completion event should fire
    expect(seenEvents).toContain('registry:agent_updated')
    expect(seenEvents).toContain('agent:completed')

    // agent:completed should come after registry:agent_updated
    const escIdx = seenEvents.indexOf('registry:agent_updated')
    const compIdx = seenEvents.indexOf('agent:completed')
    expect(compIdx).toBeGreaterThan(escIdx)

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 9. Reflection score persisted in run metadata even when escalation happens
  // -----------------------------------------------------------------------
  it('persists reflection score in run metadata regardless of escalation', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'score-persist-agent',
      name: 'Score Persist Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    const policy = createMockPolicy({
      shouldEscalate: true,
      fromTier: 'chat',
      toTier: 'reasoning',
      reason: 'low',
      consecutiveLowScores: 3,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.35),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'score-persist-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'score-persist-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    await waitForTerminalStatus(runStore, run.id)

    const completed = await runStore.get(run.id)
    const meta = completed?.metadata as Record<string, unknown>
    const reflScore = meta?.['reflectionScore'] as Record<string, unknown>
    expect(reflScore).toBeDefined()
    expect(reflScore['overall']).toBeCloseTo(0.35)

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 10. Both reflectionStore failure and escalation failure — both non-fatal
  // -----------------------------------------------------------------------
  it('handles both reflectionStore and escalation failures without crashing', async () => {
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    const failingReflectionStore: RunReflectionStore = {
      save: async () => { throw new Error('reflection DB down') },
      get: async () => undefined,
      list: async () => [],
      getPatterns: async () => [],
    }

    const failingAgentStore = {
      async get(id: string) {
        if (id === 'double-fail-agent') {
          return {
            id: 'double-fail-agent',
            name: 'Double Fail Agent',
            instructions: 'test',
            modelTier: 'chat' as const,
            active: true,
            metadata: {},
          }
        }
        return null
      },
      async save(_agent: unknown) {
        throw new Error('agent DB down')
      },
    }

    const policy = createMockPolicy({
      shouldEscalate: true,
      fromTier: 'chat',
      toTier: 'codegen',
      reason: 'low scores',
      consecutiveLowScores: 3,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore: failingAgentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.2),
      reflectionStore: failingReflectionStore,
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'double-fail-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'double-fail-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('completed')

    const logs = await runStore.getLogs(run.id)
    // Should have both warning logs
    const reflWarn = logs.find(
      (l) => l.phase === 'reflection' && l.message.includes('Failed to persist reflection summary'),
    )
    const escWarn = logs.find(
      (l) => l.phase === 'escalation' && l.level === 'warn',
    )
    expect(reflWarn).toBeDefined()
    expect(escWarn).toBeDefined()

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 11. Escalation not triggered when reflector is absent even if policy exists
  // -----------------------------------------------------------------------
  it('does not invoke escalationPolicy when reflector is not configured', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'no-reflector-agent',
      name: 'No Reflector Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    const policy = createMockPolicy({
      shouldEscalate: true,
      fromTier: 'chat',
      toTier: 'codegen',
      reason: 'should never fire',
      consecutiveLowScores: 5,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      // No reflector — only escalationPolicy
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'no-reflector-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'no-reflector-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('completed')
    expect(policy.calls).toHaveLength(0)

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 12. Escalation with structured executor result including tool call logs
  // -----------------------------------------------------------------------
  it('passes tool call data from structured result to reflector before escalation', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'tool-esc-agent',
      name: 'Tool Escalation Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    let capturedInput: ReflectionInput | undefined
    const capturingReflector: RunReflectorLike = {
      score(input: ReflectionInput): ReflectionScore {
        capturedInput = input
        return {
          overall: 0.3,
          dimensions: {
            completeness: 0.3, coherence: 0.3, toolSuccess: 0.3,
            conciseness: 0.3, reliability: 0.3,
          },
          flags: ['low_quality'],
        }
      },
    }

    const policy = createMockPolicy({
      shouldEscalate: true,
      fromTier: 'chat',
      toTier: 'codegen',
      reason: 'low',
      consecutiveLowScores: 3,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({
        output: { message: 'partial result' },
        tokenUsage: { input: 100, output: 50 },
        costCents: 0.5,
        logs: [
          { level: 'info' as const, phase: 'tool_call', message: 'Tool: search', data: { toolName: 'search', success: true, durationMs: 120 } },
          { level: 'info' as const, phase: 'tool_call', message: 'Tool: write', data: { toolName: 'write', success: false, durationMs: 300 } },
          { level: 'error' as const, phase: 'agent', message: 'Partial failure' },
          { level: 'info' as const, phase: 'retry', message: 'Retry attempt 1' },
        ],
      }),
      reflector: capturingReflector,
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'tool-esc-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'tool-esc-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    await waitForTerminalStatus(runStore, run.id)

    // Verify reflector received correct input
    expect(capturedInput).toBeDefined()
    expect(capturedInput!.toolCalls).toHaveLength(2)
    expect(capturedInput!.toolCalls![0]!.name).toBe('search')
    expect(capturedInput!.toolCalls![0]!.success).toBe(true)
    expect(capturedInput!.toolCalls![1]!.name).toBe('write')
    expect(capturedInput!.toolCalls![1]!.success).toBe(false)
    expect(capturedInput!.errorCount).toBe(1)
    expect(capturedInput!.retryCount).toBe(1)
    expect(capturedInput!.tokenUsage).toEqual({ input: 100, output: 50 })

    // And escalation was triggered
    expect(policy.calls).toHaveLength(1)
    expect(policy.calls[0]!.score).toBeCloseTo(0.3)

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 13. Escalation warning log includes error message from save failure
  // -----------------------------------------------------------------------
  it('escalation warning log includes specific error message', async () => {
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    const agentStoreFailSave = {
      async get(id: string) {
        if (id === 'err-msg-agent') {
          return {
            id: 'err-msg-agent',
            name: 'Err Msg Agent',
            instructions: 'test',
            modelTier: 'chat' as const,
            active: true,
            metadata: {},
          }
        }
        return null
      },
      async save(_agent: unknown) {
        throw new Error('unique constraint violation on model_tier')
      },
    }

    const policy = createMockPolicy({
      shouldEscalate: true,
      fromTier: 'chat',
      toTier: 'codegen',
      reason: 'low',
      consecutiveLowScores: 3,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore: agentStoreFailSave,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.2),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'err-msg-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'err-msg-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    await waitForTerminalStatus(runStore, run.id)

    const logs = await runStore.getLogs(run.id)
    const warnLog = logs.find(
      (l) => l.phase === 'escalation' && l.level === 'warn',
    )
    expect(warnLog).toBeDefined()
    const data = warnLog!.data as Record<string, unknown>
    expect(data['error']).toContain('unique constraint violation')

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 14. Escalation with modelTier from metadata overrides default 'chat'
  // -----------------------------------------------------------------------
  it('uses modelTier from job metadata for escalation currentTier', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'tier-override-agent',
      name: 'Tier Override Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    const policy = createMockPolicy({
      shouldEscalate: false,
      fromTier: 'codegen',
      toTier: 'codegen',
      reason: 'score ok',
      consecutiveLowScores: 0,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.6),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'tier-override-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'codegen' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'tier-override-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'codegen' },
      priority: 1,
    })

    await waitForTerminalStatus(runStore, run.id)

    expect(policy.calls[0]!.currentTier).toBe('codegen')

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 15. Escalation uses agent-level intent when job metadata lacks it
  // -----------------------------------------------------------------------
  it('uses agent-level intent for escalation key when job lacks intent', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'agent-intent-agent',
      name: 'Agent Intent Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
      metadata: { intent: 'code-review' },
    })

    const policy = createMockPolicy({
      shouldEscalate: false,
      fromTier: 'chat',
      toTier: 'chat',
      reason: 'ok',
      consecutiveLowScores: 0,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.7),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'agent-intent-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      // No intent in job metadata
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'agent-intent-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    await waitForTerminalStatus(runStore, run.id)

    expect(policy.calls[0]!.key).toBe('agent-intent-agent:code-review')

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 16. Escalation when shouldEscalate=false — no agent update
  // -----------------------------------------------------------------------
  it('does not update agent store when shouldEscalate is false', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'no-esc-agent',
      name: 'No Esc Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
      metadata: { existing: 'value' },
    })

    const policy = createMockPolicy({
      shouldEscalate: false,
      fromTier: 'chat',
      toTier: 'chat',
      reason: 'score ok',
      consecutiveLowScores: 1,
    })

    // Spy on save AFTER the initial setup save, so we only track worker-initiated saves
    const saveSpy = vi.spyOn(agentStore, 'save')

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.6),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'no-esc-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'no-esc-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    await waitForTerminalStatus(runStore, run.id)

    // The worker should not have called save because shouldEscalate is false
    expect(saveSpy).not.toHaveBeenCalled()

    const logs = await runStore.getLogs(run.id)
    const escalationLog = logs.find((l) => l.phase === 'escalation')
    expect(escalationLog).toBeUndefined()

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 17. Escalation message format in log
  // -----------------------------------------------------------------------
  it('escalation log message contains from/to tiers and reason', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'msg-format-agent',
      name: 'Msg Format Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    const policy = createMockPolicy({
      shouldEscalate: true,
      fromTier: 'chat',
      toTier: 'reasoning',
      reason: 'quality degradation detected',
      consecutiveLowScores: 4,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.15),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'msg-format-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'msg-format-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    await waitForTerminalStatus(runStore, run.id)

    const logs = await runStore.getLogs(run.id)
    const escLog = logs.find((l) => l.phase === 'escalation' && l.level === 'info')
    expect(escLog).toBeDefined()
    expect(escLog!.message).toContain('chat')
    expect(escLog!.message).toContain('reasoning')
    expect(escLog!.message).toContain('quality degradation detected')

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 18. Multiple runs — stateful escalation policy tracks across runs
  // -----------------------------------------------------------------------
  it('stateful policy accumulates scores across multiple runs', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'multi-run-agent',
      name: 'Multi Run Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    let callCount = 0
    const statefulPolicy: EscalationPolicyLike = {
      recordScore(key: string, score: number, currentTier: string): EscalationResultLike {
        callCount++
        return {
          shouldEscalate: callCount >= 3, // Escalate on 3rd call
          fromTier: currentTier,
          toTier: callCount >= 3 ? 'reasoning' : currentTier,
          reason: callCount >= 3 ? 'accumulated low scores' : 'not enough data',
          consecutiveLowScores: callCount,
        }
      },
    }

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.3),
      escalationPolicy: statefulPolicy,
    })

    // Run 1 — no escalation
    const run1 = await runStore.create({ agentId: 'multi-run-agent', input: { message: '1' }, metadata: { modelTier: 'chat' } })
    await runQueue.enqueue({ runId: run1.id, agentId: 'multi-run-agent', input: { message: '1' }, metadata: { modelTier: 'chat' }, priority: 1 })
    await waitForTerminalStatus(runStore, run1.id)

    // Run 2 — no escalation
    const run2 = await runStore.create({ agentId: 'multi-run-agent', input: { message: '2' }, metadata: { modelTier: 'chat' } })
    await runQueue.enqueue({ runId: run2.id, agentId: 'multi-run-agent', input: { message: '2' }, metadata: { modelTier: 'chat' }, priority: 1 })
    await waitForTerminalStatus(runStore, run2.id)

    // Run 3 — should escalate
    const run3 = await runStore.create({ agentId: 'multi-run-agent', input: { message: '3' }, metadata: { modelTier: 'chat' } })
    await runQueue.enqueue({ runId: run3.id, agentId: 'multi-run-agent', input: { message: '3' }, metadata: { modelTier: 'chat' }, priority: 1 })
    await waitForTerminalStatus(runStore, run3.id)

    expect(callCount).toBe(3)

    // Only run 3 should have escalation log
    const logs1 = await runStore.getLogs(run1.id)
    const logs3 = await runStore.getLogs(run3.id)
    expect(logs1.find((l) => l.phase === 'escalation')).toBeUndefined()
    expect(logs3.find((l) => l.phase === 'escalation' && l.level === 'info')).toBeDefined()

    // Agent should be updated to reasoning
    const updated = await agentStore.get('multi-run-agent')
    expect(updated?.metadata?.['modelTier']).toBe('reasoning')

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 19. Escalation with no intent yields "default" in key
  // -----------------------------------------------------------------------
  it('uses "default" as intent in escalation key when neither job nor agent has intent', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'no-intent-agent',
      name: 'No Intent Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
      // No metadata.intent
    })

    const policy = createMockPolicy({
      shouldEscalate: false,
      fromTier: 'chat',
      toTier: 'chat',
      reason: 'ok',
      consecutiveLowScores: 0,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.7),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'no-intent-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      // No intent in metadata
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'no-intent-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    await waitForTerminalStatus(runStore, run.id)

    expect(policy.calls[0]!.key).toBe('no-intent-agent:default')

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 20. Escalation with reflectionStore save failure followed by escalation success
  // -----------------------------------------------------------------------
  it('escalation proceeds even when reflectionStore.save() fails', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    const failingReflectionStore: RunReflectionStore = {
      save: async () => { throw new Error('reflection store down') },
      get: async () => undefined,
      list: async () => [],
      getPatterns: async () => [],
    }

    await agentStore.save({
      id: 'refl-fail-esc-ok-agent',
      name: 'Refl Fail Esc Ok Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    const policy = createMockPolicy({
      shouldEscalate: true,
      fromTier: 'chat',
      toTier: 'codegen',
      reason: 'low scores',
      consecutiveLowScores: 3,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.2),
      reflectionStore: failingReflectionStore,
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'refl-fail-esc-ok-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'refl-fail-esc-ok-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    await waitForTerminalStatus(runStore, run.id)

    // Escalation should have fired despite reflectionStore failure
    expect(policy.calls).toHaveLength(1)
    const updated = await agentStore.get('refl-fail-esc-ok-agent')
    expect(updated?.metadata?.['modelTier']).toBe('codegen')

    // Both warning and escalation logs should exist
    const logs = await runStore.getLogs(run.id)
    const reflWarn = logs.find(
      (l) => l.phase === 'reflection' && l.message.includes('Failed to persist'),
    )
    const escInfo = logs.find(
      (l) => l.phase === 'escalation' && l.level === 'info',
    )
    expect(reflWarn).toBeDefined()
    expect(escInfo).toBeDefined()

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 21. Escalation with empty string intent falls back to "default"
  // -----------------------------------------------------------------------
  it('treats empty string intent as undefined, falls back to "default"', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'empty-intent-agent',
      name: 'Empty Intent Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
      metadata: { intent: '' },
    })

    const policy = createMockPolicy({
      shouldEscalate: false,
      fromTier: 'chat',
      toTier: 'chat',
      reason: 'ok',
      consecutiveLowScores: 0,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.7),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'empty-intent-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat', intent: '' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'empty-intent-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat', intent: '' },
      priority: 1,
    })

    await waitForTerminalStatus(runStore, run.id)

    expect(policy.calls[0]!.key).toBe('empty-intent-agent:default')

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 22. Escalation score is passed to policy with correct precision
  // -----------------------------------------------------------------------
  it('passes exact reflector score to escalation policy', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'precision-agent',
      name: 'Precision Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    const policy = createMockPolicy({
      shouldEscalate: false,
      fromTier: 'chat',
      toTier: 'chat',
      reason: 'ok',
      consecutiveLowScores: 0,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.123456789),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'precision-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'precision-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    await waitForTerminalStatus(runStore, run.id)

    expect(policy.calls[0]!.score).toBeCloseTo(0.123456789, 8)

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 23. Escalation with addLog failure during escalation catch — swallowed
  // -----------------------------------------------------------------------
  it('swallows addLog failure inside escalation error handler', async () => {
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    // Custom runStore that fails addLog only for escalation phase
    const baseRunStore = new InMemoryRunStore()
    const originalAddLog = baseRunStore.addLog.bind(baseRunStore)
    let addLogCallCount = 0
    const patchedRunStore = Object.create(baseRunStore) as InMemoryRunStore
    patchedRunStore.addLog = async (runId: string, log: { level: string; phase?: string; message: string; data?: unknown }) => {
      addLogCallCount++
      // Let the escalation warning log fail (phase=escalation, level=warn)
      if (log.phase === 'escalation' && log.level === 'warn') {
        throw new Error('addLog DB failure')
      }
      return originalAddLog(runId, log)
    }

    const agentStore = {
      async get(id: string) {
        if (id === 'swallow-agent') {
          return {
            id: 'swallow-agent',
            name: 'Swallow Agent',
            instructions: 'test',
            modelTier: 'chat' as const,
            active: true,
            metadata: {},
          }
        }
        return null
      },
      async save(_agent: unknown) {
        throw new Error('save fails to trigger escalation catch')
      },
    }

    const policy = createMockPolicy({
      shouldEscalate: true,
      fromTier: 'chat',
      toTier: 'codegen',
      reason: 'low',
      consecutiveLowScores: 3,
    })

    startRunWorker({
      runQueue,
      runStore: patchedRunStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.2),
      escalationPolicy: policy,
    })

    const run = await baseRunStore.create({
      agentId: 'swallow-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'swallow-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(baseRunStore, run.id)
    // Run should still complete even when addLog itself fails in the catch block
    expect(status).toBe('completed')

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 24. Escalation does not affect run output
  // -----------------------------------------------------------------------
  it('escalation does not modify run output or status', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'output-intact-agent',
      name: 'Output Intact Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    const policy = createMockPolicy({
      shouldEscalate: true,
      fromTier: 'chat',
      toTier: 'reasoning',
      reason: 'low',
      consecutiveLowScores: 5,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({
        output: { answer: 'the answer is 42', confidence: 0.99 },
        tokenUsage: { input: 200, output: 100 },
        costCents: 1.5,
      }),
      reflector: createFixedScoreReflector(0.1),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'output-intact-agent',
      input: { question: 'what is the meaning?' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'output-intact-agent',
      input: { question: 'what is the meaning?' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('completed')

    const completed = await runStore.get(run.id)
    expect(completed?.output).toEqual({ answer: 'the answer is 42', confidence: 0.99 })
    expect(completed?.tokenUsage).toEqual({ input: 200, output: 100 })
    expect(completed?.costCents).toBe(1.5)

    await runQueue.stop(false)
  })

  // -----------------------------------------------------------------------
  // 25. Escalation with high score — no escalation, no logs
  // -----------------------------------------------------------------------
  it('produces no escalation log when score is high and shouldEscalate is false', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'high-score-agent',
      name: 'High Score Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    const policy = createMockPolicy({
      shouldEscalate: false,
      fromTier: 'chat',
      toTier: 'chat',
      reason: 'score excellent',
      consecutiveLowScores: 0,
    })

    const seenEvents: string[] = []
    eventBus.onAny((event) => seenEvents.push((event as { type: string }).type))

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      reflector: createFixedScoreReflector(0.95),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'high-score-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'high-score-agent',
      input: { message: 'test' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    await waitForTerminalStatus(runStore, run.id)

    // No escalation log and no registry:agent_updated event
    const logs = await runStore.getLogs(run.id)
    expect(logs.filter((l) => l.phase === 'escalation')).toHaveLength(0)
    expect(seenEvents).not.toContain('registry:agent_updated')

    await runQueue.stop(false)
  })
})

// ---------------------------------------------------------------------------
// Session Y — compressionLog persistence
// ---------------------------------------------------------------------------

describe('run-worker — compressionLog persistence', () => {
  it('persists compressionLog entries into run.metadata.compressionLog', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'a-compress',
      name: 'Compress Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    const expectedEntries = [
      { before: 12000, after: 4200, summary: 'compacted early history', ts: 1_700_000_000_000 },
      { before: 9000, after: 3100, summary: null, ts: 1_700_000_001_000 },
    ]

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({
        output: { message: 'ok' },
        compressionLog: expectedEntries,
      }),
    })

    const run = await runStore.create({ agentId: 'a-compress', input: { message: 'hi' } })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a-compress',
      input: { message: 'hi' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('completed')

    const completed = await runStore.get(run.id)
    const meta = completed?.metadata as Record<string, unknown> | undefined
    expect(meta?.['compressionLog']).toEqual(expectedEntries)

    await runQueue.stop(false)
  })

  it('does not add compressionLog key when executor omits it or returns empty list', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'a-no-compress',
      name: 'No Compress Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    // First run: executor omits compressionLog entirely
    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async ({ input }) => {
        const payload = input as { case?: string }
        return payload.case === 'empty'
          ? { output: { message: 'empty' }, compressionLog: [] }
          : { output: { message: 'omit' } }
      },
    })

    const run1 = await runStore.create({ agentId: 'a-no-compress', input: { case: 'omit' } })
    await runQueue.enqueue({
      runId: run1.id,
      agentId: 'a-no-compress',
      input: { case: 'omit' },
      priority: 1,
    })
    await waitForTerminalStatus(runStore, run1.id)
    const completed1 = await runStore.get(run1.id)
    const meta1 = (completed1?.metadata ?? {}) as Record<string, unknown>
    expect(meta1['compressionLog']).toBeUndefined()

    const run2 = await runStore.create({ agentId: 'a-no-compress', input: { case: 'empty' } })
    await runQueue.enqueue({
      runId: run2.id,
      agentId: 'a-no-compress',
      input: { case: 'empty' },
      priority: 1,
    })
    await waitForTerminalStatus(runStore, run2.id)
    const completed2 = await runStore.get(run2.id)
    const meta2 = (completed2?.metadata ?? {}) as Record<string, unknown>
    expect(meta2['compressionLog']).toBeUndefined()

    await runQueue.stop(false)
  })

  it('preserves sibling metadata (job.metadata + executor.metadata) alongside compressionLog', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'a-compress-merge',
      name: 'Compress Merge Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    const entry = { before: 8000, after: 2500, summary: 'rollup', ts: 1_700_000_500_000 }

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({
        output: { message: 'done' },
        metadata: { streamMode: true, chunkCount: 7 },
        compressionLog: [entry],
      }),
    })

    const run = await runStore.create({
      agentId: 'a-compress-merge',
      input: { message: 'hi' },
      metadata: { sessionId: 'sess-42', intent: 'summarize' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a-compress-merge',
      input: { message: 'hi' },
      metadata: { sessionId: 'sess-42', intent: 'summarize' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('completed')

    const completed = await runStore.get(run.id)
    const meta = completed?.metadata as Record<string, unknown>
    // Job-level metadata preserved
    expect(meta['sessionId']).toBe('sess-42')
    expect(meta['intent']).toBe('summarize')
    // Executor metadata merged
    expect(meta['streamMode']).toBe(true)
    expect(meta['chunkCount']).toBe(7)
    // compressionLog present
    expect(meta['compressionLog']).toEqual([entry])

    await runQueue.stop(false)
  })
})
