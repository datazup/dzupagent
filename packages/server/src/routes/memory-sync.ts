/**
 * Memory CRDT sync WebSocket route.
 *
 * Exposes a WebSocket endpoint at `/api/memory/sync` that accepts
 * incoming connections from remote nodes and runs the CRDT sync protocol
 * using `SyncSession` from `@dzupagent/memory`.
 *
 * The route itself is a plain Hono route that returns connection instructions;
 * actual WebSocket upgrade is handled by the server's WebSocket adapter
 * (see `createMemorySyncHandler`).
 */
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { secureLogger } from '@dzupagent/core/utils'
import type { AppEnv } from '../types.js'
import type {
  SharedMemoryNamespace,
  SyncSession,
  SyncConfig,
  SyncEvent,
  SyncTransport,
  SyncMessage,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MemorySyncRouteConfig {
  /** Shared namespaces available for sync. */
  namespaces: Map<string, SharedMemoryNamespace>
  /** Node identifier for this server. */
  nodeId: string
  /** Allowed namespace names for sync (empty = all). */
  allowedNamespaces?: string[]
  /** Anti-entropy interval in ms (default: 30000). */
  antiEntropyIntervalMs?: number
  /** Max entries per delta batch (default: 100). */
  maxBatchSize?: number
  /** Optional event handler for sync events. */
  onSyncEvent?: (event: SyncEvent) => void
}

// ---------------------------------------------------------------------------
// WebSocket sync handler (for use with ws/node upgrade handlers)
// ---------------------------------------------------------------------------

/**
 * Create a handler that manages a single WebSocket connection for CRDT sync.
 *
 * This function is called per-connection from the WebSocket upgrade handler.
 * It wraps the raw WebSocket in a `SyncTransport` and starts a `SyncSession`.
 *
 * @returns An object with `onMessage`, `onClose` callbacks to wire into the WS server.
 */
export function createMemorySyncHandler(
  config: MemorySyncRouteConfig,
  createSession: (
    syncConfig: SyncConfig,
    namespaces: Map<string, SharedMemoryNamespace>,
  ) => SyncSession,
): {
  handleConnection: (ws: SyncWebSocket) => SyncConnectionHandle
} {
  return {
    handleConnection(ws: SyncWebSocket): SyncConnectionHandle {
      const handlers: Array<(msg: SyncMessage) => void> = []

      const transport: SyncTransport = {
        async send(message: SyncMessage): Promise<void> {
          if (ws.readyState === 1 /* OPEN */) {
            ws.send(JSON.stringify(message))
          }
        },
        onMessage(handler: (message: SyncMessage) => void): void {
          handlers.push(handler)
        },
        async close(): Promise<void> {
          ws.close()
        },
      }

      const syncConfig: SyncConfig = {
        nodeId: config.nodeId,
        namespaces: config.allowedNamespaces,
        antiEntropyIntervalMs: config.antiEntropyIntervalMs ?? 30_000,
        maxBatchSize: config.maxBatchSize ?? 100,
      }

      const session = createSession(syncConfig, config.namespaces)

      if (config.onSyncEvent) {
        session.onEvent(config.onSyncEvent)
      }

      // Per-connection id so a session that never connected can be told
      // apart from an idle one in the logs.
      const connectionId = randomUUID()
      const logFailure = (operation: string, message: string, error?: unknown): void => {
        secureLogger.warn({
          level: 'warn',
          operation,
          message,
          connectionId,
          nodeId: config.nodeId,
          ...(error !== undefined
            ? { errorName: error instanceof Error ? error.name : typeof error }
            : {}),
        })
      }

      // Wire WS messages to transport handlers. Malformed frames are dropped
      // and counted; the first one per connection is logged so a misbehaving
      // peer is visible without one log line per frame.
      let malformedFrames = 0
      const onMessage = (data: string): void => {
        let message: SyncMessage
        try {
          message = JSON.parse(data) as SyncMessage
        } catch (error) {
          malformedFrames += 1
          if (malformedFrames === 1) {
            logFailure('memory-sync.frame', 'dropped malformed sync frame', error)
          }
          return
        }
        for (const handler of handlers) {
          handler(message)
        }
      }

      const onClose = (): void => {
        session.disconnect().catch((error: unknown) => {
          // Non-fatal, but a failed disconnect must be visible.
          logFailure('memory-sync.disconnect', 'sync session disconnect failed', error)
        })
      }

      // Start session
      session.connect(transport).catch((error: unknown) => {
        // Non-fatal — the session also emits its own error event.
        logFailure('memory-sync.connect', 'sync session connect failed', error)
      })

      return {
        onMessage,
        onClose,
        session,
        get malformedFrames() {
          return malformedFrames
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// REST info route (tells clients where to connect for WS sync)
// ---------------------------------------------------------------------------

export function createMemorySyncRoutes(config: MemorySyncRouteConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/api/memory/sync', (c) => {
    const namespaceNames = config.allowedNamespaces ?? Array.from(config.namespaces.keys())
    return c.json({
      protocol: 'dzupagent-crdt-sync',
      version: '1.0.0',
      nodeId: config.nodeId,
      namespaces: namespaceNames,
      websocket: '/api/memory/sync/ws',
      antiEntropyIntervalMs: config.antiEntropyIntervalMs ?? 30_000,
    })
  })

  return app
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal WebSocket interface for sync connections. */
export interface SyncWebSocket {
  send(data: string): void
  close(): void
  readyState: number
}

/** Handle returned for each sync connection. */
export interface SyncConnectionHandle {
  onMessage: (data: string) => void
  onClose: () => void
  session: SyncSession
  /** Frames dropped on this connection because they were not valid JSON. */
  readonly malformedFrames: number
}
