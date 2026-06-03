import { ToolMessage } from '@langchain/core/messages'
import { emitToolError, statusFromError } from '../tool-lifecycle-policy.js'
import type { ToolLoopConfig } from './types.js'
import type { StuckStatus } from '../../guardrails/stuck-detector.js'

export type ToolSpan = {
  setAttribute(key: string, value: string | number | boolean): unknown
  end(): void
}

/**
 * Apply caller-supplied attributes to an OTel span and end it. No-op when
 * the span is undefined or any tracer call throws.
 */
export function endSpan(
  span: ToolSpan | undefined,
  attributes: Record<string, string | number | boolean>,
): void {
  if (!span) return
  try {
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value)
    }
    span.end()
  } catch {
    // Tracer failures must not abort the tool loop.
  }
}

/**
 * Coerce an arbitrary tool result into a flat record when possible. Used to
 * detect well-known checkpoint markers without forcing tools to subclass a
 * shared base type.
 */
function coerceResultToRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.startsWith('{')) return null
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Non-JSON tool result.
    }
  }
  return null
}

/**
 * Inspect the raw tool result for `{ checkpointed: true, label }` /
 * `{ restored: boolean, label }` markers and emit the corresponding
 * `checkpoint:created` / `checkpoint:restored` event. Telemetry-only;
 * never throws.
 */
export function maybeEmitCheckpointEvent(
  config: ToolLoopConfig,
  toolName: string,
  rawResult: unknown,
): void {
  if (!config.eventBus || !config.runId) return
  const record = coerceResultToRecord(rawResult)
  if (!record) return

  try {
    if (record['checkpointed'] === true && typeof record['label'] === 'string') {
      const nodeIdValue = record['nodeId']
      const checkpointAtValue = record['checkpointAt']
      const nodeId = typeof nodeIdValue === 'string' ? nodeIdValue : toolName
      const checkpointAt =
        typeof checkpointAtValue === 'string' ? checkpointAtValue : new Date().toISOString()
      config.eventBus.emit({
        type: 'checkpoint:created',
        runId: config.runId,
        nodeId,
        label: record['label'] as string,
        checkpointAt,
      })
      return
    }

    if (
      typeof record['restored'] === 'boolean'
      && typeof record['label'] === 'string'
    ) {
      const reasonValue = record['reason']
      config.eventBus.emit({
        type: 'checkpoint:restored',
        runId: config.runId,
        checkpointLabel: record['label'] as string,
        restored: record['restored'] as boolean,
        ...(typeof reasonValue === 'string' ? { reason: reasonValue } : {}),
      })
    }
  } catch {
    // Telemetry must never abort the tool loop.
  }
}

export interface SafetyScanContext {
  toolName: string
  toolCallId: string
  validatedKeys: string[]
  startMs: number
  span: ToolSpan | undefined
  config: ToolLoopConfig
  stat: { calls: number; errors: number; totalMs: number }
}

export interface SafetyScanOutcome {
  /** When set, the caller should return this short-circuit result. */
  shortCircuit?: { message: ToolMessage }
  /** When `shortCircuit` is unset, the (possibly transformed) result string. */
  resultStr: string
}

/**
 * Run the safety monitor (if configured) over a tool result string. Hard
 * blocks return a `shortCircuit` outcome; scanner failures honor
 * `scanFailureMode`. On pass, returns the original (or replaced) result
 * string.
 */
export function applySafetyScan(
  resultStr: string,
  ctx: SafetyScanContext,
): SafetyScanOutcome {
  const { config, toolName, toolCallId, validatedKeys, startMs, span, stat } = ctx
  if (!config.safetyMonitor || config.scanToolResults === false) {
    return { resultStr }
  }
  try {
    const violations = config.safetyMonitor.scanContent(resultStr, {
      source: 'tool:result',
      toolName,
    })
    const hardBlock = violations.find(
      v => v.action === 'block' || v.action === 'kill' || v.severity === 'critical',
    )
    if (hardBlock) {
      const blockedStr = `[blocked] Tool result contained potentially unsafe content (${hardBlock.category}): ${hardBlock.message}`
      config.onToolResult?.(toolName, '[blocked: unsafe tool output]')
      const message = new ToolMessage({
        content: blockedStr,
        tool_call_id: toolCallId,
        name: toolName,
      })
      const durationMs = Date.now() - startMs
      stat.calls++
      stat.totalMs += durationMs
      config.onToolLatency?.(toolName, durationMs, 'unsafe-result')
      emitToolError(config, {
        toolName,
        toolCallId,
        durationMs,
        inputMetadataKeys: validatedKeys,
        errorCode: 'TOOL_EXECUTION_FAILED',
        errorMessage: `Tool result blocked: ${hardBlock.category} — ${hardBlock.message}`,
        status: 'denied',
      })
      endSpan(span, {
        durationMs,
        outputSize: blockedStr.length,
        blocked: true,
      })
      return { shortCircuit: { message }, resultStr: blockedStr }
    }
    return { resultStr }
  } catch {
    // RF-11 / DZUPAGENT-AGENT-M-01 — resolve the effective failure mode once.
    // A bare DzupAgent (no explicit `scanFailureMode`) is fail-closed: a
    // crashing scanner must NOT silently leak tool output. `fail-open` remains
    // available only as an explicit, opt-in legacy override.
    const effectiveMode = config.scanFailureMode ?? 'fail-closed'
    config.eventBus?.emit({
      type: 'safety:violation',
      category: 'tool_result_scanner_failure',
      severity: effectiveMode === 'fail-closed' ? 'critical' : 'warning',
      ...(config.agentId !== undefined ? { agentId: config.agentId } : {}),
      message: 'Tool result safety scanner failed',
    })

    if (effectiveMode === 'fail-closed') {
      const blockedStr = '[blocked: tool result safety scanner failed]'
      config.onToolResult?.(toolName, blockedStr)
      const message = new ToolMessage({
        content: blockedStr,
        tool_call_id: toolCallId,
        name: toolName,
      })
      const durationMs = Date.now() - startMs
      stat.calls++
      stat.totalMs += durationMs
      config.onToolLatency?.(toolName, durationMs, 'scanner-failure')
      emitToolError(config, {
        toolName,
        toolCallId,
        durationMs,
        inputMetadataKeys: validatedKeys,
        errorCode: 'TOOL_EXECUTION_FAILED',
        errorMessage: 'Tool result safety scanner failed; output withheld',
        status: 'error',
      })
      endSpan(span, { durationMs, scannerFailure: true })
      return { shortCircuit: { message }, resultStr: blockedStr }
    }
    return { resultStr }
  }
}

