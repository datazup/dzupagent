/**
 * Compile-scoped WebSocket handler.
 *
 * Responds to `subscribe:compile` / `unsubscribe:compile` client messages by
 * updating the client's filter on the shared `EventBridge`. When a filter is
 * set to `{ compileId }`, only events carrying a matching `compileId`
 * (as emitted by `@dzupagent/flow-compiler`'s `flow:compile_*` events) are
 * pushed to this socket.
 *
 * Typical wiring:
 *   1. `bridge.addClient(ws)` — on upgrade
 *   2. create both `createWsControlHandler` and `createCompileWsHandler`
 *   3. dispatch incoming text messages to one handler based on message `type`
 *      (or call both — non-matching message types are ignored silently).
 */
import type { EventBridge, WSClient, ClientFilter } from './event-bridge.js'

export interface CompileWsHandlerOptions {
  /**
   * Optional authorization guard for compile subscriptions.
   * Return false to reject the subscribe request.
   */
  authorizeCompile?: (ctx: { client: WSClient; compileId: string }) => boolean | Promise<boolean>
  /**
   * Filter to restore on unsubscribe. Defaults to `{}` (broadcast all).
   * Host runtimes using scoped subscriptions can pass a deny-all baseline.
   */
  unsubscribeFilter?: ClientFilter
}

type CompileServerError = {
  type: 'error'
  code: string
  message: string
}

type CompileServerAck =
  | { type: 'subscribed:compile'; compileId: string }
  | { type: 'unsubscribed:compile'; compileId: string }

function safeSend(client: WSClient, message: CompileServerAck | CompileServerError): void {
  try {
    client.send(JSON.stringify(message))
  } catch {
    // Best effort ack/error sending only.
  }
}

/**
 * Create a compile-scoped WS control handler.
 *
 * The returned handler accepts raw JSON text messages. It silently ignores
 * any message whose `type` is not `subscribe:compile` or `unsubscribe:compile`
 * so it can coexist with the generic control handler on the same socket.
 */
export function createCompileWsHandler(
  bridge: EventBridge,
  client: WSClient,
  options?: CompileWsHandlerOptions,
): (raw: string) => Promise<void> {
  const unsubscribeFilter = options?.unsubscribeFilter ?? {}

  return async (raw: string) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Not compile's concern — a sibling handler reports invalid JSON.
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return

    const message = parsed as Record<string, unknown>
    const kind = message['type']
    if (typeof kind !== 'string') return

    if (kind === 'subscribe:compile') {
      const compileId = typeof message['compileId'] === 'string'
        ? message['compileId'].trim()
        : ''
      if (compileId.length === 0) {
        safeSend(client, {
          type: 'error',
          code: 'INVALID_COMPILE_ID',
          message: 'subscribe:compile requires a non-empty compileId string',
        })
        return
      }
      if (options?.authorizeCompile) {
        const allowed = await options.authorizeCompile({ client, compileId })
        if (!allowed) {
          safeSend(client, {
            type: 'error',
            code: 'FORBIDDEN_COMPILE',
            message: 'compile subscription not allowed for this client',
          })
          return
        }
      }
      bridge.setClientFilter(client, { compileId })
      safeSend(client, { type: 'subscribed:compile', compileId })
      return
    }

    if (kind === 'unsubscribe:compile') {
      const compileId = typeof message['compileId'] === 'string'
        ? message['compileId'].trim()
        : ''
      if (compileId.length === 0) {
        safeSend(client, {
          type: 'error',
          code: 'INVALID_COMPILE_ID',
          message: 'unsubscribe:compile requires a non-empty compileId string',
        })
        return
      }
      bridge.setClientFilter(client, unsubscribeFilter)
      safeSend(client, { type: 'unsubscribed:compile', compileId })
      return
    }

    // Unknown message type — no-op so this handler can coexist with others.
  }
}
