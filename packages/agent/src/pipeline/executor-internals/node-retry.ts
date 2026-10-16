/**
 * Run a single pipeline node with the retry/backoff policy applied.
 *
 * The total elapsed wall-clock time across attempts is accumulated
 * into the returned `durationMs`. The number of retries (not counting
 * the initial attempt) is exposed via `retryCount` for trajectory
 * calibration.
 *
 * @module pipeline/executor-internals/node-retry
 */

import type { PipelineNode } from '@dzupagent/core/pipeline'
import type {
  NodeResult,
  NodeExecutionContext,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
  RetryPolicy,
} from '../pipeline-runtime-types.js'
import {
  calculateBackoff,
  isRetryable as isRetryableError,
  resolveRetryPolicy,
} from '../retry-policy.js'
import { nodeRetryEvent } from './runtime-events.js'
import {
  createNodeBudget,
  createNodeClock,
  nodeBudgetCents,
  nodeTimeoutMs,
  TIMEOUT_EXCEEDED_CODE,
} from './execution-policy.js'

/**
 * `policyFailure` marks a node stopped by its execution policy (time limit
 * or budget). The
 * caller fails the run without consulting catch, error edges or recovery.
 */
export async function runNodeWithRetry(
  config: PipelineRuntimeConfig,
  emit: (event: PipelineRuntimeEvent) => void,
  node: PipelineNode,
  context: NodeExecutionContext,
): Promise<NodeResult & { retryCount?: number; policyFailure?: true }> {
  const maxAttempts = (node.retries ?? 0) + 1 // retries=0 means 1 attempt (no retry)
  const effectivePolicy = resolveRetryPolicy(
    node.retryPolicy as RetryPolicy | undefined,
    config.retryPolicy,
  )
  const nodeStartTime = Date.now()
  let result: NodeResult = {
    nodeId: node.id,
    output: undefined,
    durationMs: 0,
    error: 'Pipeline node did not execute',
  }
  let nodeRetryCount = 0
  const budgetCents = nodeBudgetCents(node)
  const budget =
    budgetCents === undefined || config.nodeAttemptCostCents === undefined
      ? undefined
      : createNodeBudget(node.id, budgetCents, config.nodeAttemptCostCents)

  const timeoutMs = nodeTimeoutMs(node)
  const clock = timeoutMs === undefined ? undefined : createNodeClock(node.id, timeoutMs)
  const stopByPolicy = (failure: NodeResult) => ({
    ...failure,
    durationMs: Date.now() - nodeStartTime,
    retryCount: nodeRetryCount,
    policyFailure: true as const,
  })

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (clock === undefined) {
      result = await config.nodeExecutor(node.id, node, context)
    } else {
      // The time limit is a deadline, not only post-hoc accounting: the
      // attempt runs under a signal that aborts once the remaining time is
      // spent, and a hung attempt is abandoned at the deadline. The attempt is
      // charged the larger of its reported and its locally measured duration,
      // so an under-reporting executor cannot outrun the limit.
      const attemptStart = Date.now()
      const remainingMs = clock.remainingMs()
      const outcome = await runAttemptWithDeadline(
        (signal) => config.nodeExecutor(node.id, node, { ...context, signal }),
        remainingMs,
        context.signal,
      )
      const elapsedMs = Date.now() - attemptStart
      if (outcome === DEADLINE) {
        // The deadline passed, so the attempt used more than what was left.
        const overTime = clock.charge({
          nodeId: node.id,
          output: undefined,
          durationMs: Math.max(elapsedMs, remainingMs + 1),
        })
        return stopByPolicy(overTime ?? timeoutFallback(node.id))
      }
      result = outcome
      const reported = result.durationMs
      const overTime = clock.charge(
        typeof reported === 'number' && Number.isFinite(reported) && reported >= 0
          ? { ...result, durationMs: Math.max(reported, elapsedMs) }
          : result,
      )
      if (overTime !== undefined) return stopByPolicy(overTime)
    }

    // Every attempt is charged, time before cost (as the local host oracle);
    // an attempt over either limit has its output discarded.
    const overLimit = budget?.charge(result)
    if (overLimit !== undefined) return stopByPolicy(overLimit)

    if (!result.error) break // success

    // Last attempt — don't retry
    if (attempt === maxAttempts) break

    // Explicit terminal outcomes take precedence over code/message retry policies.
    // Keep this attempt's original output and session evidence instead of retrying.
    if (result.errorMetadata?.['retryable'] === false) break

    // Check if error is retryable
    const errorCode = result.errorMetadata?.['code']
    if (
      !isRetryableError(
        result.error,
        effectivePolicy,
        typeof errorCode === 'string' ? errorCode : undefined,
      )
    ) break

    // Calculate backoff (with optional jitter)
    const backoffMs = calculateBackoff(attempt, effectivePolicy)

    // A backoff that would exceed the time limit fails now, without waiting.
    const overTime = clock?.chargeBackoff(backoffMs)
    if (overTime !== undefined) return stopByPolicy(overTime)

    // Track retry count for trajectory calibration
    nodeRetryCount++

    // Emit retry event
    emit(nodeRetryEvent(node.id, attempt, maxAttempts, result.error, backoffMs))

    // Wait with abort support
    await delayWithAbort(backoffMs, config.signal)

    // Check abort after delay
    if (config.signal?.aborted) {
      result = {
        nodeId: node.id,
        output: undefined,
        durationMs: Date.now() - nodeStartTime,
        error: 'Pipeline cancelled during retry backoff',
      }
      break
    }
  }

  return { ...result, durationMs: Date.now() - nodeStartTime, retryCount: nodeRetryCount }
}

const DEADLINE = Symbol('node-deadline')

function timeoutFallback(nodeId: string): NodeResult {
  return { nodeId, output: undefined, durationMs: 0, error: `${TIMEOUT_EXCEEDED_CODE}: node "${nodeId}" deadline elapsed`, errorMetadata: { code: TIMEOUT_EXCEEDED_CODE } }
}

/**
 * Run one attempt under a deadline of `remainingMs`. The attempt receives a
 * signal that aborts when the deadline passes or when `parent` aborts. When
 * the deadline wins, the attempt's eventual settlement is ignored.
 */
async function runAttemptWithDeadline(
  attempt: (signal: AbortSignal) => Promise<NodeResult>,
  remainingMs: number,
  parent: NodeExecutionContext['signal'],
): Promise<NodeResult | typeof DEADLINE> {
  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  if (parent?.aborted === true) controller.abort()
  else parent?.addEventListener?.('abort', onParentAbort)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(DEADLINE)
    }, remainingMs)
  })
  const run = attempt(controller.signal)
  // An abandoned attempt that later rejects must not surface as unhandled.
  run.catch(() => undefined)
  try {
    return await Promise.race([run, deadline])
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener?.('abort', onParentAbort)
  }
}

/**
 * Sleep for `ms` milliseconds, resolving early (rather than rejecting)
 * if the signal aborts. Callers re-check `signal.aborted` after the
 * delay to react to cancellation.
 */
function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer)
        resolve() // resolve, don't reject — let the loop check signal
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