export interface ToolErrorContext {
  toolName: string
  toolCallId: string
  validatedKeys: string[]
  startMs: number
  span: ToolSpan | undefined
  config: ToolLoopConfig
  stat: { calls: number; errors: number; totalMs: number }
}

/**
 * Common path for non-permission tool errors raised from the invocation
 * stage. Builds the error `ToolMessage`, increments the error stat,
 * emits the canonical `tool:error` event, and ends the span via the
 * tracer's error path. Returns the ToolMessage and the stringified
 * error message so the outer loop can keep its existing flow.
 */
export function handleToolError(
  err: unknown,
  ctx: ToolErrorContext,
): { message: ToolMessage; errorMsg: string } {
  const { toolName, toolCallId, validatedKeys, startMs, span, config, stat } = ctx
  const errorMsg = err instanceof Error ? err.message : String(err)
  const message = new ToolMessage({
    content: `Error executing tool "${toolName}": ${errorMsg}`,
    tool_call_id: toolCallId,
    name: toolName,
  })
  config.onToolResult?.(toolName, `[error: ${errorMsg}]`)
  stat.errors++
  const lifecycleStatus = statusFromError(err)
  emitToolError(config, {
    toolName,
    toolCallId,
    durationMs: Date.now() - startMs,
    inputMetadataKeys: validatedKeys,
    errorCode: lifecycleStatus === 'timeout'
      ? 'TOOL_TIMEOUT'
      : 'TOOL_EXECUTION_FAILED',
    errorMessage: errorMsg,
    status: lifecycleStatus,
  })
  if (span) {
    try {
      span.setAttribute('durationMs', Date.now() - startMs)
      config.tracer?.endSpanWithError(span, err)
    } catch {
      // Tracer failures must not abort the tool loop.
    }
  }
  return { message, errorMsg }
}

export interface StuckEvaluation {
  stuckBreak: boolean
  stuckNudge: ToolMessage | undefined
  stuckToolName: string | undefined
  stuckReason: string | undefined
}

/**
 * Run the optional stuck detector and translate its decision into the
 * tail-of-result fields the executor returns. When the detector signals
 * stuck-by-error, set `stuckBreak`. When stuck-by-repetition, block the
 * tool via the budget guardrail and produce a nudge ToolMessage.
 */
export function evaluateStuck(
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string,
  errorMsg: string | undefined,
  config: ToolLoopConfig,
): StuckEvaluation {
  let stuckBreak = false
  let stuckNudge: ToolMessage | undefined
  let stuckToolName: string | undefined
  let stuckReason: string | undefined
  if (config.stuckDetector) {
    const stuckCheck: StuckStatus = errorMsg
      ? config.stuckDetector.recordError(new Error(errorMsg))
      : config.stuckDetector.recordToolCall(toolName, args)

    if (stuckCheck.stuck) {
      const reason = stuckCheck.reason ?? 'Unknown stuck condition'
      stuckToolName = toolName
      stuckReason = reason
      if (errorMsg) {
        const recovery = 'Stopping due to repeated errors.'
        config.onStuckDetected?.(reason, recovery)
        stuckBreak = true
      } else {
        const recovery = `Tool "${toolName}" has been blocked. Try a different approach.`
        config.budget?.blockTool(toolName)
        config.onStuckDetected?.(reason, recovery)
        stuckNudge = new ToolMessage({
          content: `[Agent appears stuck: ${reason}. ${recovery}]`,
          tool_call_id: toolCallId,
          name: toolName,
        })
      }
    }
  }
  return { stuckBreak, stuckNudge, stuckToolName, stuckReason }
}

/**
 * RF-08 — Optional output schema validation. SOFT failure: emit a
 * warning event and invoke the optional callback, but never replace
 * the tool result or abort execution.
 */
export function applyOutputValidation(
  resultStr: string,
  toolName: string,
  toolCallId: string,
  config: ToolLoopConfig,
): void {
  if (!config.toolOutputValidator?.has(toolName)) return
  try {
    const outcome = config.toolOutputValidator.validate(toolName, resultStr)
    if (!outcome.valid) {
      const errorText = outcome.error ?? 'Tool output failed schema validation'
      try {
        config.eventBus?.emit({
          type: 'tool:output:invalid',
          toolName,
          toolCallId,
          ...(config.agentId !== undefined ? { agentId: config.agentId } : {}),
          ...(config.runId !== undefined ? { runId: config.runId } : {}),
          error: errorText,
        })
      } catch {
        // Telemetry must never abort the tool loop.
      }
      try {
        config.onToolOutputInvalid?.({ toolName, toolCallId, error: errorText })
      } catch {
        // Listener errors must never abort the tool loop.
      }
    }
  } catch {
    // Validator implementation errors must never abort the tool loop.
  }
}
