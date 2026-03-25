import type { AgentDefinition, ModelRegistry, RunStore } from '@forgeagent/core'
import type { ForgeEventBus } from '@forgeagent/core'
import type { RunQueue } from '../queue/run-queue.js'
import type { GracefulShutdown } from '../lifecycle/graceful-shutdown.js'
import { isStructuredResult } from './utils.js'

export interface RunExecutionContext {
  runId: string
  agentId: string
  input: unknown
  metadata?: Record<string, unknown>
  agent: AgentDefinition
  runStore: RunStore
  eventBus: ForgeEventBus
  modelRegistry: ModelRegistry
}

export interface RunExecutorResult {
  output: unknown
  tokenUsage?: { input: number; output: number }
  costCents?: number
  metadata?: Record<string, unknown>
  logs?: Array<{
    level: 'info' | 'warn' | 'error' | 'debug'
    phase?: string
    message: string
    data?: unknown
  }>
}

export type RunExecutor = (context: RunExecutionContext) => Promise<unknown | RunExecutorResult>

export interface StartRunWorkerOptions {
  runQueue: RunQueue
  runStore: RunStore
  agentStore: { get(id: string): Promise<AgentDefinition | null> }
  eventBus: ForgeEventBus
  modelRegistry: ModelRegistry
  runExecutor: RunExecutor
  shutdown?: GracefulShutdown
}

async function waitForApprovalDecision(
  eventBus: ForgeEventBus,
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

/**
 * Start the queue worker that transitions queued runs to terminal states.
 */
export function startRunWorker(options: StartRunWorkerOptions): void {
  options.runQueue.start(async (job) => {
    const startedAt = Date.now()
    options.shutdown?.trackRun(job.runId)

    try {
      const agent = await options.agentStore.get(job.agentId)
      if (!agent) {
        await options.runStore.update(job.runId, {
          status: 'failed',
          error: `Agent "${job.agentId}" not found`,
          completedAt: new Date(),
        })
        options.eventBus.emit({
          type: 'agent:failed',
          agentId: job.agentId,
          runId: job.runId,
          errorCode: 'REGISTRY_AGENT_NOT_FOUND',
          message: `Agent "${job.agentId}" not found`,
        })
        return
      }

      await options.runStore.update(job.runId, { status: 'running' })
      await options.runStore.addLog(job.runId, {
        level: 'info',
        phase: 'queue',
        message: 'Run dequeued for execution',
        data: { jobId: job.id },
      })
      options.eventBus.emit({ type: 'agent:started', agentId: job.agentId, runId: job.runId })

      if (agent.approval === 'required') {
        const timeoutMs = typeof job.metadata?.['approvalTimeoutMs'] === 'number'
          ? Number(job.metadata['approvalTimeoutMs'])
          : 60_000

        await options.runStore.update(job.runId, {
          status: 'awaiting_approval',
          plan: { input: job.input, metadata: job.metadata },
        })
        await options.runStore.addLog(job.runId, {
          level: 'info',
          phase: 'approval',
          message: 'Awaiting approval before execution',
          data: { timeoutMs },
        })
        options.eventBus.emit({ type: 'approval:requested', runId: job.runId, plan: { input: job.input } })

        const decision = await waitForApprovalDecision(options.eventBus, job.runId, timeoutMs)
        if (!decision.approved) {
          await options.runStore.update(job.runId, {
            status: 'rejected',
            error: decision.reason ?? 'Rejected by policy',
            completedAt: new Date(),
          })
          await options.runStore.addLog(job.runId, {
            level: 'warn',
            phase: 'approval',
            message: `Run rejected before execution: ${decision.reason ?? 'no reason provided'}`,
          })
          options.eventBus.emit({
            type: 'agent:failed',
            agentId: job.agentId,
            runId: job.runId,
            errorCode: 'APPROVAL_REJECTED',
            message: decision.reason ?? 'Run rejected by approval policy',
          })
          return
        }

        await options.runStore.update(job.runId, { status: 'running' })
        await options.runStore.addLog(job.runId, {
          level: 'info',
          phase: 'approval',
          message: 'Approval granted, proceeding with execution',
        })
      }

      const execution = await options.runExecutor({
        runId: job.runId,
        agentId: job.agentId,
        input: job.input,
        metadata: job.metadata,
        agent,
        runStore: options.runStore,
        eventBus: options.eventBus,
        modelRegistry: options.modelRegistry,
      })

      const output = isStructuredResult(execution) ? execution.output : execution
      const tokenUsage = isStructuredResult(execution) ? execution.tokenUsage : undefined
      const costCents = isStructuredResult(execution) ? execution.costCents : undefined
      const metadata = isStructuredResult(execution) ? execution.metadata : undefined
      const additionalLogs = isStructuredResult(execution) ? execution.logs ?? [] : []

      const durationMs = Date.now() - startedAt
      await options.runStore.update(job.runId, {
        status: 'completed',
        output,
        ...(tokenUsage ? { tokenUsage } : {}),
        ...(typeof costCents === 'number' ? { costCents } : {}),
        ...(metadata ? { metadata: { ...(job.metadata ?? {}), ...metadata } } : {}),
        completedAt: new Date(),
      })
      await options.runStore.addLog(job.runId, {
        level: 'info',
        phase: 'run',
        message: 'Run completed',
        data: { durationMs },
      })
      for (const log of additionalLogs) {
        await options.runStore.addLog(job.runId, {
          level: log.level,
          phase: log.phase,
          message: log.message,
          data: log.data,
        })
      }
      options.eventBus.emit({
        type: 'agent:completed',
        agentId: job.agentId,
        runId: job.runId,
        durationMs,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await options.runStore.update(job.runId, {
        status: 'failed',
        error: message,
        completedAt: new Date(),
      })
      await options.runStore.addLog(job.runId, {
        level: 'error',
        phase: 'run',
        message: 'Run failed',
        data: { error: message },
      })
      options.eventBus.emit({
        type: 'agent:failed',
        agentId: job.agentId,
        runId: job.runId,
        errorCode: 'INTERNAL_ERROR',
        message,
      })
    } finally {
      options.shutdown?.untrackRun(job.runId)
    }
  })
}
