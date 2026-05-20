import { describe, it, expect } from 'vitest'
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

/**
 * SEC-M-01-EXTENDED — `startRunWorker` must stamp `tenantId` on every
 * lifecycle envelope it emits (`agent:started`, `agent:completed`) when
 * `job.metadata.tenantId` is set. Without the stamp the event gateway's
 * tenant filter (DZUPAGENT-SEC-M-01) falls back to `DEFAULT_TENANT_ID`
 * and per-tenant SSE delivery is effectively a no-op.
 */

type WithTenant = { tenantId?: string }

async function waitForCompleted(store: InMemoryRunStore, runId: string): Promise<void> {
  await waitForCondition(
    async () => {
      const run = await store.get(runId)
      return run?.status === 'completed'
    },
    { timeoutMs: 3000, intervalMs: 25, description: `Timed out waiting for ${runId}` },
  )
}

describe('run-worker tenant stamping (SEC-M-01-EXTENDED)', () => {
  it('stamps tenantId on agent:started and agent:completed when job.metadata.tenantId is set', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'agent-tenant',
      name: 'Agent Tenant',
      instructions: 'be concise',
      modelTier: 'chat',
      active: true,
    })

    const emitted: DzupEvent[] = []
    eventBus.onAny((event) => emitted.push(event))

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'ok' }),
    })

    const run = await runStore.create({ agentId: 'agent-tenant', input: { message: 'hi' } })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'agent-tenant',
      input: { message: 'hi' },
      metadata: { tenantId: 'tenant-A' },
      priority: 1,
    })

    await waitForCompleted(runStore, run.id)

    const started = emitted.find((event) => event.type === 'agent:started') as DzupEvent & WithTenant
    const completed = emitted.find((event) => event.type === 'agent:completed') as DzupEvent & WithTenant
    expect(started, 'expected agent:started to be emitted').toBeDefined()
    expect(completed, 'expected agent:completed to be emitted').toBeDefined()
    expect(started.tenantId).toBe('tenant-A')
    expect(completed.tenantId).toBe('tenant-A')

    await runQueue.stop(false)
  })

  it('omits tenantId on agent:started and agent:completed when metadata has no tenantId (legacy single-tenant)', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'agent-untenanted',
      name: 'Agent Untenanted',
      instructions: 'be concise',
      modelTier: 'chat',
      active: true,
    })

    const emitted: DzupEvent[] = []
    eventBus.onAny((event) => emitted.push(event))

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'ok' }),
    })

    const run = await runStore.create({ agentId: 'agent-untenanted', input: {} })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'agent-untenanted',
      input: {},
      priority: 1,
    })

    await waitForCompleted(runStore, run.id)

    const started = emitted.find((event) => event.type === 'agent:started') as DzupEvent & WithTenant
    const completed = emitted.find((event) => event.type === 'agent:completed') as DzupEvent & WithTenant
    expect(started).toBeDefined()
    expect(completed).toBeDefined()
    // No tenant stamp; gateway will fall back to DEFAULT_TENANT_ID. We assert
    // the field is absent (not `undefined`) so envelopes stay tidy on the wire.
    expect('tenantId' in started).toBe(false)
    expect('tenantId' in completed).toBe(false)

    await runQueue.stop(false)
  })
})
