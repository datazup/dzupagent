/**
 * Abort-signal helpers shared by OrchestratorFacade.run() and related code.
 */

export interface MergedSignal {
  signal: AbortSignal
  cleanup: (() => void) | undefined
}

/**
 * Merge a caller-supplied signal with an internal timeout signal. Uses
 * `AbortSignal.any` when available and falls back to a manual listener
 * combiner with cleanup otherwise.
 */
export function mergeAbortSignals(
  caller: AbortSignal | undefined,
  timeout: AbortSignal,
): MergedSignal {
  if (!caller) return { signal: timeout, cleanup: undefined }

  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([caller, timeout]), cleanup: undefined }
  }

  const combined = new AbortController()
  const onAbort = (): void => combined.abort()
  caller.addEventListener('abort', onAbort, { once: true })
  timeout.addEventListener('abort', onAbort, { once: true })
  return {
    signal: combined.signal,
    cleanup: () => {
      caller.removeEventListener('abort', onAbort)
      timeout.removeEventListener('abort', onAbort)
    },
  }
}
