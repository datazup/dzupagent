/**
 * Post-loop processing for the generate path (MC-026b-2).
 *
 * Hosts {@link processGeneratedRun}: emits terminal telemetry, applies
 * the legacy + pluggable output filter chain, runs the optional
 * reflection callback, and assembles the final {@link GenerateResult}.
 *
 * Extracted from `run-engine-generate-helpers.ts` so the post-loop
 * concerns don't share a file with the tool-loop driver.
 */

import type {
  CompressionLogEntry,
  DzupAgentConfig,
  GenerateResult,
} from './agent-types.js'
import type { ExecuteGenerateRunParams } from './run-engine/types.js'
import type { StopReason, ToolStat } from './tool-loop.js'
import type { RunLoopResult } from './run-engine-generate-tool-loop.js'
import { extractFinalAiMessageContent } from './message-utils.js'
import { ReflectionAnalyzer } from '../reflection/reflection-analyzer.js'
import { buildWorkflowEventsFromToolStats } from '../reflection/learning-bridge.js'
import { omitUndefined } from '../utils/exact-optional.js'
import { applyOutputFilterChain } from './output-filter.js'

/**
 * Apply the legacy `guardrails.outputFilter` callback to a content
 * string. Falls through unchanged when no filter is configured or the
 * content is empty. A `null` return from the filter is treated as
 * "don't transform", preserving the pre-filter content.
 */
async function applyLegacyOutputFilter(
  config: DzupAgentConfig,
  content: string,
): Promise<string> {
  if (!config.guardrails?.outputFilter || !content) {
    return content
  }
  const filtered = await config.guardrails.outputFilter(content)
  return filtered === null ? content : filtered
}

/**
 * Emit the terminal `agent:stop_reason` telemetry event. Carries the
 * resolved stop reason, llm-call count, and per-tool stats so dashboards
 * have a single canonical event for run terminations.
 */
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

  const rawContent = await applyLegacyOutputFilter(
    params.config,
    extractFinalAiMessageContent(result.messages),
  )

  // M-13 — pluggable output filter chain. Runs after the legacy
  // guardrails.outputFilter so existing callers are unaffected.
  const content = params.config.outputFilters?.length
    ? await applyOutputFilterChain(
        rawContent,
        params.config.outputFilters,
        {
          agentId: params.agentId,
          tenantId: params.config.memoryScope?.['tenantId'] ?? 'default',
          runId: params.options?.runId ?? params.config.toolExecution?.runId ?? '',
        },
      )
    : rawContent

  await params.maybeUpdateSummary(result.messages, params.runState.memoryFrame)

  // --- Post-run reflection analysis (best-effort, non-fatal) ---
  if (params.config.onReflectionComplete) {
    try {
      const analyzer = new ReflectionAnalyzer(params.config.reflectionAnalyzerConfig)
      const events = buildWorkflowEventsFromToolStats(
        result.toolStats,
        result.stopReason,
      )
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
    // Surface the per-run memory frame for observability so callers (and
    // the public `RunResult` via `runInBackground`) can inspect which
    // memory context was attached to this run.
    memoryFrame: params.runState.memoryFrame,
    // Only expose the compression log when at least one compression event
    // fired; leave undefined otherwise to avoid cluttering result payloads
    // for runs that never compacted.
    ...(compressionLog.length > 0 ? { compressionLog } : {}),
  })
}
