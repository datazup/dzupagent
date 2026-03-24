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
import type { MetricsCollector } from '@forgeagent/core'
import { createHealthRoutes } from './routes/health.js'
import { createRunRoutes } from './routes/runs.js'
import { createAgentRoutes } from './routes/agents.js'
import { createApprovalRoutes } from './routes/approval.js'
import { authMiddleware, type AuthConfig } from './middleware/auth.js'
import { rateLimiterMiddleware, type RateLimiterConfig } from './middleware/rate-limiter.js'
import type { RunQueue } from './queue/run-queue.js'
import type { GracefulShutdown } from './lifecycle/graceful-shutdown.js'

export interface ForgeServerConfig {
  runStore: RunStore
  agentStore: AgentStore
  eventBus: ForgeEventBus
  modelRegistry: ModelRegistry
  auth?: AuthConfig
  corsOrigins?: string | string[]
  /** Rate limiting configuration (disabled if not provided) */
  rateLimit?: Partial<RateLimiterConfig>
  /** Background run queue (in-memory queue used if not provided) */
  runQueue?: RunQueue
  /** Graceful shutdown handler */
  shutdown?: GracefulShutdown
  /** Metrics collector for observability */
  metrics?: MetricsCollector
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

  if (config.rateLimit) {
    app.use('/api/*', rateLimiterMiddleware(config.rateLimit))
  }

  // --- Shutdown guard: reject new runs when draining ---
  if (config.shutdown) {
    app.use('/api/runs', async (c, next) => {
      if (c.req.method === 'POST' && !config.shutdown!.isAcceptingRuns()) {
        return c.json(
          { error: { code: 'SERVICE_UNAVAILABLE', message: 'Server is shutting down' } },
          503,
        )
      }
      return next()
    })
  }

  // --- Request metrics ---
  if (config.metrics) {
    app.use('*', async (c, next) => {
      const start = Date.now()
      await next()
      const latency = Date.now() - start
      config.metrics!.increment('http_requests_total', {
        method: c.req.method,
        path: c.req.path,
        status: String(c.res.status),
      })
      config.metrics!.observe('http_request_duration_ms', latency, {
        method: c.req.method,
        path: c.req.path,
      })
    })
  }

  // --- Global error handler ---
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err)
    // eslint-disable-next-line no-console
    console.error(`[ForgeServer] ${c.req.method} ${c.req.path}: ${message}`)
    config.metrics?.increment('http_errors_total', { path: c.req.path })
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
