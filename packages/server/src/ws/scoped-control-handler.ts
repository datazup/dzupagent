import type { EventBridge, WSClient } from './event-bridge.js'
import type { WSControlHandlerOptions } from './control-protocol.js'
import { createWsControlHandler } from './control-protocol.js'
import type { ScopedAuthorizeFilterOptions } from './authorization.js'
import { WSClientScopeRegistry } from './scope-registry.js'

export interface ScopedWsControlHandlerOptions extends Omit<WSControlHandlerOptions, 'authorizeFilter'> {
  /**
   * Options forwarded to scoped authorize filter builder.
   * resolveClientScope is provided by registry automatically.
   */
  scopeAuthorization?: Omit<ScopedAuthorizeFilterOptions, 'resolveClientScope'>
}

/**
 * Create a WS control handler wired to a client scope registry.
 *
 * This is the recommended helper for host WS runtimes:
 * 1. register `client -> scope` in registry
 * 2. create this handler
 * 3. pass incoming text WS messages to handler
 */
export function createScopedWsControlHandler(
  bridge: EventBridge,
  client: WSClient,
  registry: WSClientScopeRegistry,
  options?: ScopedWsControlHandlerOptions,
): (raw: string) => Promise<void> {
  const authorizeFilter = registry.createAuthorizeFilter(options?.scopeAuthorization)
  return createWsControlHandler(bridge, client, {
    ...options,
    authorizeFilter,
  })
}
