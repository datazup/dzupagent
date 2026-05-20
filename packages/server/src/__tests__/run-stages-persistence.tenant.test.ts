import { describe, it, expect, vi } from 'vitest'
import {
  createEventBus,
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  type DzupEvent,
} from '@dzupagent/core'
import type { RunJob } from '../queue/run-queue.js'
import {
  persistCancellation,
  persistFailure,
  runPostRunLearningStage,
} from '../runtime/run-stages-persistence.js'
import type { StartRunWorkerOptions } from '../runtime/run-worker-types.js'
import { InMemoryRunQueue } from '../queue/run-queue.js'

/**
 * SEC-M-01-EXTENDED — persistence emit sites must stamp `tenantId` on
 * every envelope when `job.metadata.tenantId` is set:
 *   - agent:failed (AGENT_ABORTED)    — persistCancellation
 *   - agent:failed (INTERNAL_ERROR)   — persistFailure
 *   - registry:agent_updated          — maybeEscalateModelTier (escalation
 *                                       path inside runPostRunLearningStage)
 */

type WithTenant = { tenantId?: string }

function makeJob(overrides: Partial<RunJob> = {}): RunJob {
  return {
    id: 'job-1',
    runId: 'run-persistence-1',
    agentId: 'agent-persistence',
    input: { message: 'hi' },
    metadata: { tenantId: 'tenant-A' },
    priority: 1,
    attempts: 0,
    createdAt: new Date(),
    ...overrides,
  }
}

describe('run-stages-persistence tenant stamping (SEC-M-01-EXTENDED)', () => {
  it('stamps tenantId on agent:failed emitted by persistCancellation', async () => {
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const emitted: DzupEvent[] = []
    eventBus.onAny((event) => emitted.push(event))

    const job = makeJob()
    // persistCancellation reads run.status and only acts on non-terminal
    // runs — seed a 'running' run so the cancellation branch executes.
    const run = await runStore.create({ agentId: job.agentId, input: job.input })
    await runStore.update(run.id, { status: 'running' })
    const cancellableJob = { ...job, runId: run.id }

    await persistCancellation({
      runStore,
      eventBus,
      job: cancellableJob,
    })

    const failed = emitted.find((event) => event.type === 'agent:failed') as DzupEvent & WithTenant
    expect(failed).toBeDefined()
    expect(failed.tenantId).toBe('tenant-A')
  })

  it('stamps tenantId on agent:failed emitted by persistFailure', async () => {
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const emitted: DzupEvent[] = []
    eventBus.onAny((event) => emitted.push(event))

    const job = makeJob({ metadata: { tenantId: 'tenant-B' } })
    const run = await runStore.create({ agentId: job.agentId, input: job.input })
    const failingJob = { ...job, runId: run.id }

    await persistFailure({
      runStore,
      eventBus,
      job: failingJob,
      error: new Error('boom'),
    })

    const failed = emitted.find((event) => event.type === 'agent:failed') as DzupEvent & WithTenant
    expect(failed).toBeDefined()
    expect(failed.tenantId).toBe('tenant-B')
  })

  it('omits tenantId on persistFailure when job.metadata has no tenantId', async () => {
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const emitted: DzupEvent[] = []
    eventBus.onAny((event) => emitted.push(event))

    const job = makeJob({ metadata: undefined })
    const run = await runStore.create({ agentId: job.agentId, input: job.input })
    const failingJob = { ...job, runId: run.id }

    await persistFailure({
      runStore,
      eventBus,
      job: failingJob,
      error: new Error('boom'),
    })

    const failed = emitted.find((event) => event.type === 'agent:failed') as DzupEvent & WithTenant
    expect(failed).toBeDefined()
    expect('tenantId' in failed).toBe(false)
  })

  it('stamps tenantId on registry:agent_updated when escalation fires', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const emitted: DzupEvent[] = []
    eventBus.onAny((event) => emitted.push(event))
    const modelRegistry = new ModelRegistry()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })

    await agentStore.save({
      id: 'agent-escalate',
      name: 'Escalating Agent',
      instructions: 'be concise',
      modelTier: 'chat',
      active: true,
    })

    const reflector = {
      score: vi.fn(() => ({
        overall: 0.1,
        dimensions: {},
        flags: [],
      })),
    }
    const escalationPolicy = {
      recordScore: vi.fn(() => ({
        shouldEscalate: true,
        fromTier: 'chat',
        toTier: 'reasoning',
        reason: 'low quality',
        consecutiveLowScores: 3,
      })),
    }

    const workerOptions: StartRunWorkerOptions = {
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      reflector,
      escalationPolicy,
      runExecutor: async () => ({ content: 'ok' }),
    }

    const job = makeJob({ agentId: 'agent-escalate', metadata: { tenantId: 'tenant-C', modelTier: 'chat' } })
    const run = await runStore.create({ agentId: job.agentId, input: job.input })
    const escalatingJob = { ...job, runId: run.id }

    await runPostRunLearningStage({
      workerOptions,
      job: escalatingJob,
      agent: {
        id: 'agent-escalate',
        name: 'Escalating Agent',
        instructions: 'be concise',
        modelTier: 'chat',
      },
      input: job.input,
      output: { message: 'final' },
      additionalLogs: [],
      durationMs: 1234,
    })

    const updated = emitted.find((event) => event.type === 'registry:agent_updated') as DzupEvent & WithTenant
    expect(updated, 'expected registry:agent_updated to be emitted').toBeDefined()
    expect(updated.tenantId).toBe('tenant-C')
  })
})

