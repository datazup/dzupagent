/**
 * Run a single pipeline node with the retry/backoff policy applied.
 *
 * The total elapsed wall-clock time across attempts is accumulated
 * into the returned `durationMs`. The number of retries (not counting
 * the initial attempt) is exposed via `retryCount` for trajectory
 * calibration.
 *
 * @module pipeline/pipeline-runtime/node-retry
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

export async function runNodeWithRetry(
  config: PipelineRuntimeConfig,
  emit: (event: PipelineRuntimeEvent) => void,
  node: PipelineNode,
  context: NodeExecutionContext,
): Promise<NodeResult & { retryCount?: number }> {
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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result = await config.nodeExecutor(node.id, node, context)

    if (!result.error) break // success

    // Last attempt — don't retry
    if (attempt === maxAttempts) break

    // Check if error is retryable
    if (!isRetryableError(result.error, effectivePolicy)) break

    // Calculate backoff (with optional jitter)
    const backoffMs = calculateBackoff(attempt, effectivePolicy)

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
