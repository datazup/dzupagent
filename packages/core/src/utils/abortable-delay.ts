/**
 * Abortable delay helper.
 *
 * Resolves after `ms` milliseconds, or earlier if the supplied {@link AbortSignal}
 * fires. Critically, when the timer resolves naturally we always remove the
 * `abort` listener — preventing listener accumulation when the same long-lived
 * signal is reused across many calls (audit finding AGENT-108).
 *
 * Returns immediately if the signal is already aborted on entry.
 *
 * Note: a natural-resolution path that did NOT remove the listener (e.g.
 * `addEventListener('abort', ..., { once: true })`) is unsafe: a signal that
 * never fires would still keep the listener attached for the lifetime of the
 * signal, and the listener count grows linearly with retry attempts.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let onAbort: (() => void) | undefined
    const timer = setTimeout(() => {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort)
      }
      resolve()
    }, ms)
    if (signal) {
      onAbort = (): void => {
        clearTimeout(timer)
        // Self-cleanup: this listener has fired (signal aborted), so it's
        // already detached by the runtime, but explicit removal is harmless
        // and keeps the symmetry obvious to readers.
        signal.removeEventListener('abort', onAbort!)
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
