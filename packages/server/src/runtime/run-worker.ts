import type { AgentExecutionSpec, ModelRegistry, RunStore, MetricsCollector } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'
import type { RunContextTransfer, PersistedIntentContext } from '@dzupagent/core'
import { withForgeContext, type ForgeTraceContext } from '@dzupagent/otel'
import type { RunQueue } from '../queue/run-queue.js'
import type { GracefulShutdown } from '../lifecycle/graceful-shutdown.js'
import type { RunTraceStore } from '../persistence/run-trace-store.js'
import type { ExecutableAgentResolver } from '../services/executable-agent-resolver.js'
import { extractTraceContext } from '@dzupagent/core'
import { isStructuredResult, isRecord } from './utils.js'
import { reportRetrievalFeedback, type RetrievalFeedbackHookConfig } from './retrieval-feedback-hook.js'
import type { RunReflectionStore, ReflectionSummary, CompressionLogEntry } from '@dzupagent/agent'

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
}

/** Structural type for RunOutcomeAnalyzer — avoids a hard dep on the service module. */
export interface RunOutcomeAnalyzerLike {
  analyze(
    runId: string,
    options?: { agentId?: string; input?: string; output?: string; reference?: string },
  ): Promise<unknown>
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

/** Check if the signal is aborted and throw if so. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Run cancelled', 'AbortError')
  }
}

async function closeTraceWithTerminalStep(
  traceStore: RunTraceStore | undefined,
  runId: string,
  status: 'failed' | 'cancelled' | 'rejected',
  details?: Record<string, unknown>,
): Promise<void> {
  if (!traceStore) return
  await traceStore.addStep(runId, {
    timestamp: Date.now(),
    type: 'system',
    content: { status },
    metadata: details,
  })
  await traceStore.completeTrace(runId)
}

/**
 * Start the queue worker that transitions queued runs to terminal states.
 */
export function startRunWorker(options: StartRunWorkerOptions): void {
  const executableAgentResolver = options.executableAgentResolver ?? {
    resolve: (agentId: string) => options.agentStore.get(agentId),
  }

  options.runQueue.start(async (job, signal) => {
    const startedAt = Date.now()
    options.shutdown?.trackRun(job.runId)

    // Extract trace context from run metadata for log correlation.
    // Declared before try/catch so traceId is available in error handlers.
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
      // Trace extraction is non-fatal
    }

    try {
      throwIfAborted(signal)

      const agent = await executableAgentResolver.resolve(job.agentId)
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

      // --- Start trace (optional) ---
      if (options.traceStore) {
        await options.traceStore.startTrace(job.runId, job.agentId)
        await options.traceStore.addStep(job.runId, {
          timestamp: Date.now(),
          type: 'user_input',
          content: job.input,
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
          await closeTraceWithTerminalStep(
            options.traceStore,
            job.runId,
            'rejected',
            { reason: decision.reason ?? 'Run rejected by approval policy' },
          )
          return
        }

        await options.runStore.update(job.runId, { status: 'running' })
        await options.runStore.addLog(job.runId, {
          level: 'info',
          phase: 'approval',
          message: 'Approval granted, proceeding with execution',
        })
      }

      // Check cancellation before starting expensive executor work
      throwIfAborted(signal)

      // --- Load prior cross-intent context (optional) ---
      let enrichedMetadata = job.metadata
      if (options.contextTransfer) {
        try {
          const sessionId = resolveSessionId(job)
          const currentIntent = resolveIntent(job, agent)
          if (currentIntent && currentIntent !== 'unknown') {
            const priorContext = await options.contextTransfer.loadForIntent(sessionId, currentIntent)
            if (priorContext) {
              enrichedMetadata = { ...(job.metadata ?? {}), priorContext }
              await options.runStore.addLog(job.runId, {
                level: 'info',
                phase: 'context-transfer',
                message: `Loaded prior context from intent "${priorContext.fromIntent}"`,
                data: { fromIntent: priorContext.fromIntent, tokenEstimate: priorContext.tokenEstimate },
              })
            }
          }
        } catch (_err) {
          // Context loading is best-effort — never block the run
          await options.runStore.addLog(job.runId, {
            level: 'warn',
            phase: 'context-transfer',
            message: 'Failed to load prior context',
            data: { error: _err instanceof Error ? _err.message : String(_err) },
          }).catch(() => { /* swallow nested failure */ })
        }
      }

      const executeRun = () => options.runExecutor({
        runId: job.runId,
        agentId: job.agentId,
        input: job.input,
        metadata: enrichedMetadata,
        agent,
        runStore: options.runStore,
        eventBus: options.eventBus,
        modelRegistry: options.modelRegistry,
        signal,
      })
      const execution = forgeTraceContext
        ? await withForgeContext(forgeTraceContext, executeRun)
        : await executeRun()

      // Guard: don't overwrite terminal state if cancelled during execution
      throwIfAborted(signal)

      const output = isStructuredResult(execution) ? execution.output : execution
      const tokenUsage = isStructuredResult(execution) ? execution.tokenUsage : undefined
      const costCents = isStructuredResult(execution) ? execution.costCents : undefined
      const metadata = isStructuredResult(execution) ? execution.metadata : undefined
      const additionalLogs = isStructuredResult(execution) ? execution.logs ?? [] : []
      // Session Y: when the executor returns a GenerateResult-style result with
      // a non-empty compressionLog, merge it into run.metadata.compressionLog so
      // downstream consumers (telemetry, replay UI) can inspect compression
      // events without reading intermediate agent state. Only merged when at
      // least one entry exists — empty lists are treated as "no compression".
      const compressionLog = isStructuredResult(execution) && execution.compressionLog && execution.compressionLog.length > 0
        ? execution.compressionLog
        : undefined
      const mergedMetadata = metadata || compressionLog
        ? {
            ...(metadata ?? {}),
            ...(compressionLog ? { compressionLog } : {}),
          }
        : undefined

      const durationMs = Date.now() - startedAt
      // Session Q: a clean halt surfaced by the executor (e.g. token exhaustion
      // via `run:halted:token-exhausted`) is NOT a failure — it is a distinct
      // terminal state. We detect it via the `halted:true` metadata flag
      // emitted by dzip-agent-run-executor.ts and map it to the formal
      // 'halted' RunStatus. The `metadata.halted` flag is preserved so older
      // readers that predate Session Q continue to work.
      const halted = metadata != null
        && typeof metadata === 'object'
        && (metadata as Record<string, unknown>)['halted'] === true

      // Session W: if the executor persisted a tokenLifecycleReport in
      // metadata, promote it to output.tokenLifecycle so clients get full
      // phase breakdown in a single REST call without reading /context.
      // Only merged when `output` is itself a plain object — scalar outputs
      // (strings, numbers) pass through unchanged.
      const tokenLifecycleForOutput = isRecord(metadata) && isRecord(metadata['tokenLifecycleReport'])
        ? metadata['tokenLifecycleReport']
        : undefined
      const finalOutput = tokenLifecycleForOutput && isRecord(output)
        ? { ...output, tokenLifecycle: tokenLifecycleForOutput }
        : output

      await options.runStore.update(job.runId, {
        status: halted ? 'halted' : 'completed',
        output: finalOutput,
        ...(tokenUsage ? { tokenUsage } : {}),
        ...(typeof costCents === 'number' ? { costCents } : {}),
        ...(mergedMetadata ? { metadata: { ...(job.metadata ?? {}), ...mergedMetadata } } : {}),
        completedAt: new Date(),
      })
      // --- Record output step and complete trace (optional) ---
      if (options.traceStore) {
        await options.traceStore.addStep(job.runId, {
          timestamp: Date.now(),
          type: 'output',
          content: output,
          metadata: {
            ...(tokenUsage ? { tokenUsage } : {}),
            ...(typeof costCents === 'number' ? { costCents } : {}),
            durationMs,
          },
          durationMs,
        })
        await options.traceStore.completeTrace(job.runId)
      }

      await options.runStore.addLog(job.runId, {
        level: 'info',
        phase: 'run',
        message: 'Run completed',
        data: { durationMs, ...(traceId ? { traceId } : {}) },
      })
      if (additionalLogs.length > 0) {
        await options.runStore.addLogs(job.runId, additionalLogs.map(log => ({
          level: log.level,
          phase: log.phase,
          message: log.message,
          data: log.data,
        })))
      }
      // --- Reflection scoring (optional) ---
      if (options.reflector) {
        try {
          const errorCount = additionalLogs.filter(l => l.level === 'error').length
          const retryCount = additionalLogs.filter(l =>
            l.phase === 'retry' || l.message.toLowerCase().includes('retry'),
          ).length

          // Extract tool call info from logs if available
          const toolCalls = additionalLogs
            .filter(l => l.phase === 'tool_call' && l.data && typeof l.data === 'object')
            .map(l => {
              const d = l.data as Record<string, unknown>
              return {
                name: typeof d['toolName'] === 'string' ? d['toolName'] : 'unknown',
                success: d['success'] !== false,
                durationMs: typeof d['durationMs'] === 'number' ? d['durationMs'] : undefined,
              }
            })

          const reflectionInput: ReflectionInput = {
            input: job.input,
            output,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            tokenUsage,
            durationMs,
            errorCount,
            retryCount,
          }

          const reflectionScore = options.reflector.score(reflectionInput)

          // Merge reflection score into run metadata
          const existingRun = await options.runStore.get(job.runId)
          const existingMeta = (existingRun?.metadata ?? {}) as Record<string, unknown>
          await options.runStore.update(job.runId, {
            metadata: { ...existingMeta, reflectionScore },
          })

          await options.runStore.addLog(job.runId, {
            level: 'info',
            phase: 'reflection',
            message: `Run quality score: ${reflectionScore.overall.toFixed(3)}`,
            data: {
              overall: reflectionScore.overall,
              dimensions: reflectionScore.dimensions,
              flags: reflectionScore.flags,
            },
          })

          // --- Persist reflection summary (optional) ---
          if (options.reflectionStore) {
            try {
              const toolCallLogs = additionalLogs.filter(
                l => l.phase === 'tool_call' && l.data && typeof l.data === 'object',
              )
              const summary: ReflectionSummary = {
                runId: job.runId,
                completedAt: new Date(),
                durationMs,
                totalSteps: additionalLogs.length,
                toolCallCount: toolCallLogs.length,
                errorCount,
                patterns: [],
                qualityScore: reflectionScore.overall,
              }
              await options.reflectionStore.save(summary)
            } catch (_saveErr) {
              // Reflection store persistence is non-fatal — never block completion
              await options.runStore.addLog(job.runId, {
                level: 'warn',
                phase: 'reflection',
                message: 'Failed to persist reflection summary',
                data: { error: _saveErr instanceof Error ? _saveErr.message : String(_saveErr) },
              }).catch(() => { /* swallow nested failure */ })
            }
          }

          // --- Retrieval feedback: closed loop from reflection → weight learning ---
          if (options.retrievalFeedback) {
            reportRetrievalFeedback(
              options.retrievalFeedback,
              (job.metadata ?? {}) as Record<string, unknown>,
              reflectionScore,
            )
          }

          // --- Auto-escalate model tier on consecutive low scores ---
          if (options.escalationPolicy) {
            const currentTier = (job.metadata?.['modelTier'] as string) ?? 'chat'
            const intent = resolveIntent(job, agent)
            const escalationKey = `${job.agentId}:${intent ?? 'default'}`
            const escalation = options.escalationPolicy.recordScore(
              escalationKey,
              reflectionScore.overall,
              currentTier,
            )

            if (escalation.shouldEscalate && options.agentStore.save) {
              try {
                const agentDef = await options.agentStore.get(job.agentId)
                if (agentDef) {
                  await options.agentStore.save({
                    ...agentDef,
                    metadata: {
                      ...agentDef.metadata,
                      modelTier: escalation.toTier,
                    },
                  })
                }
                options.eventBus.emit({
                  type: 'registry:agent_updated',
                  agentId: job.agentId,
                  fields: ['metadata.modelTier'],
                })
                await options.runStore.addLog(job.runId, {
                  level: 'info',
                  phase: 'escalation',
                  message: `Model tier escalated: ${escalation.fromTier} -> ${escalation.toTier} (${escalation.reason})`,
                  data: {
                    fromTier: escalation.fromTier,
                    toTier: escalation.toTier,
                    consecutiveLowScores: escalation.consecutiveLowScores,
                    escalationKey,
                  },
                })
              } catch (escalationError) {
                await options.runStore.addLog(job.runId, {
                  level: 'warn',
                  phase: 'escalation',
                  message: 'Model tier escalation failed',
                  data: { error: escalationError instanceof Error ? escalationError.message : String(escalationError) },
                }).catch(() => { /* swallow nested failure */ })
              }
            }
          }
        } catch (_reflErr) {
          // Reflection is best-effort — never block the completion
          await options.runStore.addLog(job.runId, {
            level: 'warn',
            phase: 'reflection',
            message: 'Failed to compute reflection score',
            data: { error: _reflErr instanceof Error ? _reflErr.message : String(_reflErr) },
          }).catch(() => { /* swallow nested failure */ })
        }
      }

      // --- Run outcome analyzer (closed-loop self-improvement) ---
      if (options.runOutcomeAnalyzer) {
        try {
          const outputText = typeof output === 'string'
            ? output
            : output && typeof output === 'object' && 'message' in output && typeof (output as { message?: unknown }).message === 'string'
              ? (output as { message: string }).message
              : JSON.stringify(output ?? '')
          const inputText = typeof job.input === 'string'
            ? job.input
            : JSON.stringify(job.input ?? '')
          const analysis = await options.runOutcomeAnalyzer.analyze(job.runId, {
            agentId: job.agentId,
            input: inputText,
            output: outputText,
          })
          // Success log — confirms run:scored was emitted on the event bus.
          // `analysis` is typed as `unknown` via the structural interface, so
          // we narrow defensively before surfacing score/passed.
          const summary = (analysis && typeof analysis === 'object')
            ? analysis as { score?: unknown; passed?: unknown }
            : null
          const score = typeof summary?.score === 'number' ? summary.score : undefined
          const passed = typeof summary?.passed === 'boolean' ? summary.passed : undefined
          await options.runStore.addLog(job.runId, {
            level: 'info',
            phase: 'run-outcome',
            message: score !== undefined
              ? `Run outcome scored: ${score.toFixed(3)} (${passed ? 'pass' : 'fail'})`
              : 'Run outcome analyzer completed',
            data: {
              ...(score !== undefined ? { score } : {}),
              ...(passed !== undefined ? { passed } : {}),
            },
          }).catch(() => { /* swallow nested failure */ })
        } catch (_analyzerErr) {
          // Scoring is best-effort — never block the completion path.
          await options.runStore.addLog(job.runId, {
            level: 'warn',
            phase: 'run-outcome',
            message: 'Run outcome analyzer failed',
            data: { error: _analyzerErr instanceof Error ? _analyzerErr.message : String(_analyzerErr) },
          }).catch(() => { /* swallow nested failure */ })
        }
      }

      // --- Save cross-intent context after successful run (optional) ---
      if (options.contextTransfer) {
        try {
          const sessionId = resolveSessionId(job)
          const intent = resolveIntent(job, agent)
          if (intent && intent !== 'unknown') {
            const outputSummary = typeof output === 'string'
              ? output.slice(0, 500)
              : typeof output === 'object' && output !== null && 'summary' in output
                ? String((output as Record<string, unknown>).summary).slice(0, 500)
                : 'Run completed'

            const relevantFiles: string[] =
              (metadata?.['relevantFiles'] as string[] | undefined)
              ?? (job.metadata?.['relevantFiles'] as string[] | undefined)
              ?? []

            const workingState: Record<string, unknown> =
              (metadata?.['workingState'] as Record<string, unknown> | undefined)
              ?? (job.metadata?.['workingState'] as Record<string, unknown> | undefined)
              ?? {}

            const persistedContext: PersistedIntentContext = {
              fromIntent: intent,
              summary: outputSummary,
              decisions: (metadata?.['decisions'] as string[] | undefined) ?? [],
              relevantFiles,
              workingState,
              transferredAt: Date.now(),
              tokenEstimate: (tokenUsage?.input ?? 0) + (tokenUsage?.output ?? 0),
            }

            await options.contextTransfer.save(sessionId, persistedContext)
            await options.runStore.addLog(job.runId, {
              level: 'info',
              phase: 'context-transfer',
              message: `Saved context for intent "${intent}"`,
              data: { tokenEstimate: persistedContext.tokenEstimate },
            })
          }
        } catch (_err) {
          // Context saving is best-effort — never block the completion
          await options.runStore.addLog(job.runId, {
            level: 'warn',
            phase: 'context-transfer',
            message: 'Failed to save context after run',
            data: { error: _err instanceof Error ? _err.message : String(_err) },
          }).catch(() => { /* swallow nested failure */ })
        }
      }

      options.eventBus.emit({
        type: 'agent:completed',
        agentId: job.agentId,
        runId: job.runId,
        durationMs,
      })

      // --- Run completion metrics ---
      const tierLabel = (job.metadata?.['modelTier'] as string) || 'unknown'
      options.metrics?.increment('forge_run_completed_total', { tier: tierLabel })
      options.metrics?.observe('forge_run_duration_ms', durationMs, { tier: tierLabel })
    } catch (error) {
      // If cancelled via AbortSignal, set cancelled status instead of failed
      if (signal.aborted) {
        const run = await options.runStore.get(job.runId)
        // Only update if not already in a terminal state
        if (run && !['completed', 'failed', 'cancelled', 'rejected', 'halted'].includes(run.status)) {
          await options.runStore.update(job.runId, {
            status: 'cancelled',
            error: 'Cancelled by user',
            completedAt: new Date(),
          })
          await options.runStore.addLog(job.runId, {
            level: 'warn',
            phase: 'run',
            message: 'Run cancelled',
          })
          options.eventBus.emit({
            type: 'agent:failed',
            agentId: job.agentId,
            runId: job.runId,
            errorCode: 'AGENT_ABORTED',
            message: 'Cancelled by user',
          })
          await closeTraceWithTerminalStep(options.traceStore, job.runId, 'cancelled', { reason: 'Cancelled by user' })
        }
        return
      }

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
        data: { error: message, ...(traceId ? { traceId } : {}) },
      })
      options.eventBus.emit({
        type: 'agent:failed',
        agentId: job.agentId,
        runId: job.runId,
        errorCode: 'INTERNAL_ERROR',
        message,
      })
      await closeTraceWithTerminalStep(options.traceStore, job.runId, 'failed', { error: message })
    } finally {
      options.shutdown?.untrackRun(job.runId)
    }
  })
}

// ---------------------------------------------------------------------------
// Helpers for cross-intent context transfer
// ---------------------------------------------------------------------------

/** Derive a session identifier from the job metadata, falling back to runId. */
function resolveSessionId(job: { runId: string; metadata?: Record<string, unknown> }): string {
  const fromMeta = job.metadata?.['sessionId']
  return typeof fromMeta === 'string' && fromMeta.length > 0 ? fromMeta : job.runId
}

/** Derive the current intent from job/agent metadata. */
function resolveIntent(
  job: { metadata?: Record<string, unknown> },
  agent: AgentExecutionSpec,
): string | undefined {
  const fromJob = job.metadata?.['intent']
  if (typeof fromJob === 'string' && fromJob.length > 0) return fromJob

  const fromAgent = agent.metadata?.['intent']
  if (typeof fromAgent === 'string' && fromAgent.length > 0) return fromAgent

  return undefined
}
