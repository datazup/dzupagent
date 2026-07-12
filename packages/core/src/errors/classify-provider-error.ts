/**
 * Provider error classification.
 *
 * Historically, retry / fallback / circuit-breaker decisions were made by
 * string-matching raw provider SDK error messages at each decision site
 * (e.g. `msg.includes('429')`). That scattered the same brittle heuristics
 * across `retry.ts`, `invoke.ts`, `resilient-invoker.ts`, and
 * `model-registry.ts`, and coupled control-flow decisions to unredacted
 * provider text.
 *
 * This module centralises the string→code mapping in exactly ONE place:
 * {@link classifyProviderError}. It maps a raw error to a typed
 * {@link ForgeError} with a `PROVIDER_*` (or `CONTEXT_LENGTH_EXCEEDED`) code
 * and a `recoverable` flag. Every downstream decision site then reads the
 * *typed* code / `recoverable` flag rather than re-implementing substring
 * matching.
 *
 * The raw message is only inspected here, to derive the code — it is NOT
 * stored verbatim on the returned ForgeError's user-facing surfaces beyond
 * the `cause` (redaction of caller-facing text is handled separately by the
 * containment helpers, e.g. `sanitizeProviderError` in resilient-invoker.ts).
 */
import { ForgeError } from './forge-error.js'
import type { ForgeErrorCode } from './error-codes.js'

/**
 * Provider error codes that indicate a transient failure — retrying (either
 * on the same provider after backoff, or on a fallback provider) may succeed.
 */
const TRANSIENT_PROVIDER_CODES: ReadonlySet<ForgeErrorCode> = new Set([
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TIMEOUT',
  'RATE_LIMIT_EXCEEDED',
])

/**
 * Map a raw error to a specific `PROVIDER_*` / context code by inspecting its
 * message. This is the ONE authorised place substring heuristics live.
 *
 * Returns `undefined` when the error does not match any known provider-failure
 * shape (i.e. it should be treated as a non-recoverable application error).
 */
function providerCodeForMessage(msg: string): ForgeErrorCode | undefined {
  const m = msg.toLowerCase()

  // Context-length overflow is a hard, non-retryable failure — check first so
  // it is never misclassified as a transient/rate-limit error.
  if (
    m.includes('context_length_exceeded') ||
    m.includes('maximum context') ||
    m.includes('prompt is too long')
  ) {
    return 'CONTEXT_LENGTH_EXCEEDED'
  }

  // Rate limiting / quota.
  if (
    m.includes('429') ||
    m.includes('rate_limit') ||
    m.includes('rate limit') ||
    m.includes('too many requests')
  ) {
    return 'PROVIDER_RATE_LIMITED'
  }

  // Server overload / temporary unavailability.
  if (
    m.includes('503') ||
    m.includes('529') ||
    m.includes('overloaded') ||
    m.includes('capacity')
  ) {
    return 'PROVIDER_UNAVAILABLE'
  }

  // Network-level timeouts and connection resets — treat as provider timeout.
  if (
    m.includes('timeout') ||
    m.includes('econnreset') ||
    m.includes('econnrefused') ||
    m.includes('socket hang up') ||
    m.includes('fetch failed')
  ) {
    return 'PROVIDER_TIMEOUT'
  }

  // Auth failures — non-recoverable (retrying with the same key fails identically).
  if (
    m.includes('401') ||
    m.includes('403') ||
    m.includes('invalid api key') ||
    m.includes('unauthorized') ||
    m.includes('authentication')
  ) {
    return 'PROVIDER_AUTH_FAILED'
  }

  return undefined
}

/**
 * Classify a raw provider error into a typed {@link ForgeError} carrying a
 * `PROVIDER_*` / `CONTEXT_LENGTH_EXCEEDED` code and a `recoverable` flag.
 *
 * - If `err` is already a {@link ForgeError}, it is returned unchanged (its
 *   code / recoverable flag are authoritative).
 * - Otherwise the message is inspected once to derive the code. Unmatched
 *   errors map to `INTERNAL_ERROR` with `recoverable: false`.
 *
 * Callers should use the returned error's `.code` / `.recoverable` for
 * retry / fallback / breaker decisions instead of re-matching strings.
 */
export function classifyProviderError(err: unknown): ForgeError {
  if (err instanceof ForgeError) return err

  const message = err instanceof Error ? err.message : String(err ?? '')
  const code = providerCodeForMessage(message)
  const cause = err instanceof Error ? err : undefined

  if (code === undefined) {
    return ForgeError.wrap(err, {
      code: 'INTERNAL_ERROR',
      recoverable: false,
    })
  }

  const recoverable = TRANSIENT_PROVIDER_CODES.has(code)
  return new ForgeError({
    code,
    message,
    recoverable,
    ...(cause ? { cause } : {}),
  })
}

/**
 * Typed transient check: does this error represent a transient provider
 * failure that warrants a retry / fallback hop?
 *
 * Reads the typed `PROVIDER_*` code and `ForgeError.recoverable` flag rather
 * than string-matching the message at the decision site. If the error is not
 * already a ForgeError it is classified first via {@link classifyProviderError}.
 */
export function isRecoverableProviderError(err: unknown): boolean {
  const forge = classifyProviderError(err)
  return forge.recoverable && TRANSIENT_PROVIDER_CODES.has(forge.code)
}

/**
 * Typed context-length check: does this error indicate the prompt exceeded the
 * model's context window? These are non-retryable — a bigger prompt fails
 * identically. Reads the typed `CONTEXT_LENGTH_EXCEEDED` code.
 */
export function isContextLengthProviderError(err: unknown): boolean {
  return classifyProviderError(err).code === 'CONTEXT_LENGTH_EXCEEDED'
}
