/**
 * Core streaming tool-invocation phase (RF-19 / CODE-02 / MC-013).
 *
 * Extracted from `run-engine-streaming-helpers.ts` so the validation,
 * invocation (with timeout + abort), safety / prompt-injection scans,
 * and lifecycle-event emission for a single tool call live in their
 * own module. Behaviour is unchanged.
 */
import { ToolMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { ContentScanner } from '@dzupagent/security'
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
import { recordToolLatencyOutcome } from './stream-result-helpers.js'
import type {
  StreamingToolExecutionResult,
  StreamingToolPolicyOptions,
  ToolStatTracker,
} from './streaming-tool-types.js'

interface StreamingToolCall {
  id?: string
  name: string
  args: Record<string, unknown>
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

  // RF-15 — prompt-injection + PII scan on tool results.
  const piMode = policy?.promptInjectionToolResults
  const piiMode = policy?.piiToolResults
  if ((piMode !== undefined && piMode !== 'off') || (piiMode !== undefined && piiMode !== 'off')) {
    try {
      const scanner = new ContentScanner({ promptInjection: piMode ?? 'off', pii: piiMode ?? 'off' })
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
