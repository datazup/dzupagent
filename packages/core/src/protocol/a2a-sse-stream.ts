/**
 * A2A SSE streaming client.
 *
 * Connects to an A2A SSE endpoint and yields ForgeMessage events,
 * handling reconnection on connection drops.
 */
import type { ForgeMessage, ForgePayload } from './message-types.js'
import { createForgeMessage } from './message-factory.js'
import { ForgeError } from '../errors/forge-error.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface A2ASSEConfig {
  /** Custom fetch function for testing. */
  fetch?: typeof globalThis.fetch
  /** Reconnection delay in ms (default: 1000). */
  reconnectDelayMs?: number
  /** Max reconnection attempts (default: 3). */
  maxReconnects?: number
}

// ---------------------------------------------------------------------------
// SSE event parsing
// ---------------------------------------------------------------------------

/** A parsed SSE event. */
export interface SSEEvent {
  event?: string
  data: string
  id?: string
  retry?: number
}

/**
 * Parse raw SSE text into events.
 *
 * Handles multi-line data fields, event types, retry directives,
 * and comment lines (lines starting with `:`).
 *
 * SSE spec: https://html.spec.whatwg.org/multipage/server-sent-events.html
 */
export function parseSSEEvents(text: string): SSEEvent[] {
  const events: SSEEvent[] = []
  const lines = text.split('\n')

  let currentEvent: string | undefined
  let currentData: string[] = []
  let currentId: string | undefined
  let currentRetry: number | undefined

  function flush(): void {
    if (currentData.length > 0) {
      const evt: SSEEvent = {
        data: currentData.join('\n'),
      }
      if (currentEvent !== undefined) evt.event = currentEvent
      if (currentId !== undefined) evt.id = currentId
      if (currentRetry !== undefined) evt.retry = currentRetry
      events.push(evt)
    }
    currentEvent = undefined
    currentData = []
    currentId = undefined
    currentRetry = undefined
  }

  for (const line of lines) {
    // Empty line = event boundary
    if (line === '' || line === '\r') {
      flush()
      continue
    }

    // Comment line — ignore
    if (line.startsWith(':')) {
      continue
    }

    const colonIndex = line.indexOf(':')
    let field: string
    let value: string

    if (colonIndex === -1) {
      // Field with no value
      field = line
      value = ''
    } else {
      field = line.slice(0, colonIndex)
      // Skip single leading space after colon per SSE spec
      value = line[colonIndex + 1] === ' '
        ? line.slice(colonIndex + 2)
        : line.slice(colonIndex + 1)
    }

    switch (field) {
      case 'data':
        currentData.push(value)
        break
      case 'event':
        currentEvent = value
        break
      case 'id':
        currentId = value
        break
      case 'retry': {
        const parsed = parseInt(value, 10)
        if (!isNaN(parsed)) {
          currentRetry = parsed
        }
        break
      }
      default:
        // Unknown field — ignore per spec
        break
    }
  }

  // Flush any trailing event without a final blank line
  flush()

  return events
}

// ---------------------------------------------------------------------------
// A2A SSE event types
// ---------------------------------------------------------------------------

/** A2A task status update event payload. */
interface A2AStatusUpdate {
  id: string
  status: {
    state: string
    message?: {
      role: string
      parts: Array<{
        type: string
        text?: string
        data?: Record<string, unknown>
      }>
    }
  }
}

/** A2A task artifact update event payload. */
interface A2AArtifactUpdate {
  id: string
  artifact: {
    parts: Array<{
      type: string
      text?: string
      data?: Record<string, unknown>
    }>
    name?: string
  }
}

// ---------------------------------------------------------------------------
// SSE stream generator
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal: SSE stream reader
// ---------------------------------------------------------------------------

/**
 * Signal used internally to indicate stream completion (not an error).
 */
