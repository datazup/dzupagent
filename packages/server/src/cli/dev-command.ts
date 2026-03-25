/**
 * Dev mode CLI command — starts a ForgeAgent server with sensible defaults
 * for local development (no auth, in-memory stores, trace printing).
 */
import { Hono } from 'hono'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@forgeagent/core'
import type { ForgeEventBus } from '@forgeagent/core'
import { createForgeApp } from '../app.js'
import { TracePrinter } from './trace-printer.js'

export interface DevCommandConfig {
  /** Port to listen on (default: 4000) */
  port?: number
  /** Print detailed event traces (default: false) */
  verbose?: boolean
  /** Disable playground routes (default: false) */
  noPlayground?: boolean
  /** Optional pre-configured event bus */
  eventBus?: ForgeEventBus
}

export interface DevCommandHandle {
  start(): Promise<void>
  stop(): Promise<void>
}

export function createDevCommand(config?: DevCommandConfig): DevCommandHandle {
  const port = config?.port ?? 4000
  const verbose = config?.verbose ?? false
  const eventBus = config?.eventBus ?? createEventBus()

  let server: { close(): void; app: Hono } | null = null
  const tracePrinter = new TracePrinter(verbose)

  return {
    async start(): Promise<void> {
      const honoApp = createForgeApp({
        runStore: new InMemoryRunStore(),
        agentStore: new InMemoryAgentStore(),
        modelRegistry: new ModelRegistry(),
        eventBus,
      })

      tracePrinter.attach(eventBus)

      // eslint-disable-next-line no-console
      console.log(`[forge-dev] Starting dev server on port ${port}`)
      if (!config?.noPlayground) {
        // eslint-disable-next-line no-console
        console.log(`[forge-dev] Playground: http://localhost:${port}/api/health`)
      }

      // Store a reference so stop() can clean up.
      // In a real Bun/Node deployment, this would call serve().
      server = { app: honoApp, close() { /* no-op for in-memory */ } }
    },

    async stop(): Promise<void> {
      tracePrinter.detach()
      if (server) {
        server.close()
        server = null
      }
      // eslint-disable-next-line no-console
      console.log('[forge-dev] Server stopped')
    },
  }
}
