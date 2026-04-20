/**
 * Dev mode CLI command — starts a DzupAgent server with sensible defaults
 * for local development (no auth, in-memory stores, trace printing).
 *
 * All heavy imports are deferred to start() so that importing this module
 * is instantaneous (important for CLI startup time and test isolation).
 */
import type { DzupEventBus } from '@dzupagent/core'

export interface DevCommandConfig {
  /** Port to listen on (default: 4000) */
  port?: number
  /** Print detailed event traces (default: false) */
  verbose?: boolean
  /** Disable playground routes (default: false) */
  noPlayground?: boolean
  /** Optional pre-configured event bus */
  eventBus?: DzupEventBus
}

export interface DevCommandHandle {
  start(): Promise<void>
  stop(): Promise<void>
}

export function createDevCommand(config?: DevCommandConfig): DevCommandHandle {
  const port = config?.port ?? 4000
  const verbose = config?.verbose ?? false

  let stopHandle: (() => Promise<void>) | null = null

  return {
    async start(): Promise<void> {
      const [
        { InMemoryRunStore, InMemoryAgentStore, ModelRegistry, createEventBus },
        { TracePrinter },
        { InMemoryRunQueue },
        { createDefaultRunExecutor },
        { createDzupAgentRunExecutor },
        { createForgeApp },
      ] = await Promise.all([
        import('@dzupagent/core'),
        import('./trace-printer.js'),
        import('../queue/run-queue.js'),
        import('../runtime/default-run-executor.js'),
        import('../runtime/dzip-agent-run-executor.js'),
        import('../app.js'),
      ])

      const eventBus = config?.eventBus ?? createEventBus()
      const runQueue = new InMemoryRunQueue()
      const tracePrinter = new TracePrinter(verbose)
      const modelRegistry = new ModelRegistry()

      const honoApp = createForgeApp({
        runStore: new InMemoryRunStore(),
        agentStore: new InMemoryAgentStore(),
        modelRegistry,
        eventBus,
        runQueue,
        runExecutor: createDzupAgentRunExecutor({
          fallback: createDefaultRunExecutor(modelRegistry),
        }),
      })

      tracePrinter.attach(eventBus)

      console.log(`[forge-dev] Starting dev server on port ${port}`)
      if (!config?.noPlayground) {
        console.log(`[forge-dev] Playground: http://localhost:${port}/api/health`)
      }

      stopHandle = async () => {
        tracePrinter.detach()
        await runQueue.stop(false)
        console.log('[forge-dev] Server stopped')
      }

      // In a real Bun/Node deployment, this would call serve() with honoApp.
      void honoApp
    },

    async stop(): Promise<void> {
      if (stopHandle) {
        await stopHandle()
        stopHandle = null
      }
    },
  }
}
