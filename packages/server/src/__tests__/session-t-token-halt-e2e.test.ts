/**
 * Session T: E2E integration test for the full token-halt flow.
 *
 * Spans the complete pipeline:
 *   run-worker (queue) → dzip-agent-run-executor → DzupAgent.stream()
 *
 * The test uses a fake DzupAgent whose stream() yields two text turns then
 * emits a `done` event with `stopReason: 'token_exhausted'` to simulate
 * a TokenLifecycleManager that exhausts the budget after N turns.
 *
 * Three invariants are verified:
 *   1. `run:halted:token-exhausted` is emitted exactly once on the event bus.
 *   2. The persisted run record has `metadata.halted === true` and
 *      `status === 'halted'` (Session Q).
 *   3. No double-emit can occur between executor and run-engine layers
 *      because the executor consumes DzupAgent.stream() directly — the
 *      run-engine's token-exhausted branch is never reached from this path.
 *
 * Nothing in this test makes real LLM calls, network requests, or database
 * connections. Everything is fully in-memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
  type DzupEvent,
} from '@dzupagent/core'
import { waitForCondition } from '@dzupagent/test-utils'
import { InMemoryRunQueue } from '../queue/run-queue.js'
import { startRunWorker } from '../runtime/run-worker.js'
import { createDzupAgentRunExecutor } from '../runtime/dzip-agent-run-executor.js'

// ---------------------------------------------------------------------------
// DzupAgent mock — configured per-test via `agentStreamEvents`.
//
// We must hoist the mutable reference so the mock factory (hoisted by Vitest)
// can capture a stable reference to the array mutated in beforeEach.
// ---------------------------------------------------------------------------

type StreamEvent = { type: string; data: Record<string, unknown> }

/**
 * Two text chunks followed by a `done` with `stopReason: 'token_exhausted'`
 * and `iterations: 2`.  Represents the shape emitted when a
 * TokenLifecycleManager exhausts the budget after the second LLM turn.
 */
function makeExhaustedStream(): StreamEvent[] {
  return [
    { type: 'text', data: { content: 'Turn 1 partial response. ' } },
    { type: 'text', data: { content: 'Turn 2 partial response.' } },
    {
      type: 'done',
      data: {
        content: 'Turn 1 partial response. Turn 2 partial response.',
        stopReason: 'token_exhausted',
        iterations: 2,
      },
    },
  ]
}

let agentStreamEvents: StreamEvent[] = []

vi.mock('@dzupagent/agent', () => ({
  DzupAgent: class {
    async *stream(): AsyncGenerator<StreamEvent, void, undefined> {
      for (const event of agentStreamEvents) {
        yield event
      }
    }
  },
}))

