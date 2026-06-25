/**
 * Result / failure helpers for streaming tool calls (RF-19 / CODE-02 /
 * MC-013).
 *
 * Extracted from `run-engine-streaming-helpers.ts` so latency telemetry,
 * success-path message construction, and invocation-failure handling live
 * in their own module. Behaviour is unchanged.
 */
import { ToolMessage } from '@langchain/core/messages'
import { PromptInjectionGuard } from '@dzupagent/security'
import type { IterationBudget } from '../guardrails/iteration-budget.js'
import { omitUndefined } from '../utils/exact-optional.js'
import { emitToolError, statusFromError } from './tool-lifecycle-policy.js'
import type { StuckDetector } from '../guardrails/stuck-detector.js'
import type {
  StreamingToolExecutionResult,
  StreamingToolPolicyOptions,
  ToolStatTracker,
} from './streaming-tool-types.js'

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
  if (onToolLatency) {
    if (errorTag !== undefined) {
      onToolLatency(toolName, durationMs, errorTag)
    } else {
      onToolLatency(toolName, durationMs)
    }
  }
  return durationMs
}

/**
 * MC-3 (AGENT-H-06) — process-wide default prompt-injection guardrail for the
 * streaming tool path. Mirrors the generate() path default so both modes wrap
 * tool-result context identically (stream/generate parity, MJ-AGENT-02).
 */
const DEFAULT_PROMPT_INJECTION_GUARD = new PromptInjectionGuard()

/**
 * MC-3 — wrap a successful tool result's CONTEXT content in an
 * `<untrusted_content source="tool_result">` delimiter before it enters the
 * model's message history. Returns the raw result unchanged when wrapping is
 * disabled. The emitted `tool_result` event payload (`eventResult`) keeps the
 * raw output — only the ToolMessage content is wrapped.
 */
function wrapToolResultContent(
  result: string,
  guard:
    | {
        wrap: (
          content: string,
          opts?: { label?: string; screen?: boolean; delimit?: boolean }
        ) => string
      }
    | undefined,
  wrapToolResults: boolean | undefined,
): string {
  if (wrapToolResults === false) return result
  return (guard ?? DEFAULT_PROMPT_INJECTION_GUARD).wrap(result, {
    label: 'tool_result',
  })
}

/**
 * Build the success-path {@link StreamingToolExecutionResult}, applying
 * stuck-detection on the verified tool call. When the detector flags a
 * repeat, the tool is added to the iteration-budget block list and a
 * `stuckNudge` ToolMessage is appended for the model.
 */
export function buildSuccessResult(args: {
  toolName: string
  toolCallId: string
  transformedResult: string
  validatedArgs: Record<string, unknown>
  stuckDetector?: StuckDetector
  budget?: IterationBudget
  promptInjectionGuard?: {
    wrap: (
      content: string,
      opts?: { label?: string; screen?: boolean; delimit?: boolean }
    ) => string
  }
  wrapToolResults?: boolean
}): StreamingToolExecutionResult {
  const {
    toolName,
    toolCallId,
    transformedResult,
    validatedArgs,
    stuckDetector,
    budget,
    promptInjectionGuard,
    wrapToolResults,
  } = args
  // Context-bound content is wrapped; `eventResult` stays raw for parity with
  // the generate() path's observability semantics.
  const contextContent = wrapToolResultContent(
    transformedResult,
    promptInjectionGuard,
    wrapToolResults,
  )
  const stuckCheck = stuckDetector?.recordToolCall(toolName, validatedArgs)
  if (stuckCheck?.stuck) {
    const reason = stuckCheck.reason ?? 'Unknown stuck condition'
    const recovery = `Tool "${toolName}" has been blocked. Try a different approach.`
    budget?.blockTool(toolName)
    return {
      message: new ToolMessage({
        content: contextContent,
        tool_call_id: toolCallId,
        name: toolName,
      }),
      eventResult: transformedResult,
      stuckReason: reason,
      stuckRecovery: recovery,
      repeatedTool: toolName,
      stuckNudge: new ToolMessage({
        content: `[Agent appears stuck: ${reason}. ${recovery}]`,
        tool_call_id: toolCallId,
        name: toolName,
      }),
    }
  }
  return {
    message: new ToolMessage({
      content: contextContent,
      tool_call_id: toolCallId,
      name: toolName,
    }),
    eventResult: transformedResult,
  }
}

/**
 * Build the error-path {@link StreamingToolExecutionResult}. Records
 * latency, emits the `tool:error` event, and runs the stuck detector
 * over the error message before assembling the final ToolMessage that
 * is fed back to the model.
 *
 * The `__dzupValidatedKeys` marker (attached by the streaming phase
 * helper when an invocation throws) lets this helper preserve the
 * exact `inputMetadataKeys` payload of the pre-extraction path.
 */
export function handleInvocationFailure(args: {
  error: unknown
  toolName: string
  toolCallId: string
  inputMetadataKeys: string[]
  startMs: number
  statTracker: ToolStatTracker
  onToolLatency?: (name: string, durationMs: number, error?: string) => void
  stuckDetector?: StuckDetector
  policy?: StreamingToolPolicyOptions
}): StreamingToolExecutionResult {
  const {
    error,
    toolName,
    toolCallId,
    inputMetadataKeys,
    startMs,
    statTracker,
    onToolLatency,
    stuckDetector,
    policy,
  } = args
  const errorMsg = error instanceof Error ? error.message : String(error)
  const surfacedKeys =
    error !== null && typeof error === 'object' && '__dzupValidatedKeys' in error
      ? (error as { __dzupValidatedKeys?: string[] }).__dzupValidatedKeys
      : undefined
  const validatedKeys = surfacedKeys ?? inputMetadataKeys

  const durationMs = recordToolLatencyOutcome(omitUndefined({
    statTracker,
    onToolLatency,
    toolName,
    startMs,
    errorTag: errorMsg,
    recordOnTracker: true,
  }))

  const lifecycleStatus = statusFromError(error)
  emitToolError(policy, {
    toolName,
    toolCallId,
    durationMs,
    inputMetadataKeys: validatedKeys,
    errorCode: lifecycleStatus === 'timeout' ? 'TOOL_TIMEOUT' : 'TOOL_EXECUTION_FAILED',
    errorMessage: errorMsg,
    status: lifecycleStatus,
  })

  const stuckCheck = stuckDetector?.recordError(new Error(errorMsg))
  const reason = stuckCheck?.stuck
    ? (stuckCheck.reason ?? 'Unknown stuck condition')
    : undefined
  const recovery = reason ? 'Stopping due to repeated errors.' : undefined

  return omitUndefined({
    message: new ToolMessage({
      content: `Error executing tool "${toolName}": ${errorMsg}`,
      tool_call_id: toolCallId,
      name: toolName,
    }),
    eventResult: `[error: ${errorMsg}]`,
    stuckReason: reason,
    stuckRecovery: recovery,
    repeatedTool: reason ? toolName : undefined,
    shouldStop: reason !== undefined,
  }) as StreamingToolExecutionResult
}
