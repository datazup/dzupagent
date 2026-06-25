/**
 * Tool-loop driver for the generate path (MC-026b-2).
 *
 * Hosts {@link setupModelCall}: builds the {@link ToolLoopConfig},
 * wires LLM-audit / token-lifecycle / compression / snapshot hooks,
 * and runs `runToolLoop` to produce the {@link RunLoopResult}. All
 * event-bus emissions and OTel spans are emitted in the same order as
 * the pre-MC-026b-2 implementation.
 */

import type { BaseMessage } from '@langchain/core/messages'
import {
  calculateCostCents,
  estimateTokens,
  type TokenUsage,
} from '@dzupagent/core/llm'
import { injectPromptCacheMarkersForModel } from '@dzupagent/context'
import {
  runToolLoop,
  type ToolLoopConfig,
  type ToolLoopResult,
} from './tool-loop.js'
import type { ExecuteGenerateRunParams } from './run-engine/types.js'
import { omitUndefined } from '../utils/exact-optional.js'
import type { CompressionLogEntry, DzupAgentConfig } from './agent-types.js'
import {
  createRunStateSnapshotWriter,
  resolveRunStateRunId,
} from './run-engine-generate-snapshot.js'
import { wrapInvokeModelWithAudit } from './run-engine-generate-audit.js'

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
   * `resultScanner`; pre-resolved here so the loop config builder
   * doesn't have to recompute it.
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
 * Output shape of the inner `runToolLoop` invocation. Re-exported so
 * downstream consumers can type the post-loop processing without
 * re-importing the tool-loop module.
 */
export type RunLoopResult = ToolLoopResult

/**
 * Build the tool-execution policy slice of the loop config (MJ-AGENT-01).
 * Each field is forwarded only when present so the resulting config
 * stays identical to the pre-MJ-AGENT-01 shape when `toolExecution` is
 * unset.
 */
function buildPolicyConfig(
  params: ExecuteGenerateRunParams,
  prelude: GuardPrelude,
): Partial<ToolLoopConfig> {
  const { toolExec, resolvedSafetyMonitor } = prelude
  return {
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
    // MC-3 — forward the prompt-injection guardrail to the generate-path
    // tool loop (parity with stream(), MJ-AGENT-02).
    ...(toolExec?.promptInjectionGuard !== undefined
      ? { promptInjectionGuard: toolExec.promptInjectionGuard }
      : {}),
    ...(toolExec?.wrapToolResults !== undefined
      ? { wrapToolResults: toolExec.wrapToolResults }
      : {}),
    ...(toolExec?.timeouts !== undefined ? { toolTimeouts: toolExec.timeouts } : {}),
    ...(toolExec?.tracer !== undefined ? { tracer: toolExec.tracer } : {}),
    // agentId: fall back to the agent's own id ONLY when toolExecution is
    // provided, so the pre-MJ-AGENT-01 surface (no toolExecution) is
    // bit-for-bit identical to the previous behaviour.
    ...(toolExec ? { agentId: toolExec.agentId ?? params.agentId } : {}),
    ...(toolExec?.runId !== undefined ? { runId: toolExec.runId } : {}),
    ...(toolExec?.argumentValidator !== undefined
      ? { validateToolArgs: toolExec.argumentValidator }
      : {}),
    ...(toolExec?.permissionPolicy !== undefined
      ? { toolPermissionPolicy: toolExec.permissionPolicy }
      : {}),
    // Forward the agent's eventBus to the loop ONLY when toolExecution is
    // configured. Without `toolExecution`, the loop continues to operate
    // without lifecycle telemetry — matching pre-MJ-AGENT-01 behaviour
    // exactly.
    ...(toolExec && params.config.eventBus !== undefined
      ? { eventBus: params.config.eventBus }
      : {}),
  }
}

/**
 * Phase 2 — build the {@link ToolLoopConfig} and execute the tool loop.
 *
 * Contains LLM-audit sink wiring (RF-12), token-lifecycle hooks,
 * provider failover bridge, compression callback, and stuck-detector
 * telemetry. All event-bus emissions and OTel spans are emitted in the
 * same order as the pre-refactor implementation.
 */
