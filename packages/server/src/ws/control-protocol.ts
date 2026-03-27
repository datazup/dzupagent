import type { DzipEvent } from '@dzipagent/core'
import type { EventSubscriptionFilter } from '../events/event-gateway.js'
import type { ClientFilter, EventBridge, WSClient } from './event-bridge.js'

export type WSControlClientMessage =
  | { type: 'subscribe'; filter?: EventSubscriptionFilter }
  | { type: 'unsubscribe' }

export type WSControlServerMessage =
  | { type: 'subscribed'; filter: ClientFilter }
  | { type: 'unsubscribed' }
  | { type: 'error'; code: string; message: string }

export interface WSControlAuthorizeContext {
  client: WSClient
  filter: ClientFilter
}

export type WSControlAuthorizeFilter = (
  ctx: WSControlAuthorizeContext,
) => boolean | Promise<boolean>

export interface WSControlHandlerOptions {
  /**
   * Optional authorization guard for subscribe requests.
   * Return false to reject the filter update.
   */
  authorizeFilter?: WSControlAuthorizeFilter
  /**
   * If true, subscribe filter must include at least one scope field.
   * Scope fields: runId, agentId, eventTypes.
   */
  requireScopedSubscription?: boolean
  /**
   * Filter to apply on unsubscribe.
   * Defaults to empty filter (all events).
   */
  unsubscribeFilter?: ClientFilter
}

function safeSend(client: WSClient, message: WSControlServerMessage): void {
  try {
    client.send(JSON.stringify(message))
  } catch {
    // Best effort ack/error sending only.
  }
}

function normalizeFilter(input: unknown): ClientFilter | null {
  if (input == null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) return null

  const src = input as Record<string, unknown>
  const runId = typeof src['runId'] === 'string' && src['runId'].trim().length > 0
    ? src['runId'].trim()
    : undefined
  const agentId = typeof src['agentId'] === 'string' && src['agentId'].trim().length > 0
    ? src['agentId'].trim()
    : undefined

  let eventTypes: DzipEvent['type'][] | undefined
  if (src['eventTypes'] !== undefined) {
    if (!Array.isArray(src['eventTypes'])) return null
    const parsed = src['eventTypes']
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    eventTypes = parsed.length > 0 ? (parsed as DzipEvent['type'][]) : undefined
  }

  return { runId, agentId, eventTypes }
}

function isScopedFilter(filter: ClientFilter): boolean {
  if (filter.runId) return true
  if (filter.agentId) return true
  if (filter.eventTypes && filter.eventTypes.length > 0) return true
  return false
}

/**
 * Create a message handler for runtime WS servers.
 *
 * Host runtime usage (pseudo):
 * 1. bridge.addClient(ws)
 * 2. const onMessage = createWsControlHandler(bridge, ws)
 * 3. forward incoming text messages to onMessage(raw)
 */
export function createWsControlHandler(
  bridge: EventBridge,
  client: WSClient,
  options?: WSControlHandlerOptions,
): (raw: string) => Promise<void> {
  const requireScopedSubscription = options?.requireScopedSubscription ?? false
  const unsubscribeFilter = options?.unsubscribeFilter ?? {}

  return async (raw: string) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      safeSend(client, {
        type: 'error',
        code: 'INVALID_JSON',
        message: 'Control message must be valid JSON',
      })
      return
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      safeSend(client, {
        type: 'error',
        code: 'INVALID_MESSAGE',
        message: 'Control message must be a JSON object',
      })
      return
    }

    const message = parsed as Record<string, unknown>
    const kind = message['type']
    if (typeof kind !== 'string') {
      safeSend(client, {
        type: 'error',
        code: 'MISSING_TYPE',
        message: 'Control message "type" is required',
      })
      return
    }

    if (kind === 'subscribe') {
      const filter = normalizeFilter(message['filter'])
      if (!filter) {
        safeSend(client, {
          type: 'error',
          code: 'INVALID_FILTER',
          message: 'Subscribe filter must be an object with optional runId/agentId/eventTypes[]',
        })
        return
      }
      if (requireScopedSubscription && !isScopedFilter(filter)) {
        safeSend(client, {
          type: 'error',
          code: 'UNSCOPED_SUBSCRIPTION',
          message: 'Subscribe filter must include runId, agentId, or eventTypes',
        })
        return
      }
      if (options?.authorizeFilter) {
        const allowed = await options.authorizeFilter({ client, filter })
        if (!allowed) {
          safeSend(client, {
            type: 'error',
            code: 'FORBIDDEN_FILTER',
            message: 'Subscribe filter is not allowed for this client',
          })
          return
        }
      }
      bridge.setClientFilter(client, filter)
      safeSend(client, { type: 'subscribed', filter })
      return
    }

    if (kind === 'unsubscribe') {
      bridge.setClientFilter(client, unsubscribeFilter)
      safeSend(client, { type: 'unsubscribed' })
      return
    }

    safeSend(client, {
      type: 'error',
      code: 'UNSUPPORTED_TYPE',
      message: `Unsupported control message type "${kind}"`,
    })
  }
}
