/**
 * Shared HTTP -> ForgeError normalization for vector-store adapters.
 *
 * Mirrors the provider-adapter helper but emits vector-store-scoped error
 * codes so the calling layer (semantic store, memory service) can decide
 * whether a failure is transient.
 *
 * Status mapping:
 *   - 429          -> VECTOR_STORE_RATE_LIMITED     (recoverable: true)
 *   - 401 / 403    -> VECTOR_STORE_AUTH_FAILED      (recoverable: false)
 *   - 5xx          -> VECTOR_STORE_UNAVAILABLE      (recoverable: true)
 *   - other 4xx    -> VECTOR_STORE_REJECTED_REQUEST (recoverable: false)
 *   - everything else (non-2xx fallthrough) -> VECTOR_STORE_UNAVAILABLE
 *
 * The raw response body is stored in `context.body` for debugging but is
 * NEVER interpolated into the human-readable `message`.
 */
import { ForgeError } from '../errors/forge-error.js'
import type { ForgeErrorCode } from '../errors/error-codes.js'

/** Truncate an arbitrary body to a safe size for the error context. */
function summarizeBody(body: unknown, maxLen = 2_000): unknown {
  if (typeof body === 'string') {
    return body.length > maxLen ? `${body.slice(0, maxLen)}…[truncated]` : body
  }
  return body
}

interface VectorHttpErrorMapping {
  code: ForgeErrorCode
  recoverable: boolean
  label: string
}

function mapStatus(status: number): VectorHttpErrorMapping {
  if (status === 429) {
    return { code: 'VECTOR_STORE_RATE_LIMITED', recoverable: true, label: 'rate limited' }
  }
  if (status === 401 || status === 403) {
    return { code: 'VECTOR_STORE_AUTH_FAILED', recoverable: false, label: 'authentication failed' }
  }
  if (status >= 500) {
    return { code: 'VECTOR_STORE_UNAVAILABLE', recoverable: true, label: 'service unavailable' }
  }
  if (status >= 400) {
    return { code: 'VECTOR_STORE_REJECTED_REQUEST', recoverable: false, label: 'request rejected' }
  }
  return { code: 'VECTOR_STORE_UNAVAILABLE', recoverable: true, label: 'unexpected response' }
}

/**
 * Convert an upstream vector-store HTTP failure into a structured
 * {@link ForgeError}.
 *
 * @param status     HTTP status code of the failing response.
 * @param body       Raw (already-read) response body — stored in context,
 *                   never in the message.
 * @param providerId Logical vector-store provider id (e.g. 'pinecone').
 */
export function vectorHttpErrorToForgeError(
  status: number,
  body: unknown,
  providerId: string,
): ForgeError {
  const { code, recoverable, label } = mapStatus(status)
  return new ForgeError({
    code,
    message: `${providerId} vector store ${label} (HTTP ${status})`,
    recoverable,
    context: { providerId, status, body: summarizeBody(body) },
  })
}
