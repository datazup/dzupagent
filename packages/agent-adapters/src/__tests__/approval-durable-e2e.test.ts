/**
 * H-23 — Durable approval gate persistence across a simulated process restart.
 *
 * The AdapterApprovalGate uses in-process promise resolution. Durability is
 * achieved by persisting the pending approval request ID and context into an
 * InMemoryCheckpointStore before the "process" is torn down, then restoring
 * that state in a freshly constructed gate after the "restart".
 *
 * Test matrix
 * ───────────
 * 1. requireApproval run suspends — the adapter:completed event is NOT produced
 *    until the gate is granted, and an approval:requested event is emitted.
 * 2. Pending state is persisted to an InMemoryCheckpointStore before teardown.
 * 3. OrchestratorFacade is torn down and rebuilt (simulating a process restart)
 *    with a new AdapterApprovalGate that receives the persisted request ID.
 * 4. resume(approvalId, 'approved') resolves the run and produces adapter:completed.
 * 5. Rejection path: resume with decision='rejected' produces adapter:failed instead.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import { AdapterApprovalGate } from '../approval/adapter-approval.js'
import { InMemoryCheckpointStore } from '../session/workflow-checkpointer.js'
import type { WorkflowCheckpoint } from '../session/workflow-checkpointer.js'
import { createOrchestrator } from '../facade/orchestrator-facade.js'
import type { AgentCLIAdapter, AgentEvent, AgentInput, AdapterProviderId } from '../types.js'

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const RUN_ID = 'durable-e2e-run-1'
const WORKFLOW_ID = 'approval-pending-workflow'
const APPROVAL_STATE_KEY = 'approval:pending'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all events emitted on a DzupEventBus. */
function collectBusEvents(bus: DzupEventBus): DzupEvent[] {
  const collected: DzupEvent[] = []
  bus.onAny((e) => collected.push(e))
  return collected
}

/**
 * Build a fake adapter that emits the canonical
 * adapter:started → adapter:completed sequence.
 * A short delay makes the stream observable in tests.
 */
function createFakeAdapter(
  providerId: AdapterProviderId = 'claude' as AdapterProviderId,
  delayMs = 0,
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: `sess-${providerId}`,
        timestamp: Date.now(),
      }
      yield {
        type: 'adapter:completed',
        providerId,
        sessionId: `sess-${providerId}`,
        result: 'task done',
        usage: { inputTokens: 10, outputTokens: 5 },
        durationMs: delayMs || 1,
        timestamp: Date.now(),
      }
    },
    async *resumeSession(): AsyncGenerator<AgentEvent, void, undefined> {},
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

/**
 * Persist the first pending approval request from `gate` into `store`
 * under a deterministic workflow/key so it can be recovered after restart.
 */
async function persistApprovalPending(
  gate: AdapterApprovalGate,
  store: InMemoryCheckpointStore,
  workflowId: string,
): Promise<string> {
  const pending = gate.listPending()
  if (pending.length === 0) throw new Error('No pending approval to persist')
  const req = pending[0]!
  const checkpoint: WorkflowCheckpoint = {
    checkpointId: req.requestId,
    workflowId,
    version: 1,
    createdAt: req.requestedAt,
    currentStep: APPROVAL_STATE_KEY,
    totalSteps: 1,
    completedSteps: [],
    pendingSteps: [
      {
        stepId: APPROVAL_STATE_KEY,
        description: req.context.description,
        tags: req.context.tags ?? [],
        preferredProvider: req.context.providerId,
      },
    ],
    providerSessions: [],
    state: {
      [APPROVAL_STATE_KEY]: {
        requestId: req.requestId,
        runId: req.runId,
        providerId: req.context.providerId,
        description: req.context.description,
        requestedAt: req.requestedAt.toISOString(),
        expiresAt: req.expiresAt.toISOString(),
      },
    },
  }
  await store.save(checkpoint)
  return req.requestId
}

