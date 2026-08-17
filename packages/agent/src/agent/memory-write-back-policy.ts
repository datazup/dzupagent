/**
 * Canonical memory write-back policy for every agent run path.
 *
 * Keep this map total over {@link StopReason}: adding a stop reason must fail
 * compilation until its persistence behavior is classified explicitly.
 */
import type { StopReason } from './tool-loop.js'

/**
 * The operator-ratified "keep partial work" policy.
 *
 * Ceiling-limited runs retain trustworthy work already produced. Runs stopped
 * by cancellation, failure, stuck detection, compression failure, or a pending
 * approval do not write back.
 */
export const MEMORY_WRITE_BACK_BY_STOP_REASON: Record<StopReason, boolean> = {
  complete: true,
  iteration_limit: true,
  budget_exceeded: true,
  aborted: false,
  error: false,
  stuck: false,
  token_exhausted: true,
  compression_failed: false,
  approval_pending: false,
}

export function shouldWriteBackMemory(stopReason: StopReason): boolean {
  return MEMORY_WRITE_BACK_BY_STOP_REASON[stopReason]
}
