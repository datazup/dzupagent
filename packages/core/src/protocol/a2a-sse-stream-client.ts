/**
 * A2A SSE streaming client.
 *
 * Connects to an A2A SSE endpoint and yields ForgeMessage events,
 * handling reconnection on connection drops up to `maxReconnects` times.
 * Respects AbortSignal for cancellation.
 */
import type { ForgeMessage } from './message-types.js'
import { ForgeError } from '../errors/forge-error.js'
import {
  type A2ASSEConfig,
  StreamEndSignal,
} from './a2a-sse-stream-types.js'
import {
  convertA2AEventToForgeMessage,
  parseSSEEvents,
} from './a2a-sse-stream-parser.js'
import { sleepWithSignal } from './a2a-sse-stream-reconnect.js'

/**
 * Connect to an A2A SSE endpoint and yield ForgeMessage events.
 *
 * Handles reconnection on connection drop up to `maxReconnects` times.
 * Respects AbortSignal for cancellation.
 */
export async function* streamA2ATask(
  endpoint: string,
  taskId: string,
  config?: A2ASSEConfig & { signal?: AbortSignal },
): AsyncGenerator<ForgeMessage, void, undefined> {
  const fetchFn = config?.fetch ?? globalThis.fetch.bind(globalThis)
  const maxReconnects = config?.maxReconnects ?? 3
  const reconnectDelayMs = config?.reconnectDelayMs ?? 1_000

  let reconnectCount = 0
  let lastEventId: string | undefined

  while (reconnectCount <= maxReconnects) {
    // Check abort before connecting
    if (config?.signal?.aborted) {
      return
    }

    const url = `${endpoint}/tasks/${taskId}/stream`
    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
    }
    if (lastEventId !== undefined) {
      headers['Last-Event-ID'] = lastEventId
    }

    let response: Response
    try {
      response = await fetchFn(url, {
        method: 'GET',
        headers,
        ...(config?.signal !== undefined && { signal: config.signal }),
      })
    } catch (err: unknown) {
      // Abort signal will throw — just return
      if (config?.signal?.aborted) {
        return
      }

      reconnectCount++
      if (reconnectCount > maxReconnects) {
        throw new ForgeError({
          code: 'PROTOCOL_CONNECTION_FAILED',
          message: `A2A SSE connection failed after ${maxReconnects} reconnect attempts: ${err instanceof Error ? err.message : String(err)}`,
          recoverable: false,
          ...(err instanceof Error && { cause: err }),
        })
      }
      await sleepWithSignal(reconnectDelayMs, config?.signal)
      continue
    }

    if (!response.ok) {
      throw new ForgeError({
        code: 'PROTOCOL_CONNECTION_FAILED',
        message: `A2A SSE endpoint returned ${response.status}`,
        recoverable: response.status >= 500,
        context: { url, status: response.status },
      })
    }

    if (!response.body) {
      throw new ForgeError({
        code: 'PROTOCOL_CONNECTION_FAILED',
        message: 'A2A SSE response has no body',
        recoverable: false,
      })
    }

    // Read the stream
    let completed = false
    try {
      yield* readSSEStream(response.body, taskId, config?.signal, (id) => {
        lastEventId = id
      })
      // If readSSEStream returns normally, stream ended cleanly
      completed = true
    } catch (err: unknown) {
      if (config?.signal?.aborted) {
        return
      }

      // Check if it's a stream_end signal (non-error completion)
      if (err instanceof StreamEndSignal) {
        return
      }

      // Connection dropped — attempt reconnect
      reconnectCount++
      if (reconnectCount > maxReconnects) {
        throw new ForgeError({
          code: 'PROTOCOL_CONNECTION_FAILED',
          message: `A2A SSE stream dropped after ${maxReconnects} reconnect attempts`,
          recoverable: false,
          ...(err instanceof Error && { cause: err }),
        })
      }
      await sleepWithSignal(reconnectDelayMs, config?.signal)
      continue
    }

    if (completed) {
      return
    }
  }
}

/**
 * Read SSE data from a ReadableStream and yield ForgeMessage events.
 */
async function* readSSEStream(
  body: ReadableStream<Uint8Array>,
  taskId: string,
  signal: AbortSignal | undefined,
  onEventId: (id: string) => void,
): AsyncGenerator<ForgeMessage, void, undefined> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''

  try {
    while (true) {
      if (signal?.aborted) {
        return
      }

      const { done, value } = await reader.read()
      if (done) {
        // Process any remaining buffer
        if (buffer.trim().length > 0) {
          const events = parseSSEEvents(buffer + '\n\n')
          for (const evt of events) {
            if (evt.id !== undefined) {
              onEventId(evt.id)
            }
            const msg = convertA2AEventToForgeMessage(evt, taskId)
            if (msg !== null) {
              if (msg.type === 'stream_end' || msg.type === 'error') {
                yield msg
                return
              }
              yield msg
            }
          }
        }
        return
      }

      buffer += decoder.decode(value, { stream: true })

      // Process complete events (separated by double newlines)
      const parts = buffer.split('\n\n')
      // Keep the last part as it may be incomplete
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        if (part.trim().length === 0) continue
        const events = parseSSEEvents(part + '\n\n')
        for (const evt of events) {
          if (evt.id !== undefined) {
            onEventId(evt.id)
          }
          const msg = convertA2AEventToForgeMessage(evt, taskId)
          if (msg !== null) {
            yield msg
            if (msg.type === 'stream_end' || msg.type === 'error') {
              return
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
