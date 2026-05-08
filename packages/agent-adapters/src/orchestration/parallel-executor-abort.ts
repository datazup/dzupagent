/**
 * Abort/cancellation helpers for ParallelExecutor.
 *
 * The executor uses a single internal AbortController whose `reason` may be
 * one of three sentinels: `external` (caller-provided signal aborted),
 * `timeout` (deadline exceeded), or `first-wins` (a sibling provider already
 * succeeded under the first-wins strategy). User-driven cancellations are
 * `external` and `timeout`; `first-wins` is internal scheduling.
 */

export type ParallelAbortReason = 'external' | 'timeout' | 'first-wins'

/**
 * Read the abort reason off a signal, normalising unknown reasons to
 * `external` (caller-driven). Returns `undefined` if the signal is not aborted.
 */
export function getAbortReason(signal: AbortSignal): ParallelAbortReason | undefined {
  if (!signal.aborted) return undefined
  return (
    signal.reason === 'external' ||
    signal.reason === 'timeout' ||
    signal.reason === 'first-wins'
  )
    ? signal.reason
    : 'external'
}

/**
 * True if the abort reason represents a user-visible cancellation (external
 * cancel, deadline timeout). `first-wins` is treated as a normal completion
 * path, not a cancellation.
 */
export function isUserCancellationReason(reason: ParallelAbortReason | undefined): boolean {
  return reason === 'external' || reason === 'timeout'
}

/**
 * Render a human-readable cancellation message based on the abort reason.
 * Falls back to a caller-supplied message (e.g. an error string captured
 * mid-stream) and finally to a generic phrase.
 */
export function getCancellationMessage(signal: AbortSignal, fallback?: string): string {
  const reason = getAbortReason(signal)
  if (reason === 'timeout') return 'Parallel execution timed out'
  if (reason === 'first-wins') return 'Parallel execution cancelled after first successful provider'
  return fallback ?? 'Parallel execution was cancelled'
}
