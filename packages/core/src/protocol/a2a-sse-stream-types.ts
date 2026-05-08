/**
 * Type definitions for the A2A SSE streaming client.
 */
import type { ForgeMessage } from './message-types.js'

/** Configuration for the A2A SSE streaming client. */
export interface A2ASSEConfig {
  /** Custom fetch function for testing. */
  fetch?: typeof globalThis.fetch
  /** Reconnection delay in ms (default: 1000). */
  reconnectDelayMs?: number
  /** Max reconnection attempts (default: 3). */
  maxReconnects?: number
}

/** A parsed SSE event. */
export interface SSEEvent {
  event?: string
  data: string
  id?: string
  retry?: number
}

/** A2A task status update event payload. */
export interface A2AStatusUpdate {
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
export interface A2AArtifactUpdate {
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

/**
 * Signal used internally to indicate stream completion (not an error).
 */
export class StreamEndSignal {
  readonly message: ForgeMessage
  constructor(message: ForgeMessage) {
    this.message = message
  }
}
