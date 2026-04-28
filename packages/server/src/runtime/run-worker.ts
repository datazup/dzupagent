import type { AgentExecutionSpec, ModelRegistry, RunContextTransfer, RunStore, MetricsCollector } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'
import { extractTraceContext } from '@dzupagent/core'
import type { ForgeTraceContext } from '@dzupagent/otel'
import type { CompressionLogEntry, RunReflectionStore } from '@dzupagent/agent'
import type { RunQueue } from '../queue/run-queue.js'
import type { GracefulShutdown } from '../lifecycle/graceful-shutdown.js'
import type { RunTraceStore } from '../persistence/run-trace-store.js'
import type { ExecutableAgentResolver } from '../services/executable-agent-resolver.js'
import type { ResourceQuotaManager } from '../security/resource-quota.js'
import { createInputGuard, type InputGuard, type InputGuardConfig } from '../security/input-guard.js'
import { type RetrievalFeedbackHookConfig } from './retrieval-feedback-hook.js'
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

export interface RunExecutionContext {
  runId: string
  agentId: string
  input: unknown
  metadata?: Record<string, unknown>
  agent: AgentExecutionSpec
  runStore: RunStore
  eventBus: DzupEventBus
  modelRegistry: ModelRegistry
  signal: AbortSignal
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
  /**
   * Session Y: compression events observed during the run.
   *
   * Populated when the underlying agent emitted one or more auto-compression
   * events (see {@link GenerateResult.compressionLog}). The run-worker merges
   * this list into `run.metadata.compressionLog` so telemetry consumers can
   * inspect when (and by how much) the conversation was compacted without
   * reading intermediate agent state.
   */
  compressionLog?: CompressionLogEntry[]
}

export type RunExecutor = (context: RunExecutionContext) => Promise<unknown | RunExecutorResult>

// ---------------------------------------------------------------------------
// Structural types for RunReflector (avoids hard dependency on @dzupagent/agent)
// ---------------------------------------------------------------------------

/** Individual dimension scores, each in the range [0, 1]. */
export interface ReflectionDimensions {
  completeness: number
  coherence: number
  toolSuccess: number
  conciseness: number
  reliability: number
}

/** Full reflection score returned by a reflector's `score()` method. */
export interface ReflectionScore {
  overall: number
  dimensions: ReflectionDimensions
  flags: string[]
}

/** Input data required for scoring a run. */
export interface ReflectionInput {
  input: unknown
  output: unknown
  toolCalls?: Array<{ name: string; success: boolean; durationMs?: number }>
  tokenUsage?: { input: number; output: number }
  durationMs: number
  errorCount?: number
  retryCount?: number
}

/** Structural type matching RunReflector.score() without importing the class. */
export interface RunReflectorLike {
  score(input: ReflectionInput): ReflectionScore
}

/** Structural type for the escalation policy result (avoids importing @dzupagent/core). */
export interface EscalationResultLike {
  shouldEscalate: boolean
  fromTier: string
  toTier: string
  reason: string
  consecutiveLowScores: number
}

/** Structural type for a model tier escalation policy. */
export interface EscalationPolicyLike {
  recordScore(key: string, score: number, currentTier: string): EscalationResultLike
}

export interface StartRunWorkerOptions {
  runQueue: RunQueue
  runStore: RunStore
  executableAgentResolver?: ExecutableAgentResolver
  agentStore: {
    get(id: string): Promise<AgentExecutionSpec | null>
    save?(agent: AgentExecutionSpec): Promise<void>
  }
  eventBus: DzupEventBus
  modelRegistry: ModelRegistry
  runExecutor: RunExecutor
  shutdown?: GracefulShutdown
  /** Optional cross-intent context transfer. When provided, context is
   *  loaded before each run and saved after successful completion. */
  contextTransfer?: RunContextTransfer
  /** Optional metrics collector for run-level observability */
  metrics?: MetricsCollector
  /** Optional run reflector — scores every completed run for quality tracking.
   *  Uses structural typing to avoid a hard dependency on @dzupagent/agent. */
  reflector?: RunReflectorLike
  /** Optional retrieval feedback config. When provided alongside a reflector,
   *  maps reflection scores to AdaptiveRetriever feedback for weight learning. */
  retrievalFeedback?: RetrievalFeedbackHookConfig
  /** Optional trace store for step-by-step run replay and debugging.
   *  When provided, bookend steps (user_input, output) are recorded automatically. */
  traceStore?: RunTraceStore
  /** Optional model tier escalation policy. When provided alongside a reflector,
   *  auto-escalates the agent's model tier after consecutive low reflection scores. */
  escalationPolicy?: EscalationPolicyLike
  /** Optional reflection store — persists a ReflectionSummary after each completed run
   *  when a reflector is configured. Failure to save is non-fatal. */
  reflectionStore?: RunReflectionStore
  /** Optional run outcome analyzer — scores persisted run events via eval
   *  scorers and emits `run:scored`. Any failure is swallowed and surfaced
   *  via the analyzer's `onError` hook. */
  runOutcomeAnalyzer?: RunOutcomeAnalyzerLike
  /**
   * MC-S03: Optional {@link InputGuard} configuration.
   * - `undefined` (default): a standard guard with built-in rules is created.
   * - `false`: scanning is disabled entirely (all inputs flow through).
   * - An {@link InputGuardConfig}: supplies custom length caps / PII flag /
   *   injected safety monitor.
   *
   * When the guard rejects input, the run terminates in `'rejected'` status
   * before the executor is invoked. When the guard returns a redacted copy,
   * the redacted value replaces the raw input for dispatch and is persisted
   * on the run record so downstream readers see the sanitized payload.
   */
  inputGuardConfig?: InputGuardConfig | false
  /**
   * MC-S01: Optional per-key {@link ResourceQuotaManager}. When provided,
   * actual token usage from each completed run is fed back via
   * `recordUsage(keyId, tokensUsed)` so the next admission check (in
   * `handleCreateRun`) sees an up-to-date sliding-window total. The key id
   * is read from `job.metadata.ownerId` (stamped at run creation). Quota
   * enforcement itself lives at the HTTP boundary — the worker only
   * attributes consumption after completion.
   */
  resourceQuota?: ResourceQuotaManager
}

/** Structural type for RunOutcomeAnalyzer — avoids a hard dep on the service module. */
export interface RunOutcomeAnalyzerLike {
  analyze(
    runId: string,
    options?: { agentId?: string; input?: string; output?: string; reference?: string },
  ): Promise<unknown>
}

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
      options.eventBus.emit({ type: 'agent:started', agentId: job.agentId, runId: job.runId })

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

      options.eventBus.emit({
        type: 'agent:completed',
        agentId: job.agentId,
        runId: job.runId,
        durationMs: terminal.durationMs,
      })

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
