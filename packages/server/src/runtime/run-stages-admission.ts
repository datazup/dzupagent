import type { DzupEventBus } from '@dzupagent/core/events'
import type { AgentExecutionSpec, RunStore } from '@dzupagent/core/persistence'
import type { RunTraceStore } from '../persistence/run-trace-store.js'
import type { RunJob } from '../queue/run-queue.js'
import type { InputGuard } from '../security/input-guard.js'
import { closeTraceWithTerminalStep } from './run-stages-utils.js'

/**
 * SEC-M-01-EXTENDED — stamp an event envelope with the job's owning tenant
 * when present. Mirrors the closure helper in `run-worker.ts` and
 * `dzip-agent-run-executor.ts`. Returns the event unchanged when the job
 * has no `metadata.tenantId`, preserving the gateway's legacy
 * `DEFAULT_TENANT_ID` fallback for single-tenant deployments.
 */
function stampTenant<T extends object>(event: T, job: RunJob): T & { tenantId?: string } {
  const tenantId =
    typeof job.metadata?.['tenantId'] === 'string'
      ? (job.metadata['tenantId'] as string)
      : undefined
  return tenantId !== undefined ? { ...event, tenantId } : event
}

export type AdmissionStageResult =
  | { agent: AgentExecutionSpec; input: unknown; rejected: false }
  | { agent?: AgentExecutionSpec; input: unknown; rejected: true }

export async function runAdmissionStage(options: {
  job: RunJob
  inputGuard: InputGuard | null
  runStore: RunStore
  eventBus: DzupEventBus
  traceStore?: RunTraceStore
  resolveAgent(agentId: string): Promise<AgentExecutionSpec | null>
}): Promise<AdmissionStageResult> {
  const agent = await options.resolveAgent(options.job.agentId)
  if (!agent) {
    await options.runStore.update(options.job.runId, {
      status: 'failed',
      error: `Agent "${options.job.agentId}" not found`,
      completedAt: new Date(),
    })
    options.eventBus.emit(stampTenant({
      type: 'agent:failed',
      agentId: options.job.agentId,
      runId: options.job.runId,
      errorCode: 'REGISTRY_AGENT_NOT_FOUND',
      message: `Agent "${options.job.agentId}" not found`,
    }, options.job))
    return { input: options.job.input, rejected: true }
  }

  let input: unknown = options.job.input
  if (!options.inputGuard) {
    return { agent, input, rejected: false }
  }

  const guardResult = await options.inputGuard.scan(options.job.input)
  if (!guardResult.allowed) {
    const reason = guardResult.reason ?? 'Rejected by input guard'
    await options.runStore.update(options.job.runId, {
      status: 'rejected',
      error: reason,
      completedAt: new Date(),
    })
    await options.runStore.addLog(options.job.runId, {
      level: 'warn',
      phase: 'security',
      message: `Input guard rejected run: ${reason}`,
      data: {
        violations: guardResult.violations?.map((v) => ({
          category: v.category,
          severity: v.severity,
          action: v.action,
        })),
      },
    })
    options.eventBus.emit(stampTenant({
      type: 'agent:failed',
      agentId: options.job.agentId,
      runId: options.job.runId,
      errorCode: 'POLICY_DENIED',
      message: reason,
    }, options.job))
    await closeTraceWithTerminalStep(
      options.traceStore,
      options.job.runId,
      'rejected',
      { reason, guardedBy: 'input-guard' },
    )
    return { agent, input, rejected: true }
  }

  if (guardResult.redactedInput !== undefined) {
    input = guardResult.redactedInput
    await options.runStore.update(options.job.runId, { input })
    await options.runStore.addLog(options.job.runId, {
      level: 'info',
      phase: 'security',
      message: 'Input guard redacted PII in run input',
    })
  }

  return { agent, input, rejected: false }
}

export async function waitForRunApproval(options: {
  agent: AgentExecutionSpec
  job: RunJob
  input: unknown
  runStore: RunStore
  eventBus: DzupEventBus
  traceStore?: RunTraceStore
}): Promise<boolean> {
  if (options.agent.approval !== 'required') {
    return true
  }

  const timeoutMs = typeof options.job.metadata?.['approvalTimeoutMs'] === 'number'
    ? Number(options.job.metadata['approvalTimeoutMs'])
    : 60_000

  await options.runStore.update(options.job.runId, {
    status: 'awaiting_approval',
    plan: { input: options.input, metadata: options.job.metadata },
  })
  await options.runStore.addLog(options.job.runId, {
    level: 'info',
    phase: 'approval',
    message: 'Awaiting approval before execution',
    data: { timeoutMs },
  })
  options.eventBus.emit(stampTenant({ type: 'approval:requested', runId: options.job.runId, plan: { input: options.input } }, options.job))

  const decision = await waitForApprovalDecision(options.eventBus, options.job.runId, timeoutMs)
  if (!decision.approved) {
    await options.runStore.update(options.job.runId, {
      status: 'rejected',
      error: decision.reason ?? 'Rejected by policy',
      completedAt: new Date(),
    })
    await options.runStore.addLog(options.job.runId, {
      level: 'warn',
      phase: 'approval',
      message: `Run rejected before execution: ${decision.reason ?? 'no reason provided'}`,
    })
    options.eventBus.emit(stampTenant({
      type: 'agent:failed',
      agentId: options.job.agentId,
      runId: options.job.runId,
      errorCode: 'APPROVAL_REJECTED',
      message: decision.reason ?? 'Run rejected by approval policy',
    }, options.job))
    await closeTraceWithTerminalStep(
      options.traceStore,
      options.job.runId,
      'rejected',
      { reason: decision.reason ?? 'Run rejected by approval policy' },
    )
    return false
  }

  await options.runStore.update(options.job.runId, { status: 'running' })
  await options.runStore.addLog(options.job.runId, {
    level: 'info',
    phase: 'approval',
    message: 'Approval granted, proceeding with execution',
  })
  return true
}

async function waitForApprovalDecision(
  eventBus: DzupEventBus,
  runId: string,
  timeoutMs: number,
): Promise<{ approved: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const unsubGrant = eventBus.on('approval:granted', (event) => {
      if (event.runId !== runId) return
      unsubGrant()
      unsubReject()
      clearTimeout(timer)
      resolve({ approved: true })
    })

    const unsubReject = eventBus.on('approval:rejected', (event) => {
      if (event.runId !== runId) return
      unsubGrant()
      unsubReject()
      clearTimeout(timer)
      resolve({ approved: false, reason: event.reason })
    })

    const timer = setTimeout(() => {
      unsubGrant()
      unsubReject()
      resolve({ approved: false, reason: `Approval timed out after ${timeoutMs}ms` })
    }, timeoutMs)
  })
}
