import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WSClient } from './event-bridge.js'
import type { WSClientScope } from './authorization.js'
import type { WSSessionManager } from './session-manager.js'
import { attachNodeWsSession, type NodeWSLike } from './node-adapter.js'

export interface NodeWebSocketServerLike {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: NodeWSLike, request: IncomingMessage) => void,
  ): void
}

export interface NodeWsUpgradeHandlerOptions {
  wss: NodeWebSocketServerLike
  manager: WSSessionManager
  /**
   * Resolve WS client scope from Node request context.
   * If omitted, manager.resolveScope may still handle it.
   */
  resolveScopeFromRequest?: (
    req: IncomingMessage,
  ) => Promise<WSClientScope | null> | WSClientScope | null
  /**
   * Request-level allow/deny guard.
   * Return false to reject before WS upgrade.
   */
  shouldHandleRequest?: (
    req: IncomingMessage,
  ) => boolean | Promise<boolean>
  /**
   * Called when request is rejected before upgrade.
   */
  onRejected?: (ctx: { req: IncomingMessage; reason: string }) => void
  /**
   * Called if attach fails after successful upgrade.
   */
  onAttachError?: (ctx: { req: IncomingMessage; ws: WSClient; error: unknown }) => void
  /**
   * Destroy raw socket when rejecting request (default: true).
   */
  destroySocketOnReject?: boolean
}

/**
 * Create a Node HTTP `upgrade` handler for `ws` package noServer mode.
 */
export function createNodeWsUpgradeHandler(options: NodeWsUpgradeHandlerOptions):
  (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const destroySocketOnReject = options.destroySocketOnReject ?? true

  return (req, socket, head) => {
    void (async () => {
      const allowed = options.shouldHandleRequest
        ? await options.shouldHandleRequest(req)
        : true

      if (!allowed) {
        options.onRejected?.({ req, reason: 'request_not_allowed' })
        if (destroySocketOnReject && typeof (socket as { destroy?: () => void }).destroy === 'function') {
          ;(socket as { destroy: () => void }).destroy()
        }
        return
      }

      options.wss.handleUpgrade(req, socket, head, (ws, upgradeReq) => {
        void (async () => {
          try {
            const scope = options.resolveScopeFromRequest
              ? await options.resolveScopeFromRequest(upgradeReq)
              : undefined
            await attachNodeWsSession({
              manager: options.manager,
              socket: ws,
              scope: scope ?? undefined,
            })
          } catch (error) {
            options.onAttachError?.({ req: upgradeReq, ws, error })
            try { ws.close() } catch { /* best effort */ }
          }
        })()
      })
    })()
  }
}

/**
 * Best-practice matcher helper for upgrade paths.
 */
export function createPathUpgradeGuard(expectedPath: string): (req: IncomingMessage) => boolean {
  return (req: IncomingMessage) => {
    const rawUrl = req.url ?? '/'
    const parsed = new URL(rawUrl, 'http://localhost')
    return parsed.pathname === expectedPath
  }
}
