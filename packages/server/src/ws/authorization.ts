import type { ForgeEvent } from '@forgeagent/core'
import type { ClientFilter, WSClient } from './event-bridge.js'
import type { WSControlAuthorizeFilter } from './control-protocol.js'

export interface WSClientScope {
  tenantId?: string
  /** Allowed run IDs for this client. */
  runIds?: string[]
  /** Allowed agent IDs for this client. */
  agentIds?: string[]
  /** Event types the client is allowed to subscribe to. */
  eventTypes?: ForgeEvent['type'][]
  /** If true, bypass scope checks. Intended for trusted operators. */
  canSubscribeAll?: boolean
}

export interface ScopedAuthorizeFilterOptions {
  /** Resolve scope/claims for a WS client from runtime session context. */
  resolveClientScope: (client: WSClient) => Promise<WSClientScope | null> | WSClientScope | null
  /**
   * Optional custom run authorization for filters.
   * If omitted, runIds list in scope is used.
   */
  canAccessRun?: (ctx: {
    client: WSClient
    scope: WSClientScope
    runId: string
  }) => Promise<boolean> | boolean
  /**
   * Optional custom agent authorization for filters.
   * If omitted, agentIds list in scope is used.
   */
  canAccessAgent?: (ctx: {
    client: WSClient
    scope: WSClientScope
    agentId: string
  }) => Promise<boolean> | boolean
  /**
   * Whether to allow empty filters.
   * Default false (recommended for multi-tenant deployments).
   */
  allowUnscoped?: boolean
}

function isUnscoped(filter: ClientFilter): boolean {
  const hasRun = typeof filter.runId === 'string' && filter.runId.length > 0
  const hasAgent = typeof filter.agentId === 'string' && filter.agentId.length > 0
  const hasTypes = Array.isArray(filter.eventTypes) && filter.eventTypes.length > 0
  return !hasRun && !hasAgent && !hasTypes
}

/**
 * Factory for tenant/scope-aware WS control authorization.
 *
 * Host runtime should bind WS client -> auth context and provide `resolveClientScope`.
 */
export function createScopedAuthorizeFilter(
  options: ScopedAuthorizeFilterOptions,
): WSControlAuthorizeFilter {
  const allowUnscoped = options.allowUnscoped ?? false

  return async ({ client, filter }) => {
    if (isUnscoped(filter) && !allowUnscoped) {
      return false
    }

    const scope = await options.resolveClientScope(client)
    if (!scope) return false
    if (scope.canSubscribeAll) return true

    if (filter.runId) {
      if (options.canAccessRun) {
        const ok = await options.canAccessRun({ client, scope, runId: filter.runId })
        if (!ok) return false
      } else if (!scope.runIds?.includes(filter.runId)) {
        return false
      }
    }

    if (filter.agentId) {
      if (options.canAccessAgent) {
        const ok = await options.canAccessAgent({ client, scope, agentId: filter.agentId })
        if (!ok) return false
      } else if (!scope.agentIds?.includes(filter.agentId)) {
        return false
      }
    }

    if (filter.eventTypes && filter.eventTypes.length > 0) {
      if (!scope.eventTypes || scope.eventTypes.length === 0) return false
      const allowed = filter.eventTypes.every((eventType) =>
        scope.eventTypes!.includes(eventType as ForgeEvent['type']),
      )
      if (!allowed) return false
    }

    return true
  }
}
