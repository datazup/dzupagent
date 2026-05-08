/**
 * Pre-execution gate stack for streaming tool calls (RF-19 / CODE-02 /
 * MC-013).
 *
 * Extracted from `run-engine-streaming-helpers.ts` so the budget /
 * permission / governance / tool-map gating concerns live in their own
 * module. Behaviour is unchanged: this module owns the same observable
 * event ordering and short-circuit shapes as the pre-MC-013 code path.
 */
import { ToolMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { ForgeError } from '@dzupagent/core/events'
import type { IterationBudget } from '../guardrails/iteration-budget.js'
import { emitToolError } from './tool-lifecycle-policy.js'
import type {
  StreamingToolExecutionResult,
  StreamingToolPolicyOptions,
} from './streaming-tool-types.js'

interface StreamingToolCall {
  id?: string
  name: string
  args: Record<string, unknown>
}

/**
 * Outcome of {@link applyBudgetGate}: either a short-circuit
 * {@link StreamingToolExecutionResult} (denied / blocked / approval-pending /
 * not-found) the orchestrator must return as-is, or a `continue` token that
 * carries the resolved tool to invoke.
 */
export type BudgetDecision =
  | { kind: 'short-circuit'; result: StreamingToolExecutionResult; throwError?: ForgeError }
  | { kind: 'continue'; tool: StructuredToolInterface }

/**
 * Pre-execution gate stack: permission policy, iteration-budget block,
 * governance access check (incl. approval), and tool-map lookup.
 *
 * Mirrors lines 744-847 of the original `executeStreamingToolCall`.
 */
export function applyBudgetGate(args: {
  toolCall: StreamingToolCall
  toolCallId: string
  toolName: string
  inputMetadataKeys: string[]
  budget?: IterationBudget
  toolMap: Map<string, StructuredToolInterface>
  policy?: StreamingToolPolicyOptions
}): BudgetDecision {
  const { toolCall, toolCallId, toolName, inputMetadataKeys, budget, toolMap, policy } = args

  // Permission policy check (MC-GA03).
  if (policy?.toolPermissionPolicy && policy.agentId) {
    if (!policy.toolPermissionPolicy.hasPermission(policy.agentId, toolName)) {
      emitToolError(policy, {
        toolName,
        toolCallId,
        durationMs: 0,
        inputMetadataKeys,
        errorCode: 'TOOL_PERMISSION_DENIED',
        errorMessage: `Tool "${toolName}" is not accessible to agent "${policy.agentId}"`,
        status: 'denied',
      })
      const err = new ForgeError({
        code: 'TOOL_PERMISSION_DENIED',
        message: `Tool "${toolName}" is not accessible to agent "${policy.agentId}"`,
        context: { agentId: policy.agentId, toolName },
      })
      return {
        kind: 'short-circuit',
        // The orchestrator throws this; result is never read but kept for
        // type-shape symmetry with other branches.
        result: {
          message: new ToolMessage({
            content: err.message,
            tool_call_id: toolCallId,
            name: toolName,
          }),
          eventResult: '[denied]',
        },
        throwError: err,
      }
    }
  }

  if (budget?.isToolBlocked(toolName)) {
    emitToolError(policy, {
      toolName,
      toolCallId,
      durationMs: 0,
      inputMetadataKeys,
      errorCode: 'TOOL_PERMISSION_DENIED',
      errorMessage: `Tool "${toolName}" is blocked by guardrails`,
      status: 'denied',
    })
    return {
      kind: 'short-circuit',
      result: {
        message: new ToolMessage({
          content: `[Tool "${toolName}" is blocked by guardrails]`,
          tool_call_id: toolCallId,
          name: toolName,
        }),
        eventResult: '[blocked]',
      },
    }
  }

  if (policy?.toolGovernance) {
    const access = policy.toolGovernance.checkAccess(toolName, toolCall.args)
    if (!access.allowed) {
      const reason = access.reason ?? 'Tool access denied'
      emitToolError(policy, {
        toolName,
        toolCallId,
        durationMs: 0,
        inputMetadataKeys,
        errorCode: 'TOOL_PERMISSION_DENIED',
        errorMessage: reason,
        status: 'denied',
      })
      return {
        kind: 'short-circuit',
        result: {
          message: new ToolMessage({
            content: `[blocked] ${reason}`,
            tool_call_id: toolCallId,
            name: toolName,
          }),
          eventResult: `[blocked: ${reason}]`,
        },
      }
    }
    if (access.requiresApproval) {
      const correlationId = policy.runId ?? toolCallId
      try {
        policy.eventBus?.emit({
          type: 'approval:requested',
          runId: correlationId,
          plan: { toolName, args: toolCall.args },
        })
      } catch {
        // Non-fatal: event emission must not abort the run.
      }
      const reason = access.reason ?? 'Approval required'
      return {
        kind: 'short-circuit',
        result: {
          message: new ToolMessage({
            content: `[approval_pending] Tool "${toolName}" requires human approval before execution. ${reason}`,
            tool_call_id: toolCallId,
            name: toolName,
          }),
          eventResult: `[approval_pending: ${reason}]`,
          approvalPending: true,
        },
      }
    }
  }

  const tool = toolMap.get(toolName)
  if (!tool) {
    return {
      kind: 'short-circuit',
      result: {
        message: new ToolMessage({
          content: `Error: Tool "${toolName}" not found. Available tools: ${[...toolMap.keys()].join(', ')}`,
          tool_call_id: toolCallId,
          name: toolName,
        }),
        eventResult: '[not found]',
      },
    }
  }

  return { kind: 'continue', tool }
}
