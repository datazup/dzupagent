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
    result = await config.nodeExecutor(node.id, node, context)

    // Every attempt is charged, time before cost (as the local host oracle);
    // an attempt over either limit has its output discarded.
    const overLimit = clock?.charge(result) ?? budget?.charge(result)
    if (overLimit !== undefined) return stopByPolicy(overLimit)

    if (!result.error) break // success

    // Last attempt — don't retry
    if (attempt === maxAttempts) break

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
