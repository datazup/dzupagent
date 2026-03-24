/**
 * Hono app factory for ForgeAgent server.
 *
 * Creates a configured Hono application with REST API routes, middleware,
 * and optional WebSocket support.
 *
 * @example
 * ```ts
 * import { createForgeApp } from '@forgeagent/server'
 *
 * const app = createForgeApp({
 *   eventBus: createEventBus(),
 *   modelRegistry: registry,
 *   runStore: new InMemoryRunStore(),
 *   agentStore: new InMemoryAgentStore(),
 * })
 *
 * export default { port: 4000, fetch: app.fetch }
 * ```
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { RunStore, AgentStore, ModelRegistry } from '@forgeagent/core'
import type { ForgeEventBus } from '@forgeagent/core'
import { createHealthRoutes } from './routes/health.js'
import { createRunRoutes } from './routes/runs.js'
import { createAgentRoutes } from './routes/agents.js'
import { createApprovalRoutes } from './routes/approval.js'
import { authMiddleware, type AuthConfig } from './middleware/auth.js'

export interface ForgeServerConfig {
  runStore: RunStore
  agentStore: AgentStore
  eventBus: ForgeEventBus
  modelRegistry: ModelRegistry
  auth?: AuthConfig
  corsOrigins?: string | string[]
}

export function createForgeApp(config: ForgeServerConfig): Hono {
  const app = new Hono()

  // --- Middleware ---
  app.use('*', cors({
    origin: config.corsOrigins ?? '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }))

  if (config.auth) {
    app.use('/api/*', authMiddleware(config.auth))
  }

  // --- Global error handler ---
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err)
    // eslint-disable-next-line no-console
    console.error(`[ForgeServer] ${c.req.method} ${c.req.path}: ${message}`)
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      500,
    )
  })

  // --- Routes ---
  app.route('/api/health', createHealthRoutes(config))
  app.route('/api/runs', createRunRoutes(config))
  app.route('/api/agents', createAgentRoutes(config))
  app.route('/api/runs', createApprovalRoutes(config))

  return app
}
