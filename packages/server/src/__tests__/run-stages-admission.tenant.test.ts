import { describe, it, expect } from 'vitest'
import { createEventBus, InMemoryRunStore, type DzupEvent } from '@dzupagent/core'
import type { AgentExecutionSpec } from '@dzupagent/core/persistence'
import type { RunJob } from '../queue/run-queue.js'
import {
  runAdmissionStage,
  waitForRunApproval,
} from '../runtime/run-stages-admission.js'
import { InMemoryTenantRunQuota } from '../security/tenant-run-quota.js'

/**
 * SEC-M-01-EXTENDED — admission and approval emit sites must stamp
 * `tenantId` on every envelope when `job.metadata.tenantId` is set:
 *   - agent:failed (REGISTRY_AGENT_NOT_FOUND)  — runAdmissionStage
 *   - approval:requested                        — waitForRunApproval
 *   - agent:failed (APPROVAL_REJECTED)          — waitForRunApproval
 */

type WithTenant = { tenantId?: string }

function makeJob(overrides: Partial<RunJob> = {}): RunJob {
  return {
    id: 'job-1',
    runId: 'run-admission-1',
    agentId: 'agent-admission',
    input: {},
    metadata: { tenantId: 'tenant-A' },
    priority: 1,
    attempts: 0,
    createdAt: new Date(),
    ...overrides,
  }
}

describe('run-stages-admission tenant stamping (SEC-M-01-EXTENDED)', () => {
  it('stamps tenantId on agent:failed when the agent is not found', async () => {
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const emitted: DzupEvent[] = []
    eventBus.onAny((event) => { emitted.push(event) })

    await runStore.create({ agentId: 'missing', input: {} })
    const job = makeJob({ agentId: 'missing' })

    const result = await runAdmissionStage({
      job,
      inputGuard: null,
      runStore,
      eventBus,
      resolveAgent: async () => null,
    })

    expect(result.rejected).toBe(true)
    const failed = emitted.find((event) => event.type === 'agent:failed') as DzupEvent & WithTenant
    expect(failed).toBeDefined()
    expect(failed.tenantId).toBe('tenant-A')
  })

  it('omits tenantId when job.metadata has no tenantId (legacy single-tenant)', async () => {
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const emitted: DzupEvent[] = []
    eventBus.onAny((event) => { emitted.push(event) })

    await runStore.create({ agentId: 'missing', input: {} })
    const job = makeJob({ agentId: 'missing', metadata: undefined })

    await runAdmissionStage({
      job,
      inputGuard: null,
      runStore,
      eventBus,
      resolveAgent: async () => null,
    })

    const failed = emitted.find((event) => event.type === 'agent:failed') as DzupEvent & WithTenant
    expect(failed).toBeDefined()
    expect('tenantId' in failed).toBe(false)
  })

  it('stamps tenantId on approval:requested and on agent:failed when approval is rejected', async () => {
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const emitted: DzupEvent[] = []
    eventBus.onAny((event) => { emitted.push(event) })

    await runStore.create({ agentId: 'approval-agent', input: {} })
    const job = makeJob({ agentId: 'approval-agent', metadata: { tenantId: 'tenant-B', approvalTimeoutMs: 5000 } })

    const agent: AgentExecutionSpec = {
      id: 'approval-agent',
      name: 'Approval Agent',
      instructions: 'wait for approval',
      modelTier: 'chat',
      approval: 'required',
    }

    // Reject the approval shortly after the wait begins.
    setTimeout(() => {
      eventBus.emit({ type: 'approval:rejected', runId: job.runId, reason: 'policy reject' })
    }, 10)

    const approved = await waitForRunApproval({
      agent,
      job,
      input: job.input,
      runStore,
      eventBus,
    })

    expect(approved).toBe(false)

    const requested = emitted.find((event) => event.type === 'approval:requested') as DzupEvent & WithTenant
    const rejected = emitted.find((event) => event.type === 'agent:failed') as DzupEvent & WithTenant
    expect(requested).toBeDefined()
    expect(rejected).toBeDefined()
    expect(requested.tenantId).toBe('tenant-B')
    expect(rejected.tenantId).toBe('tenant-B')
  })
})

/**
 * DZUPAGENT-SEC-M-05 — the per-tenant concurrent-run cap is server-side.
 * A job's `metadata.tenantRunLimit` hint may tighten it but can never raise
 * it above the default cap or disable it.
 */
describe('run-stages-admission tenant run cap (DZUPAGENT-SEC-M-05)', () => {
  const agent: AgentExecutionSpec = {
    id: 'quota-agent',
    name: 'Quota Agent',
    instructions: 'run',
    modelTier: 'chat',
  }

  async function admit(active: number, metadata: Record<string, unknown>) {
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const emitted: DzupEvent[] = []
    eventBus.onAny((event) => { emitted.push(event) })
    const quota = new InMemoryTenantRunQuota()
    for (let i = 0; i < active; i++) quota.increment('tenant-A')

    const run = await runStore.create({ agentId: 'quota-agent', input: {} })
    const job = makeJob({ runId: run.id, agentId: 'quota-agent', metadata: { tenantId: 'tenant-A', ...metadata } })

    const result = await runAdmissionStage({
      job,
      inputGuard: null,
      runStore,
      eventBus,
      resolveAgent: async () => agent,
      tenantRunQuota: quota,
    })
    const failed = emitted.find((event) => event.type === 'agent:failed') as
      | (DzupEvent & { errorCode?: string })
      | undefined
    return { result, failed, stored: await runStore.get(run.id), quota }
  }

  function expectRejected(outcome: Awaited<ReturnType<typeof admit>>) {
    expect(outcome.result.rejected).toBe(true)
    expect(outcome.failed?.errorCode).toBe('TENANT_QUOTA_EXCEEDED')
    expect(outcome.stored?.status).toBe('rejected')
  }

  it('rejects at the default cap when the hint is 0 (cannot disable the cap)', async () => {
    expectRejected(await admit(20, { tenantRunLimit: 0 }))
  })

  it('rejects at the default cap when the hint is larger (cannot raise the cap)', async () => {
    expectRejected(await admit(20, { tenantRunLimit: 1000 }))
  })

  it.each([-1, 2.5, '0'])('ignores the invalid hint %j and applies the default cap', async (hint) => {
    expectRejected(await admit(20, { tenantRunLimit: hint }))
  })

  it('honours a smaller positive integer hint', async () => {
    expectRejected(await admit(2, { tenantRunLimit: 2 }))
  })

  it('admits below the default cap without a hint and reserves a slot', async () => {
    const outcome = await admit(19, {})
    expect(outcome.result.rejected).toBe(false)
    expect(outcome.failed).toBeUndefined()
    expect(outcome.quota.snapshot()['tenant-A']).toBe(20)
  })
})