vi.mock('../runtime/tool-resolver.js', () => ({
  resolveAgentTools: async () => ({
    tools: [],
    activated: [],
    unresolved: [],
    warnings: [],
    cleanup: async () => {},
  }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForRunStatus(
  store: InMemoryRunStore,
  runId: string,
  timeoutMs = 4000,
): Promise<string> {
  const terminal = ['completed', 'halted', 'failed', 'rejected', 'cancelled']
  let observed: string | undefined
  await waitForCondition(
    async () => {
      const run = await store.get(runId)
      if (run && terminal.includes(run.status)) {
        observed = run.status
        return true
      }
      return false
    },
    { timeoutMs, intervalMs: 20, description: `Run ${runId} never reached terminal status` },
  )
  return observed!
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Session T — E2E token-halt integration', () => {
  let runStore: InMemoryRunStore
  let agentStore: InMemoryAgentStore
  let runQueue: InMemoryRunQueue

  beforeEach(async () => {
    agentStreamEvents = makeExhaustedStream()

    runStore = new InMemoryRunStore()
    agentStore = new InMemoryAgentStore()
    runQueue = new InMemoryRunQueue({ concurrency: 1 })

    await agentStore.save({
      id: 'halt-e2e-agent',
      name: 'Halt E2E Agent',
      instructions: 'Be concise.',
      modelTier: 'chat',
      active: true,
    })
  })

  afterEach(async () => {
    await runQueue.stop(false)
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Primary invariant: event emitted exactly once, metadata correct.
  // -------------------------------------------------------------------------

  it('emits run:halted:token-exhausted exactly once and sets halted status + metadata', async () => {
    const eventBus = createEventBus()
    const modelRegistry = new ModelRegistry()

    // Collect every event emitted on the bus so we can count halt events.
    const allEvents: DzupEvent[] = []
    eventBus.onAny((event) => { allEvents.push(event) })

    const executor = createDzupAgentRunExecutor()

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: executor,
    })

    const run = await runStore.create({
      agentId: 'halt-e2e-agent',
      input: { message: 'Exhaust my token budget please.' },
      metadata: {},
    })

    await runQueue.enqueue({
      runId: run.id,
      agentId: 'halt-e2e-agent',
      input: { message: 'Exhaust my token budget please.' },
      priority: 1,
    })

    // Wait for the run to reach a terminal state.
    const finalStatus = await waitForRunStatus(runStore, run.id)

    // ------------------------------------------------------------------
    // Assertion 1: run:halted:token-exhausted fires exactly once.
    // ------------------------------------------------------------------
    const haltEvents = allEvents.filter(
      (e) => e.type === 'run:halted:token-exhausted',
    )
    expect(haltEvents).toHaveLength(1)

    const haltEvent = haltEvents[0] as {
      type: string
      agentId: string
      runId: string
      iterations: number
      reason: string
    }
    expect(haltEvent.type).toBe('run:halted:token-exhausted')
    expect(haltEvent.runId).toBe(run.id)
    expect(haltEvent.agentId).toBe('halt-e2e-agent')
    expect(haltEvent.iterations).toBe(2)
    expect(haltEvent.reason).toBe('token_exhausted')

    // ------------------------------------------------------------------
    // Assertion 2: run record has status='halted' (Session Q) and
    // metadata.halted=true for backward-compat readers.
    // ------------------------------------------------------------------
    expect(finalStatus).toBe('halted')

    const finalRun = await runStore.get(run.id)
    expect(finalRun).not.toBeNull()
    expect(finalRun!.status).toBe('halted')
    expect(finalRun!.metadata?.['halted']).toBe(true)
    expect(finalRun!.metadata?.['haltReason']).toBe('token_exhausted')
    expect(finalRun!.metadata?.['haltIterations']).toBe(2)
    expect(finalRun!.completedAt).toBeInstanceOf(Date)

    // ------------------------------------------------------------------
    // Assertion 3: No double-emit between executor and run-engine layers.
    //
    // The executor (dzip-agent-run-executor.ts) emits the halt event when
    // DzupAgent.stream() yields `done { stopReason: 'token_exhausted' }`.
    // The run-engine (run-engine.ts) has a SEPARATE emit path that fires
    // when runToolLoop() returns `stopReason === 'token_exhausted'`.
    //
    // From this pipeline the executor uses DzupAgent.stream() directly —
    // it does NOT go through run-engine.executeGenerateRun. Therefore only
    // one emit can occur.  The assertion is the same as Assertion 1 but
    // we state it explicitly to document the no-double-emit guarantee.
    // ------------------------------------------------------------------
    expect(haltEvents).toHaveLength(1) // redundant by design — makes intent clear

    // No failure event should have been emitted (halt is not an error).
    const failedEvents = allEvents.filter(
      (e) => e.type === 'agent:failed' && (e as { runId?: string }).runId === run.id,
    )
    expect(failedEvents).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Boundary check: a normal (non-halted) stream does NOT emit the event.
  // -------------------------------------------------------------------------

  it('does not emit run:halted:token-exhausted on a normal completion', async () => {
    // Override the stream events to simulate a clean completion.
    agentStreamEvents = [
      { type: 'text', data: { content: 'All done.' } },
      { type: 'done', data: { content: 'All done.', stopReason: 'complete' } },
    ]

    const eventBus = createEventBus()
    const modelRegistry = new ModelRegistry()

    const allEvents: DzupEvent[] = []
    eventBus.onAny((event) => { allEvents.push(event) })

    const executor = createDzupAgentRunExecutor()

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: executor,
    })

    const run = await runStore.create({
      agentId: 'halt-e2e-agent',
      input: { message: 'Normal request.' },
      metadata: {},
    })

    await runQueue.enqueue({
      runId: run.id,
      agentId: 'halt-e2e-agent',
      input: { message: 'Normal request.' },
      priority: 1,
    })

    const finalStatus = await waitForRunStatus(runStore, run.id)

    expect(finalStatus).toBe('completed')

    const haltEvents = allEvents.filter(
      (e) => e.type === 'run:halted:token-exhausted',
    )
    expect(haltEvents).toHaveLength(0)

    const finalRun = await runStore.get(run.id)
    expect(finalRun!.metadata?.['halted']).toBeUndefined()
    expect(finalRun!.metadata?.['haltReason']).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Partial content is preserved (clean halt, not an error).
  // -------------------------------------------------------------------------

  it('preserves partial LLM output as run output when the token budget is exhausted', async () => {
    const eventBus = createEventBus()
    const modelRegistry = new ModelRegistry()

    const executor = createDzupAgentRunExecutor()

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: executor,
    })

    const run = await runStore.create({
      agentId: 'halt-e2e-agent',
      input: { message: 'Generate something long.' },
      metadata: {},
    })

    await runQueue.enqueue({
      runId: run.id,
      agentId: 'halt-e2e-agent',
      input: { message: 'Generate something long.' },
      priority: 1,
    })

    await waitForRunStatus(runStore, run.id)

    const finalRun = await runStore.get(run.id)
    expect(finalRun!.status).toBe('halted')

    // Partial output is NOT discarded — the run was cleanly halted.
    const output = finalRun!.output as { message?: string } | null
    expect(output).not.toBeNull()
    // The content is the join of the two text chunks.
    expect(output!.message).toContain('Turn 1 partial response.')
    expect(output!.message).toContain('Turn 2 partial response.')
  })

  // -------------------------------------------------------------------------
  // Run logs contain a warn entry for the halt.
  // -------------------------------------------------------------------------

  it('records a warn log entry describing the token-exhaustion halt', async () => {
    const eventBus = createEventBus()
    const modelRegistry = new ModelRegistry()

    const executor = createDzupAgentRunExecutor()

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: executor,
    })

    const run = await runStore.create({
      agentId: 'halt-e2e-agent',
      input: { message: 'Work until exhausted.' },
      metadata: {},
    })

    await runQueue.enqueue({
      runId: run.id,
      agentId: 'halt-e2e-agent',
      input: { message: 'Work until exhausted.' },
      priority: 1,
    })

    await waitForRunStatus(runStore, run.id)

    const logs = await runStore.getLogs(run.id)
    const haltLog = logs.find(
      (l) =>
        l.level === 'warn' &&
        l.phase === 'agent' &&
        l.message === 'Run halted due to token exhaustion',
    )
    expect(haltLog).toBeDefined()
  })
})
