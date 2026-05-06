/**
 * Streaming tool-call helpers extracted from {@link executeStreamingToolCall}
 * (RF-19 / CODE-02).
 *
 * The helpers preserve the original observable behaviour of
 * `executeStreamingToolCall` — event-bus emissions, OTel span attributes,
 * abort-signal threading, error rethrows, stuck-detection ordering, and
 * latency telemetry — while keeping the orchestrator under 100 LOC.
 *
 * Each helper is independent and may be unit-tested in isolation. The
 * signatures are deliberately generic so that callers can stub
 * `statTracker`, `onToolLatency`, and event sinks without taking a
 * dependency on the wider {@link executeStreamingToolCall} input shape.
 */
import { ToolMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { ForgeError } from '@dzupagent/core'
import { ContentScanner } from '@dzupagent/security'
import type { IterationBudget } from '../guardrails/iteration-budget.js'
import { omitUndefined } from '../utils/exact-optional.js'
import {
  emitToolCalled,
  emitToolCancellationRequested,
  emitToolError,
  emitToolResult,
  extractInputMetadataKeys,
  invokeWithOptionalTimeout,
  maybeValidateArgs,
  resolveValidatorConfig,
} from './tool-lifecycle-policy.js'
import type {
  StreamingToolExecutionResult,
  StreamingToolPolicyOptions,
  ToolStatTracker,
} from './run-engine.js'

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

/**
 * Outcome of {@link runToolStreamingPhase}: either a short-circuit (validation
 * error / safety block / prompt-injection block / scanner failure when
 * fail-closed) that the orchestrator must surface verbatim, or a successful
 * invocation with the transformed result and metadata required for
 * stuck-detection and final ToolMessage construction.
 */
export type StreamPhaseResult =
  | { kind: 'short-circuit'; result: StreamingToolExecutionResult }
  | {
      kind: 'success'
      transformedResult: string
      validatedArgs: Record<string, unknown>
      validatedKeys: string[]
    }

/**
 * Validate args, invoke the tool (with timeout + abort signal), run safety
 * and prompt-injection scans on the result, and emit lifecycle events.
 *
 * Mirrors lines 849-1107 of the original `executeStreamingToolCall`.
 *
 * Throws unhandled tool-invocation errors so the orchestrator's outer
 * try/catch can apply error-path stuck detection and emit the same
 * `tool:error` / OTel attributes as before extraction.
 */
export async function runToolStreamingPhase(args: {
  toolCall: StreamingToolCall
  toolCallId: string
  toolName: string
  inputMetadataKeys: string[]
  tool: StructuredToolInterface
  transformToolResult: (
    toolName: string,
    input: Record<string, unknown>,
    result: string,
  ) => Promise<string>
  statTracker: ToolStatTracker
  onToolLatency?: (name: string, durationMs: number, error?: string) => void
  signal?: AbortSignal
  policy?: StreamingToolPolicyOptions
  startMs: number
}): Promise<StreamPhaseResult> {
  const {
    toolCall,
    toolCallId,
    toolName,
    inputMetadataKeys,
    tool,
    transformToolResult,
    statTracker,
    onToolLatency,
    signal,
    policy,
    startMs,
  } = args

  // Argument validation (mirrors tool-loop.ts ~1056-1078).
  const validatorCfg = resolveValidatorConfig(policy?.validateToolArgs)
  const { args: validatedArgs, validationError } = maybeValidateArgs(
    toolCall,
    tool,
    validatorCfg,
  )

  if (validationError) {
    emitToolError(policy, {
      toolName,
      toolCallId,
      durationMs: 0,
      inputMetadataKeys,
      errorCode: 'VALIDATION_FAILED',
      errorMessage: validationError,
      status: 'error',
    })
    return {
      kind: 'short-circuit',
      result: {
        message: new ToolMessage({
          content: validationError,
          tool_call_id: toolCallId,
          name: toolName,
        }),
        eventResult: '[validation error]',
      },
    }
  }

  const validatedKeys = extractInputMetadataKeys(validatedArgs)

  emitToolCalled(policy, {
    toolName,
    toolCallId,
    input: validatedArgs,
    inputMetadataKeys: validatedKeys,
  })

  // Optional OTel span per tool invocation (mirrors tool-loop.ts ~1106).
  const inputSize = JSON.stringify(validatedArgs).length
  const span = policy?.tracer?.startToolSpan(toolName, { inputSize })

  let rawResult: string
  let transformedResult: string
  try {
    const result = await invokeWithOptionalTimeout(
      toolName,
      policy?.toolTimeouts?.[toolName],
      ({ signal: invocationSignal }) => tool.invoke(validatedArgs, { signal: invocationSignal }),
      omitUndefined({
        signal: policy?.signal ?? signal,
        onCancelRequested: (reason: 'timeout' | 'run_cancelled') => emitToolCancellationRequested(policy, {
          toolName,
          toolCallId,
          inputMetadataKeys: validatedKeys,
          reason,
          ...(reason === 'timeout' && policy?.toolTimeouts?.[toolName] !== undefined
            ? { timeoutMs: policy.toolTimeouts[toolName] }
            : {}),
        }),
      }),
    )
    rawResult = typeof result === 'string' ? result : JSON.stringify(result)
    transformedResult = await transformToolResult(toolName, validatedArgs, rawResult)
  } catch (invocationError: unknown) {
    // Surface validatedKeys + active span to the orchestrator so the
    // outer catch block can call `emitToolError`, `endSpanWithError`,
    // and stuck-detection with the SAME observable order as the
    // pre-extraction code path.
    if (span) {
      try {
        const durationMs = Date.now() - startMs
        span.setAttribute('durationMs', durationMs)
        policy?.tracer?.endSpanWithError(span, invocationError)
      } catch {
        // Tracer failures must not abort the streaming loop
      }
    }
    throw Object.assign(
      invocationError instanceof Error ? invocationError : new Error(String(invocationError)),
      { __dzupValidatedKeys: validatedKeys, __dzupSpanEnded: true },
    )
  }

  // Safety scan (mirrors tool-loop.ts ~1119-1170).
  if (policy?.safetyMonitor && policy.scanToolResults !== false) {
    try {
      const violations = policy.safetyMonitor.scanContent(transformedResult, {
        source: 'tool:result',
        toolName,
      })
      const hardBlock = violations.find(
        (v) => v.action === 'block' || v.action === 'kill' || v.severity === 'critical',
      )
      if (hardBlock) {
        const blockedContent = `[blocked] Tool result contained potentially unsafe content (${hardBlock.category}): ${hardBlock.message}`
        transformedResult = blockedContent
        const durationMs = recordToolLatencyOutcome(omitUndefined({
          statTracker,
          onToolLatency,
          toolName,
          startMs,
          errorTag: 'unsafe-result',
        }))
        emitToolError(policy, {
          toolName,
          toolCallId,
          durationMs,
          inputMetadataKeys: validatedKeys,
          errorCode: 'TOOL_EXECUTION_FAILED',
          errorMessage: `Tool result blocked: ${hardBlock.category} — ${hardBlock.message}`,
          status: 'denied',
        })
        if (span) {
          try {
            span.setAttribute('durationMs', durationMs)
            span.setAttribute('outputSize', blockedContent.length)
            span.setAttribute('blocked', true)
            span.end()
          } catch {
            // Tracer failures must not abort the streaming loop
          }
        }
        return {
          kind: 'short-circuit',
          result: {
            message: new ToolMessage({
              content: blockedContent,
              tool_call_id: toolCallId,
              name: toolName,
            }),
            eventResult: '[blocked: unsafe tool output]',
          },
        }
      }
    } catch {
      policy.eventBus?.emit({
        type: 'safety:violation',
        category: 'tool_result_scanner_failure',
        severity: policy.scanFailureMode === 'fail-closed' ? 'critical' : 'warning',
        ...(policy.agentId !== undefined ? { agentId: policy.agentId } : {}),
        message: 'Tool result safety scanner failed',
      })

      if (policy.scanFailureMode === 'fail-closed') {
        const blockedContent = '[blocked: tool result safety scanner failed]'
        const durationMs = recordToolLatencyOutcome(omitUndefined({
          statTracker,
          onToolLatency,
          toolName,
          startMs,
          errorTag: 'scanner-failure',
        }))
        emitToolError(policy, {
          toolName,
          toolCallId,
          durationMs,
          inputMetadataKeys: validatedKeys,
          errorCode: 'TOOL_EXECUTION_FAILED',
          errorMessage: 'Tool result safety scanner failed; output withheld',
          status: 'error',
        })
        if (span) {
          try {
            span.setAttribute('durationMs', durationMs)
            span.setAttribute('scannerFailure', true)
            span.end()
          } catch {
            // Tracer failures must not abort the streaming loop
          }
        }
        return {
          kind: 'short-circuit',
          result: {
            message: new ToolMessage({
              content: blockedContent,
              tool_call_id: toolCallId,
              name: toolName,
            }),
            eventResult: blockedContent,
          },
        }
      }
    }
  }

  // RF-15 — prompt-injection scan on tool results.
  const piMode = policy?.promptInjectionToolResults
  if (piMode !== undefined && piMode !== 'off') {
    try {
      const scanner = new ContentScanner({ promptInjection: piMode, pii: 'off' })
      const scan = await scanner.scan(transformedResult)
      if (scan.verdict === 'block') {
        const blockedContent = '[blocked: tool result contained prompt-injection markers]'
        const durationMs = recordToolLatencyOutcome(omitUndefined({
          statTracker,
          onToolLatency,
          toolName,
          startMs,
          errorTag: 'prompt-injection',
        }))
        policy?.eventBus?.emit({
          type: 'safety:violation',
          category: 'tool_result_prompt_injection',
          severity: 'critical',
          ...(policy?.agentId !== undefined ? { agentId: policy.agentId } : {}),
          message: `Tool "${toolName}" output blocked: prompt-injection markers detected (${scan.findings.length} finding(s))`,
        })
        emitToolError(policy, {
          toolName,
          toolCallId,
          durationMs,
          inputMetadataKeys: validatedKeys,
          errorCode: 'TOOL_EXECUTION_FAILED',
          errorMessage: 'Tool result blocked: prompt-injection detected',
          status: 'denied',
        })
        if (span) {
          try {
            span.setAttribute('durationMs', durationMs)
            span.setAttribute('outputSize', blockedContent.length)
            span.setAttribute('blocked', true)
            span.setAttribute('blockReason', 'prompt_injection')
            span.end()
          } catch {
            // Tracer failures must not abort the streaming loop
          }
        }
        return {
          kind: 'short-circuit',
          result: {
            message: new ToolMessage({
              content: blockedContent,
              tool_call_id: toolCallId,
              name: toolName,
            }),
            eventResult: blockedContent,
          },
        }
      }
      if (scan.verdict === 'sanitize') {
        policy?.eventBus?.emit({
          type: 'safety:violation',
          category: 'tool_result_prompt_injection',
          severity: 'warning',
          ...(policy?.agentId !== undefined ? { agentId: policy.agentId } : {}),
          message: `Tool "${toolName}" output sanitized: prompt-injection markers rewritten (${scan.findings.length} finding(s))`,
        })
        transformedResult = scan.sanitized
      }
    } catch {
      // Scanner exceptions are non-fatal — emit a violation event and
      // continue with the original output.
      policy?.eventBus?.emit({
        type: 'safety:violation',
        category: 'tool_result_prompt_injection_scanner_failure',
        severity: 'warning',
        ...(policy?.agentId !== undefined ? { agentId: policy.agentId } : {}),
        message: 'Tool result prompt-injection scanner failed',
      })
    }
  }

  // Successful path: record latency, emit `tool:result`, end span.
  const durationMs = recordToolLatencyOutcome(omitUndefined({
    statTracker,
    onToolLatency,
    toolName,
    startMs,
  }))

  emitToolResult(policy, {
    toolName,
    toolCallId,
    durationMs,
    inputMetadataKeys: validatedKeys,
    output: transformedResult,
  })
  if (span) {
    try {
      span.setAttribute('durationMs', durationMs)
      span.setAttribute('outputSize', transformedResult.length)
      span.end()
    } catch {
      // Tracer failures must not abort the streaming loop
    }
  }

  return {
    kind: 'success',
    transformedResult,
    validatedArgs,
    validatedKeys,
  }
}

/**
 * Record per-tool latency telemetry: writes to the in-memory
 * {@link ToolStatTracker} and forwards to the optional `onToolLatency`
 * callback. Returns `durationMs` so the caller can re-use it for span
 * attributes / error events without recomputing `Date.now() - startMs`.
 *
 * `errorTag` is forwarded ONLY to `onToolLatency` (callers that scan
 * latency for ad-hoc failure flags); the in-memory `statTracker` only
 * receives the tool name and duration for blocked / scanner / prompt-
 * injection paths — error counters are reserved for the outer catch
 * block which records `errorTag` on the tracker too. Pass
 * `recordOnTracker: true` to mirror the catch-block semantics.
 */
export function recordToolLatencyOutcome(args: {
  statTracker: ToolStatTracker
  onToolLatency?: (name: string, durationMs: number, error?: string) => void
  toolName: string
  startMs: number
  errorTag?: string
  recordOnTracker?: boolean
}): number {
  const { statTracker, onToolLatency, toolName, startMs, errorTag, recordOnTracker } = args
  const durationMs = Date.now() - startMs
  if (recordOnTracker === true && errorTag !== undefined) {
    statTracker.record(toolName, durationMs, errorTag)
  } else {
    statTracker.record(toolName, durationMs)
  }
  onToolLatency?.(toolName, durationMs, errorTag)
  return durationMs
}

