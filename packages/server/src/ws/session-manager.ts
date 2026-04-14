import type { WSClient, EventBridge } from './event-bridge.js'
import type { WSClientScopeRegistry } from './scope-registry.js'
import type { WSClientScope } from './authorization.js'
import type { ScopedWsControlHandlerOptions } from './scoped-control-handler.js'
import { createScopedWsControlHandler } from './scoped-control-handler.js'

export interface WSSessionManagerOptions extends ScopedWsControlHandlerOptions {
  /**
   * Optional async scope resolver invoked when client attaches.
   * If omitted, caller can pass scope directly to attach().
   */
  resolveScope?: (client: WSClient) => Promise<WSClientScope | null> | WSClientScope | null
}

/**
 * Runtime integration helper for WS lifecycle:
 * - attach client
 * - process control messages
 * - detach client
 */
export class WSSessionManager {
  private readonly controlHandlers = new WeakMap<WSClient, (raw: string) => Promise<void>>()

  constructor(
    private readonly bridge: EventBridge,
    private readonly scopeRegistry: WSClientScopeRegistry,
    private readonly options?: WSSessionManagerOptions,
  ) {}

  async attach(client: WSClient, scope?: WSClientScope): Promise<void> {
    // Attach with an explicit deny-all baseline until the client sends an authorized subscribe filter.
    this.bridge.addClient(client, { eventTypes: [] })

    const resolvedScope = scope ?? await this.options?.resolveScope?.(client) ?? null
    if (resolvedScope) {
      this.scopeRegistry.set(client, resolvedScope)
    }

    const onControl = createScopedWsControlHandler(
      this.bridge,
      client,
      this.scopeRegistry,
      this.options,
    )
    this.controlHandlers.set(client, onControl)
  }

  async handleMessage(client: WSClient, raw: string): Promise<void> {
    const handler = this.controlHandlers.get(client)
    if (!handler) return
    await handler(raw)
  }

  detach(client: WSClient): void {
    this.controlHandlers.delete(client)
    this.scopeRegistry.delete(client)
    this.bridge.removeClient(client)
  }
}
