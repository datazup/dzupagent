/**
 * Shared outcome metadata for best-effort memory operations.
 *
 * Memory APIs often keep the primary agent run alive when a backing service
 * fails. These fields preserve that non-fatal policy without making
 * unavailable input or partial writes look like successful empty work.
 */

export type MemoryOperationStatus = 'completed' | 'degraded'

export type MemoryOperation =
  | 'search'
  | 'get'
  | 'put'
  | 'delete'
  | 'summarize'

export type MemoryDegradationImpact =
  | 'source-unavailable'
  | 'partial-result'
  | 'fallback-used'

export interface MemoryOperationDegradation {
  /** Operation that could not provide its normal guarantee. */
  operation: MemoryOperation
  /** Caller-visible consequence of the failure. */
  impact: MemoryDegradationImpact
  /** Sanitized failure reason suitable for diagnostics and telemetry. */
  reason: string
  /** Optional record, cluster, namespace, or network identifier. */
  target?: string
}

export interface MemoryOperationOutcome {
  status?: MemoryOperationStatus
  degradations?: MemoryOperationDegradation[]
}

/**
 * Guaranteed outcome returned by the updated best-effort operation methods.
 *
 * Existing public result interfaces extend the optional shape above so old
 * structural mocks remain source-compatible. Method return types intersect
 * with this interface, giving new callers required fields.
 */
export interface MemoryOperationResult extends MemoryOperationOutcome {
  status: MemoryOperationStatus
  degradations: MemoryOperationDegradation[]
}

export function degradation(
  operation: MemoryOperation,
  impact: MemoryDegradationImpact,
  error: unknown,
  target?: string,
): MemoryOperationDegradation {
  return {
    operation,
    impact,
    reason: error instanceof Error ? error.message : String(error),
    ...(target !== undefined ? { target } : {}),
  }
}

export function statusFor(
  degradations: readonly MemoryOperationDegradation[],
): MemoryOperationStatus {
  return degradations.length === 0 ? 'completed' : 'degraded'
}
