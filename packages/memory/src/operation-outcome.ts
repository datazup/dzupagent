/**
 * Shared outcome metadata for best-effort memory operations.
 *
 * Memory APIs often keep the primary agent run alive when a backing service
 * fails. These fields preserve that non-fatal policy without making
 * unavailable input or partial writes look like successful empty work.
 */

import { logError, type FrameworkLogger } from './error-log.js'

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

/**
 * Stable, safe classification of *why* an operation degraded.
 *
 * ERR-C-30: this replaces the raw driver `.message` that used to be copied
 * onto this object. Prisma/ioredis/pg messages embed table, column, index and
 * constraint names, and `MemoryOperationDegradation` is part of the public
 * `MemoryOperationResult` — so it crosses into event buses, agent finalizer
 * messages and ultimately LLM context. Codes are derived from error *type*,
 * never from message text, so no backend detail can ride along.
 *
 * Full detail (name, message, stack) goes to the `error-log.ts` chokepoint
 * built for ERR-C-22 and is correlated by {@link MemoryOperationDegradation.errorId}.
 */
export type MemoryDegradationReason =
  /** Backend could not be reached (connection refused/reset/DNS/host down). */
  | 'backend-unavailable'
  /** Backend was reached but the call did not complete in time. */
  | 'operation-timeout'
  /** Caller or runtime aborted the call. */
  | 'operation-aborted'
  /** Backend refused the call for authn/authz reasons. */
  | 'permission-denied'
  /** The request itself was malformed or violated a backend constraint. */
  | 'invalid-request'
  /** Reached and answered, but the backend reported a failure. */
  | 'backend-error'
  /** Bounded scan/page budget ran out before the namespace was exhausted. */
  | 'scan-budget-exhausted'
  /** Required memory wiring (provider, namespace, scope) was absent. */
  | 'not-configured'
  /** A non-`Error` value was thrown; nothing further can be classified. */
  | 'unknown-error'

export interface MemoryOperationDegradation {
  /** Operation that could not provide its normal guarantee. */
  operation: MemoryOperation
  /** Caller-visible consequence of the failure. */
  impact: MemoryDegradationImpact
  /**
   * Stable machine-readable reason code. Never derived from driver text —
   * see {@link MemoryDegradationReason}.
   */
  reason: MemoryDegradationReason
  /**
   * Correlation id of the single structured log line that carries the full
   * error detail. Opaque to the caller; safe to surface anywhere.
   */
  errorId: string
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

/** Node/driver error codes that mean "we never got a usable connection". */
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EAI_AGAIN',
])

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT'])

const PERMISSION_CODES = new Set(['EACCES', 'EPERM'])

function errorCodeOf(error: Error): string {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}

/**
 * Map a thrown value onto a {@link MemoryDegradationReason}.
 *
 * Classification reads only the error's *type surface* — `name` and `code`.
 * It deliberately never inspects `message`, because message text is exactly
 * the channel ERR-C-30 is closing.
 */
export function classifyDegradationReason(
  error: unknown,
): MemoryDegradationReason {
  if (!(error instanceof Error)) return 'unknown-error'

  const name = error.name
  const code = errorCodeOf(error)

  if (name === 'AbortError' || code === 'ABORT_ERR') return 'operation-aborted'
  if (name === 'TimeoutError' || TIMEOUT_CODES.has(code)) {
    return 'operation-timeout'
  }
  if (UNAVAILABLE_CODES.has(code)) return 'backend-unavailable'
  if (name === 'PrismaClientInitializationError') return 'backend-unavailable'
  if (PERMISSION_CODES.has(code)) return 'permission-denied'
  if (
    name === 'TypeError'
    || name === 'RangeError'
    || name === 'SyntaxError'
    || name === 'ZodError'
    || name === 'PrismaClientValidationError'
  ) {
    return 'invalid-request'
  }
  return 'backend-error'
}

export interface DegradationOptions {
  /**
   * Override the classified reason code. Use only when the call site knows
   * something the error type cannot express (e.g. an internally-raised budget
   * exhaustion), never to smuggle backend text through.
   */
  reason?: MemoryDegradationReason | undefined
  /** Module emitting the log line. Defaults to `memory`. */
  component?: string | undefined
  /** Logger sink. Defaults to the `error-log.ts` default logger. */
  logger?: FrameworkLogger | undefined
}

/**
 * Build a public degradation record and emit exactly one structured log line
 * carrying the full error detail.
 *
 * The returned object is safe to place on any public result: it holds a code,
 * not prose. The raw error goes to {@link logError} — the ERR-C-22 chokepoint
 * — and the two are joined by `errorId`.
 */
export function degradation(
  operation: MemoryOperation,
  impact: MemoryDegradationImpact,
  error: unknown,
  target?: string,
  options?: DegradationOptions,
): MemoryOperationDegradation {
  const reason = options?.reason ?? classifyDegradationReason(error)
  const errorId = logError({
    component: options?.component ?? 'memory',
    operation: `degradation:${operation}:${impact}:${reason}`,
    error,
    logger: options?.logger,
  })
  return {
    operation,
    impact,
    reason,
    errorId,
    ...(target !== undefined ? { target } : {}),
  }
}

export function statusFor(
  degradations: readonly MemoryOperationDegradation[],
): MemoryOperationStatus {
  return degradations.length === 0 ? 'completed' : 'degraded'
}
