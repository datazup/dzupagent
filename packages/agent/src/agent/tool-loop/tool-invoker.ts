import type { StructuredToolInterface } from '@langchain/core/tools'
import { ForgeError } from '@dzupagent/core/events'
import { isTransientError } from '@dzupagent/core/llm'
import { calculateBackoff } from '@dzupagent/core/utils'
import {
  emitToolCancellationRequested,
  invokeWithOptionalTimeout,
} from '../tool-lifecycle-policy.js'
import {
  isToolCancellationError,
  isToolTimeoutError,
} from '../tool-timeout-error.js'
import type { ToolLoopConfig, ToolRetryConfig } from './types.js'
import { omitUndefined } from '../../utils/exact-optional.js'
import {
  emitPermissionDeniedSafetyViolation,
  evaluateToolPermission,
} from './policy-checks.js'

/**
 * Resolve a {@link ToolRetryConfig} into the concrete shape expected by the
 * retry loop. Returns `null` when retry is disabled (no entry, or maxAttempts
 * <= 1). Defaults match the values documented on `ToolLoopConfig.toolRetry`.
 */
export function resolveRetryConfig(
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

export interface InvokeWithRetryParams {
  tool: StructuredToolInterface
  toolName: string
  toolCallId: string
  validatedArgs: Record<string, unknown>
  validatedKeys: string[]
  config: ToolLoopConfig
}

/**
 * Invoke the tool — optionally guarded by per-tool timeout and per-tool
 * retry policy. Encapsulates:
 *   - REC-M-06 issuance-time permission re-check (TOCTOU close)
 *   - per-call cancellation/abort plumbing
 *   - exponential-backoff retry with caller-cancellation honored between
 *     attempts
 *
 * Throws on terminal failure; returns the raw tool result on success.
 */
export async function invokeToolWithRetry(
  params: InvokeWithRetryParams,
): Promise<unknown> {
  const { tool, toolName, toolCallId, validatedArgs, validatedKeys, config } = params

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

  if (!retryCfg) {
    return invokeOnce()
  }

  let attempt = 0
  // Loop is bounded by retryCfg.maxAttempts; the body either returns,
  // breaks (non-retryable), or sleeps then re-iterates.
  while (true) {
    try {
      return await invokeOnce()
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
      // If the parent signal aborts during backoff, wake up early so
      // we can surface the cancellation on the next iteration.
      // The listener is always removed after the promise settles to
      // prevent accumulation across retries (DZUPAGENT-AGENT-L-05).
      let onAbort: (() => void) | undefined
      try {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, delayMs)
          if (config.signal) {
            onAbort = (): void => {
              clearTimeout(t)
              resolve()
            }
            config.signal.addEventListener('abort', onAbort, { once: true })
          }
        })
      } finally {
        if (onAbort && config.signal) {
          config.signal.removeEventListener('abort', onAbort)
        }
      }
      attempt++
    }
  }
}
