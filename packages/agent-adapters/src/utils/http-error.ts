/**
 * Shared HTTP -> ForgeError normalization for provider adapters.
 *
 * Maps an upstream HTTP status code onto a structured {@link ForgeError}
 * with a stable error code and a correct `recoverable` flag so the circuit
 * breaker / fallback layer can act on transient failures without retrying
 * permanent ones.
 *
 * Status mapping:
 *   - 429          -> PROVIDER_RATE_LIMITED      (recoverable: true)
 *   - 401 / 403    -> PROVIDER_AUTH_FAILED       (recoverable: false)
 *   - 5xx          -> PROVIDER_UNAVAILABLE       (recoverable: true)
 *   - other 4xx    -> PROVIDER_REJECTED_REQUEST  (recoverable: false)
 *   - everything else (non-2xx fallthrough) -> PROVIDER_UNAVAILABLE
 *
 * The raw response body is stored in `context.body` for debugging but is
 * NEVER interpolated into the human-readable `message` (avoids leaking
 * secrets / PII into logs that surface the message).
 */
import { ForgeError, type ForgeErrorCode } from '@dzupagent/core/events'

/** Truncate an arbitrary body to a safe size for the error context. */
function summarizeBody(body: unknown, maxLen = 2_000): unknown {
  if (typeof body === 'string') {
    return body.length > maxLen ? `${body.slice(0, maxLen)}…[truncated]` : body
  }
  return body
}

interface HttpErrorMapping {
  code: ForgeErrorCode
  recoverable: boolean
  label: string
}

function mapStatus(status: number): HttpErrorMapping {
  if (status === 429) {
    return { code: 'PROVIDER_RATE_LIMITED', recoverable: true, label: 'rate limited' }
  }
  if (status === 401 || status === 403) {
    return { code: 'PROVIDER_AUTH_FAILED', recoverable: false, label: 'authentication failed' }
  }
  if (status >= 500) {
    return { code: 'PROVIDER_UNAVAILABLE', recoverable: true, label: 'service unavailable' }
  }
  if (status >= 400) {
    return { code: 'PROVIDER_REJECTED_REQUEST', recoverable: false, label: 'request rejected' }
  }
  // Non-2xx that is not a recognised 4xx/5xx — treat as transient.
  return { code: 'PROVIDER_UNAVAILABLE', recoverable: true, label: 'unexpected response' }
}

/**
 * Convert an upstream HTTP failure into a structured {@link ForgeError}.
 *
 * @param status     HTTP status code of the failing response.
 * @param body       Raw (already-read) response body — stored in context,
 *                   never in the message.
 * @param providerId Logical provider id (e.g. 'openai', 'openrouter').
 */
export function httpErrorToForgeError(
  status: number,
  body: unknown,
  providerId: string,
): ForgeError {
  const { code, recoverable, label } = mapStatus(status)
  return new ForgeError({
    code,
    message: `${providerId} provider ${label} (HTTP ${status})`,
    recoverable,
    context: { providerId, status, body: summarizeBody(body) },
  })
}
