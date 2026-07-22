import type { GenerateResult } from "../agent-types.js";
import { ApprovalSuspendedError } from "../../approval/approval-errors.js";
import {
  persistRunStateSnapshot,
  prepareGuardPrelude,
  resolveRunStateRunId,
  setupModelCall,
  processGeneratedRun,
} from "../run-engine-generate-helpers.js";
import type { ExecuteGenerateRunParams } from "./types.js";

export async function executeGenerateRun(
  params: ExecuteGenerateRunParams
): Promise<GenerateResult> {
  try {
    return await executeGenerateRunInner(params);
  } catch (err) {
    // Durable approval gate -- surface a `suspended` GenerateResult instead
    // of bubbling the error so the outer agent driver can return a clean
    // pause result. Other errors propagate unchanged.
    if (err instanceof ApprovalSuspendedError) {
      // MC-AGT-04 Phase 1 — record a snapshot at the suspension point so
      // resume can pick up from the last known message history.
      if (params.config.runStateStore) {
        const runStateRunId = resolveRunStateRunId(
          params.agentId,
          params.options,
          params.config.toolExecution?.runId
        );
        const tenantId = params.config.memoryScope?.["tenantId"];
        void persistRunStateSnapshot({
          store: params.config.runStateStore,
          runId: runStateRunId,
          agentId: params.agentId,
          ...(tenantId !== undefined ? { tenantId } : {}),
          iteration: 0,
          messages: params.runState.preparedMessages,
          cumulativeUsage: [],
          terminalReason: "approval_pending",
        });
      }
      return {
        content: "",
        messages: params.runState.preparedMessages,
        usage: { totalInputTokens: 0, totalOutputTokens: 0, llmCalls: 0 },
        hitIterationLimit: false,
        stopReason: "approval_pending",
        toolStats: [],
        suspended: { runId: err.runId, resumeToken: err.resumeToken },
      };
    }
    // MC-AGT-04 Phase 1 — failed runs still get a final snapshot so
    // operators can inspect the last-known state when triaging errors.
    if (params.config.runStateStore) {
      const runStateRunId = resolveRunStateRunId(
        params.agentId,
        params.options,
        params.config.toolExecution?.runId
      );
      const tenantId = params.config.memoryScope?.["tenantId"];
      const reason = err instanceof Error ? err.message : String(err);
      void persistRunStateSnapshot({
        store: params.config.runStateStore,
        runId: runStateRunId,
        agentId: params.agentId,
        ...(tenantId !== undefined ? { tenantId } : {}),
        iteration: 0,
        messages: params.runState.preparedMessages,
        cumulativeUsage: [],
        terminalReason: `error: ${reason}`,
      });
    }
    throw err;
  }
}

/**
 * RF-25 (CODE-17) — orchestrator that delegates to three phase helpers
 * in {@link ../run-engine-generate-helpers.js}:
 *
 *   1. {@link prepareGuardPrelude} — accumulator + tool-exec policy resolve.
 *   2. {@link setupModelCall}      — runs the tool loop with full telemetry.
 *   3. {@link processGeneratedRun} — post-run filter, summary, reflection,
 *      and final result assembly.
 *
 * Observable order (event-bus emissions, OTel spans, error rethrows) is
 * preserved across the extraction.
 */
async function executeGenerateRunInner(
  params: ExecuteGenerateRunParams
): Promise<GenerateResult> {
  const prelude = prepareGuardPrelude(params.config);
  const result = await setupModelCall(params, prelude);
  return processGeneratedRun(params, result, prelude.compressionLog);
}
