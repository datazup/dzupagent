/**
 * Guardrail stage helpers for the sub-agent ReAct loop (DZUPAGENT-AGENT-C-04).
 *
 * `SubAgentSpawner.spawnReAct` historically executed tool calls with none of
 * the controls the main tool loop applies. The full remedy (MJ-01) is to route
 * sub-agent execution through `@dzupagent/agent`'s `runToolLoop` /
 * `executePolicyEnabledToolCall`; that is blocked by the package-boundary rule
 * (`@dzupagent/core` is the dependency root and must not import
 * `@dzupagent/agent`).
 *
 * This module therefore re-implements — in core, over core-visible
 * dependencies only — the subset of the policy stack whose primitives already
 * live at or below core: prompt-injection fencing of tool results
 * (`@dzupagent/security`), tool-permission policy (`@dzupagent/agent-types`),
 * `ToolGovernance` access/approval checks (`core/tools`), and `tool:called` /
 * `tool:result` / `tool:error` lifecycle emission (`core/events`).
 *
 * Semantics deliberately mirror `packages/agent/src/agent/tool-loop/
 * policy-checks.ts` so a later migration to the shared executor is a
 * behaviour-preserving swap.
 */
import {
  fenceToolResult as fenceSecurityToolResult,
  PromptInjectionGuard,
} from "@dzupagent/security";
import type { ToolPermissionPolicy } from "@dzupagent/agent-types";
import type { DzupEventBus } from "../events/event-bus.js";
import { requireTerminalToolExecutionRunId } from "../events/tool-event-correlation.js";
import type { ToolGovernance } from "../tools/tool-governance.js";
import type { ForgeErrorCode } from "../errors/error-codes.js";

/** Guardrail dependencies resolved once per `spawnReAct` invocation. */
export interface SubAgentGuardrailContext {
  /** Agent identity used for permission checks and event attribution. */
  agentId: string;
  /** Stable run id carried on every emitted tool lifecycle event. */
  executionRunId: string;
  eventBus?: DzupEventBus | undefined;
  /** Injection guard applied to tool results. `undefined` disables fencing. */
  promptInjectionGuard?: PromptInjectionGuard | undefined;
  toolPermissionPolicy?: ToolPermissionPolicy | undefined;
  toolGovernance?: ToolGovernance | undefined;
}

/** Outcome of the pre-execution policy checks for one tool call. */
export type ToolPolicyDecision =
  | { kind: "allow" }
  | { kind: "blocked"; content: string; errorCode: ForgeErrorCode }
  | { kind: "approval_pending"; content: string };

/**
 * Top-level keys of a tool input. Values are never emitted (they can carry
 * secrets); only the key shape reaches telemetry.
 */
export function inputMetadataKeysOf(args: unknown): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  return Object.keys(args as Record<string, unknown>);
}

/**
 * Pre-execution policy gate: permission policy, then governance access /
 * approval. Returns `allow` when no configured control objects.
 */
export function checkToolPolicy(
  ctx: SubAgentGuardrailContext,
  toolName: string,
  args: Record<string, unknown>,
): ToolPolicyDecision {
  if (
    ctx.toolPermissionPolicy &&
    !ctx.toolPermissionPolicy.hasPermission(ctx.agentId, toolName)
  ) {
    return {
      kind: "blocked",
      content: `[blocked] Tool "${toolName}" is not accessible to agent "${ctx.agentId}"`,
      errorCode: "TOOL_PERMISSION_DENIED",
    };
  }

  if (ctx.toolGovernance) {
    const access = ctx.toolGovernance.checkAccess(toolName, args);
    if (!access.allowed) {
      const reason = access.reason ?? "Tool access denied";
      return {
        kind: "blocked",
        content: `[blocked] ${reason}`,
        errorCode: "TOOL_PERMISSION_DENIED",
      };
    }
    if (access.requiresApproval) {
      const reason = access.reason ?? "Approval required";
      safeEmit(ctx, {
        type: "approval:requested",
        runId: ctx.executionRunId,
        plan: { toolName, args },
      });
      return {
        kind: "approval_pending",
        content: `[approval_pending] Tool "${toolName}" requires human approval before execution. ${reason}`,
      };
    }
  }

  return { kind: "allow" };
}

/**
 * Fence untrusted tool output inside an `<untrusted_content source="tool_result">`
 * block so the model cannot mistake it for authoritative instruction
 * (AGENT-H-06 / SEC-M-06 parity with the main loop's success path).
 */
export function fenceToolResult(
  ctx: SubAgentGuardrailContext,
  content: string,
): string {
  if (!ctx.promptInjectionGuard) return content;
  return fenceSecurityToolResult(content, {
    guard: ctx.promptInjectionGuard,
  });
}

/** Emit `tool:called`. Never throws — telemetry must not abort a run. */
export function emitToolCalled(
  ctx: SubAgentGuardrailContext,
  params: { toolName: string; toolCallId: string; args: Record<string, unknown> },
): void {
  safeEmit(ctx, {
    type: "tool:called",
    toolName: params.toolName,
    agentId: ctx.agentId,
    executionRunId: ctx.executionRunId,
    runId: ctx.executionRunId,
    toolCallId: params.toolCallId,
    inputMetadataKeys: inputMetadataKeysOf(params.args),
  });
}

/** Emit `tool:result` with a guaranteed non-empty execution run id. */
export function emitToolResult(
  ctx: SubAgentGuardrailContext,
  params: {
    toolName: string;
    toolCallId: string;
    durationMs: number;
    inputMetadataKeys: string[];
  },
): void {
  const executionRunId = requireTerminalToolExecutionRunId({
    eventType: "tool:result",
    toolName: params.toolName,
    executionRunId: ctx.executionRunId,
  });
  safeEmit(ctx, {
    type: "tool:result",
    toolName: params.toolName,
    durationMs: params.durationMs,
    agentId: ctx.agentId,
    executionRunId,
    runId: executionRunId,
    toolCallId: params.toolCallId,
    inputMetadataKeys: params.inputMetadataKeys,
    status: "success",
  });
}

/** Emit `tool:error` with a guaranteed non-empty execution run id. */
export function emitToolError(
  ctx: SubAgentGuardrailContext,
  params: {
    toolName: string;
    toolCallId: string;
    durationMs: number;
    inputMetadataKeys: string[];
    errorCode: ForgeErrorCode;
    message: string;
  },
): void {
  const executionRunId = requireTerminalToolExecutionRunId({
    eventType: "tool:error",
    toolName: params.toolName,
    executionRunId: ctx.executionRunId,
  });
  safeEmit(ctx, {
    type: "tool:error",
    toolName: params.toolName,
    errorCode: params.errorCode,
    message: params.message,
    durationMs: params.durationMs,
    agentId: ctx.agentId,
    executionRunId,
    runId: executionRunId,
    toolCallId: params.toolCallId,
    inputMetadataKeys: params.inputMetadataKeys,
  });
}

/** Event emission is best-effort; a broken bus must never fail the sub-agent. */
function safeEmit(
  ctx: SubAgentGuardrailContext,
  event: Parameters<DzupEventBus["emit"]>[0],
): void {
  if (!ctx.eventBus) return;
  try {
    ctx.eventBus.emit(event);
  } catch {
    // Non-fatal by design.
  }
}

/** Default guard instance used when injection fencing is enabled. */
export const DEFAULT_SUBAGENT_INJECTION_GUARD = new PromptInjectionGuard();
