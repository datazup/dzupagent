/**
 * WebSocket event bridge — forwards DzupEventBus events to connected WebSocket clients.
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
import type { DzupEventBus } from '@dzupagent/core/events'
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
  /** Only receive events for this compile */
  compileId?: string
}

/**
 * Resolver invoked at `addClient` time to derive the tenant scope for a WS
 * client. Returning `undefined` preserves the legacy single-tenant fan-out
 * (the bridge does NOT set `filter.tenantId`), so anonymous/local-dev clients
 * continue to see every envelope. Returning a string opts the client into the
 * gateway's fail-closed tenant filter — see `matchesFilter` in
 * `event-gateway.ts`. (DZUPAGENT-SEC-M-WS-01)
 */
export type WSClientTenantResolver = (ws: WSClient) => string | undefined

export interface EventBridgeConfig {
  maxQueueSize?: number
  /**
   * Optional resolver that lifts a WS client's authenticated tenant into the
   * subscription filter. Centralises tenant scoping at the single bridge
   * enforcement point so every call site (control protocol, compile handler,
   * session manager's deny-all baseline) inherits it without changes.
   * (DZUPAGENT-SEC-M-WS-01)
   */
  tenantResolver?: WSClientTenantResolver
}

const WS_OPEN = 1

function isEventGateway(input: DzupEventBus | EventGateway): input is EventGateway {
  return 'subscribe' in input && typeof input.subscribe === 'function'
}

export class EventBridge {
  private clients = new Map<WSClient, { filter: ClientFilter; subscription: EventSubscription }>()
  private readonly gateway: EventGateway
  private readonly ownsGateway: boolean
  private readonly maxQueueSize: number
  private readonly tenantResolver: WSClientTenantResolver | undefined

  constructor(input: DzupEventBus | EventGateway, config?: EventBridgeConfig) {
    this.maxQueueSize = config?.maxQueueSize ?? 512
    this.tenantResolver = config?.tenantResolver
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
    const resolvedFilter = this.applyTenantScope(ws, filter ?? {})
    const subscription = this.gateway.subscribe(
      resolvedFilter,
      (envelope) => this.sendToClient(ws, envelope),
      { maxQueueSize: this.maxQueueSize, overflowStrategy: 'disconnect' },
    )
    this.clients.set(ws, { filter: resolvedFilter, subscription })
  }

  /**
   * Inject the resolved tenant into the subscription filter. Fail-closed
   * semantics live in the gateway: setting `filter.tenantId` opts the
   * subscriber into strict equality matching against `envelope.tenantId`.
   * When the resolver yields `undefined` (or none is configured) the field
   * is intentionally left unset to preserve legacy single-tenant fan-out
   * for unauthenticated clients. (DZUPAGENT-SEC-M-WS-01)
   *
   * An explicit `filter.tenantId` on the caller side takes precedence over
   * the resolver — useful for tests and for callers that already know the
   * tenant context.
   */
  private applyTenantScope(ws: WSClient, filter: ClientFilter): ClientFilter {
    if (filter.tenantId !== undefined) return filter
    if (!this.tenantResolver) return filter
    const tenantId = this.tenantResolver(ws)
    if (typeof tenantId !== 'string' || tenantId.length === 0) return filter
    return { ...filter, tenantId }
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
