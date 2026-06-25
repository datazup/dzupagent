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
import type { DzupEventBus } from "@dzupagent/core/events";
import {
  InMemoryEventGateway,
  type EventEnvelope,
  type EventGateway,
  type EventSubscription,
  type EventSubscriptionFilter,
} from "../events/event-gateway.js";

export interface WSClient {
  send(data: string): void;
  close(): void;
  readyState: number;
}

export interface ClientFilter extends EventSubscriptionFilter {
  /** Only receive events for this run */
  runId?: string;
  /** Only receive events for this compile */
  compileId?: string;
}

/**
 * Resolver invoked at `addClient` time to derive the tenant scope for a WS
 * client. Returning `undefined` preserves the legacy single-tenant fan-out
 * (the bridge does NOT set `filter.tenantId`), so anonymous/local-dev clients
 * continue to see every envelope. Returning a string opts the client into the
 * gateway's fail-closed tenant filter — see `matchesFilter` in
 * `event-gateway.ts`. (DZUPAGENT-SEC-M-WS-01)
 */
export type WSClientTenantResolver = (ws: WSClient) => string | undefined;

/**
 * Minimal logging sink used by the bridge to surface tenant-scope security
 * events. Defaults to `console` so production deployments capture violations
 * without extra wiring; tests can inject a spy. (DZUPAGENT-SEC-M-01)
 */
export interface EventBridgeLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface EventBridgeConfig {
  maxQueueSize?: number;
  /**
   * Optional resolver that lifts a WS client's authenticated tenant into the
   * subscription filter. Centralises tenant scoping at the single bridge
   * enforcement point so every call site (control protocol, compile handler,
   * session manager's deny-all baseline) inherits it without changes.
   * (DZUPAGENT-SEC-M-WS-01)
   */
  tenantResolver?: WSClientTenantResolver;
  /**
   * Fail-closed multi-tenant mode (DZUPAGENT-SEC-M-01). When `true`:
   * - `addClient` REQUIRES a server-resolved tenant. If no `tenantResolver` is
   *   configured, or it yields no tenant for the client, the client is rejected
   *   (`addClient` returns `false`; no subscription is created).
   * - A caller-supplied `filter.tenantId` can NEVER override the server-resolved
   *   tenant: the resolver's value always wins, and any divergence is logged as
   *   a security warning. This closes the cross-tenant subscription hole where
   *   client A could pass `filter.tenantId = 'B'` to read client B's stream.
   *
   * Default `false` preserves legacy single-tenant fan-out: anonymous clients
   * are accepted and a caller-supplied `filter.tenantId` takes precedence over
   * the resolver (developer/test convenience).
   */
  requireTenantScope?: boolean;
  /**
   * Sink for tenant-scope security warnings. Defaults to `console`.
   * (DZUPAGENT-SEC-M-01)
   */
  logger?: EventBridgeLogger;
}

const WS_OPEN = 1;

function isEventGateway(
  input: DzupEventBus | EventGateway
): input is EventGateway {
  return "subscribe" in input && typeof input.subscribe === "function";
}

export class EventBridge {
  private clients = new Map<
    WSClient,
    { filter: ClientFilter; subscription: EventSubscription }
  >();
  private readonly gateway: EventGateway;
  private readonly ownsGateway: boolean;
  private readonly maxQueueSize: number;
  private readonly tenantResolver: WSClientTenantResolver | undefined;
  private readonly requireTenantScope: boolean;
  private readonly logger: EventBridgeLogger;

  constructor(input: DzupEventBus | EventGateway, config?: EventBridgeConfig) {
    this.maxQueueSize = config?.maxQueueSize ?? 512;
    this.tenantResolver = config?.tenantResolver;
    this.requireTenantScope = config?.requireTenantScope ?? false;
    this.logger = config?.logger ?? console;
    if (isEventGateway(input)) {
      this.gateway = input;
      this.ownsGateway = false;
      return;
    }
    this.gateway = new InMemoryEventGateway(input);
    this.ownsGateway = true;
  }

  /**
   * Build a fail-closed, multi-tenant `EventBridge` for host integrations that
   * already track an authenticated tenant per client (e.g. `WSSessionManager`
   * backed by a `WSClientScopeRegistry`). The supplied `resolveTenant` becomes
   * the bridge's `tenantResolver` and `requireTenantScope` is forced on, so a
   * caller-supplied `filter.tenantId` can never select another tenant's stream.
   * (DZUPAGENT-SEC-M-01)
   */
  static tenantScoped(
    input: DzupEventBus | EventGateway,
    resolveTenant: WSClientTenantResolver,
    config?: Omit<EventBridgeConfig, "tenantResolver" | "requireTenantScope">
  ): EventBridge {
    return new EventBridge(input, {
      ...config,
      tenantResolver: resolveTenant,
      requireTenantScope: true,
    });
  }

