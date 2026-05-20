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
