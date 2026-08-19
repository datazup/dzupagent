import type { CodexAppServerClientLimits } from './codex-app-server-client-contracts.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000
const DEFAULT_MAX_LINE_BYTES = 512_000
const DEFAULT_MAX_AGGREGATE_OUTPUT_BYTES = 8_000_000
const DEFAULT_MAX_FRAMES = 10_000
const DEFAULT_MAX_PENDING_REQUESTS = 32
const DEFAULT_MAX_QUEUED_EVENTS = 256

/**
 * Each default doubles as the ceiling: a caller may only tighten a limit, never
 * raise one, so a compromised or misconfigured caller cannot widen the
 * containment boundaries the transport relies on.
 */
export function normalizeLimits(
  limits: CodexAppServerClientLimits | undefined,
): Required<CodexAppServerClientLimits> {
  return {
    requestTimeoutMs: finiteLimit(
      limits?.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    cleanupTimeoutMs: finiteLimit(
      limits?.cleanupTimeoutMs,
      DEFAULT_CLEANUP_TIMEOUT_MS,
      DEFAULT_CLEANUP_TIMEOUT_MS,
    ),
    maxLineBytes: finiteLimit(limits?.maxLineBytes, DEFAULT_MAX_LINE_BYTES, DEFAULT_MAX_LINE_BYTES),
    maxAggregateOutputBytes: finiteLimit(
      limits?.maxAggregateOutputBytes,
      DEFAULT_MAX_AGGREGATE_OUTPUT_BYTES,
      DEFAULT_MAX_AGGREGATE_OUTPUT_BYTES,
    ),
    maxFrames: finiteLimit(limits?.maxFrames, DEFAULT_MAX_FRAMES, DEFAULT_MAX_FRAMES),
    maxPendingRequests: finiteLimit(
      limits?.maxPendingRequests,
      DEFAULT_MAX_PENDING_REQUESTS,
      DEFAULT_MAX_PENDING_REQUESTS,
    ),
    maxQueuedEvents: finiteLimit(
      limits?.maxQueuedEvents,
      DEFAULT_MAX_QUEUED_EVENTS,
      DEFAULT_MAX_QUEUED_EVENTS,
    ),
  }
}

function finiteLimit(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new Error(`Codex app-server limit must be an integer between 1 and ${ceiling}`)
  }
  return value
}