  /**
   * Register a WebSocket client to receive events.
   *
   * Returns `true` when the client was subscribed, `false` when it was rejected.
   * Rejection only happens in fail-closed multi-tenant mode (`requireTenantScope`)
   * when no server tenant can be resolved for the client. (DZUPAGENT-SEC-M-01)
   */
  addClient(ws: WSClient, filter?: ClientFilter): boolean {
    this.removeClient(ws);
    const resolvedFilter = this.applyTenantScope(ws, filter ?? {});
    if (resolvedFilter === null) {
      // Fail-closed: no server-resolved tenant in multi-tenant mode. Never
      // create a subscription — the client sees nothing rather than everything.
      try {
        ws.close();
      } catch {
        /* best-effort */
      }
      return false;
    }
    const subscription = this.gateway.subscribe(
      resolvedFilter,
      (envelope) => this.sendToClient(ws, envelope),
      { maxQueueSize: this.maxQueueSize, overflowStrategy: "disconnect" }
    );
    this.clients.set(ws, { filter: resolvedFilter, subscription });
    return true;
  }

  /**
   * Inject the resolved tenant into the subscription filter. Fail-closed
   * semantics live in the gateway: setting `filter.tenantId` opts the
   * subscriber into strict equality matching against `envelope.tenantId`.
   *
   * Two modes (DZUPAGENT-SEC-M-01):
   *
   * - `requireTenantScope: false` (default, single-tenant): an explicit
   *   `filter.tenantId` on the caller side takes precedence over the resolver.
   *   When the resolver yields `undefined` (or none is configured) the field
   *   is intentionally left unset to preserve legacy single-tenant fan-out for
   *   unauthenticated clients. Always returns a filter (never rejects).
   *
   * - `requireTenantScope: true` (multi-tenant): the server-resolved tenant
   *   ALWAYS wins. A caller-supplied `filter.tenantId` can never select another
   *   tenant's stream — any divergence is logged and overwritten. If no tenant
   *   can be resolved (no resolver, or resolver returns nothing) the client is
   *   rejected by returning `null`.
   */
  private applyTenantScope(
    ws: WSClient,
    filter: ClientFilter
  ): ClientFilter | null {
    const resolved = this.tenantResolver ? this.tenantResolver(ws) : undefined;
    const serverTenant =
      typeof resolved === "string" && resolved.length > 0
        ? resolved
        : undefined;

    if (this.requireTenantScope) {
      if (serverTenant === undefined) {
        this.logger.warn(
          "EventBridge: rejecting WS client — no server-resolved tenant in requireTenantScope mode (DZUPAGENT-SEC-M-01)",
          { hasResolver: this.tenantResolver !== undefined }
        );
        return null;
      }
      // Server tenant wins. A caller filter must never override it.
      if (filter.tenantId !== undefined && filter.tenantId !== serverTenant) {
        this.logger.warn(
          "EventBridge: ignoring caller-supplied filter.tenantId that diverges from server-resolved tenant (DZUPAGENT-SEC-M-01)",
          { callerTenantId: filter.tenantId, serverTenantId: serverTenant }
        );
      }
      return { ...filter, tenantId: serverTenant };
    }

    // Single-tenant / legacy mode: caller-supplied tenantId wins.
    if (filter.tenantId !== undefined) return filter;
    if (serverTenant === undefined) return filter;
    return { ...filter, tenantId: serverTenant };
  }

  /**
   * Update filter for an existing client without reconnecting the socket.
   *
   * Returns `false` if the client is unknown or was rejected by the tenant
   * scope guard (in which case the client is removed). (DZUPAGENT-SEC-M-01)
   */
  setClientFilter(ws: WSClient, filter: ClientFilter): boolean {
    if (!this.clients.has(ws)) return false;
    return this.addClient(ws, filter);
  }

  /** Remove a WebSocket client */
  removeClient(ws: WSClient): void {
    const existing = this.clients.get(ws);
    if (!existing) return;
    existing.subscription.unsubscribe();
    this.clients.delete(ws);
  }

  /** Get number of connected clients */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Whether this bridge enforces fail-closed multi-tenant scoping. Host
   * integrations (e.g. `WSSessionManager`) can assert this before accepting
   * authenticated clients. (DZUPAGENT-SEC-M-01)
   */
  get isTenantScoped(): boolean {
    return this.requireTenantScope;
  }

  /** Stop listening to events and disconnect all clients */
  destroy(): void {
    this.disconnectAll();
  }

  /** Close all WebSocket connections and stop event forwarding */
  disconnectAll(): void {
    for (const [ws, { subscription }] of this.clients) {
      subscription.unsubscribe();
      try {
        ws.close();
      } catch {
        /* best-effort */
      }
    }
    this.clients.clear();
    if (this.ownsGateway) {
      this.gateway.destroy();
    }
  }

  private sendToClient(ws: WSClient, envelope: EventEnvelope): boolean {
    if (ws.readyState !== WS_OPEN) {
      this.removeClient(ws);
      return false;
    }
    try {
      ws.send(JSON.stringify(envelope));
      return true;
    } catch {
      this.removeClient(ws);
      return false;
    }
  }
}
