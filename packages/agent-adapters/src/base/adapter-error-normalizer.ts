import { ForgeError } from '@dzupagent/core'

export interface NormalizedAdapterError {
  message: string
  code?: string | undefined
  original: unknown
}

/**
 * Normalize an arbitrary thrown value into a structured shape suitable for
 * an `adapter:failed` event. Preserves the original error reference so
 * callers can decide whether to rethrow.
 */
export function normalizeAdapterError(err: unknown): NormalizedAdapterError {
  if (err instanceof Error) {
    return {
      message: err.message,
      code: ForgeError.is(err) ? err.code : undefined,
      original: err,
    }
  }
  return {
    message: String(err),
    code: undefined,
    original: err,
  }
}

/**
 * Decide whether the original error should be rethrown after the
 * adapter:failed event has been yielded. Currently only `ForgeError`
 * instances rethrow — they signal recoverable framework-level failures
 * the host needs to observe.
 */
export function shouldRethrowAdapterError(err: unknown): boolean {
  return ForgeError.is(err)
}
