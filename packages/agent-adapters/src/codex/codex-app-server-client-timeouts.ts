import {
  CodexAppServerClientError,
  operationCancelled,
} from './codex-app-server-client-contracts.js'

/**
 * Races an operation against a deadline and an optional abort signal.
 *
 * The settle latch matters: a timeout, an abort, and the operation itself can
 * all resolve in the same tick, and only the first is allowed to decide the
 * outcome. Losing that race would let a cancelled operation report success.
 */
export function withinTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => finish(operationCancelled())
    const finish = (error: unknown, value?: T) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error !== undefined) reject(error)
      else resolve(value as T)
    }
    timer = setTimeout(() => finish(new CodexAppServerClientError(
      'CODEX_APP_SERVER_TIMEOUT',
      'Codex app-server operation timed out',
    )), timeoutMs)
    if (signal?.aborted) {
      finish(operationCancelled())
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => finish(undefined, value),
      (error: unknown) => finish(error),
    )
  })
}

export function ensureNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw operationCancelled()
}

/**
 * Converts an absolute deadline into the time left, and treats "no time left"
 * as a timeout rather than returning zero. A zero would be handed straight to
 * `setTimeout`, which fires immediately and would report the wrong stage.
 */
export function remainingTimeout(deadline: number, monotonicNow: () => number): number {
  const remaining = Math.ceil(deadline - monotonicNow())
  if (!Number.isSafeInteger(remaining) || remaining < 1) {
    throw new CodexAppServerClientError(
      'CODEX_APP_SERVER_TIMEOUT',
      'Codex app-server operation timed out',
    )
  }
  return remaining
}

/** A per-call ceiling may only tighten the configured limit, never expand it. */
export function tightenedRequestTimeout(configured: number, ceiling: number | undefined): number {
  if (ceiling === undefined) return configured
  if (!Number.isSafeInteger(ceiling) || ceiling < 1) {
    throw new CodexAppServerClientError(
      'CODEX_APP_SERVER_TIMEOUT',
      'Codex app-server request had no remaining time',
    )
  }
  return Math.min(configured, ceiling)
}
