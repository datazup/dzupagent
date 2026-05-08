import { ToolMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { ForgeError } from '@dzupagent/core/events'
import {
  emitToolError,
  extractInputMetadataKeys,
  maybeValidateArgs,
  resolveValidatorConfig,
} from '../tool-lifecycle-policy.js'
import type { ToolLoopConfig } from '../tool-loop.js'
import type { ToolCall, ToolCallResult } from './contracts.js'

/**
 * REC-M-06 — Shared permission-tier evaluation helper.
 *
 * Returns `true` when the given tool is permitted under the configured
 * `toolPermissionPolicy` for the configured `agentId`. Returns `true` (i.e.
 * "no-op pass") when either the policy or `agentId` is absent, preserving
 * the pre-policy surface where permission checks are opt-in.
 *
 * This helper is invoked at TWO sites inside the executor:
 *
 *   1. Pre-flight, immediately on entry (the historical check).
 *   2. Tool-issuance, immediately before `tool.invoke()` runs.
 *
 * The second site closes the time-of-check / time-of-use (TOCTOU) window
 * that exists between pre-flight and the actual tool invocation: a
 * concurrent mutation of the policy (or a re-entrant loop with a different
 * policy in scope) could otherwise allow a write tool to land after
 * pre-flight signed off. Both sites therefore call THIS function to
 * guarantee the decision is consistent.
 *
 * The helper is deliberately lightweight: it never performs I/O, never
 * mutates state, and never throws — callers handle denial. Policy
 * implementations are themselves expected to be O(1) (allowlist lookup or
 * tier comparison); the audit caveat that the second check be "lightweight,
 * no extra DB calls" is the policy's contract, not this helper's.
 */
export function evaluateToolPermission(
  config: ToolLoopConfig,
  toolName: string,
): boolean {
  if (!config.toolPermissionPolicy || !config.agentId) return true
  return config.toolPermissionPolicy.hasPermission(config.agentId, toolName)
}

/**
 * REC-M-06 — Emit `safety:violation` for a denied tool issuance.
 *
 * Consumed by the second (issuance-time) permission check. The first
 * (pre-flight) check predates this helper and emits its denial via
 * `tool:error` only — that path is preserved for backward compatibility.
 * The issuance-time denial is treated as a stronger signal (a tool that
 * passed pre-flight but is now blocked indicates either a policy mutation
 * or a TOCTOU race) and therefore additionally surfaces as a high-severity
 * `safety:violation` so audit pipelines can flag it.
 */
export function emitPermissionDeniedSafetyViolation(
  config: ToolLoopConfig,
  toolName: string,
): void {
  if (!config.eventBus) return
  try {
    config.eventBus.emit({
      type: 'safety:violation',
      category: 'tool_permission_denied',
      severity: 'high',
      ...(config.agentId !== undefined ? { agentId: config.agentId } : {}),
      message: `Tool "${toolName}" denied at issuance time after passing pre-flight`,
    })
  } catch {
    // Telemetry must never abort the tool loop.
  }
}

/**
 * Outcome of the pre-flight policy gauntlet. When `result` is set the caller
 * should short-circuit and return it. When `result` is undefined the gauntlet
 * passed and the caller can proceed to invoke the tool. `validatedArgs` and
 * `validatedKeys` are populated on success so the caller does not redo the
 * validation step.
 */
export interface PolicyCheckOutcome {
  result?: ToolCallResult
  validatedArgs?: Record<string, unknown>
  validatedKeys?: string[]
  tool?: StructuredToolInterface
  /** Set when the gauntlet hit a hard error path (raised pre-emptively). */
  thrown?: Error
}

/**
 * Run the pre-flight policy gauntlet for a single tool call. Returns either
 * an early `ToolCallResult` (denial / blocked / not-found / validation
 * failure / approval pending) or the validated arguments + tool reference
 * the caller needs to invoke the tool.
 *
 * The gauntlet checks, in order:
 *   1. Permission policy (REC-M-06 pre-flight site)
 *   2. Budget tool block
 *   3. Tool governance access + approval
 *   4. Tool registry lookup
 *   5. Argument schema validation / repair
 *
 * Any callers must handle the `thrown` field separately — the historical
 * permission-denial path throws a `ForgeError` rather than returning a
 * `ToolCallResult`, and that contract is preserved here.
 */
export function runPolicyChecks(
  tc: ToolCall,
  toolMap: Map<string, StructuredToolInterface>,
  config: ToolLoopConfig,
  toolCallId: string,
  inputMetadataKeys: string[],
): PolicyCheckOutcome {
  const toolName = tc.name

  // REC-M-06 — Pre-flight permission check (first of two sites). The
  // second site fires immediately before `tool.invoke()` to close the
  // time-of-check / time-of-use window. Both sites delegate to the shared
  // `evaluateToolPermission` helper.
  if (!evaluateToolPermission(config, toolName)) {
    emitToolError(config, {
      toolName,
      toolCallId,
      durationMs: 0,
      inputMetadataKeys,
      errorCode: 'TOOL_PERMISSION_DENIED',
      errorMessage: `Tool "${toolName}" is not accessible to agent "${config.agentId}"`,
      status: 'denied',
    })
    return {
      thrown: new ForgeError({
        code: 'TOOL_PERMISSION_DENIED',
        message: `Tool "${toolName}" is not accessible to agent "${config.agentId}"`,
        context: { agentId: config.agentId, toolName },
      }),
    }
  }

  if (config.budget?.isToolBlocked(toolName)) {
    config.onToolResult?.(toolName, '[blocked]')
    emitToolError(config, {
      toolName,
      toolCallId,
      durationMs: 0,
      inputMetadataKeys,
      errorCode: 'TOOL_PERMISSION_DENIED',
      errorMessage: `Tool "${toolName}" is blocked by guardrails`,
      status: 'denied',
    })
    return {
      result: {
        message: new ToolMessage({
          content: `[Tool "${toolName}" is blocked by guardrails]`,
          tool_call_id: toolCallId,
          name: toolName,
        }),
      },
    }
  }

  if (config.toolGovernance) {
    const access = config.toolGovernance.checkAccess(toolName, tc.args)
    if (!access.allowed) {
      const reason = access.reason ?? 'Tool access denied'
      config.onToolResult?.(toolName, `[blocked: ${reason}]`)
      emitToolError(config, {
        toolName,
        toolCallId,
        durationMs: 0,
        inputMetadataKeys,
        errorCode: 'TOOL_PERMISSION_DENIED',
        errorMessage: reason,
        status: 'denied',
      })
      return {
        result: {
          message: new ToolMessage({
            content: `[blocked] ${reason}`,
            tool_call_id: toolCallId,
            name: toolName,
          }),
        },
      }
    }
    if (access.requiresApproval) {
      const correlationId = config.runId ?? toolCallId
      try {
        config.eventBus?.emit({
          type: 'approval:requested',
          runId: correlationId,
          plan: { toolName, args: tc.args },
        })
      } catch {
        // Non-fatal: event emission must not abort the run.
      }
      const reason = access.reason ?? 'Approval required'
      config.onToolResult?.(toolName, `[approval_pending: ${reason}]`)
      return {
        result: {
          message: new ToolMessage({
            content: `[approval_pending] Tool "${toolName}" requires human approval before execution. ${reason}`,
            tool_call_id: toolCallId,
            name: toolName,
          }),
          approvalPending: true,
        },
      }
    }
  }

  const tool = toolMap.get(toolName)
  if (!tool) {
    config.onToolResult?.(toolName, '[not found]')
    emitToolError(config, {
      toolName,
      toolCallId,
      durationMs: 0,
      inputMetadataKeys,
      errorCode: 'TOOL_NOT_FOUND',
      errorMessage: `Tool "${toolName}" not found`,
      status: 'error',
    })
    return {
      result: {
        message: new ToolMessage({
          content: `Error: Tool "${toolName}" not found. Available tools: ${[...toolMap.keys()].join(', ')}`,
          tool_call_id: toolCallId,
          name: toolName,
        }),
      },
    }
  }

  const validatorCfg = resolveValidatorConfig(config.validateToolArgs)
  const { args: validatedArgs, validationError } = maybeValidateArgs(tc, tool, validatorCfg)

  if (validationError) {
    config.onToolResult?.(toolName, '[validation error]')
    emitToolError(config, {
      toolName,
      toolCallId,
      durationMs: 0,
      inputMetadataKeys,
      errorCode: 'VALIDATION_FAILED',
      errorMessage: validationError,
      status: 'error',
    })
    return {
      result: {
        message: new ToolMessage({
          content: validationError,
          tool_call_id: toolCallId,
          name: toolName,
        }),
      },
    }
  }

  const validatedKeys = extractInputMetadataKeys(validatedArgs)
  return { tool, validatedArgs, validatedKeys }
}
