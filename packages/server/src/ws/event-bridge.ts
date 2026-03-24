/**
 * WebSocket event bridge — forwards ForgeEventBus events to connected WebSocket clients.
 *
 * Clients can subscribe to:
 * - All events (wildcard)
 * - Events for a specific run (by runId)
 *
 * @example
 * ```ts
 * const bridge = new EventBridge(eventBus)
 *
 * // In WebSocket upgrade handler:
 * bridge.addClient(ws, { runId: 'run-123' })
 *
 * // Events for run-123 + wildcard events are pushed to ws
 * ```
 */
import type { ForgeEventBus, ForgeEvent } from '@forgeagent/core'

export interface WSClient {
  send(data: string): void
  close(): void
  readyState: number
}

export interface ClientFilter {
  /** Only receive events for this run */
  runId?: string
}

const WS_OPEN = 1

export class EventBridge {
  private clients = new Map<WSClient, ClientFilter>()
  private unsubscribe: (() => void) | null = null

  constructor(private eventBus: ForgeEventBus) {
    this.unsubscribe = this.eventBus.onAny((event) => {
      this.broadcast(event)
    })
  }

  /** Register a WebSocket client to receive events */
  addClient(ws: WSClient, filter?: ClientFilter): void {
    this.clients.set(ws, filter ?? {})
  }

  /** Remove a WebSocket client */
  removeClient(ws: WSClient): void {
    this.clients.delete(ws)
  }

  /** Get number of connected clients */
  get clientCount(): number {
    return this.clients.size
  }

  /** Stop listening to events and disconnect all clients */
  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    this.clients.clear()
  }

  private broadcast(event: ForgeEvent): void {
    const eventRunId = 'runId' in event ? (event as { runId: string }).runId : undefined
    const data = JSON.stringify(event)

    for (const [ws, filter] of this.clients) {
      // Clean up closed connections
      if (ws.readyState !== WS_OPEN) {
        this.clients.delete(ws)
        continue
      }

      // Apply filter: if client subscribed to a specific runId, only send matching events
      if (filter.runId && eventRunId && filter.runId !== eventRunId) {
        continue
      }

      try {
        ws.send(data)
      } catch {
        // Client disconnected — remove
        this.clients.delete(ws)
      }
    }
  }
}
