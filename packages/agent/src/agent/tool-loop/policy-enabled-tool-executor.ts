import { ToolMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { ForgeError, calculateBackoff, isTransientError } from '@dzupagent/core'
import type { StuckStatus } from '../../guardrails/stuck-detector.js'
import {
  emitToolCalled,
  emitToolCancellationRequested,
  emitToolError,
  emitToolResult,
  extractInputMetadataKeys,
  invokeWithOptionalTimeout,
  maybeValidateArgs,
  resolveValidatorConfig,
  statusFromError,
} from '../tool-lifecycle-policy.js'
import {
  isToolCancellationError,
  isToolTimeoutError,
} from '../tool-timeout-error.js'
import type { ToolLoopConfig, ToolRetryConfig } from '../tool-loop.js'
import type {
  StatGetter,
  ToolCall,
  ToolCallResult,
} from './contracts.js'
import { omitUndefined } from '../../utils/exact-optional.js'

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
function evaluateToolPermission(
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
function emitPermissionDeniedSafetyViolation(
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
 * Resolve a {@link ToolRetryConfig} into the concrete shape expected by the
 * retry loop. Returns `null` when retry is disabled (no entry, or maxAttempts
 * <= 1). Defaults match the values documented on `ToolLoopConfig.toolRetry`.
 */
function resolveRetryConfig(
  raw: ToolRetryConfig | undefined,
): {
  maxAttempts: number
  initialBackoffMs: number
  maxBackoffMs: number
  multiplier: number
  jitter: boolean
  retryOn: (err: Error) => boolean
} | null {
  if (!raw) return null
  const maxAttempts = raw.maxAttempts ?? 3
  if (maxAttempts <= 1) return null
  return {
    maxAttempts,
    initialBackoffMs: raw.initialBackoffMs ?? 200,
    maxBackoffMs: raw.maxBackoffMs ?? 4000,
    multiplier: raw.multiplier ?? 2,
    jitter: raw.jitter ?? true,
    retryOn: raw.retryOn ?? isTransientError,
  }
}

export interface PolicyEnabledToolExecutorParams {
  toolMap: Map<string, StructuredToolInterface>
  config: ToolLoopConfig
  getOrCreateStat: StatGetter
}

/**
 * Policy-enabled single-tool execution stage.
 *
 * The scheduler kernel calls this stage for each chosen tool call. This stage
 * owns governance, permissions, budget blocks, argument validation, timeout,
 * safety scanning, token-result callbacks, stuck detection, telemetry, and
 * tracing so sequential, parallel, and future streaming schedulers can reuse
 * the same execution contract.
 */
export async function executePolicyEnabledToolCall(
  tc: ToolCall,
  params: PolicyEnabledToolExecutorParams,
): Promise<ToolCallResult> {
  const { toolMap, config, getOrCreateStat } = params
  const toolName = tc.name
  const toolCallId = tc.id ?? `call_${Date.now()}`
  const inputMetadataKeys = extractInputMetadataKeys(tc.args)

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
    throw new ForgeError({
      code: 'TOOL_PERMISSION_DENIED',
      message: `Tool "${toolName}" is not accessible to agent "${config.agentId}"`,
      context: { agentId: config.agentId, toolName },
    })
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
      message: new ToolMessage({
        content: `[Tool "${toolName}" is blocked by guardrails]`,
        tool_call_id: toolCallId,
        name: toolName,
      }),
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
        message: new ToolMessage({
          content: `[blocked] ${reason}`,
          tool_call_id: toolCallId,
          name: toolName,
        }),
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
        message: new ToolMessage({
          content: `[approval_pending] Tool "${toolName}" requires human approval before execution. ${reason}`,
          tool_call_id: toolCallId,
          name: toolName,
        }),
        approvalPending: true,
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
      message: new ToolMessage({
        content: `Error: Tool "${toolName}" not found. Available tools: ${[...toolMap.keys()].join(', ')}`,
        tool_call_id: toolCallId,
        name: toolName,
      }),
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
      message: new ToolMessage({
        content: validationError,
        tool_call_id: toolCallId,
        name: toolName,
      }),
    }
  }

  const validatedKeys = extractInputMetadataKeys(validatedArgs)
  emitToolCalled(config, {
    toolName,
    toolCallId,
    input: validatedArgs,
    inputMetadataKeys: validatedKeys,
  })

  config.onToolCall?.(toolName, validatedArgs)

  const stat = getOrCreateStat(toolName)
  const startMs = Date.now()
  let errorMsg: string | undefined
  let message: ToolMessage
  const inputSize = JSON.stringify(validatedArgs).length
  const span = config.tracer?.startToolSpan(toolName, { inputSize })

  try {
    const retryCfg = resolveRetryConfig(config.toolRetry?.[toolName])
    const invokeOnce = (): Promise<unknown> =>
      invokeWithOptionalTimeout(
        toolName,
        config.toolTimeouts?.[toolName],
        async ({ signal }) => {
          // REC-M-06 — Second permission-tier check at tool issuance.
          // This fires immediately before the underlying tool runs,
          // closing the time-of-check / time-of-use window between the
          // executor's pre-flight check and the actual side-effecting
          // call. If the policy was mutated (e.g. tier downgraded mid-run,
          // re-entrant loop with a tighter policy in scope), the call is
          // blocked here even though pre-flight signed off. Failure path:
          //   1. Emit `safety:violation` (category=tool_permission_denied,
          //      severity=high) so audit pipelines flag the TOCTOU event.
          //   2. Throw a ForgeError matching the pre-flight shape so the
          //      retry loop's `instanceof ForgeError` filter prevents
          //      retry, and the outer error handler emits `tool:error`
          //      with status=denied.
          // The callback is `async` so a synchronous throw is captured
          // as a rejected promise; this matters because
          // `invokeWithOptionalTimeout` chains `.catch()` on the returned
          // promise to remap aborts.
          if (!evaluateToolPermission(config, toolName)) {
            emitPermissionDeniedSafetyViolation(config, toolName)
            throw new ForgeError({
              code: 'TOOL_PERMISSION_DENIED',
              message: `Tool "${toolName}" is not accessible to agent "${config.agentId}"`,
              context: { agentId: config.agentId, toolName, phase: 'issuance' },
            })
          }
          return tool.invoke(validatedArgs, { signal })
        },
        omitUndefined({
          signal: config.signal,
          onCancelRequested: (reason: 'timeout' | 'run_cancelled') => emitToolCancellationRequested(config, {
            toolName,
            toolCallId,
            inputMetadataKeys: validatedKeys,
            reason,
            ...(reason === 'timeout' && config.toolTimeouts?.[toolName] !== undefined
              ? { timeoutMs: config.toolTimeouts[toolName] }
              : {}),
          }),
        }),
      )

    let result: unknown
    if (!retryCfg) {
      result = await invokeOnce()
    } else {
      let attempt = 0
      // Loop is bounded by retryCfg.maxAttempts; the body either returns,
      // breaks (non-retryable), or sleeps then re-iterates.
      while (true) {
        try {
          result = await invokeOnce()
          break
        } catch (err: unknown) {
          // Cancellation is upstream-driven and must never be retried —
          // the caller asked us to stop. Same for already-fired timeouts:
          // retrying would just hit the per-call deadline again.
          if (isToolCancellationError(err) || isToolTimeoutError(err)) throw err
          // ForgeError surfaces structured permission/governance/approval
          // denials (raised before tool.invoke runs) — never retry.
          if (err instanceof ForgeError) throw err
          const errAsError = err instanceof Error ? err : new Error(String(err))
          const remaining = retryCfg.maxAttempts - attempt - 1
          if (remaining <= 0) throw err
          if (!retryCfg.retryOn(errAsError)) throw err
          // Honor caller cancellation between attempts.
          if (config.signal?.aborted) throw err
          const delayMs = calculateBackoff(attempt, {
            initialBackoffMs: retryCfg.initialBackoffMs,
            maxBackoffMs: retryCfg.maxBackoffMs,
            multiplier: retryCfg.multiplier,
            jitter: retryCfg.jitter,
          })
          // No dedicated `tool:retry` event exists in the DzupEvent union
          // (audit constraint: do not extend the union without owner sign-off).
          // Surface the retry decision via the optional onToolLatency hook so
          // operators can trace partial failures, and log to stderr at debug
          // level so it shows up in CI captures.
          config.onToolLatency?.(
            toolName,
            0,
            `retry ${attempt + 1}/${retryCfg.maxAttempts - 1} after ${delayMs}ms: ${errAsError.message}`,
          )
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, delayMs)
            // If the parent signal aborts during backoff, wake up early so
            // we can surface the cancellation on the next iteration.
            if (config.signal) {
              const onAbort = (): void => {
                clearTimeout(t)
                resolve()
              }
              config.signal.addEventListener('abort', onAbort, { once: true })
            }
          })
          attempt++
        }
      }
    }
    const rawResultStr = typeof result === 'string' ? result : JSON.stringify(result)
    let resultStr = config.transformToolResult
      ? await config.transformToolResult(toolName, validatedArgs, rawResultStr)
      : rawResultStr

    if (config.safetyMonitor && config.scanToolResults !== false) {
      try {
        const violations = config.safetyMonitor.scanContent(resultStr, {
          source: 'tool:result',
          toolName,
        })
        const hardBlock = violations.find(
          v => v.action === 'block' || v.action === 'kill' || v.severity === 'critical',
        )
        if (hardBlock) {
          resultStr = `[blocked] Tool result contained potentially unsafe content (${hardBlock.category}): ${hardBlock.message}`
          config.onToolResult?.(toolName, '[blocked: unsafe tool output]')
          message = new ToolMessage({
            content: resultStr,
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
            outputSize: resultStr.length,
            blocked: true,
          })
          return { message }
        }
      } catch {
        config.eventBus?.emit({
          type: 'safety:violation',
          category: 'tool_result_scanner_failure',
          severity: config.scanFailureMode === 'fail-closed' ? 'critical' : 'warning',
          ...(config.agentId !== undefined ? { agentId: config.agentId } : {}),
          message: 'Tool result safety scanner failed',
        })

        if (config.scanFailureMode === 'fail-closed') {
          resultStr = '[blocked: tool result safety scanner failed]'
          config.onToolResult?.(toolName, resultStr)
          message = new ToolMessage({
            content: resultStr,
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
          return { message }
        }
      }
    }

    // RF-08 — Optional output schema validation. SOFT failure: emit a
    // warning event and invoke the optional callback, but never replace
    // the tool result or abort execution.
    if (config.toolOutputValidator?.has(toolName)) {
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

    message = new ToolMessage({
      content: resultStr,
      tool_call_id: toolCallId,
      name: toolName,
    })
    config.onToolResult?.(toolName, resultStr)
    emitToolResult(config, {
      toolName,
      toolCallId,
      durationMs: Date.now() - startMs,
      inputMetadataKeys: validatedKeys,
      output: resultStr,
    })
    maybeEmitCheckpointEvent(config, toolName, result ?? resultStr)
    endSpan(span, {
      durationMs: Date.now() - startMs,
      outputSize: resultStr.length,
    })
  } catch (err: unknown) {
    // REC-M-06 — When the issuance-time permission check denies a tool,
    // the helper throws a ForgeError(TOOL_PERMISSION_DENIED) shaped to
    // match the pre-flight site. Surface it the same way pre-flight does:
    // emit `tool:error` (status=denied) and re-throw past the retry loop
    // and out of this function. This preserves the contract that
    // permission denials terminate the call, never produce a tool-error
    // ToolMessage, and never count as an "error" in tool stats.
    if (
      err instanceof ForgeError &&
      err.code === 'TOOL_PERMISSION_DENIED' &&
      err.context?.['phase'] === 'issuance'
    ) {
      emitToolError(config, {
        toolName,
        toolCallId,
        durationMs: Date.now() - startMs,
        inputMetadataKeys: validatedKeys,
        errorCode: 'TOOL_PERMISSION_DENIED',
        errorMessage: err.message,
        status: 'denied',
      })
      if (span) {
        try {
          span.setAttribute('durationMs', Date.now() - startMs)
          config.tracer?.endSpanWithError(span, err)
        } catch {
          // Tracer failures must not abort the tool loop.
        }
      }
      throw err
    }
    errorMsg = err instanceof Error ? err.message : String(err)
    message = new ToolMessage({
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
  }

  const durationMs = Date.now() - startMs
  stat.calls++
  stat.totalMs += durationMs
  config.onToolLatency?.(toolName, durationMs, errorMsg)

  let stuckBreak = false
  let stuckNudge: ToolMessage | undefined
  let stuckToolName: string | undefined
  let stuckReason: string | undefined
  if (config.stuckDetector) {
    const stuckCheck: StuckStatus = errorMsg
      ? config.stuckDetector.recordError(new Error(errorMsg))
      : config.stuckDetector.recordToolCall(toolName, tc.args)

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

  return omitUndefined({ message, stuckNudge, stuckBreak, stuckToolName, stuckReason })
}

function endSpan(
  span: { setAttribute(key: string, value: string | number | boolean): unknown; end(): void } | undefined,
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

function maybeEmitCheckpointEvent(
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
