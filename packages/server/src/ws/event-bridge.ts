/**
 * WebSocket event bridge — forwards DzipEventBus events to connected WebSocket clients.
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
import type { DzipEventBus } from '@dzipagent/core'
import {
  InMemoryEventGateway,
  type EventEnvelope,
  type EventGateway,
  type EventSubscription,
  type EventSubscriptionFilter,
} from '../events/event-gateway.js'

export interface WSClient {
  send(data: string): void
  close(): void
  readyState: number
}

export interface ClientFilter extends EventSubscriptionFilter {
  /** Only receive events for this run */
  runId?: string
}

export interface EventBridgeConfig {
  maxQueueSize?: number
}

const WS_OPEN = 1

function isEventGateway(input: DzipEventBus | EventGateway): input is EventGateway {
  return 'subscribe' in input && typeof input.subscribe === 'function'
}

export class EventBridge {
  private clients = new Map<WSClient, { filter: ClientFilter; subscription: EventSubscription }>()
  private readonly gateway: EventGateway
  private readonly ownsGateway: boolean
  private readonly maxQueueSize: number

  constructor(input: DzipEventBus | EventGateway, config?: EventBridgeConfig) {
    this.maxQueueSize = config?.maxQueueSize ?? 512
    if (isEventGateway(input)) {
      this.gateway = input
      this.ownsGateway = false
      return
    }
    this.gateway = new InMemoryEventGateway(input)
    this.ownsGateway = true
  }

  /** Register a WebSocket client to receive events */
  addClient(ws: WSClient, filter?: ClientFilter): void {
    this.removeClient(ws)
    const resolvedFilter = filter ?? {}
    const subscription = this.gateway.subscribe(
      resolvedFilter,
      (envelope) => this.sendToClient(ws, envelope),
      { maxQueueSize: this.maxQueueSize, overflowStrategy: 'disconnect' },
    )
    this.clients.set(ws, { filter: resolvedFilter, subscription })
  }

  /** Update filter for an existing client without reconnecting the socket. */
  setClientFilter(ws: WSClient, filter: ClientFilter): void {
    if (!this.clients.has(ws)) return
    this.addClient(ws, filter)
  }

  /** Remove a WebSocket client */
  removeClient(ws: WSClient): void {
    const existing = this.clients.get(ws)
    if (!existing) return
    existing.subscription.unsubscribe()
    this.clients.delete(ws)
  }

  /** Get number of connected clients */
  get clientCount(): number {
    return this.clients.size
  }

  /** Stop listening to events and disconnect all clients */
  destroy(): void {
    this.disconnectAll()
  }

  /** Close all WebSocket connections and stop event forwarding */
  disconnectAll(): void {
    for (const [ws, { subscription }] of this.clients) {
      subscription.unsubscribe()
      try { ws.close() } catch { /* best-effort */ }
    }
    this.clients.clear()
    if (this.ownsGateway) {
      this.gateway.destroy()
    }
  }

  private sendToClient(ws: WSClient, envelope: EventEnvelope): boolean {
    if (ws.readyState !== WS_OPEN) {
      this.removeClient(ws)
      return false
    }
    try {
      ws.send(JSON.stringify(envelope))
      return true
    } catch {
      this.removeClient(ws)
      return false
    }
  }
}
