/**
 * ReAct-style tool calling loop.
 *
 * Iteratively invokes the LLM, executes any tool calls it returns,
 * appends tool results, and re-invokes until the LLM produces a
 * final text response (no tool calls) or limits are reached.
 */
import {
  ToolMessage,
  type AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { StuckError } from "./stuck-error.js";
import { ContextCompressionFailedError } from "./context-compression-failed-error.js";
import type { ToolCall } from "./tool-loop/contracts.js";
import { executeModelTurn } from "./tool-loop/model-turn-kernel.js";
import { executePolicyEnabledToolCall } from "./tool-loop/policy-enabled-tool-executor.js";
import { scheduleToolCalls } from "./tool-loop/tool-scheduler-kernel.js";
import {
  appendBudgetExceededMessage,
  handleToolResults,
  injectToolStatsHint,
  maybeCompressTurn,
  recordTurnUsage,
  type ToolLoopState,
} from "./tool-loop/loop-stages.js";
import { omitUndefined } from "../utils/exact-optional.js";
// Note: parallel-executor.ts still exports the standalone semaphore
// primitive (executeToolsParallel) for callers that want raw parallel
// dispatch without the policy stack. The tool-loop's parallel path was
// refactored to schedule the policy-enabled single-tool stage directly
// under its own semaphore, so the raw primitive is no longer used here.

// Type and interface declarations were extracted to ./tool-loop/types.ts
// (RF-03 / H-18). Re-exported here for backward compatibility — existing
// callers continue to import from this entrypoint.
export type {
  ToolStat,
  StopReason,
  ToolResultScanFailureMode,
  ToolRetryConfig,
  ToolLoopConfig,
  ToolLoopSpan,
  ToolLoopTracer,
  ToolLoopResult,
} from "./tool-loop/types.js";
import type {
  ToolLoopConfig,
  ToolLoopResult,
  StopReason,
  ToolStat,
} from "./tool-loop/types.js";

/**
 * Run the ReAct tool-calling loop.
 *
 * @param model - LLM instance (should already have tools bound if applicable)
 * @param messages - Initial messages including system prompt
 * @param tools - Available tools (used for execution, not for binding)
 * @param config - Loop configuration
 */
export async function runToolLoop(
  model: BaseChatModel,
  messages: BaseMessage[],
  tools: StructuredToolInterface[],
  config: ToolLoopConfig
): Promise<ToolLoopResult> {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  let llmCalls = 0;
  let stopReason: StopReason = "complete";

  // Mutable loop state threaded through the staged helpers in
  // `./tool-loop/loop-stages.ts`. Helpers mutate it in place so the
  // call-site reads as a sequence of named stages (H-18 refactor).
  const state: ToolLoopState = {
    messages: [...messages],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    // Escalating stuck recovery stage: 0 = not stuck, 1 = tool blocked,
    // 2 = nudge sent, 3 = abort.
    stuckStage: 0,
    lastStuckToolName: undefined,
    lastStuckReason: undefined,
    consecutiveCompressionFailures: 0,
  };

  // Mutable per-tool stat accumulators
  const statMap = new Map<
    string,
    { calls: number; errors: number; totalMs: number }
  >();

  function getOrCreateStat(name: string) {
    let stat = statMap.get(name);
    if (!stat) {
      stat = { calls: 0, errors: 0, totalMs: 0 };
      statMap.set(name, stat);
    }
    return stat;
  }

  for (let iteration = 0; iteration < config.maxIterations; iteration++) {
    // Check abort signal
    if (config.signal?.aborted) {
      stopReason = "aborted";
      break;
    }

    // Check budget hard limits
    if (config.budget) {
      const check = config.budget.isExceeded();
      if (check.exceeded) {
        stopReason = "budget_exceeded";
        appendBudgetExceededMessage(state, check.reason);
        break;
      }
    }

    // Record iteration in budget
    if (config.budget) {
      const warnings = config.budget.recordIteration();
      for (const w of warnings) {
        config.onBudgetWarning?.(w.message);
      }
    }

    // Refresh tool-stats hint before each LLM invocation so the LLM always
    // sees the latest per-intent ranking.
    injectToolStatsHint(state.messages, config.toolStatsTracker, config.intent);

    // Kernel stage: invoke the model and extract usage. Policy stages around
    // it own budget, compression, halt checks, and telemetry.
    const { response, usage } = await executeModelTurn({
      model,
      messages: state.messages,
      config,
    });
    llmCalls++;

    // Track usage and feed budget warnings.
    recordTurnUsage(state, usage, config.budget, {
      ...(config.onUsage ? { onUsage: config.onUsage } : {}),
      ...(config.onBudgetWarning
        ? { onBudgetWarning: config.onBudgetWarning }
        : {}),
    });

    state.messages.push(response);

    // Token lifecycle auto-compression — invoked AFTER usage has been
    // recorded on the current LLM response and BEFORE the halt check.
    // The hook (typically AgentLoopPlugin.maybeCompress) internally
    // short-circuits when pressure status is ok/warn, so invoking it on
    // every turn is safe and cheap. Errors are swallowed; a sanitized
    // `context:compress_failed` event is emitted to the configured event
    // bus when the hook itself throws (M-01 fix).
    try {
      await maybeCompressTurn(state, config);
    } catch (err) {
      // AGENT-112: two consecutive compression failures — terminate cleanly
      // rather than burning budget on LLM calls that can no longer fit.
      if (err instanceof ContextCompressionFailedError) {
        stopReason = "compression_failed";
        break;
      }
      throw err;
    }

    // Token lifecycle halt check — evaluated AFTER usage is recorded on
    // the current LLM response but BEFORE any tool calls in this turn
    // execute. A `true` return ends the loop with `token_exhausted`.
    if (config.shouldHalt?.()) {
      stopReason = "token_exhausted";
      config.onHalted?.("token_exhausted");
      break;
    }

    // Check for tool calls
    const ai = response as AIMessage;
    const toolCalls = ai.tool_calls as ToolCall[] | undefined;

    if (!toolCalls || toolCalls.length === 0) {
      // No tool calls — this is the final response
      break;
    }

    // T-AP-002: in parallel mode, treat approval-required calls as a
    // batch-level gate. If ANY sibling in the turn requires approval,
    // suspend before executing any tool in that batch.
    if (config.parallelTools && toolCalls.length > 1 && config.toolGovernance) {
      const governance = config.toolGovernance;
      const approvalTarget = toolCalls.find((tc) => {
        const access = governance.checkAccess(tc.name, tc.args);
        return access.allowed && access.requiresApproval;
      });

      if (approvalTarget) {
        const toolCallId = approvalTarget.id ?? `call_${Date.now()}`;
        const correlationId = config.runId ?? toolCallId;
        const access = governance.checkAccess(
          approvalTarget.name,
          approvalTarget.args
        );
        const reason = access.reason ?? "Approval required";

        try {
          config.eventBus?.emit({
            type: "approval:requested",
            runId: correlationId,
            plan: { toolName: approvalTarget.name, args: approvalTarget.args },
          });
        } catch {
          // Non-fatal: event emission must not abort the run.
        }

        config.onToolResult?.(
          approvalTarget.name,
          `[approval_pending: ${reason}]`
        );
        state.messages.push(
          new ToolMessage({
            content: `[approval_pending] Tool "${approvalTarget.name}" requires human approval before execution. ${reason}`,
            tool_call_id: toolCallId,
            name: approvalTarget.name,
          })
        );
        stopReason = "approval_pending";
        break;
      }
    }

    // Kernel stage: schedule tool calls sequentially or in parallel. The
    // supplied executor is the policy-decorated stage, so both scheduling
    // modes share governance, validation, scanning, timeout, telemetry,
    // and stuck-detection behavior.
    const results = await scheduleToolCalls(
      toolCalls,
      omitUndefined({
        parallelTools: config.parallelTools,
        maxParallelTools: config.maxParallelTools,
        signal: config.signal,
        agentId: config.agentId,
        toolPermissionPolicy: config.toolPermissionPolicy,
        // DZUPAGENT-AGENT-H-02 — Forward governance into the kernel so its
        // approval pre-scan can downgrade parallel batches to serial when a
        // sibling requires human approval. The outer loop's T-AP-002 pre-scan
        // already covers this code path; the kernel-level check is
        // defense-in-depth for direct consumers of `scheduleToolCalls`.
        toolGovernance: config.toolGovernance,
      }),
      (toolCall) =>
        executePolicyEnabledToolCall(toolCall, {
          toolMap,
          config,
          getOrCreateStat,
        })
    );

    // Drain results, applying approval-gating and 3-stage stuck-recovery
    // escalation. Returns a typed transition signaling whether the outer
    // loop should continue or halt with a specific stop reason.
    const transition = await handleToolResults(results, state, config);
    if (transition.kind === "halt") {
      stopReason = transition.stopReason;
      break;
    }

    // --- Stuck detection: after all tool calls in iteration ---
    if (config.stuckDetector) {
      const idleCheck = config.stuckDetector.recordIteration(toolCalls.length);
      if (idleCheck.stuck) {
        const reason = idleCheck.reason ?? "No progress detected";
        const recovery = "Stopping due to idle iterations.";
        config.onStuckDetected?.(reason, recovery);
        state.lastStuckReason = reason;
        stopReason = "stuck";
        break;
      }
    }

    // Defensive check: if a stuck handler advanced the stage to 3 without
    // halting via the inner transition, end the loop here.
    if (state.stuckStage >= 3) {
      stopReason = "stuck";
      break;
    }

    // Check if this was the last allowed iteration
    if (iteration === config.maxIterations - 1) {
      stopReason = "iteration_limit";
    }

    // MC-AGT-04 Phase 1 — run-state snapshot boundary. Fires after the LLM
    // turn (and any tool results) have been folded into `state.messages`
    // and after stuck/budget/halt checks have run for this iteration.
    // Errors are swallowed so a failing snapshot listener never aborts the
    // run.
    if (config.onIteration) {
      try {
        config.onIteration({
          iteration: iteration + 1,
          messages: [...state.messages],
          totalInputTokens: state.totalInputTokens,
          totalOutputTokens: state.totalOutputTokens,
          llmCalls,
        });
      } catch {
        // Snapshot hooks must never disturb the run loop.
      }
    }
  }

  // Build toolStats array from accumulators
  const toolStats: ToolStat[] = [];
  for (const [name, stat] of statMap) {
    toolStats.push({
      name,
      calls: stat.calls,
      errors: stat.errors,
      totalMs: stat.totalMs,
      avgMs: stat.calls > 0 ? Math.round(stat.totalMs / stat.calls) : 0,
    });
  }

  // Build StuckError when loop terminated due to stuck detection
  const stuckError =
    stopReason === "stuck"
      ? new StuckError({
          reason: state.lastStuckReason ?? "Agent stuck with no progress",
          ...(state.lastStuckToolName !== undefined
            ? { repeatedTool: state.lastStuckToolName }
            : {}),
          escalationLevel: Math.max(1, Math.min(state.stuckStage, 3)) as
            | 1
            | 2
            | 3,
        })
      : undefined;

  return omitUndefined({
    messages: state.messages,
    totalInputTokens: state.totalInputTokens,
    totalOutputTokens: state.totalOutputTokens,
    llmCalls,
    hitIterationLimit:
      stopReason === "iteration_limit" || stopReason === "budget_exceeded",
    stopReason,
    toolStats,
    stuckError,
  });
}