class StreamEndSignal {
  readonly message: ForgeMessage
  constructor(message: ForgeMessage) {
    this.message = message
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

// ---------------------------------------------------------------------------
// A2A event -> ForgeMessage conversion
// ---------------------------------------------------------------------------

/**
 * Convert a parsed SSE event into a ForgeMessage.
 *
 * Returns null for events that don't map to a ForgeMessage
 * (comments, heartbeats, etc.).
 */
function convertA2AEventToForgeMessage(
  evt: SSEEvent,
  taskId: string,
): ForgeMessage | null {
  const eventType = evt.event ?? ''

  let parsed: unknown
  try {
    parsed = JSON.parse(evt.data)
  } catch {
    // Non-JSON data — treat as text chunk
    if (evt.data.trim().length > 0) {
      return createForgeMessage({
        type: 'stream_chunk',
        from: `a2a://task/${taskId}`,
        to: 'forge://local',
        protocol: 'a2a',
        payload: { type: 'text', content: evt.data },
        metadata: { a2aTaskId: taskId },
      })
    }
    return null
  }

  // task.status.update
  if (eventType === 'task.status.update' || isStatusUpdate(parsed)) {
    const update = parsed as A2AStatusUpdate
    const state = update.status?.state

    if (state === 'completed') {
      return createForgeMessage({
        type: 'stream_end',
        from: `a2a://task/${taskId}`,
        to: 'forge://local',
        protocol: 'a2a',
        payload: extractStatusPayload(update),
        metadata: { a2aTaskId: taskId, a2aTaskState: state },
      })
    }

    if (state === 'failed') {
      const message = extractStatusText(update) ?? `Task ${taskId} failed`
      return createForgeMessage({
        type: 'error',
        from: `a2a://task/${taskId}`,
        to: 'forge://local',
        protocol: 'a2a',
        payload: { type: 'error', code: 'PROTOCOL_SEND_FAILED', message },
        metadata: { a2aTaskId: taskId, a2aTaskState: state },
      })
    }

    // working, submitted, input-required, canceled
    const payload = extractStatusPayload(update)
    return createForgeMessage({
      type: 'stream_chunk',
      from: `a2a://task/${taskId}`,
      to: 'forge://local',
      protocol: 'a2a',
      payload,
      metadata: { a2aTaskId: taskId, a2aTaskState: state },
    })
  }

  // task.artifact.update
  if (eventType === 'task.artifact.update' || isArtifactUpdate(parsed)) {
    const update = parsed as A2AArtifactUpdate
    return createForgeMessage({
      type: 'stream_chunk',
      from: `a2a://task/${taskId}`,
      to: 'forge://local',
      protocol: 'a2a',
      payload: { type: 'json', data: update.artifact as unknown as Record<string, unknown> },
      metadata: { a2aTaskId: taskId, artifactName: update.artifact.name },
    })
  }

  // Unknown event type with JSON data — yield as json chunk
  if (typeof parsed === 'object' && parsed !== null) {
    return createForgeMessage({
      type: 'stream_chunk',
      from: `a2a://task/${taskId}`,
      to: 'forge://local',
      protocol: 'a2a',
      payload: { type: 'json', data: parsed as Record<string, unknown> },
      metadata: { a2aTaskId: taskId },
    })
  }

  return null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isStatusUpdate(data: unknown): data is A2AStatusUpdate {
  return (
    typeof data === 'object' &&
    data !== null &&
    'status' in data &&
    typeof (data as Record<string, unknown>)['status'] === 'object'
  )
}

function isArtifactUpdate(data: unknown): data is A2AArtifactUpdate {
  return (
    typeof data === 'object' &&
    data !== null &&
    'artifact' in data &&
    typeof (data as Record<string, unknown>)['artifact'] === 'object'
  )
}

function extractStatusPayload(update: A2AStatusUpdate): ForgePayload {
  const msg = update.status.message
  if (msg) {
    const textParts = msg.parts.filter((p) => p.type === 'text' && p.text)
    if (textParts.length > 0 && textParts[0]?.text) {
      return { type: 'text', content: textParts[0].text }
    }
    const dataParts = msg.parts.filter((p) => p.type === 'data' && p.data)
    if (dataParts.length > 0 && dataParts[0]?.data) {
      return { type: 'json', data: dataParts[0].data }
    }
  }
  return { type: 'text', content: `Task ${update.id} ${update.status.state}` }
}

function extractStatusText(update: A2AStatusUpdate): string | undefined {
  const msg = update.status.message
  if (msg) {
    const textParts = msg.parts.filter((p) => p.type === 'text' && p.text)
    if (textParts.length > 0 && textParts[0]?.text) {
      return textParts[0].text
    }
  }
  return undefined
}

/**
 * Sleep for the given duration, returning early on abort.
 */
function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
