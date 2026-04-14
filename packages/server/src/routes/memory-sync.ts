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
import { Hono } from 'hono'
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

      // Wire WS messages to transport handlers
      const onMessage = (data: string): void => {
        try {
          const message = JSON.parse(data) as SyncMessage
          for (const handler of handlers) {
            handler(message)
          }
        } catch {
          // Malformed message — ignore
        }
      }

      const onClose = (): void => {
        session.disconnect().catch(() => {
          // Non-fatal
        })
      }

      // Start session
      session.connect(transport).catch(() => {
        // Non-fatal — session will emit error event
      })

      return { onMessage, onClose, session }
    },
  }
}

// ---------------------------------------------------------------------------
// REST info route (tells clients where to connect for WS sync)
// ---------------------------------------------------------------------------

export function createMemorySyncRoutes(config: MemorySyncRouteConfig): Hono {
  const app = new Hono()

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
}
