import { extractInputMetadataKeys } from "../tool-lifecycle-policy.js";
import {
  applyBudgetGate,
  buildSuccessResult,
  handleInvocationFailure,
  runToolStreamingPhase,
} from "../run-engine-streaming-helpers.js";
import { omitUndefined } from "../../utils/exact-optional.js";
import type { StreamingToolExecutionResult } from "../streaming-tool-types.js";
import type { ExecuteStreamingToolCallParams } from "./types.js";

// ---------- Streaming policy stack helpers (MJ-AGENT-02) ----------

export async function executeStreamingToolCall(
  params: ExecuteStreamingToolCallParams
): Promise<StreamingToolExecutionResult> {
  // RF-19 (CODE-02) — orchestrator. The 397-LOC body has been split into
  // five phase helpers in `../run-engine-streaming-helpers.ts` so each
  // phase can be unit-tested in isolation. Observable behaviour
  // (event-bus emissions, OTel span attributes, abort-signal threading,
  // error rethrows, stuck-detection ordering) is preserved exactly.
  const { toolCall, policy } = params;
  const toolName = toolCall.name;
  const toolCallId = toolCall.id ?? `call_${Date.now()}`;
  const inputMetadataKeys = extractInputMetadataKeys(toolCall.args);

  // Phase 1 — pre-execution gate stack.
  const gate = applyBudgetGate(
    omitUndefined({
      toolCall,
      toolCallId,
      toolName,
      inputMetadataKeys,
      budget: params.budget,
      toolMap: params.toolMap,
      policy,
    })
  );
  if (gate.kind === "short-circuit") {
    if (gate.throwError) throw gate.throwError;
    return gate.result;
  }

  const startMs = Date.now();

  try {
    // Phase 2 — validate, invoke, scan, emit lifecycle events.
    const phase = await runToolStreamingPhase(
      omitUndefined({
        toolCall,
        toolCallId,
        toolName,
        inputMetadataKeys,
        tool: gate.tool,
        transformToolResult: params.transformToolResult,
        statTracker: params.statTracker,
        onToolLatency: params.onToolLatency,
        signal: params.signal,
        policy,
        startMs,
      })
    );
    if (phase.kind === "short-circuit") return phase.result;

    // Phase 3 — assemble success result with stuck-detection nudge.
    // MC-3 — forward the prompt-injection guard config so the streaming path
    // wraps tool-result context identically to generate() (parity,
    // MJ-AGENT-02).
    return buildSuccessResult(
      omitUndefined({
        toolName,
        toolCallId,
        transformedResult: phase.transformedResult,
        validatedArgs: phase.validatedArgs,
        stuckDetector: params.stuckDetector,
        budget: params.budget,
        promptInjectionGuard: policy?.promptInjectionGuard,
        wrapToolResults: policy?.wrapToolResults,
      })
    );
  } catch (error: unknown) {
    // Phase 4 — error path: latency recording, tool:error emission,
    // and stuck-detection over the error message.
    return handleInvocationFailure(
      omitUndefined({
        error,
        toolName,
        toolCallId,
        inputMetadataKeys,
        startMs,
        statTracker: params.statTracker,
        onToolLatency: params.onToolLatency,
        stuckDetector: params.stuckDetector,
        policy,
      })
    );
  }
}
