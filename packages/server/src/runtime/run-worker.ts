import type { AgentDefinition, ModelRegistry, RunStore, MetricsCollector } from '@dzipagent/core'
import type { DzipEventBus } from '@dzipagent/core'
import type { RunContextTransfer, PersistedIntentContext } from '@dzipagent/core'
import type { RunQueue } from '../queue/run-queue.js'
import type { GracefulShutdown } from '../lifecycle/graceful-shutdown.js'
import type { RunTraceStore } from '../persistence/run-trace-store.js'
import { extractTraceContext } from '@dzipagent/core'
import { isStructuredResult } from './utils.js'
import { reportRetrievalFeedback, type RetrievalFeedbackHookConfig } from './retrieval-feedback-hook.js'

export interface RunExecutionContext {
  runId: string
  agentId: string
  input: unknown
  metadata?: Record<string, unknown>
  agent: AgentDefinition
  runStore: RunStore
  eventBus: DzipEventBus
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
}

export type RunExecutor = (context: RunExecutionContext) => Promise<unknown | RunExecutorResult>

// ---------------------------------------------------------------------------
// Structural types for RunReflector (avoids hard dependency on @dzipagent/agent)
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

/** Structural type for the escalation policy result (avoids importing @dzipagent/core). */
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
  agentStore: {
    get(id: string): Promise<AgentDefinition | null>
    save?(agent: AgentDefinition): Promise<void>
  }
  eventBus: DzipEventBus
  modelRegistry: ModelRegistry
  runExecutor: RunExecutor
  shutdown?: GracefulShutdown
  /** Optional cross-intent context transfer. When provided, context is
   *  loaded before each run and saved after successful completion. */
  contextTransfer?: RunContextTransfer
  /** Optional metrics collector for run-level observability */
  metrics?: MetricsCollector
  /** Optional run reflector — scores every completed run for quality tracking.
   *  Uses structural typing to avoid a hard dependency on @dzipagent/agent. */
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
}

async function waitForApprovalDecision(
  eventBus: DzipEventBus,
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

/**
 * Start the queue worker that transitions queued runs to terminal states.
 */
export function startRunWorker(options: StartRunWorkerOptions): void {
  options.runQueue.start(async (job, signal) => {
    const startedAt = Date.now()
    options.shutdown?.trackRun(job.runId)

    // Extract trace context from run metadata for log correlation.
    // Declared before try/catch so traceId is available in error handlers.
    let traceId: string | undefined
    try {
      const traceCtx = extractTraceContext(job.metadata as Record<string, unknown> | undefined)
      traceId = traceCtx?.traceId
    } catch {
      // Trace extraction is non-fatal
    }

    try {
      throwIfAborted(signal)

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

      // --- Start trace (optional) ---
      options.traceStore?.startTrace(job.runId, job.agentId)
      options.traceStore?.addStep(job.runId, {
        timestamp: Date.now(),
        type: 'user_input',
        content: job.input,
        metadata: job.metadata ? { ...job.metadata } : undefined,
      })

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

      const execution = await options.runExecutor({
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

      // Guard: don't overwrite terminal state if cancelled during execution
      throwIfAborted(signal)

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
      // --- Record output step and complete trace (optional) ---
      options.traceStore?.addStep(job.runId, {
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
      options.traceStore?.completeTrace(job.runId)

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
        if (run && !['completed', 'failed', 'cancelled', 'rejected'].includes(run.status)) {
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
  agent: AgentDefinition,
): string | undefined {
  const fromJob = job.metadata?.['intent']
  if (typeof fromJob === 'string' && fromJob.length > 0) return fromJob

  const fromAgent = agent.metadata?.['intent']
  if (typeof fromAgent === 'string' && fromAgent.length > 0) return fromAgent

  return undefined
}
