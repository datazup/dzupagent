/**
 * Helpers extracted from `executeGenerateRunInner` (RF-25 / CODE-17).
 *
 * The original 270 LOC orchestrator has been split into three phases:
 *
 *   1. {@link prepareGuardPrelude} — accumulator + tool-execution policy
 *      resolution that must run before the model call.
 *   2. {@link setupModelCall}      — builds the {@link ToolLoopConfig} and
 *      drives the actual `runToolLoop` invocation, including LLM-audit
 *      sink wiring, telemetry callbacks, and compression hooks.
 *   3. {@link processGeneratedRun} — post-loop telemetry, output filtering,
 *      summary update, optional reflection callback, and assembling the
 *      final {@link GenerateResult}.
 *
 * Helpers preserve the original observable order of event-bus emissions,
 * OTel spans, and error rethrows. They are kept colocated with the run
 * engine so Wave A4's edits to the streaming branch don't conflict with
 * this refactor.
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  calculateCostCents,
  estimateTokens,
  extractTokenUsage,
} from '@dzupagent/core'
import type {
  CompressionLogEntry,
  DzupAgentConfig,
  GenerateResult,
} from './agent-types.js'
import {
  runToolLoop,
  type StopReason,
  type ToolLoopConfig,
  type ToolLoopResult,
  type ToolStat,
} from './tool-loop.js'
import type { ExecuteGenerateRunParams } from './run-engine.js'
import { extractFinalAiMessageContent } from './message-utils.js'
import { ReflectionAnalyzer } from '../reflection/reflection-analyzer.js'
import { buildWorkflowEventsFromToolStats } from '../reflection/learning-bridge.js'
import { omitUndefined } from '../utils/exact-optional.js'
import type {
  LlmCallAuditEntry,
  LlmCallAuditSink,
} from '../observability/llm-call-audit.js'

/**
 * Push an LLM-call audit entry to the configured sink. Fire-and-forget:
 * synchronous throws and rejected promises are swallowed so the run
 * never fails because of an audit-sink defect.
 */
async function recordAuditEntry(
  sink: LlmCallAuditSink,
  entry: LlmCallAuditEntry,
): Promise<void> {
  try {
    await sink.record(entry)
  } catch {
    // Audit sink failures must never disturb the run. Compliance reports
    // surface missing entries via downstream reconciliation, not here.
  }
}

/**
 * Output of {@link prepareGuardPrelude}. Threads the compression log
 * accumulator and the resolved tool-execution policy bundle through to
 * {@link setupModelCall}.
 */
export interface GuardPrelude {
  compressionLog: CompressionLogEntry[]
  toolExec: DzupAgentConfig['toolExecution']
  /**
   * `safetyMonitor` takes precedence over the public-surface alias
   * `resultScanner`; pre-resolved here so the loop config builder doesn't
   * have to recompute it.
   */
  resolvedSafetyMonitor: NonNullable<DzupAgentConfig['toolExecution']>['safetyMonitor']
    | NonNullable<DzupAgentConfig['toolExecution']>['resultScanner']
    | undefined
}

/**
 * Phase 1 — set up run-scoped accumulators and resolve the optional
 * public tool-execution policy bundle (MJ-AGENT-01).
 *
 * `toolExecution.agentId` falls back to the agent's own id at the
 * call-site (in {@link setupModelCall}) so callers don't have to repeat
 * it. Each policy field is forwarded only when present so the resulting
 * {@link ToolLoopConfig} stays identical to the pre-MJ-AGENT-01 shape
 * when `toolExecution` is unset (backwards-compatibility guarantee).
 */
export function prepareGuardPrelude(
  config: DzupAgentConfig,
): GuardPrelude {
  const compressionLog: CompressionLogEntry[] = []
  const toolExec = config.toolExecution
  const resolvedSafetyMonitor =
    toolExec?.safetyMonitor ?? toolExec?.resultScanner
  return { compressionLog, toolExec, resolvedSafetyMonitor }
}

