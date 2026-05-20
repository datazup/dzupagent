import { extractTraceContext } from '@dzupagent/core/utils'
import type { ForgeTraceContext } from '@dzupagent/otel'
import { createInputGuard, type InputGuard } from '../security/input-guard.js'
import {
  dispatchExecutionStage,
  persistCancellation,
  persistFailure,
  persistTerminalSuccess,
  recordTelemetryStage,
  runAdmissionStage,
  runPostRunLearningStage,
  throwIfAborted,
  waitForRunApproval,
} from './run-worker-stages.js'

// Re-export shared types for backward compatibility. The canonical home is
// `./run-worker-types.ts` — these re-exports preserve the long-standing
// import surface (`from './run-worker.js'`) used by composition modules,
// `runtime.ts`, and the executor implementations.
export type {
  EscalationPolicyLike,
  EscalationResultLike,
  ReflectionDimensions,
  ReflectionInput,
  ReflectionScore,
  RunExecutionContext,
  RunExecutor,
  RunExecutorResult,
  RunOutcomeAnalyzerLike,
  RunReflectorLike,
  StartRunWorkerOptions,
} from './run-worker-types.js'

import type { StartRunWorkerOptions } from './run-worker-types.js'

/**
 * Start the queue worker that transitions queued runs to terminal states.
 */
export function startRunWorker(options: StartRunWorkerOptions): void {
  const executableAgentResolver = options.executableAgentResolver ?? {
    resolve: (agentId: string) => options.agentStore.get(agentId),
  }

  // MC-S03: Construct the InputGuard once per worker. A single guard
  // instance (with its internal SafetyMonitor) is reused across runs to
  // avoid rebuilding the scanner's pattern set per job. When the host
  // passes `inputGuardConfig: false`, scanning is disabled entirely.
  const inputGuard: InputGuard | null =
    options.inputGuardConfig === false
      ? null
      : createInputGuard(options.inputGuardConfig)

  options.runQueue.start(async (job, signal) => {
    const startedAt = Date.now()
    options.shutdown?.trackRun(job.runId)

    // SEC-M-01-EXTENDED — stamp every envelope emitted from this worker
    // closure with the job's owning tenant. Mirrors the helper pattern in
    // `dzip-agent-run-executor.ts`. When `metadata.tenantId` is absent the
    // event is emitted without a `tenantId` field (NOT with `undefined`),
    // preserving the legacy single-tenant `DEFAULT_TENANT_ID` fallback in
    // the event gateway.
    const tenantId =
      typeof job.metadata?.['tenantId'] === 'string'
        ? (job.metadata['tenantId'] as string)
        : undefined
    const withTenant = <T extends object>(event: T): T & { tenantId?: string } =>
      tenantId !== undefined ? { ...event, tenantId } : event

    let traceId: string | undefined
    let forgeTraceContext: ForgeTraceContext | undefined
    try {
      const traceCtx = extractTraceContext(job.metadata as Record<string, unknown> | undefined)
      traceId = traceCtx?.traceId
      if (traceCtx) {
        forgeTraceContext = {
          traceId: traceCtx.traceId,
          spanId: traceCtx.spanId,
          agentId: job.agentId,
          runId: job.runId,
          tenantId: typeof job.metadata?.['tenantId'] === 'string'
            ? job.metadata['tenantId']
            : undefined,
          baggage: {},
        }
      }
    } catch {
      // Trace extraction is non-fatal.
    }

    try {
      throwIfAborted(signal)

      const admission = await runAdmissionStage({
        job,
        inputGuard,
        runStore: options.runStore,
        eventBus: options.eventBus,
        traceStore: options.traceStore,
        resolveAgent: (agentId) => executableAgentResolver.resolve(agentId),
      })
      if (admission.rejected) return

      const { agent, input: jobInput } = admission
      await options.runStore.update(job.runId, { status: 'running' })

      if (options.traceStore) {
        await options.traceStore.startTrace(job.runId, job.agentId)
        await options.traceStore.addStep(job.runId, {
          timestamp: Date.now(),
          type: 'user_input',
          content: jobInput,
          metadata: job.metadata ? { ...job.metadata } : undefined,
        })
      }

      await options.runStore.addLog(job.runId, {
        level: 'info',
        phase: 'queue',
        message: 'Run dequeued for execution',
        data: { jobId: job.id, ...(traceId ? { traceId } : {}) },
      })
      options.eventBus.emit(withTenant({ type: 'agent:started', agentId: job.agentId, runId: job.runId }))

      const approved = await waitForRunApproval({
        agent,
        job,
        input: jobInput,
        runStore: options.runStore,
        eventBus: options.eventBus,
        traceStore: options.traceStore,
      })
      if (!approved) return

      throwIfAborted(signal)
      const execution = await dispatchExecutionStage({
        workerOptions: options,
        job,
        agent,
        input: jobInput,
        signal,
        forgeTraceContext,
      })

      // Guard: don't overwrite terminal state if cancelled during execution.
      throwIfAborted(signal)

      const terminal = await persistTerminalSuccess({
        runStore: options.runStore,
        traceStore: options.traceStore,
        job,
        execution,
        startedAt,
        traceId,
      })

      await runPostRunLearningStage({
        workerOptions: options,
        job,
        agent,
        input: jobInput,
        output: execution.output,
        tokenUsage: execution.tokenUsage,
        metadata: execution.metadata,
        additionalLogs: execution.additionalLogs,
        durationMs: terminal.durationMs,
      })

      options.eventBus.emit(withTenant({
        type: 'agent:completed',
        agentId: job.agentId,
        runId: job.runId,
        durationMs: terminal.durationMs,
      }))

      await recordTelemetryStage({
        workerOptions: options,
        job,
        durationMs: terminal.durationMs,
        tokenUsage: execution.tokenUsage,
      })
    } catch (error) {
      if (signal.aborted) {
        await persistCancellation({
          runStore: options.runStore,
          eventBus: options.eventBus,
          traceStore: options.traceStore,
          job,
        })
        return
      }

      await persistFailure({
        runStore: options.runStore,
        eventBus: options.eventBus,
        traceStore: options.traceStore,
        job,
        error,
        traceId,
      })
    } finally {
      options.shutdown?.untrackRun(job.runId)
    }
  })
}
