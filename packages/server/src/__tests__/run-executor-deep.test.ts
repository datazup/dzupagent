/**
 * Wave 21 deep coverage for server-side run execution.
 *
 * Exercises:
 *  - Full run lifecycle transitions (queued → running → completed / failed / cancelled / rejected)
 *  - Lifecycle event emission with correct runId/agentId correlation
 *  - Tool call recording via logs (tool_call / tool_result phases)
 *  - Cancellation (both queue-level cancel and abort-signal cancel)
 *  - Error propagation and retryable-error surfacing
 *  - Concurrent run execution with no cross-contamination
 *  - Stream / delta path (stream_delta and stream_done events)
 *  - Run metadata durability: tokenUsage, costCents, fields populated
 *
 * Uses @dzupagent/core in-memory primitives — no DB, no LLM, no network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
  type DzupEventBus,
  type DzupEvent,
  type Run,
} from '@dzupagent/core'
import { InMemoryRunQueue } from '../queue/run-queue.js'
import { startRunWorker } from '../runtime/run-worker.js'
import { createDefaultRunExecutor } from '../runtime/default-run-executor.js'
import type { RunExecutor, RunExecutorResult } from '../runtime/run-worker.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForTerminalStatus(
  store: InMemoryRunStore,
  runId: string,
  timeoutMs = 3000,
): Promise<Run> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const run = await store.get(runId)
    if (
      run &&
      ['completed', 'failed', 'rejected', 'cancelled'].includes(run.status)
    ) {
      return run
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out waiting for terminal state on run ${runId}`)
}

async function waitForStatus(
  store: InMemoryRunStore,
  runId: string,
  target: Run['status'],
  timeoutMs = 2000,
): Promise<Run> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const run = await store.get(runId)
    if (run?.status === target) return run
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`Timed out waiting for status=${target} on run ${runId}`)
}

// Helper to enqueue + await terminal state in one call
async function runAndWait(
  queue: InMemoryRunQueue,
  store: InMemoryRunStore,
  opts: { runId: string; agentId: string; input?: unknown; metadata?: Record<string, unknown> },
  timeoutMs = 3000,
): Promise<Run> {
  await queue.enqueue({
    runId: opts.runId,
    agentId: opts.agentId,
    input: opts.input ?? {},
    metadata: opts.metadata,
    priority: 1,
  })
  return waitForTerminalStatus(store, opts.runId, timeoutMs)
}

// ---------------------------------------------------------------------------
// Test suite — DefaultRunExecutor + run-worker lifecycle
// ---------------------------------------------------------------------------

describe('Server run-executor deep coverage (W21-B2)', () => {
  let runStore: InMemoryRunStore
  let agentStore: InMemoryAgentStore
  let eventBus: DzupEventBus
  let runQueue: InMemoryRunQueue
  let modelRegistry: ModelRegistry

  beforeEach(async () => {
    runStore = new InMemoryRunStore()
    agentStore = new InMemoryAgentStore()
    eventBus = createEventBus()
    runQueue = new InMemoryRunQueue({ concurrency: 4 })
    modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'agent-main',
      name: 'Main',
      instructions: 'You are helpful',
      modelTier: 'chat',
      active: true,
    })
  })

  afterEach(async () => {
    await runQueue.stop(false)
  })

  // =========================================================================
  // 1. Run lifecycle state transitions
  // =========================================================================

  describe('Run lifecycle state transitions', () => {
    it('created → running → completed on success', async () => {
      const statuses: string[] = []
      // subscribe to runStore via run-worker emitted events
      eventBus.onAny((e) => {
        if ('runId' in e) statuses.push(e.type)
      })

      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => ({ output: { message: 'ok' } }),
      })

      const run = await runStore.create({
        agentId: 'agent-main',
        input: { message: 'hi' },
      })
      expect(run.status).toBe('queued')

      const completed = await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })
      expect(completed.status).toBe('completed')
      expect(statuses).toContain('agent:started')
      expect(statuses).toContain('agent:completed')
    })

    it('created → running → failed on executor throw', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => {
          throw new Error('unreachable provider')
        },
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      const failed = await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })
      expect(failed.status).toBe('failed')
      expect(failed.error).toContain('unreachable provider')
    })

    it('created → rejected when approval denied', async () => {
      await agentStore.save({
        id: 'agent-approve',
        name: 'Approve',
        instructions: 'manual gate',
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
        runExecutor: async () => ({ output: { ok: true } }),
      })

      const run = await runStore.create({
        agentId: 'agent-approve',
        input: { message: 'hi' },
        metadata: { approvalTimeoutMs: 1000 },
      })

      // Reject shortly after enqueue
      setTimeout(() => {
        eventBus.emit({ type: 'approval:rejected', runId: run.id, reason: 'policy' })
      }, 50)

      const out = await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-approve',
        metadata: { approvalTimeoutMs: 1000 },
      })
      expect(out.status).toBe('rejected')
      expect(out.error).toContain('policy')
    })

    it('completedAt is populated after terminal state', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => ({ output: { ok: true } }),
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      const completed = await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })
      expect(completed.completedAt).toBeInstanceOf(Date)
    })

    it('agent:failed is emitted for unknown agent id', async () => {
      const events: DzupEvent[] = []
      eventBus.onAny((e) => events.push(e))

      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => ({ output: {} }),
      })

      const run = await runStore.create({
        agentId: 'does-not-exist',
        input: {},
      })

      const out = await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'does-not-exist',
      })
      expect(out.status).toBe('failed')
      const failEvent = events.find((e) => e.type === 'agent:failed') as
        | Extract<DzupEvent, { type: 'agent:failed' }>
        | undefined
      expect(failEvent?.errorCode).toBe('REGISTRY_AGENT_NOT_FOUND')
    })

    it('status stored/retrievable during running state', async () => {
      let gate!: () => void
      const waiter = new Promise<void>((resolve) => {
        gate = resolve
      })

      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => {
          await waiter
          return { output: { ok: true } }
        },
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await runQueue.enqueue({
        runId: run.id,
        agentId: 'agent-main',
        input: {},
        priority: 1,
      })
      // Give worker time to pick up and transition to 'running'
      const runningRun = await waitForStatus(runStore, run.id, 'running', 1000)
      expect(runningRun.status).toBe('running')
      gate()
      await waitForTerminalStatus(runStore, run.id)
    })
  })

  // =========================================================================
  // 2. Event emission — correlation & fan-out
  // =========================================================================

  describe('Event emission', () => {
    it('emits agent:started with correct runId and agentId', async () => {
      const events: DzupEvent[] = []
      eventBus.onAny((e) => events.push(e))

      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => ({ output: { ok: true } }),
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })

      const started = events.find((e) => e.type === 'agent:started') as
        | Extract<DzupEvent, { type: 'agent:started' }>
        | undefined
      expect(started).toBeDefined()
      expect(started?.agentId).toBe('agent-main')
      expect(started?.runId).toBe(run.id)
    })

    it('emits agent:completed with durationMs', async () => {
      const events: DzupEvent[] = []
      eventBus.onAny((e) => events.push(e))

      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => ({ output: { ok: true } }),
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })

      const completedEvent = events.find((e) => e.type === 'agent:completed') as
        | Extract<DzupEvent, { type: 'agent:completed' }>
        | undefined
      expect(completedEvent).toBeDefined()
      expect(completedEvent?.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('emits agent:failed with errorCode INTERNAL_ERROR when executor throws', async () => {
      const events: DzupEvent[] = []
      eventBus.onAny((e) => events.push(e))

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

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })

      const failed = events.find((e) => e.type === 'agent:failed') as
        | Extract<DzupEvent, { type: 'agent:failed' }>
        | undefined
      expect(failed?.errorCode).toBe('INTERNAL_ERROR')
      expect(failed?.message).toContain('boom')
    })

    it('does not emit agent:completed when the executor throws', async () => {
      const events: DzupEvent[] = []
      eventBus.onAny((e) => events.push(e))

      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => {
          throw new Error('nope')
        },
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })

      expect(events.some((e) => e.type === 'agent:completed')).toBe(false)
    })

    it('event runIds match createdAt run id (correlation)', async () => {
      const events: DzupEvent[] = []
      eventBus.onAny((e) => {
        if ('runId' in e) events.push(e)
      })

      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => ({ output: { ok: true } }),
      })

      const r1 = await runStore.create({ agentId: 'agent-main', input: {} })
      const r2 = await runStore.create({ agentId: 'agent-main', input: {} })
      await Promise.all([
        runAndWait(runQueue, runStore, { runId: r1.id, agentId: 'agent-main' }),
        runAndWait(runQueue, runStore, { runId: r2.id, agentId: 'agent-main' }),
      ])

      const startedEvents = events.filter((e) => e.type === 'agent:started')
      const ids = new Set(startedEvents.map((e) => (e as { runId: string }).runId))
      expect(ids.has(r1.id)).toBe(true)
      expect(ids.has(r2.id)).toBe(true)
    })
  })

  // =========================================================================
  // 3. Cancellation
  // =========================================================================

  describe('Cancellation', () => {
    it('pending run cancelled before execution: executor not invoked', async () => {
      let callCount = 0
      // hold slot-0 indefinitely to keep new jobs pending
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))

      startRunWorker({
        runQueue: new InMemoryRunQueue({ concurrency: 1 }),
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => {
          callCount++
          await gate
          return { output: { ok: true } }
        },
      })
      const q = new InMemoryRunQueue({ concurrency: 1 })
      startRunWorker({
        runQueue: q,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => {
          callCount++
          if (callCount === 1) await gate
          return { output: { ok: true } }
        },
      })

      // Fill slot 1
      const blocker = await runStore.create({ agentId: 'agent-main', input: {} })
      await q.enqueue({
        runId: blocker.id,
        agentId: 'agent-main',
        input: {},
        priority: 1,
      })
      await new Promise((r) => setTimeout(r, 100)) // let blocker start

      // enqueue and immediately cancel a pending job
      const cancelable = await runStore.create({ agentId: 'agent-main', input: {} })
      await q.enqueue({
        runId: cancelable.id,
        agentId: 'agent-main',
        input: {},
        priority: 5,
      })
      const ok = q.cancel(cancelable.id)
      expect(ok).toBe(true)

      release()
      await waitForTerminalStatus(runStore, blocker.id)

      // Cancelled pending job must not have been executed
      const count = callCount
      expect(count).toBe(1) // only blocker invoked
      await q.stop(false)
    })

    it('cancel() returns false for unknown runId', async () => {
      const q = new InMemoryRunQueue({ concurrency: 1 })
      expect(q.cancel('no-such-run')).toBe(false)
      await q.stop(false)
    })

    it('running job receives abort signal on cancel and becomes cancelled', async () => {
      const q = new InMemoryRunQueue({ concurrency: 1 })
      let sawAbort = false

      startRunWorker({
        runQueue: q,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async ({ signal }) => {
          // Wait until cancelled
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener('abort', () => {
              sawAbort = true
              reject(new DOMException('Run cancelled', 'AbortError'))
            })
            // Never resolves on its own
          })
          return { output: {} }
        },
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await q.enqueue({
        runId: run.id,
        agentId: 'agent-main',
        input: {},
        priority: 1,
      })
      // Give run time to start
      await new Promise((r) => setTimeout(r, 100))
      expect(q.cancel(run.id)).toBe(true)

      const terminal = await waitForTerminalStatus(runStore, run.id, 2000)
      expect(terminal.status).toBe('cancelled')
      expect(sawAbort).toBe(true)
      await q.stop(false)
    })
  })

  // =========================================================================
  // 4. Timeout
  // =========================================================================

  describe('Timeout', () => {
    it('queue job timeout forces cancellation of long-running executor', async () => {
      const q = new InMemoryRunQueue({ concurrency: 1, jobTimeoutMs: 200 })

      startRunWorker({
        runQueue: q,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async ({ signal }) => {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(new DOMException('Run cancelled', 'AbortError'))
            })
          })
          return { output: {} }
        },
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await q.enqueue({
        runId: run.id,
        agentId: 'agent-main',
        input: {},
        priority: 1,
      })

      const terminal = await waitForTerminalStatus(runStore, run.id, 3000)
      // After timeout the worker sees signal.aborted and sets 'cancelled'
      expect(['cancelled', 'failed']).toContain(terminal.status)
      await q.stop(false)
    })
  })

  // =========================================================================
  // 5. Concurrent runs
  // =========================================================================

  describe('Concurrent runs', () => {
    it('two parallel runs for same agent both complete successfully', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async ({ input }) => {
          const msg = typeof input === 'object' && input && 'message' in input
            ? String((input as { message: unknown }).message)
            : 'unknown'
          return { output: { message: msg } }
        },
      })

      const r1 = await runStore.create({
        agentId: 'agent-main',
        input: { message: 'alpha' },
      })
      const r2 = await runStore.create({
        agentId: 'agent-main',
        input: { message: 'beta' },
      })

      const [t1, t2] = await Promise.all([
        runAndWait(runQueue, runStore, {
          runId: r1.id,
          agentId: 'agent-main',
          input: { message: 'alpha' },
        }),
        runAndWait(runQueue, runStore, {
          runId: r2.id,
          agentId: 'agent-main',
          input: { message: 'beta' },
        }),
      ])

      expect(t1.status).toBe('completed')
      expect(t2.status).toBe('completed')
      expect((t1.output as { message: string }).message).toBe('alpha')
      expect((t2.output as { message: string }).message).toBe('beta')
    })

    it('concurrent runs do not cross-contaminate outputs', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async ({ runId }) => {
          // Random-ish delay to encourage interleaving
          await new Promise((r) => setTimeout(r, Math.random() * 50))
          return { output: { owner: runId } }
        },
      })

      const runs = await Promise.all(
        Array.from({ length: 5 }, () =>
          runStore.create({ agentId: 'agent-main', input: {} }),
        ),
      )
      const completed = await Promise.all(
        runs.map((r) =>
          runAndWait(runQueue, runStore, { runId: r.id, agentId: 'agent-main' }),
        ),
      )
      for (const c of completed) {
        expect((c.output as { owner: string }).owner).toBe(c.id)
      }
    })

    it('all run IDs are unique across concurrent creations', async () => {
      const runs = await Promise.all(
        Array.from({ length: 20 }, () =>
          runStore.create({ agentId: 'agent-main', input: {} }),
        ),
      )
      const ids = runs.map((r) => r.id)
      expect(new Set(ids).size).toBe(ids.length)
    })
  })

  // =========================================================================
  // 6. Error propagation
  // =========================================================================

  describe('Error propagation', () => {
    it('tool throws: run status → failed, error captured', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => {
          throw new Error('Tool read_file failed: EACCES')
        },
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      const out = await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })
      expect(out.status).toBe('failed')
      expect(out.error).toContain('EACCES')
    })

    it('LLM provider error: error message persisted in run.error', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => {
          throw new Error('LLM_PROVIDER_UNAVAILABLE: gateway timeout')
        },
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      const out = await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })
      expect(out.error).toContain('LLM_PROVIDER_UNAVAILABLE')
    })

    it('error details logged via run store', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => {
          throw new Error('critical failure')
        },
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })

      const logs = await runStore.getLogs(run.id)
      const errorLog = logs.find((l) => l.level === 'error' && l.phase === 'run')
      expect(errorLog).toBeDefined()
      expect(errorLog?.message).toContain('Run failed')
    })

    it('non-Error throw values are stringified into run.error', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => {
          throw 'literal string error'
        },
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      const out = await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })
      expect(out.status).toBe('failed')
      expect(out.error).toContain('literal string error')
    })
  })

  // =========================================================================
  // 7. Tool call recording
  // =========================================================================

  describe('Tool call recording', () => {
    it('tool_call phase logs captured from executor result.logs', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () =>
          ({
            output: { message: 'done' },
            logs: [
              {
                level: 'info',
                phase: 'tool_call',
                message: 'Tool called: read_file',
                data: { toolName: 'read_file', input: { path: 'a.ts' } },
              },
              {
                level: 'info',
                phase: 'tool_result',
                message: 'Tool result: read_file',
                data: { result: 'ok' },
              },
            ],
          }) satisfies RunExecutorResult,
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })

      const logs = await runStore.getLogs(run.id)
      expect(logs.some((l) => l.phase === 'tool_call')).toBe(true)
      expect(logs.some((l) => l.phase === 'tool_result')).toBe(true)
    })

    it('executor can record tool duration via log data', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () =>
          ({
            output: {},
            logs: [
              {
                level: 'info',
                phase: 'tool_call',
                message: 'Tool called: write_file',
                data: { toolName: 'write_file', durationMs: 42, success: true },
              },
            ],
          }) satisfies RunExecutorResult,
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })

      const logs = await runStore.getLogs(run.id)
      const toolLog = logs.find((l) => l.phase === 'tool_call')
      expect(toolLog).toBeDefined()
      const data = toolLog?.data as { durationMs?: number; success?: boolean } | undefined
      expect(data?.durationMs).toBe(42)
      expect(data?.success).toBe(true)
    })

    it('tokenUsage stored on run after completion', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => ({
          output: { ok: true },
          tokenUsage: { input: 123, output: 45 },
          costCents: 0.3,
        }),
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      const done = await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })
      expect(done.tokenUsage).toEqual({ input: 123, output: 45 })
      expect(done.costCents).toBeCloseTo(0.3, 6)
    })
  })

  // =========================================================================
  // 8. Stream path
  // =========================================================================

  describe('Stream / delta path', () => {
    it('stream_delta and stream_done events can be emitted via executor', async () => {
      const streamEvents: DzupEvent[] = []
      eventBus.onAny((e) => {
        if (e.type === 'agent:stream_delta' || e.type === 'agent:stream_done') {
          streamEvents.push(e)
        }
      })

      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async (ctx) => {
          for (const chunk of ['hello ', 'world']) {
            ctx.eventBus.emit({
              type: 'agent:stream_delta',
              agentId: ctx.agentId,
              runId: ctx.runId,
              content: chunk,
            })
          }
          ctx.eventBus.emit({
            type: 'agent:stream_done',
            agentId: ctx.agentId,
            runId: ctx.runId,
            finalContent: 'hello world',
          })
          return { output: { message: 'hello world' } }
        },
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })

      const deltas = streamEvents.filter((e) => e.type === 'agent:stream_delta')
      const dones = streamEvents.filter((e) => e.type === 'agent:stream_done')
      expect(deltas).toHaveLength(2)
      expect(dones).toHaveLength(1)
      expect((dones[0] as { finalContent: string }).finalContent).toBe('hello world')
    })

    it('stream is closed even if executor errors', async () => {
      const events: DzupEvent[] = []
      eventBus.onAny((e) => events.push(e))

      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async (ctx) => {
          ctx.eventBus.emit({
            type: 'agent:stream_delta',
            agentId: ctx.agentId,
            runId: ctx.runId,
            content: 'partial...',
          })
          throw new Error('mid-stream failure')
        },
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      const out = await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })
      expect(out.status).toBe('failed')
      // agent:failed is the terminal stream closure signal
      expect(events.some((e) => e.type === 'agent:failed')).toBe(true)
    })
  })

  // =========================================================================
  // 9. Default run executor (unconfigured model registry fallback)
  // =========================================================================

  describe('createDefaultRunExecutor fallback', () => {
    it('returns deterministic message when registry has no providers', async () => {
      const exec = createDefaultRunExecutor(modelRegistry)
      const run = await runStore.create({
        agentId: 'agent-main',
        input: 'hello there',
      })
      const ctrl = new AbortController()
      const result = await exec({
        runId: run.id,
        agentId: 'agent-main',
        input: 'hello there',
        agent: (await agentStore.get('agent-main'))!,
        metadata: {},
        runStore,
        eventBus,
        modelRegistry,
        signal: ctrl.signal,
      })
      expect((result as { message: string }).message).toContain('[Main]')
      expect((result as { message: string }).message).toContain('hello there')
    })

    it('handles object input by extracting .message', async () => {
      const exec = createDefaultRunExecutor(modelRegistry)
      const run = await runStore.create({
        agentId: 'agent-main',
        input: { message: 'from-object' },
      })
      const ctrl = new AbortController()
      const result = await exec({
        runId: run.id,
        agentId: 'agent-main',
        input: { message: 'from-object' },
        agent: (await agentStore.get('agent-main'))!,
        metadata: {},
        runStore,
        eventBus,
        modelRegistry,
        signal: ctrl.signal,
      })
      expect((result as { message: string }).message).toContain('from-object')
    })

    it('handles empty input with a default message', async () => {
      const exec = createDefaultRunExecutor(modelRegistry)
      const run = await runStore.create({ agentId: 'agent-main', input: '' })
      const ctrl = new AbortController()
      const result = await exec({
        runId: run.id,
        agentId: 'agent-main',
        input: '',
        agent: (await agentStore.get('agent-main'))!,
        metadata: {},
        runStore,
        eventBus,
        modelRegistry,
        signal: ctrl.signal,
      })
      expect((result as { message: string }).message).toContain('Run processed successfully')
    })

    it('falls back through priority keys (content, prompt) when message missing', async () => {
      const exec = createDefaultRunExecutor(modelRegistry)
      const ctrl = new AbortController()
      const result = await exec({
        runId: 'r1',
        agentId: 'agent-main',
        input: { content: 'from-content' },
        agent: (await agentStore.get('agent-main'))!,
        metadata: {},
        runStore,
        eventBus,
        modelRegistry,
        signal: ctrl.signal,
      })
      expect((result as { message: string }).message).toContain('from-content')
    })

    it('prefers string input over object input', async () => {
      const exec = createDefaultRunExecutor(modelRegistry)
      const ctrl = new AbortController()
      const out = await exec({
        runId: 'r2',
        agentId: 'agent-main',
        input: 'raw-string',
        agent: (await agentStore.get('agent-main'))!,
        metadata: {},
        runStore,
        eventBus,
        modelRegistry,
        signal: ctrl.signal,
      })
      expect((out as { message: string }).message).toContain('raw-string')
    })
  })

  // =========================================================================
  // 10. Metadata propagation through the pipeline
  // =========================================================================

  describe('Metadata propagation', () => {
    it('run metadata preserved through to completion', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => ({
          output: { ok: true },
          metadata: { enriched: true },
        }),
      })

      const run = await runStore.create({
        agentId: 'agent-main',
        input: {},
        metadata: { sessionId: 's1', tenantId: 't1' },
      })
      const completed = await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
        metadata: { sessionId: 's1', tenantId: 't1' },
      })
      const meta = completed.metadata as Record<string, unknown>
      expect(meta['sessionId']).toBe('s1')
      expect(meta['tenantId']).toBe('t1')
      expect(meta['enriched']).toBe(true)
    })

    it('executor metadata merges on top of job metadata', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => ({
          output: { ok: true },
          metadata: { tenantId: 'overridden' },
        }),
      })

      const run = await runStore.create({
        agentId: 'agent-main',
        input: {},
        metadata: { sessionId: 's1', tenantId: 't1' },
      })
      const out = await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
        metadata: { sessionId: 's1', tenantId: 't1' },
      })
      const meta = out.metadata as Record<string, unknown>
      // executor metadata takes precedence
      expect(meta['tenantId']).toBe('overridden')
      // original keys still present
      expect(meta['sessionId']).toBe('s1')
    })

    it('executor-only metadata keys appear in the final run metadata', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => ({
          output: {},
          metadata: { modelUsed: 'claude-opus-4', traceSpanId: 'abc' },
        }),
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      const out = await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })
      const meta = out.metadata as Record<string, unknown>
      expect(meta['modelUsed']).toBe('claude-opus-4')
      expect(meta['traceSpanId']).toBe('abc')
    })
  })

  // =========================================================================
  // 11. Log aggregation and aux phases
  // =========================================================================

  describe('Log aggregation', () => {
    it('queue and run phase logs are recorded in order', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => ({ output: {} }),
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })

      const logs = await runStore.getLogs(run.id)
      const phases = logs.map((l) => l.phase)
      expect(phases).toContain('queue')
      expect(phases).toContain('run')
      // queue log should precede run completion log
      const queueIdx = phases.indexOf('queue')
      const runIdx = phases.lastIndexOf('run')
      expect(queueIdx).toBeGreaterThanOrEqual(0)
      expect(runIdx).toBeGreaterThan(queueIdx)
    })

    it('executor-provided logs are appended after default run-complete log', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => ({
          output: {},
          logs: [
            { level: 'info', phase: 'llm', message: 'LLM call succeeded' },
            { level: 'debug', phase: 'trace', message: 'detail' },
          ],
        }),
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })

      const logs = await runStore.getLogs(run.id)
      expect(logs.some((l) => l.phase === 'llm')).toBe(true)
      expect(logs.some((l) => l.phase === 'trace')).toBe(true)
    })

    it('additional logs preserve their level attributes', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => ({
          output: {},
          logs: [
            { level: 'warn', phase: 'policy', message: 'Low-confidence result' },
            { level: 'error', phase: 'tool', message: 'tool non-fatal error' },
          ],
        }),
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })

      const logs = await runStore.getLogs(run.id)
      expect(logs.some((l) => l.level === 'warn' && l.phase === 'policy')).toBe(true)
      expect(logs.some((l) => l.level === 'error' && l.phase === 'tool')).toBe(true)
    })
  })

  // =========================================================================
  // 12. Unstructured executor return (non-structured output)
  // =========================================================================

  describe('Unstructured executor return value', () => {
    it('non-structured primitive return value becomes run.output', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => 'just-a-string',
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      const done = await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })
      expect(done.output).toBe('just-a-string')
    })

    it('plain object (non-structured) becomes run.output', async () => {
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => ({ greeting: 'hi' }),
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      const done = await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })
      // Note: { greeting: 'hi' } has no 'output' key so it's treated as raw output
      expect(done.output).toEqual({ greeting: 'hi' })
    })
  })

  // =========================================================================
  // 13. RunStore durability checks
  // =========================================================================

  describe('RunStore durability', () => {
    it('run.id is unique and run record is persisted', async () => {
      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      expect(run.id).toBeTruthy()
      const reread = await runStore.get(run.id)
      expect(reread?.id).toBe(run.id)
    })

    it('updating a non-existent run is a no-op (does not throw)', async () => {
      await expect(
        runStore.update('no-such-run', { status: 'failed' }),
      ).resolves.toBeUndefined()
    })

    it('getLogs returns a copy, not the internal array', async () => {
      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await runStore.addLog(run.id, { level: 'info', message: 'hello' })
      const l1 = await runStore.getLogs(run.id)
      const l2 = await runStore.getLogs(run.id)
      expect(l1).not.toBe(l2)
      expect(l1).toEqual(l2)
    })
  })

  // =========================================================================
  // 14. Spy-based event ordering assertion
  // =========================================================================

  describe('Event ordering', () => {
    it('agent:started precedes agent:completed', async () => {
      const order: string[] = []
      eventBus.onAny((e) => {
        if (e.type === 'agent:started' || e.type === 'agent:completed') {
          order.push(e.type)
        }
      })

      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => ({ output: {} }),
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })
      expect(order.indexOf('agent:started')).toBeLessThan(order.indexOf('agent:completed'))
    })

    it('agent:started precedes agent:failed on error', async () => {
      const order: string[] = []
      eventBus.onAny((e) => {
        if (e.type === 'agent:started' || e.type === 'agent:failed') {
          order.push(e.type)
        }
      })

      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async () => {
          throw new Error('fail')
        },
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })
      expect(order.indexOf('agent:started')).toBeLessThan(order.indexOf('agent:failed'))
    })
  })

  // =========================================================================
  // 15. Mock-friendly run executor interface
  // =========================================================================

  describe('RunExecutor contract', () => {
    it('accepts a vi.fn mock and receives all context fields', async () => {
      const executorMock = vi.fn<RunExecutor>(async () => ({ output: { ok: true } }))

      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: executorMock,
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })

      expect(executorMock).toHaveBeenCalledTimes(1)
      const ctx = executorMock.mock.calls[0]![0]
      expect(ctx.runId).toBe(run.id)
      expect(ctx.agentId).toBe('agent-main')
      expect(ctx.runStore).toBe(runStore)
      expect(ctx.eventBus).toBe(eventBus)
      expect(ctx.modelRegistry).toBe(modelRegistry)
      expect(ctx.agent.id).toBe('agent-main')
      expect(ctx.signal).toBeInstanceOf(AbortSignal)
    })

    it('executor can inspect the abort signal to check for cancellation', async () => {
      let seenSignal: AbortSignal | undefined
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: async ({ signal }) => {
          seenSignal = signal
          return { output: {} }
        },
      })

      const run = await runStore.create({ agentId: 'agent-main', input: {} })
      await runAndWait(runQueue, runStore, {
        runId: run.id,
        agentId: 'agent-main',
      })

      expect(seenSignal).toBeDefined()
      expect(typeof seenSignal!.aborted).toBe('boolean')
    })
  })
})