/**
 * Output shape of the inner `runToolLoop` invocation. Re-exported as
 * {@link ToolLoopResult} so {@link processGeneratedRun} can consume it
 * without re-importing the tool-loop module.
 */
export type RunLoopResult = ToolLoopResult

/**
 * Phase 2 — build the {@link ToolLoopConfig} and execute the tool loop.
 *
 * Contains the LLM-audit sink wiring (RF-12), token-lifecycle hooks,
 * provider failover bridge, compression callback, and stuck-detector
 * telemetry. All event-bus emissions and OTel spans are emitted in the
 * same order as the pre-refactor implementation.
 */
export async function setupModelCall(
  params: ExecuteGenerateRunParams,
  prelude: GuardPrelude,
): Promise<RunLoopResult> {
  const { compressionLog, toolExec, resolvedSafetyMonitor } = prelude

  const result = await runToolLoop(
    params.runState.model,
    params.runState.preparedMessages,
    params.runState.tools,
    omitUndefined<ToolLoopConfig>({
      maxIterations: params.runState.maxIterations,
      budget: params.runState.budget,
      signal: params.options?.signal,
      stuckDetector: params.runState.stuckDetector,
      toolStatsTracker: params.config.toolStatsTracker,
      intent: params.options?.intent,
      // MJ-AGENT-01 — public tool-execution policy surface. Each field is
      // forwarded only when present so the resulting ToolLoopConfig stays
      // identical to the pre-MJ-AGENT-01 shape when `toolExecution` is
      // unset (backwards compatibility guarantee).
      ...(toolExec?.governance !== undefined
        ? { toolGovernance: toolExec.governance }
        : {}),
      ...(resolvedSafetyMonitor !== undefined
        ? { safetyMonitor: resolvedSafetyMonitor }
        : {}),
      ...(toolExec?.scanToolResults !== undefined
        ? { scanToolResults: toolExec.scanToolResults }
        : {}),
      ...(toolExec?.scanFailureMode !== undefined
        ? { scanFailureMode: toolExec.scanFailureMode }
        : {}),
      ...(toolExec?.timeouts !== undefined
        ? { toolTimeouts: toolExec.timeouts }
        : {}),
      ...(toolExec?.tracer !== undefined
        ? { tracer: toolExec.tracer }
        : {}),
      // agentId: fall back to the agent's own id ONLY when toolExecution
      // is provided, so the pre-MJ-AGENT-01 surface (no toolExecution) is
      // bit-for-bit identical to the previous behaviour. When threaded,
      // the loop tags canonical lifecycle events (`tool:called`,
      // `tool:result`, `tool:error`) with provenance and feeds permission
      // policies with the caller id.
      ...(toolExec
        ? { agentId: toolExec.agentId ?? params.agentId }
        : {}),
      ...(toolExec?.runId !== undefined ? { runId: toolExec.runId } : {}),
      ...(toolExec?.argumentValidator !== undefined
        ? { validateToolArgs: toolExec.argumentValidator }
        : {}),
      ...(toolExec?.permissionPolicy !== undefined
        ? { toolPermissionPolicy: toolExec.permissionPolicy }
        : {}),
      // Forward the agent's eventBus to the loop ONLY when toolExecution
      // is configured. Without `toolExecution`, the loop continues to
      // operate without lifecycle telemetry — matching pre-MJ-AGENT-01
      // behaviour exactly. With `toolExecution`, downstream policy events
      // (e.g. `approval:requested`) and canonical lifecycle events are
      // routed to the same bus the agent already uses for `llm:invoked`,
      // `tool:latency`, etc.
      ...(toolExec && params.config.eventBus !== undefined
        ? { eventBus: params.config.eventBus }
        : {}),
      onStuckDetected: (reason, recovery) => {
        params.config.eventBus?.emit({
          type: 'agent:stuck_detected',
          agentId: params.agentId,
          reason,
          recovery,
          timestamp: Date.now(),
        })
      },
      onStuck: (toolName, stage) => {
        params.config.eventBus?.emit({
          type: 'agent:stuck_detected',
          agentId: params.agentId,
          reason: `Stuck on tool "${toolName}" (escalation stage ${stage})`,
          recovery: stage >= 3 ? 'Aborting loop' : stage === 2 ? 'Nudge injected' : 'Tool blocked',
          timestamp: Date.now(),
        })
      },
      invokeModel: async (model, messages) => {
        // RF-12 — record every LLM invocation in the configured audit
        // sink for compliance traceability. Fire-and-forget; never blocks
        // the run, never propagates sink errors.
        const auditStore = params.config.auditStore
        const startMs = Date.now()
        const modelId =
          (model as BaseChatModel & { model?: string }).model
          ?? (typeof params.config.model === 'string' ? params.config.model : 'unknown')
        try {
          const response = await params.invokeModel(model, messages)
          if (auditStore) {
            const usage = extractTokenUsage(response, modelId)
            void recordAuditEntry(auditStore, {
              agentId: params.agentId,
              ...(params.options?.runId !== undefined ? { runId: params.options.runId } : {}),
              model: modelId,
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              durationMs: Date.now() - startMs,
              timestamp: Date.now(),
              success: true,
            })
          }
          return response
        } catch (err) {
          if (auditStore) {
            const errorMessage = err instanceof Error ? err.message : String(err)
            void recordAuditEntry(auditStore, {
              agentId: params.agentId,
              ...(params.options?.runId !== undefined ? { runId: params.options.runId } : {}),
              model: modelId,
              inputTokens: 0,
              outputTokens: 0,
              durationMs: Date.now() - startMs,
              timestamp: Date.now(),
              success: false,
              error: errorMessage,
            })
          }
          throw err
        }
      },
      transformToolResult: (name, input, result) =>
        params.transformToolResult(name, input, result),
      onUsage: (usage) => {
        params.options?.onUsage?.(usage)
        // Compliance / audit — ISO/IEC 42001 traceability: every LLM
        // invocation must be recorded in the audit store. The event bus
        // listener in ComplianceAuditLogger picks this up automatically.
        params.config.eventBus?.emit({
          type: 'llm:invoked',
          agentId: params.agentId,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
          ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
          costCents: calculateCostCents(usage),
          timestamp: Date.now(),
        })
      },
      onToolResult: (_name, result) => {
        // Charge tool-result bytes against the token lifecycle plugin so
        // per-phase breakdowns reflect tool output ingestion separately
        // from LLM input/output.
        if (params.config.tokenLifecyclePlugin && result) {
          params.config.tokenLifecyclePlugin.trackPhase(
            'tool-result',
            estimateTokens(result),
          )
        }
      },
      onToolLatency: (name, durationMs, error) => {
        params.config.eventBus?.emit({
          type: 'tool:latency',
          toolName: name,
          durationMs,
          ...(error !== undefined ? { error } : {}),
        })
      },
      shouldHalt: params.config.tokenLifecyclePlugin
        ? () => params.config.tokenLifecyclePlugin!.shouldHalt()
        : undefined,
      // Auto-compression — delegates to the token lifecycle plugin.
      // The plugin short-circuits internally when pressure is ok/warn;
      // actual compression only runs when pressure transitions to
      // critical or exhausted.
      maybeCompress: params.config.tokenLifecyclePlugin
        ? (messages) =>
            params.config.tokenLifecyclePlugin!.maybeCompress(
              messages,
              params.runState.model,
              null,
            )
        : undefined,
      // Persist each compression event to the run-scoped compressionLog so
      // callers can inspect when (and by how much) the history was compacted.
      // Only fires when `maybeCompress` returned `compressed: true`.
      onCompressed: (info) => {
        compressionLog.push({
          before: info.before,
          after: info.after,
          summary: info.summary,
          ts: Date.now(),
        })
      },
      // Note: run:halted:token-exhausted is emitted AFTER the loop
      // completes (in processGeneratedRun) so the iteration count is
      // accurate.
    }),
  )

  return result
}