// ---------------------------------------------------------------------------
// RUN-REFLECTION-STORE-WIDEN: reflection-summary save-side stamping
// ---------------------------------------------------------------------------
describe('run-stages-persistence reflection stamping (RUN-REFLECTION-STORE-WIDEN)', () => {
  it('stamps tenantId + ownerId on the ReflectionSummary passed to reflectionStore.save', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const modelRegistry = new ModelRegistry()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })

    await agentStore.save({
      id: 'agent-reflect',
      name: 'Reflecting Agent',
      instructions: 'be concise',
      modelTier: 'chat',
      active: true,
    })

    const reflector = {
      score: vi.fn(() => ({ overall: 0.9, dimensions: {}, flags: [] })),
    }

    const savedSummaries: Array<{ runId: string; tenantId?: string; ownerId?: string }> = []
    const reflectionStore = {
      save: vi.fn(async (summary: { runId: string; tenantId?: string; ownerId?: string }) => {
        savedSummaries.push({
          runId: summary.runId,
          ...(summary.tenantId !== undefined ? { tenantId: summary.tenantId } : {}),
          ...(summary.ownerId !== undefined ? { ownerId: summary.ownerId } : {}),
        })
      }),
      get: vi.fn(),
      list: vi.fn(),
      getPatterns: vi.fn(),
    }

    const workerOptions: StartRunWorkerOptions = {
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      reflector,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reflectionStore: reflectionStore as any,
      runExecutor: async () => ({ content: 'ok' }),
    }

    const run = await runStore.create({ agentId: 'agent-reflect', input: { message: 'hi' } })
    const job: RunJob = {
      id: 'job-r',
      runId: run.id,
      agentId: 'agent-reflect',
      input: { message: 'hi' },
      metadata: { tenantId: 'tenant-R', ownerId: 'key-R', modelTier: 'chat' },
      priority: 1,
      attempts: 0,
      createdAt: new Date(),
    }

    await runPostRunLearningStage({
      workerOptions,
      job,
      agent: {
        id: 'agent-reflect',
        name: 'Reflecting Agent',
        instructions: 'be concise',
        modelTier: 'chat',
      },
      input: job.input,
      output: { message: 'done' },
      additionalLogs: [],
      durationMs: 500,
    })

    expect(reflectionStore.save).toHaveBeenCalledOnce()
    expect(savedSummaries).toHaveLength(1)
    expect(savedSummaries[0]!.tenantId).toBe('tenant-R')
    expect(savedSummaries[0]!.ownerId).toBe('key-R')
  })

  it('omits tenantId + ownerId when job.metadata has neither', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const modelRegistry = new ModelRegistry()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })

    await agentStore.save({
      id: 'agent-bare',
      name: 'Bare Agent',
      instructions: 'be concise',
      modelTier: 'chat',
      active: true,
    })

    const reflector = {
      score: vi.fn(() => ({ overall: 0.9, dimensions: {}, flags: [] })),
    }

    const captured: Array<Record<string, unknown>> = []
    const reflectionStore = {
      save: vi.fn(async (summary: Record<string, unknown>) => {
        captured.push(summary)
      }),
      get: vi.fn(),
      list: vi.fn(),
      getPatterns: vi.fn(),
    }

    const workerOptions: StartRunWorkerOptions = {
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      reflector,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reflectionStore: reflectionStore as any,
      runExecutor: async () => ({ content: 'ok' }),
    }

    const run = await runStore.create({ agentId: 'agent-bare', input: { message: 'hi' } })
    const job: RunJob = {
      id: 'job-bare',
      runId: run.id,
      agentId: 'agent-bare',
      input: { message: 'hi' },
      priority: 1,
      attempts: 0,
      createdAt: new Date(),
    }

    await runPostRunLearningStage({
      workerOptions,
      job,
      agent: {
        id: 'agent-bare',
        name: 'Bare Agent',
        instructions: 'be concise',
        modelTier: 'chat',
      },
      input: job.input,
      output: { message: 'done' },
      additionalLogs: [],
      durationMs: 500,
    })

    expect(captured).toHaveLength(1)
    expect('tenantId' in captured[0]!).toBe(false)
    expect('ownerId' in captured[0]!).toBe(false)
  })
})
