/**
 * Per-event guardrail handlers for {@link AdapterGuardrails}.
 *
 * Extracted from `adapter-guardrails.ts` (MC-027a-2). The orchestrator
 * delegates to {@link processGuardrailEvent} which dispatches on
 * `event.type` and mutates the shared `GuardrailsHandlerState`.
 */
import type { DzupEventBus } from "@dzupagent/core/events";
import type { AgentEvent } from "../types.js";
import {
  looksLikeError,
  type GuardrailViolation,
  type StuckStatus,
} from "./adapter-guardrails-types.js";
import type { AdapterStuckDetector } from "./adapter-stuck-detector.js";
import type { GuardrailsBudgetTracker } from "./guardrails-budget-tracker.js";
import { assertCommandNotDestructive } from "../security/destructive-command-guard.js";

export interface GuardrailsHandlerState {
  readonly stuckDetector: AdapterStuckDetector | null;
  readonly blockedTools: Set<string>;
  readonly budget: GuardrailsBudgetTracker;
  /** Live reference to the orchestrator's violation list. */
  readonly violations: GuardrailViolation[];
  /** Current run's last observed stuck status. Updated in place. */
  lastStuckStatus: StuckStatus;
  /** Counter cleared on each `adapter:completed` to detect idle iterations. */
  toolCallsInCurrentIteration: number;
  readonly eventBus: DzupEventBus | undefined;
  readonly outputFilter:
    | ((output: string) => Promise<string | null>)
    | undefined;
  /** Late-bound callback so `setOnRuleViolation()` is honoured. */
  readonly getOnRuleViolation: () =>
    | ((ruleId: string, severity: "warn" | "block", detail: string) => void)
    | undefined;
}

export interface ProcessEventResult {
  abort: boolean;
  abortReason?: string;
  filteredEvent?: AgentEvent;
}

/**
 * Dispatch a single event onto the appropriate handler. Pure with respect
 * to its return value but mutates `state` (counters, stuck status,
 * violations) so the orchestrator's snapshot stays in sync.
 */
export async function processGuardrailEvent(
  event: AgentEvent,
  state: GuardrailsHandlerState
): Promise<ProcessEventResult> {
  switch (event.type) {
    case "adapter:tool_call":
      return handleToolCall(event, state);
    case "adapter:tool_result":
      return handleToolResult(event, state);
    case "adapter:completed":
      return handleCompleted(event, state);
    case "adapter:failed":
      return handleFailed(event, state);
    default:
      return state.budget.checkBudgets();
  }
}

function handleToolCall(
  event: Extract<AgentEvent, { type: "adapter:tool_call" }>,
  state: GuardrailsHandlerState
): ProcessEventResult {
  // Pre-execution destructive-command deny.
  try {
    assertCommandNotDestructive(
      event.toolName,
      event.input as Record<string, unknown> | null
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Destructive command blocked";
    const violation: GuardrailViolation = {
      type: "blocked_tool",
      message,
      severity: "critical",
    };
    state.violations.push(violation);
    state.getOnRuleViolation()?.("destructive_command", "block", message);
    return { abort: true, abortReason: message };
  }

  if (state.blockedTools.has(event.toolName)) {
    const violation: GuardrailViolation = {
      type: "blocked_tool",
      message: `Tool "${event.toolName}" is blocked by guardrails`,
      severity: "critical",
    };
    state.violations.push(violation);
    state.getOnRuleViolation()?.("blocked_tool", "block", violation.message);
    return { abort: true, abortReason: violation.message };
  }

  if (state.stuckDetector) {
    const stuckStatus = state.stuckDetector.recordToolCall(
      event.toolName,
      event.input
    );
    state.lastStuckStatus = stuckStatus;
    if (stuckStatus.stuck) {
      const message = stuckStatus.reason ?? "Agent appears stuck";
      state.violations.push({ type: "stuck", message, severity: "critical" });
      state.eventBus?.emit({
        type: "agent:stuck_detected",
        agentId: event.providerId,
        reason: stuckStatus.reason ?? "Unknown",
        recovery: "abort",
        timestamp: Date.now(),
        repeatedTool: event.toolName,
      });
      return { abort: true, abortReason: message };
    }
  }

  state.budget.iterations++;
  state.toolCallsInCurrentIteration++;

  return state.budget.checkBudgets();
}

function handleToolResult(
  event: Extract<AgentEvent, { type: "adapter:tool_result" }>,
  state: GuardrailsHandlerState
): ProcessEventResult {
  if (state.stuckDetector && looksLikeError(event.output)) {
    const stuckStatus = state.stuckDetector.recordError(event.output);
    state.lastStuckStatus = stuckStatus;
    if (stuckStatus.stuck) {
      const message = stuckStatus.reason ?? "Too many errors";
      state.violations.push({ type: "stuck", message, severity: "critical" });
      state.eventBus?.emit({
        type: "agent:stuck_detected",
        agentId: event.providerId,
        reason: stuckStatus.reason ?? "Error loop detected",
        recovery: "abort",
        timestamp: Date.now(),
      });
      return { abort: true, abortReason: message };
    }
  }
  return state.budget.checkBudgets();
}

async function handleCompleted(
  event: Extract<AgentEvent, { type: "adapter:completed" }>,
  state: GuardrailsHandlerState
): Promise<ProcessEventResult> {
  if (event.usage) {
    state.budget.accumulateUsage(event.usage);
  }

  if (state.stuckDetector) {
    const stuckStatus = state.stuckDetector.recordIteration(
      state.toolCallsInCurrentIteration
    );
    state.toolCallsInCurrentIteration = 0;
    state.lastStuckStatus = stuckStatus;
    if (stuckStatus.stuck) {
      state.violations.push({
        type: "stuck",
        message: stuckStatus.reason ?? "Agent idle",
        severity: "warning",
      });
    }
  }

  if (state.outputFilter && event.result) {
    const filtered = await state.outputFilter(event.result);
    if (filtered === null) {
      const message = "Output was rejected by content filter";
      state.violations.push({
        type: "output_filtered",
        message,
        severity: "critical",
      });
      return { abort: true, abortReason: message };
    }
    if (filtered !== event.result) {
      return { abort: false, filteredEvent: { ...event, result: filtered } };
    }
  }

  return state.budget.checkBudgets();
}

function handleFailed(
  event: Extract<AgentEvent, { type: "adapter:failed" }>,
  state: GuardrailsHandlerState
): ProcessEventResult {
  if (state.stuckDetector) {
    const stuckStatus = state.stuckDetector.recordError(event.error);
    state.lastStuckStatus = stuckStatus;
    if (stuckStatus.stuck) {
      state.violations.push({
        type: "stuck",
        message: stuckStatus.reason ?? "Error loop detected",
        severity: "critical",
      });
    }
  }
  // Don't abort on failure events — they already indicate failure.
  return { abort: false };
}