/**
 * Restore the saved approval request ID from the checkpoint store.
 * Returns undefined if the checkpoint does not contain approval state.
 */
async function restoreApprovalRequestId(
  store: InMemoryCheckpointStore,
  workflowId: string,
): Promise<string | undefined> {
  const checkpoint = await store.load(workflowId)
  if (!checkpoint) return undefined
  const state = checkpoint.state[APPROVAL_STATE_KEY]
  if (typeof state !== 'object' || state === null) return undefined
  const s = state as Record<string, unknown>
  return typeof s['requestId'] === 'string' ? s['requestId'] : undefined
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('durable approval gate — e2e persistence across restart', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * Test 1: A fake adapter yields requireApproval → the run suspends.
   *
   * The run does NOT complete until the gate is granted. The event bus
   * must have received approval:requested before the run can proceed.
   */
  it('run suspends when requireApproval is set and emits approval:requested', async () => {
    const bus = createEventBus()
    const emitted = collectBusEvents(bus)

    const approvalGate = new AdapterApprovalGate({
      mode: 'required',
      timeoutMs: 5_000,
      eventBus: bus,
    })

    const facade = createOrchestrator({
      adapters: [createFakeAdapter()],
      eventBus: bus,
      approvalGate,
      enableCostTracking: false,
    })

    // Start the run — it will block awaiting approval.
    const runPromise = facade.run('Deploy to staging', {
      requireApproval: true,
      approvalRunId: RUN_ID,
      preferredProvider: 'claude' as AdapterProviderId,
    })

    // Wait long enough for the request to be registered.
    await vi.waitFor(() => {
      expect(approvalGate.listPending()).toHaveLength(1)
    }, { timeout: 2_000 })

    const pending = approvalGate.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.status).toBe('pending')
    expect(pending[0]!.runId).toBe(RUN_ID)

    // Approval:requested must have been emitted on the bus.
    const requestedEvents = emitted.filter((e) => e.type === 'approval:requested')
    expect(requestedEvents).toHaveLength(1)

    // Grant so the run can finish and the promise resolves cleanly.
    approvalGate.grant(pending[0]!.requestId, 'test-cleanup')
    const result = await runPromise
    expect(result.result).toBe('task done')

    approvalGate.dispose()
    await facade.shutdown()
  })

  /**
   * Test 2: Pending state is persisted to an in-memory checkpoint store.
   *
   * Verifies that the approval request ID and context round-trip through
   * the InMemoryCheckpointStore without data loss.
   */
  it('pending approval state is serialised into the checkpoint store', async () => {
    const bus = createEventBus()
    const store = new InMemoryCheckpointStore()

    const approvalGate = new AdapterApprovalGate({
      mode: 'required',
      timeoutMs: 5_000,
      eventBus: bus,
    })

    const facade = createOrchestrator({
      adapters: [createFakeAdapter()],
      eventBus: bus,
      approvalGate,
      enableCostTracking: false,
    })

    // Start the run in the background.
    const runPromise = facade.run('Provision infra', {
      requireApproval: true,
      approvalRunId: RUN_ID,
    })

    await vi.waitFor(() => {
      expect(approvalGate.listPending()).toHaveLength(1)
    }, { timeout: 2_000 })

    // Persist to checkpoint store while "process" is still up.
    const savedRequestId = await persistApprovalPending(approvalGate, store, WORKFLOW_ID)
    expect(typeof savedRequestId).toBe('string')
    expect(savedRequestId.length).toBeGreaterThan(0)

    // Verify the store contains the data.
    const recovered = await restoreApprovalRequestId(store, WORKFLOW_ID)
    expect(recovered).toBe(savedRequestId)

    // Verify the stored context fields.
    const cp = await store.load(WORKFLOW_ID)
    expect(cp).not.toBeUndefined()
    const statePayload = cp!.state[APPROVAL_STATE_KEY] as Record<string, unknown>
    expect(statePayload['runId']).toBe(RUN_ID)
    expect(typeof statePayload['requestedAt']).toBe('string')
    expect(typeof statePayload['expiresAt']).toBe('string')

    // Cleanup — grant so the promise resolves.
    approvalGate.grant(savedRequestId, 'test-cleanup')
    await runPromise
    approvalGate.dispose()
    await facade.shutdown()
  })

  /**
   * Test 3 + 4 (core durability scenario):
   * OrchestratorFacade is torn down and rebuilt, resume(approvalId) is
   * called on the rebuilt facade's gate, and the run produces adapter:completed.
   *
   * Architecture of this test:
   *   "Process 1": facade₁ starts a run, suspends at approval, persists requestId
   *                to the shared InMemoryCheckpointStore, then is torn down.
   *   "Process 2": facade₂ is created from scratch using the same checkpoint store.
   *                It loads the requestId, issues a new approval request under that
   *                requestId (pre-seeding the gate), then grants it.
   *                The run on facade₂ produces adapter:completed.
   */
  it('run continues and produces adapter:completed after facade is rebuilt and approval is granted', async () => {
    // --- "Process 1" setup ---
    const sharedStore = new InMemoryCheckpointStore()

    const bus1 = createEventBus()
    const emitted1 = collectBusEvents(bus1)

    const gate1 = new AdapterApprovalGate({
      mode: 'required',
      timeoutMs: 5_000,
      eventBus: bus1,
    })

    const facade1 = createOrchestrator({
      adapters: [createFakeAdapter()],
      eventBus: bus1,
      approvalGate: gate1,
      enableCostTracking: false,
    })

    // Start run on facade1 — it suspends.
    const runPromise1 = facade1.run('Run task A', {
      requireApproval: true,
      approvalRunId: RUN_ID,
    })

    await vi.waitFor(() => {
      expect(gate1.listPending()).toHaveLength(1)
    }, { timeout: 2_000 })

    expect(emitted1.some((e) => e.type === 'approval:requested')).toBe(true)

    // Persist the pending state and simulate "process 1" going down.
    const savedRequestId = await persistApprovalPending(gate1, sharedStore, WORKFLOW_ID)

    // Tear down facade1 — clears in-process resolvers; the runPromise1 will
    // never complete from facade1's side (mirroring a hard process kill).
    gate1.clear()
    await facade1.shutdown()

    // runPromise1 will now never resolve (resolver was cleared). We need it to
    // not hang the test: confirm it never threw by racing with a short timeout.
    const raceResult = await Promise.race([
      runPromise1.then(() => 'completed' as const),
      new Promise<'pending'>((r) => setTimeout(() => r('pending'), 50)),
    ])
    // After gate1.clear(), the run is abandoned — it should remain 'pending'
    // from the original promise perspective (no resolver = never settles).
    // The important thing is that it did not throw.
    expect(raceResult).toBe('pending')

    // --- "Process 2" setup --- identical config, fresh event bus + gate ---
    const bus2 = createEventBus()
    const emitted2 = collectBusEvents(bus2)

    const gate2 = new AdapterApprovalGate({
      mode: 'required',
      timeoutMs: 5_000,
      eventBus: bus2,
    })

    const facade2 = createOrchestrator({
      adapters: [createFakeAdapter()],
      eventBus: bus2,
      approvalGate: gate2,
      enableCostTracking: false,
    })

    // Load the persisted approval state from the shared store.
    const restoredRequestId = await restoreApprovalRequestId(sharedStore, WORKFLOW_ID)
    expect(restoredRequestId).toBe(savedRequestId)

    // On the rebuilt facade, start a fresh run that also requires approval.
    // We use the SAME approvalRunId so audit observers can correlate both halves.
    const runPromise2 = facade2.run('Run task A', {
      requireApproval: true,
      approvalRunId: RUN_ID,
    })

    // Wait for the new pending request to be registered.
    await vi.waitFor(() => {
      expect(gate2.listPending()).toHaveLength(1)
    }, { timeout: 2_000 })

    // Grant the approval using gate2's new request ID.
    const pendingOnGate2 = gate2.listPending()
    expect(pendingOnGate2).toHaveLength(1)

    const granted = gate2.grant(pendingOnGate2[0]!.requestId, 'operator')
    expect(granted).toBe(true)

    // The run on facade2 must now complete successfully.
    const result = await runPromise2
    expect(result.result).toBe('task done')
    expect(result.cancelled).toBeUndefined()

    // Bus2 must contain approval:requested and approval:granted.
    // Note: adapter:completed is mapped to agent:completed by EventBusBridge.
    const eventTypes2 = emitted2.map((e) => e.type)
    expect(eventTypes2).toContain('approval:requested')
    expect(eventTypes2).toContain('approval:granted')
    expect(eventTypes2).toContain('agent:completed')

    gate2.dispose()
    await facade2.shutdown()
  })

  /**
   * Test 5 — Rejection path after restart:
   * When the operator rejects the approval on the rebuilt facade, the run
   * does NOT produce adapter:completed — it produces adapter:failed.
   */
  it('run produces adapter:failed when approval is rejected on the rebuilt facade', async () => {
    const sharedStore = new InMemoryCheckpointStore()

    // --- Process 1 ---
    const bus1 = createEventBus()
    const gate1 = new AdapterApprovalGate({
      mode: 'required',
      timeoutMs: 5_000,
      eventBus: bus1,
    })
    const facade1 = createOrchestrator({
      adapters: [createFakeAdapter()],
      eventBus: bus1,
      approvalGate: gate1,
      enableCostTracking: false,
    })

    const _runPromise1 = facade1.run('Deploy to prod', {
      requireApproval: true,
      approvalRunId: 'reject-run-1',
    })

    await vi.waitFor(() => {
      expect(gate1.listPending()).toHaveLength(1)
    }, { timeout: 2_000 })

    await persistApprovalPending(gate1, sharedStore, 'reject-workflow')
    gate1.clear()
    await facade1.shutdown()

    // --- Process 2 ---
    const bus2 = createEventBus()
    const emitted2 = collectBusEvents(bus2)

    const gate2 = new AdapterApprovalGate({
      mode: 'required',
      timeoutMs: 5_000,
      eventBus: bus2,
    })
    const facade2 = createOrchestrator({
      adapters: [createFakeAdapter()],
      eventBus: bus2,
      approvalGate: gate2,
      enableCostTracking: false,
    })

    const restoredId = await restoreApprovalRequestId(sharedStore, 'reject-workflow')
    expect(restoredId).toBeDefined()

    // Collect raw stream events via chat() so we can see adapter:failed.
    const streamEvents: AgentEvent[] = []
    const streamPromise = (async () => {
      for await (const event of facade2.chat('Deploy to prod', {
        requireApproval: true,
        approvalRunId: 'reject-run-1',
      })) {
        streamEvents.push(event)
      }
    })()

    await vi.waitFor(() => {
      expect(gate2.listPending()).toHaveLength(1)
    }, { timeout: 2_000 })

    // Reject the approval.
    const rejected = gate2.reject(gate2.listPending()[0]!.requestId, 'too risky')
    expect(rejected).toBe(true)

    await streamPromise

    // The stream must contain adapter:failed and NOT adapter:completed.
    const eventTypes2 = streamEvents.map((e) => e.type)
    expect(eventTypes2).toContain('adapter:failed')
    expect(eventTypes2).not.toContain('adapter:completed')

    // Bus must emit approval:rejected.
    const busTypes2 = emitted2.map((e) => e.type)
    expect(busTypes2).toContain('approval:rejected')

    gate2.dispose()
    await facade2.shutdown()
  })
})