/**
 * Phase 3 — post-run telemetry, output filtering, summary update, and
 * the optional reflection callback. Returns the final
 * {@link GenerateResult} ready to bubble back up to the caller.
 *
 * The token-exhaustion event precedes the generic stop-reason event so
 * dashboards can react to the halt before the catch-all telemetry fires.
 */
export async function processGeneratedRun(
  params: ExecuteGenerateRunParams,
  result: RunLoopResult,
  compressionLog: CompressionLogEntry[],
): Promise<GenerateResult> {
  // Emit token-exhaustion telemetry as soon as the loop reports the
  // matching stop reason. This precedes agent:stop_reason so dashboards
  // can react to the halt before the generic stop event fires.
  if (result.stopReason === 'token_exhausted') {
    params.config.eventBus?.emit({
      type: 'run:halted:token-exhausted',
      agentId: params.agentId,
      iterations: result.llmCalls,
      reason: 'token_exhausted',
    })
  }

  emitStopReasonTelemetry(params.config, params.agentId, {
    stopReason: result.stopReason,
    llmCalls: result.llmCalls,
    toolStats: result.toolStats,
  })

  const content = await applyOutputFilter(
    params.config,
    extractFinalAiMessageContent(result.messages),
  )

  await params.maybeUpdateSummary(result.messages, params.runState.memoryFrame)

  // --- Post-run reflection analysis (best-effort, non-fatal) ---
  if (params.config.onReflectionComplete) {
    try {
      const analyzer = new ReflectionAnalyzer(params.config.reflectionAnalyzerConfig)
      const events = buildWorkflowEventsFromToolStats(result.toolStats, result.stopReason)
      const summary = analyzer.analyze(
        params.agentId + ':' + Date.now().toString(36),
        events,
      )
      await params.config.onReflectionComplete(summary)
    } catch {
      // Reflection callback errors must NEVER affect the run result.
    }
  }

  return omitUndefined({
    content,
    messages: result.messages,
    usage: {
      totalInputTokens: result.totalInputTokens,
      totalOutputTokens: result.totalOutputTokens,
      llmCalls: result.llmCalls,
    },
    hitIterationLimit: result.hitIterationLimit,
    stopReason: result.stopReason,
    toolStats: result.toolStats,
    stuckError: result.stuckError,
    // Surface the per-run memory frame for observability so callers (and the
    // public `RunResult` via `runInBackground`) can inspect which memory
    // context was attached to this run.
    memoryFrame: params.runState.memoryFrame,
    // Only expose the compression log when at least one compression event
    // fired; leave undefined otherwise to avoid cluttering result payloads
    // for runs that never compacted.
    ...(compressionLog.length > 0 ? { compressionLog } : {}),
  })
}

// ---------- Local copies of small helpers (kept private to this file) ----------
//
// These two helpers are also exported from `run-engine.ts` for external
// consumers; we re-implement (and re-export) them here so this file can
// be loaded without creating a circular import on `run-engine.ts`.

async function applyOutputFilter(
  config: DzupAgentConfig,
  content: string,
): Promise<string> {
  if (!config.guardrails?.outputFilter || !content) {
    return content
  }
  const filtered = await config.guardrails.outputFilter(content)
  return filtered === null ? content : filtered
}

function emitStopReasonTelemetry(
  config: Pick<DzupAgentConfig, 'eventBus'>,
  agentId: string,
  payload: {
    stopReason: StopReason
    llmCalls: number
    toolStats: ToolStat[]
  },
): void {
  config.eventBus?.emit({
    type: 'agent:stop_reason',
    agentId,
    reason: payload.stopReason,
    iterations: payload.llmCalls,
    toolStats: payload.toolStats,
  })
}
