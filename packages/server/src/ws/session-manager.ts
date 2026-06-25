import type { WSClient, EventBridge } from "./event-bridge.js";
import type { WSClientScopeRegistry } from "./scope-registry.js";
import type { WSClientScope } from "./authorization.js";
import type { ScopedWsControlHandlerOptions } from "./scoped-control-handler.js";
import { createScopedWsControlHandler } from "./scoped-control-handler.js";

export interface WSSessionManagerOptions extends ScopedWsControlHandlerOptions {
  /**
   * Optional async scope resolver invoked when client attaches.
   * If omitted, caller can pass scope directly to attach().
   */
  resolveScope?: (
    client: WSClient
  ) => Promise<WSClientScope | null> | WSClientScope | null;
  /**
   * Require the injected bridge to be fail-closed multi-tenant
   * (`EventBridge.isTenantScoped`). When `true`, `attach` throws if the bridge
   * is not tenant-scoped, preventing a multi-tenant deployment from silently
   * running on a fail-open bridge. (DZUPAGENT-SEC-M-01)
   *
   * Default `false` preserves single-tenant deployments.
   */
  requireTenantScope?: boolean;
}

/**
 * Runtime integration helper for WS lifecycle:
 * - attach client
 * - process control messages
 * - detach client
 */
export class WSSessionManager {
  private readonly controlHandlers = new WeakMap<
    WSClient,
    (raw: string) => Promise<void>
  >();

  constructor(
    private readonly bridge: EventBridge,
    private readonly scopeRegistry: WSClientScopeRegistry,
    private readonly options?: WSSessionManagerOptions
  ) {}

  async attach(client: WSClient, scope?: WSClientScope): Promise<void> {
    // SEC-M-01: in multi-tenant deployments the bridge MUST be fail-closed.
    // Refuse to attach against a fail-open bridge rather than silently leaking.
    if (this.options?.requireTenantScope && !this.bridge.isTenantScoped) {
      throw new Error(
        "WSSessionManager: requireTenantScope is set but the EventBridge is not tenant-scoped (DZUPAGENT-SEC-M-01)"
      );
    }

    const resolvedScope =
      scope ?? (await this.options?.resolveScope?.(client)) ?? null;
    // SEC-M-WS-01: populate the scope registry BEFORE adding the client to the
    // bridge so the bridge's tenantResolver (which reads from the registry)
    // sees the authenticated tenant on the very first subscription. Without
    // this ordering, the deny-all baseline below would skip tenant scoping
    // and a later setClientFilter call would have to re-resolve.
    if (resolvedScope) {
      this.scopeRegistry.set(client, resolvedScope);
    }

    // Attach with an explicit deny-all baseline until the client sends an
    // authorized subscribe filter. On a tenant-scoped bridge this may be
    // rejected when no server tenant resolves — in which case we clean up and
    // never register a control handler, so the client cannot subscribe at all.
    const added = this.bridge.addClient(client, { eventTypes: [] });
    if (!added) {
      this.scopeRegistry.delete(client);
      return;
    }

    const onControl = createScopedWsControlHandler(
      this.bridge,
      client,
      this.scopeRegistry,
      this.options
    );
    this.controlHandlers.set(client, onControl);
  }

  async handleMessage(client: WSClient, raw: string): Promise<void> {
    const handler = this.controlHandlers.get(client);
    if (!handler) return;
    await handler(raw);
  }

  detach(client: WSClient): void {
    this.controlHandlers.delete(client);
    this.scopeRegistry.delete(client);
    this.bridge.removeClient(client);
  }
}