export async function setupModelCall(
  params: ExecuteGenerateRunParams,
  prelude: GuardPrelude,
): Promise<RunLoopResult> {
  const { compressionLog, toolExec } = prelude

  // MC-AGT-04 Phase 1 — accumulate token usage across the run so
  // snapshots can carry the full per-call breakdown. The accumulator is
  // shared between the `onUsage` callback (already wired below) and the
  // `onIteration` snapshot hook, both of which are activated only when
  // `runStateStore` is configured.
  const cumulativeUsage: TokenUsage[] = []
  const runStateStore = params.config.runStateStore
  const runStateSnapshotWriter = runStateStore
    ? createRunStateSnapshotWriter(runStateStore)
    : undefined
  const runStateRunId = runStateStore
    ? resolveRunStateRunId(params.agentId, params.options, toolExec?.runId)
    : undefined
  const runStateTenantId = runStateStore
    ? params.config.memoryScope?.['tenantId']
    : undefined

  const auditedInvokeModel = wrapInvokeModelWithAudit(params)

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
      ...buildPolicyConfig(params, prelude),
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
          recovery:
            stage >= 3
              ? 'Aborting loop'
              : stage === 2
                ? 'Nudge injected'
                : 'Tool blocked',
          timestamp: Date.now(),
        })
      },
      invokeModel: auditedInvokeModel,
      transformToolResult: (name, input, result) =>
        params.transformToolResult(name, input, result),
      onUsage: (usage) => {
        params.options?.onUsage?.(usage)
        // MC-AGT-04 Phase 1 — accumulate per-call usage so iteration
        // snapshots can carry the full breakdown. Only collected when a
        // run-state store is configured to avoid retaining usage objects
        // for runs that don't persist them.
        if (runStateStore) {
          cumulativeUsage.push(usage)
        }
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
      // MC-AGT-04 Phase 1 — fire-and-forget run-state snapshot at every
      // iteration boundary when a store is configured. The hook is a
      // no-op otherwise, preserving the legacy fast path exactly.
      ...(runStateStore && runStateRunId !== undefined
        ? {
            onIteration: (info: {
              iteration: number
              messages: BaseMessage[]
              totalInputTokens: number
              totalOutputTokens: number
              llmCalls: number
            }) => {
              runStateSnapshotWriter?.({
                runId: runStateRunId,
                agentId: params.agentId,
                ...(runStateTenantId !== undefined
                  ? { tenantId: runStateTenantId }
                  : {}),
                iteration: info.iteration,
                messages: info.messages,
                cumulativeUsage: [...cumulativeUsage],
              })
            },
          }
        : {}),
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
      // Auto-compression — delegates to the token lifecycle plugin. The
      // plugin short-circuits internally when pressure is ok/warn; actual
      // compression only runs when pressure transitions to critical or
      // exhausted.
      //
      // REC-H-10 — when compression returns a fresh transcript we MUST
      // re-inject Anthropic prompt-cache markers, otherwise every LLM turn
      // for the rest of the run pays full input price. The injector is a
      // no-op for non-Claude models and short transcripts so this is safe
      // to apply unconditionally.
      maybeCompress: params.config.tokenLifecyclePlugin
        ? async (messages) => {
            const result = await params.config.tokenLifecyclePlugin!.maybeCompress(
              messages,
              params.runState.model,
              null,
            )
            if (result.compressed) {
              return {
                ...result,
                messages: injectPromptCacheMarkersForModel(
                  result.messages,
                  params.runState.model,
                ),
              }
            }
            return result
          }
        : undefined,
      // Persist each compression event to the run-scoped compressionLog so
      // callers can inspect when (and by how much) the history was
      // compacted. Only fires when `maybeCompress` returned
      // `compressed: true`.
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

  // MC-AGT-04 Phase 1 — final snapshot at run termination so external
  // observers can locate the last-known good state regardless of stop
  // reason (complete / iteration_limit / budget_exceeded / stuck / etc).
  // Errors are logged but never rethrown.
  if (runStateSnapshotWriter && runStateRunId !== undefined) {
    runStateSnapshotWriter({
      runId: runStateRunId,
      agentId: params.agentId,
      ...(runStateTenantId !== undefined ? { tenantId: runStateTenantId } : {}),
      iteration: result.llmCalls,
      messages: result.messages,
      cumulativeUsage: [...cumulativeUsage],
      terminalReason: result.stopReason,
    })
  }

  return result
}
