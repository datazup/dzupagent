import { describe, it, expect, vi } from 'vitest'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@forgeagent/core'
import { InMemoryRunQueue } from '../queue/run-queue.js'
import { startRunWorker } from '../runtime/run-worker.js'
import type {
  RunReflectorLike,
  ReflectionInput,
  ReflectionScore,
  EscalationPolicyLike,
  EscalationResultLike,
} from '../runtime/run-worker.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForTerminalStatus(
  store: InMemoryRunStore,
  runId: string,
  timeoutMs = 3000,
): Promise<'completed' | 'failed' | 'rejected' | 'cancelled'> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const run = await store.get(runId)
    if (
      run?.status === 'completed' ||
      run?.status === 'failed' ||
      run?.status === 'rejected' ||
      run?.status === 'cancelled'
    ) {
      return run.status
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for run ${runId} to reach terminal state`)
}

/** Creates a reflector that always returns the given overall score. */
function createFixedReflector(overall: number): RunReflectorLike {
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

/** Creates an escalation policy mock that tracks calls and returns configured results. */
function createMockEscalationPolicy(
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

async function setupAndRun(opts: {
  agentId: string
  modelTier?: string
  intent?: string
  reflector: RunReflectorLike
  escalationPolicy?: EscalationPolicyLike
}) {
  const runStore = new InMemoryRunStore()
  const agentStore = new InMemoryAgentStore()
  const eventBus = createEventBus()
  const runQueue = new InMemoryRunQueue({ concurrency: 1 })
  const modelRegistry = new ModelRegistry()

  await agentStore.save({
    id: opts.agentId,
    name: 'Test Agent',
    instructions: 'test',
    modelTier: opts.modelTier ?? 'chat',
    active: true,
    metadata: opts.intent ? { intent: opts.intent } : {},
  })

  const seenEvents: Array<{ type: string; [k: string]: unknown }> = []
  eventBus.onAny((event) => {
    seenEvents.push(event as { type: string; [k: string]: unknown })
  })

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
    reflector: opts.reflector,
    escalationPolicy: opts.escalationPolicy,
  })

  const jobMetadata: Record<string, unknown> = {}
  if (opts.modelTier) jobMetadata['modelTier'] = opts.modelTier
  if (opts.intent) jobMetadata['intent'] = opts.intent

  const run = await runStore.create({
    agentId: opts.agentId,
    input: { message: 'hello' },
    metadata: jobMetadata,
  })
  await runQueue.enqueue({
    runId: run.id,
    agentId: opts.agentId,
    input: { message: 'hello' },
    metadata: jobMetadata,
    priority: 1,
  })

  const status = await waitForTerminalStatus(runStore, run.id)

  return { runStore, agentStore, eventBus, runQueue, run, status, seenEvents }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('escalation policy wiring in run-worker', () => {
  it('triggers escalation and updates agent store on consecutive low scores', async () => {
    const policy = createMockEscalationPolicy({
      shouldEscalate: true,
      fromTier: 'chat',
      toTier: 'codegen',
      reason: '3 consecutive scores below 0.5',
      consecutiveLowScores: 3,
    })

    const { runStore, agentStore, run, status, seenEvents, runQueue } = await setupAndRun({
      agentId: 'esc-agent-1',
      modelTier: 'chat',
      intent: 'generate',
      reflector: createFixedReflector(0.3),
      escalationPolicy: policy,
    })

    expect(status).toBe('completed')

    // Verify escalation policy was called with correct key format
    expect(policy.calls).toHaveLength(1)
    expect(policy.calls[0]!.key).toBe('esc-agent-1:generate')
    expect(policy.calls[0]!.score).toBeCloseTo(0.3)
    expect(policy.calls[0]!.currentTier).toBe('chat')

    // Verify agent store was updated
    const updatedAgent = await agentStore.get('esc-agent-1')
    expect(updatedAgent?.metadata?.['modelTier']).toBe('codegen')

    // Verify escalation log was written
    const logs = await runStore.getLogs(run.id)
    const escalationLog = logs.find((l) => l.phase === 'escalation')
    expect(escalationLog).toBeDefined()
    expect(escalationLog!.message).toContain('chat')
    expect(escalationLog!.message).toContain('codegen')

    // Verify registry:agent_updated event was emitted
    const updateEvent = seenEvents.find((e) => e.type === 'registry:agent_updated')
    expect(updateEvent).toBeDefined()
    expect(updateEvent!['agentId']).toBe('esc-agent-1')

    await runQueue.stop(false)
  })

  it('does not trigger escalation on high reflection scores', async () => {
    const policy = createMockEscalationPolicy({
      shouldEscalate: false,
      fromTier: 'chat',
      toTier: 'chat',
      reason: 'score above threshold',
      consecutiveLowScores: 0,
    })

    const { agentStore, runQueue } = await setupAndRun({
      agentId: 'esc-agent-2',
      modelTier: 'chat',
      intent: 'generate',
      reflector: createFixedReflector(0.9),
      escalationPolicy: policy,
    })

    // Policy was called but should not escalate
    expect(policy.calls).toHaveLength(1)

    // Agent store should NOT have modelTier in metadata
    const agent = await agentStore.get('esc-agent-2')
    expect(agent?.metadata?.['modelTier']).toBeUndefined()

    await runQueue.stop(false)
  })

  it('skips escalation gracefully when no policy is provided', async () => {
    const { status, runStore, run, runQueue } = await setupAndRun({
      agentId: 'esc-agent-3',
      modelTier: 'chat',
      reflector: createFixedReflector(0.3),
      // No escalationPolicy
    })

    expect(status).toBe('completed')

    // Verify no escalation log was written
    const logs = await runStore.getLogs(run.id)
    const escalationLog = logs.find((l) => l.phase === 'escalation')
    expect(escalationLog).toBeUndefined()

    await runQueue.stop(false)
  })

  it('does not crash the worker when escalation fails', async () => {
    const brokenPolicy: EscalationPolicyLike & { calls: Array<{ key: string; score: number; currentTier: string }> } = {
      calls: [],
      recordScore(key: string, score: number, currentTier: string): EscalationResultLike {
        this.calls.push({ key, score, currentTier })
        return {
          shouldEscalate: true,
          fromTier: currentTier,
          toTier: 'codegen',
          reason: 'test escalation',
          consecutiveLowScores: 3,
        }
      },
    }

    // Use an agent store where save() throws
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    const throwingAgentStore = {
      async get(id: string) {
        if (id === 'esc-agent-4') {
          return {
            id: 'esc-agent-4',
            name: 'Test Agent',
            instructions: 'test',
            modelTier: 'chat',
            active: true,
            metadata: {},
          }
        }
        return null
      },
      async save(_agent: unknown) {
        throw new Error('DB write failed')
      },
    }

    startRunWorker({
      runQueue,
      runStore,
      agentStore: throwingAgentStore,
      eventBus,
      modelRegistry,
      runExecutor: async ({ input }) => {
        const payload = input as { message?: string }
        return { content: `ok:${payload.message ?? ''}` }
      },
      reflector: createFixedReflector(0.2),
      escalationPolicy: brokenPolicy,
    })

    const run = await runStore.create({
      agentId: 'esc-agent-4',
      input: { message: 'hello' },
      metadata: { modelTier: 'chat' },
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'esc-agent-4',
      input: { message: 'hello' },
      metadata: { modelTier: 'chat' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id)

    // Run should still complete despite escalation failure
    expect(status).toBe('completed')

    // Verify a warning log was written about the failure
    const logs = await runStore.getLogs(run.id)
    const failLog = logs.find(
      (l) => l.phase === 'escalation' && l.level === 'warn',
    )
    expect(failLog).toBeDefined()
    expect(failLog!.message).toContain('escalation failed')

    await runQueue.stop(false)
  })

  it('uses correct key format: agentId:intent with fallback to default', async () => {
    // Test with intent
    const policyWithIntent = createMockEscalationPolicy({
      shouldEscalate: false,
      fromTier: 'chat',
      toTier: 'chat',
      reason: 'not enough low scores',
      consecutiveLowScores: 1,
    })

    const result1 = await setupAndRun({
      agentId: 'key-agent',
      modelTier: 'chat',
      intent: 'codegen',
      reflector: createFixedReflector(0.3),
      escalationPolicy: policyWithIntent,
    })
    expect(policyWithIntent.calls[0]!.key).toBe('key-agent:codegen')
    await result1.runQueue.stop(false)

    // Test without intent — should fallback to "default"
    const policyNoIntent = createMockEscalationPolicy({
      shouldEscalate: false,
      fromTier: 'chat',
      toTier: 'chat',
      reason: 'not enough low scores',
      consecutiveLowScores: 1,
    })

    const result2 = await setupAndRun({
      agentId: 'key-agent-no-intent',
      modelTier: 'chat',
      reflector: createFixedReflector(0.3),
      escalationPolicy: policyNoIntent,
    })
    expect(policyNoIntent.calls[0]!.key).toBe('key-agent-no-intent:default')
    await result2.runQueue.stop(false)
  })

  it('defaults modelTier to chat when metadata lacks modelTier', async () => {
    const policy = createMockEscalationPolicy({
      shouldEscalate: false,
      fromTier: 'chat',
      toTier: 'chat',
      reason: 'not enough',
      consecutiveLowScores: 1,
    })

    // Setup without modelTier in metadata
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'no-tier-agent',
      name: 'Test Agent',
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
      reflector: createFixedReflector(0.3),
      escalationPolicy: policy,
    })

    const run = await runStore.create({
      agentId: 'no-tier-agent',
      input: { message: 'test' },
      // No modelTier in metadata
    })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'no-tier-agent',
      input: { message: 'test' },
      priority: 1,
    })

    await waitForTerminalStatus(runStore, run.id)

    // Should have defaulted to 'chat'
    expect(policy.calls[0]!.currentTier).toBe('chat')

    await runQueue.stop(false)
  })
})
