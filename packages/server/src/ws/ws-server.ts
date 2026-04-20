/**
 * High-level WebSocket server factory that wires together:
 * - {@link EventBridge} (DzupEventBus -> WS fan-out)
 * - {@link WSClientScopeRegistry} (per-client scope storage)
 * - {@link WSSessionManager} (attach/detach lifecycle + control protocol)
 *
 * Consumers should prefer this helper over hand-rolled wiring. Once created,
 * call the returned `attach()` with a Node `http.Server` to hook the HTTP
 * `upgrade` event and route matching paths through the session manager.
 *
 * @example
 * ```ts
 * import http from 'node:http'
 * import { WebSocketServer } from 'ws'
 * import { createEventBus } from '@dzupagent/core'
 * import { createWsServer } from '@dzupagent/server'
 *
 * const eventBus = createEventBus()
 * const { manager, bridge, attach } = createWsServer({
 *   source: eventBus,
 *   session: { ... },
 *   server: { path: '/ws' },
 * })
 *
 * const httpServer = http.createServer()
 * attach(httpServer)
 * httpServer.listen(4000)
 * ```
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import type { DzupEventBus } from '@dzupagent/core'
import { EventBridge, type EventBridgeConfig } from './event-bridge.js'
import type { EventGateway } from '../events/event-gateway.js'
import { WSClientScopeRegistry } from './scope-registry.js'
import { WSSessionManager, type WSSessionManagerOptions } from './session-manager.js'
import type { WSClientScope } from './authorization.js'
import type { WSClient } from './event-bridge.js'
import {
  createNodeWsUpgradeHandler,
  createPathUpgradeGuard,
  type NodeWebSocketServerLike,
} from './node-upgrade-handler.js'

/**
 * Optional transport-level config for how the WS server binds to an HTTP upgrade
 * and constructs the underlying WebSocket server.
 */
export interface WSServerConfig {
  /**
   * WebSocket server instance (e.g. `new WebSocketServer({ noServer: true })`).
   * Required when `attach()` is used — the factory itself does not pull in the
   * `ws` package to keep the server package's peer surface minimal.
   */
  wss?: NodeWebSocketServerLike
  /**
   * Expected URL path for WebSocket upgrades. Requests with any other pathname
   * are rejected before the upgrade. Defaults to accepting all paths when
   * omitted.
   */
  path?: string
  /**
   * Resolve a {@link WSClientScope} from an incoming upgrade request
   * (e.g. from cookie/session/header). Falls back to
   * `session.resolveScope` if omitted.
   */
  resolveScopeFromRequest?: (
    req: IncomingMessage,
  ) => Promise<WSClientScope | null> | WSClientScope | null
  /**
   * Optional request-level guard called before upgrade. Returning `false`
   * rejects the upgrade. Composed with the path guard when both are given.
   */
  shouldHandleRequest?: (req: IncomingMessage) => boolean | Promise<boolean>
  /** Called when a request is rejected before upgrade. */
  onRejected?: (ctx: { req: IncomingMessage; reason: string }) => void
  /** Called when `attach()` fails after a successful upgrade. */
  onAttachError?: (ctx: { req: IncomingMessage; ws: WSClient; error: unknown }) => void
  /** Forwarded to {@link createNodeWsUpgradeHandler}. */
  destroySocketOnReject?: boolean
}

export interface CreateWsServerOptions {
  /**
   * Event source — a raw `DzupEventBus` or a pre-built `EventGateway`.
   * When a bus is passed, the bridge lazily builds an `InMemoryEventGateway`.
   */
  source: DzupEventBus | EventGateway
  /** Forwarded to the internally constructed {@link EventBridge}. */
  bridge?: EventBridgeConfig
  /**
   * Session-manager options. The same shape as `WSSessionManagerOptions`:
   * `authorize`, `resolveScope`, `compileHandler`, etc.
   */
  session?: WSSessionManagerOptions
  /**
   * Optional pre-built scope registry. Useful when callers want to share
   * the same registry across multiple endpoints. A fresh registry is
   * created when omitted.
   */
  scopeRegistry?: WSClientScopeRegistry
  /** Transport-level config — only needed when you plan to call `attach()`. */
  server?: WSServerConfig
}

/**
 * Return type of {@link createWsServer}. Exposes the underlying primitives
 * for advanced composition plus a convenience `attach()` that hooks the
 * Node `http.Server` upgrade pipeline.
 */
export interface WsServerHandle {
  /** The WS session manager (call `attach`/`detach` directly if needed). */
  readonly manager: WSSessionManager
  /** The event bridge — read `clientCount` or `destroy()` for shutdown. */
  readonly bridge: EventBridge
  /** Scope registry shared with the session manager. */
  readonly scopeRegistry: WSClientScopeRegistry
  /**
   * Hook an `http.Server` `upgrade` event. Requires `server.wss` to be set.
   * Returns a disposer that removes the upgrade listener.
   */
  attach(httpServer: HttpServer): () => void
  /** Tear down the bridge and close all connections. */
  close(): void
}

function composeGuards(
  first?: (req: IncomingMessage) => boolean | Promise<boolean>,
  second?: (req: IncomingMessage) => boolean | Promise<boolean>,
): ((req: IncomingMessage) => Promise<boolean>) | undefined {
  if (!first && !second) return undefined
  return async (req: IncomingMessage) => {
    if (first && !(await first(req))) return false
    if (second && !(await second(req))) return false
    return true
  }
}

/**
 * Higher-level wiring helper. See module docs.
 */
export function createWsServer(options: CreateWsServerOptions): WsServerHandle {
  const bridge = new EventBridge(options.source, options.bridge)
  const scopeRegistry = options.scopeRegistry ?? new WSClientScopeRegistry()
  const manager = new WSSessionManager(bridge, scopeRegistry, options.session)

  const attach = (httpServer: HttpServer): (() => void) => {
    const serverConfig = options.server
    if (!serverConfig?.wss) {
      throw new Error(
        '[createWsServer] `server.wss` is required to call attach(). Pass a `new WebSocketServer({ noServer: true })` instance.',
      )
    }

    const pathGuard = serverConfig.path ? createPathUpgradeGuard(serverConfig.path) : undefined
    const composedGuard = composeGuards(pathGuard, serverConfig.shouldHandleRequest)

    const handler = createNodeWsUpgradeHandler({
      wss: serverConfig.wss,
      manager,
      resolveScopeFromRequest: serverConfig.resolveScopeFromRequest,
      shouldHandleRequest: composedGuard,
      onRejected: serverConfig.onRejected,
      onAttachError: serverConfig.onAttachError,
      destroySocketOnReject: serverConfig.destroySocketOnReject,
    })

    const listener = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
      handler(req, socket, head)
    }
    httpServer.on('upgrade', listener)

    return () => {
      httpServer.off('upgrade', listener)
    }
  }

  const close = (): void => {
    bridge.destroy()
  }

  return { manager, bridge, scopeRegistry, attach, close }
}
