import { describe, it, expect } from 'vitest'
import { createEventBus, InMemoryRunStore, type DzupEvent } from '@dzupagent/core'
import type { AgentExecutionSpec } from '@dzupagent/core/persistence'
import type { RunJob } from '../queue/run-queue.js'
import {
  runAdmissionStage,
  waitForRunApproval,
} from '../runtime/run-stages-admission.js'

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
    eventBus.onAny((event) => emitted.push(event))

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
    eventBus.onAny((event) => emitted.push(event))

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
    eventBus.onAny((event) => emitted.push(event))

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
