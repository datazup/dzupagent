/**
 * Centralized route error sanitization.
 *
 * Prevents internal error details (stack traces, DB messages, system info)
 * from leaking to API clients.  Known "safe" error types preserve their
 * message; everything else returns a generic string.
 */

const GENERIC = 'Internal server error'

/**
 * Error classes whose messages are safe to expose to clients.
 * Extend this set when you add new domain-specific error types that
 * carry user-facing information (e.g. validation failures).
 */
const SAFE_PREFIXES = [
  'Validation',   // "Validation failed: ..."
  'NotFound',     // "NotFound: ..."
  'Conflict',     // "Conflict: ..."
  'BadRequest',   // "BadRequest: ..."
] as const

/** Returns `true` when the error message is safe to forward to a client. */
function isSafeMessage(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const name = err.constructor.name
  if (SAFE_PREFIXES.some((p) => name.startsWith(p))) return true
  // Errors whose message starts with a safe prefix (thrown as plain Error)
  if (SAFE_PREFIXES.some((p) => err.message.startsWith(p))) return true
  return false
}

/**
 * Extract a client-safe message from an unknown thrown value.
 *
 * - Known safe errors → original message
 * - Everything else   → generic "Internal server error"
 *
 * The raw message is always returned as `internal` so callers can still
 * log it server-side.
 */
export function sanitizeError(err: unknown): { safe: string; internal: string } {
  const internal = err instanceof Error ? err.message : String(err)
  const safe = isSafeMessage(err) ? internal : GENERIC
  return { safe, internal }
}

// ── Numeric query-param parsing ──────────────────────────────────

/**
 * Parse a string query parameter to a bounded integer.
 *
 * Returns `defaultValue` when `raw` is undefined/null.
 * Returns `undefined` when `raw` is present but invalid (NaN, out of bounds).
 * Callers should check for `undefined` and return a 400.
 */
export function parseIntBounded(
  raw: string | undefined | null,
  opts: { min?: number | undefined; max?: number | undefined; defaultValue?: number | undefined } = {},
): number | undefined {
  const { min = 0, max = 10_000, defaultValue } = opts
  if (raw == null || raw === '') return defaultValue
  const n = parseInt(raw, 10)
  if (isNaN(n) || n < min || n > max) return undefined
  return n
}
