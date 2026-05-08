/**
 * SSE event parsing + A2A → ForgeMessage conversion.
 *
 * - `parseSSEEvents` parses raw SSE text into events per the WHATWG spec.
 * - `convertA2AEventToForgeMessage` maps A2A task.status.update /
 *   task.artifact.update events to ForgeMessage instances.
 */
import type { ForgeMessage, ForgePayload } from './message-types.js'
import { createForgeMessage } from './message-factory.js'
import type {
  A2AArtifactUpdate,
  A2AStatusUpdate,
  SSEEvent,
} from './a2a-sse-stream-types.js'

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
// A2A event -> ForgeMessage conversion
// ---------------------------------------------------------------------------

/**
 * Convert a parsed SSE event into a ForgeMessage.
 *
 * Returns null for events that don't map to a ForgeMessage
 * (comments, heartbeats, etc.).
 */
export function convertA2AEventToForgeMessage(
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
