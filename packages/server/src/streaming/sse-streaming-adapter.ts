/**
 * SSE streaming adapter — bridges StreamingRunHandle to Hono SSE transport.
 *
 * Pipes events from a StreamingRunHandle's async iterable to a Hono
 * SSEStreamingApi. Completes (closes SSE) when the handle emits 'done'
 * or 'error'. Cancels the handle when the client disconnects via
 * stream.onAbort.
 */
import type { StreamingRunHandle, StreamEvent } from '@dzupagent/agent'

/**
 * Minimal interface for Hono's SSEStreamingApi.
 *
 * We define our own interface rather than importing from hono/streaming
 * to keep the adapter testable without requiring the full Hono runtime.
 * Any object that satisfies this contract (including Hono's real SSEStreamingApi)
 * can be used.
 */
export interface SSEStreamLike {
  writeSSE(message: { data: string; event?: string; id?: string }): Promise<void>
  onAbort(callback: () => void): void
}

export interface StreamRunHandleToSSEOptions {
  /** Called when a stream write throws (e.g., client already disconnected). */
  onError?: (error: unknown) => void
  /** Emit a ping event if no data has been sent in this many ms. Default: 30_000. 0 = disabled. */
  keepAliveIntervalMs?: number
  /** Fail the handle if the run has not completed within this many ms. Default: 0 = disabled. */
  runTimeoutMs?: number
  /**
   * Called when the internal write buffer exceeds 80% of `maxBufferBytes`.
   *
   * The `fillRatio` argument is `bufferedBytes / maxBufferBytes` (always > 0.8
   * when fired). Invoked at most once per 500 ms to avoid callback spam.
   * Callers can use this signal to apply backpressure upstream.
   */
  onBufferSaturation?: (fillRatio: number) => void
  /**
   * Maximum buffer capacity in bytes used for the saturation metric.
   * Default: 1_048_576 (1 MiB). Only relevant when `onBufferSaturation` is set.
   */
  maxBufferBytes?: number
}

/**
 * Serialize a StreamEvent to SSE-safe JSON.
 *
 * Error objects are not JSON-serializable, so we convert them to
 * a plain object with message and name fields.
 */
function serializeEvent(event: StreamEvent): string {
  if (event.type === 'error') {
    return JSON.stringify({
      type: event.type,
      error: {
        message: event.error.message,
        name: event.error.name,
      },
    })
  }
  return JSON.stringify(event)
}

/**
 * Pipes events from a StreamingRunHandle to a Hono SSE stream.
 *
 * Each StreamEvent is written as an SSE message with:
 * - `event` field set to `event.type` (e.g., 'text_delta', 'tool_call_start')
 * - `data` field set to `JSON.stringify(event)`
 *
 * The function resolves when:
 * - The handle emits a 'done' event (stream completes normally)
 * - The handle emits an 'error' event (stream completes with error forwarded)
 * - The handle enters a terminal state (completed, failed, cancelled)
 *
 * If the client disconnects (stream.onAbort fires), the handle is cancelled
 * to stop the upstream producer.
 */
export async function streamRunHandleToSSE(
  handle: StreamingRunHandle,
  stream: SSEStreamLike,
  opts?: StreamRunHandleToSSEOptions,
): Promise<void> {
  const keepAliveIntervalMs = opts?.keepAliveIntervalMs ?? 30_000
  const runTimeoutMs = opts?.runTimeoutMs ?? 0
  const onBufferSaturation = opts?.onBufferSaturation
  const maxBufferBytes = opts?.maxBufferBytes ?? 1_048_576
  const SATURATION_THRESHOLD = 0.8
  const SATURATION_DEBOUNCE_MS = 500

  let bufferedBytes = 0
  let lastSaturationCallTime = 0
  let lastEventTime = Date.now()

  // Keep-alive: emit a transport-level ping if no data has been sent recently.
  // The ping bypasses StreamEvent serialization — it is purely a heartbeat to
  // prevent proxies (nginx, ALB) from dropping idle connections.
  const keepAliveTimer = keepAliveIntervalMs > 0
    ? setInterval(() => {
        if (Date.now() - lastEventTime >= keepAliveIntervalMs) {
          void stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => {
            // Swallow — if write fails the main loop will detect it on the next event.
          })
          lastEventTime = Date.now()
        }
      }, Math.min(keepAliveIntervalMs, 5_000))
    : null

  // Run timeout: fail the handle if it has not completed within the budget.
  const timeoutTimer = runTimeoutMs > 0
    ? setTimeout(() => {
        handle.fail(new Error('run_timeout'))
      }, runTimeoutMs)
    : null

  function clearTimers(): void {
    if (keepAliveTimer !== null) clearInterval(keepAliveTimer)
    if (timeoutTimer !== null) clearTimeout(timeoutTimer)
  }

  // Cancel the handle when the client disconnects
  stream.onAbort(() => {
    clearTimers()
    handle.cancel()
  })

  for await (const event of handle.events()) {
    try {
      const serialized = serializeEvent(event)
      const byteLen = Buffer.byteLength(serialized, 'utf8')
      bufferedBytes += byteLen

      // Check buffer saturation while bytes are queued (before the write drains)
      if (onBufferSaturation) {
        const fillRatio = bufferedBytes / maxBufferBytes
        if (fillRatio > SATURATION_THRESHOLD) {
          const now = Date.now()
          if (now - lastSaturationCallTime >= SATURATION_DEBOUNCE_MS) {
            lastSaturationCallTime = now
            onBufferSaturation(fillRatio)
          }
        }
      }

      await stream.writeSSE({
        data: serialized,
        event: event.type,
      })
      bufferedBytes -= byteLen
      lastEventTime = Date.now()
    } catch (err: unknown) {
      clearTimers()
      opts?.onError?.(err)
      // If we can't write, the stream is broken — cancel the handle and bail
      handle.cancel()
      return
    }

    // After forwarding a done or error event, we're finished
    if (event.type === 'done' || event.type === 'error') {
      clearTimers()
      return
    }
  }

  // Handle ended without done/error (e.g., complete() with no events)
  clearTimers()
}
