import type { WSClient } from './event-bridge.js'
import type {
  ScopedAuthorizeFilterOptions,
  WSClientScope,
} from './authorization.js'
import { createScopedAuthorizeFilter } from './authorization.js'
import type { WSControlAuthorizeFilter } from './control-protocol.js'

/**
 * In-memory scope registry for active WS clients.
 *
 * Host runtimes can populate this at connection time from auth/session context.
 */
export class WSClientScopeRegistry {
  private readonly scopes = new WeakMap<WSClient, WSClientScope>()

  set(client: WSClient, scope: WSClientScope): void {
    this.scopes.set(client, scope)
  }

  get(client: WSClient): WSClientScope | undefined {
    return this.scopes.get(client)
  }

  delete(client: WSClient): void {
    this.scopes.delete(client)
  }

  createAuthorizeFilter(
    options?: Omit<ScopedAuthorizeFilterOptions, 'resolveClientScope'>,
  ): WSControlAuthorizeFilter {
    return createScopedAuthorizeFilter({
      ...options,
      resolveClientScope: (client) => this.get(client) ?? null,
    })
  }
}
