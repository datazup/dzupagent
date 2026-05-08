/**
 * Memory health routes — exposes retrieval provider health metrics.
 *
 * GET /api/memory/health — Returns provider health metrics from AdaptiveRetriever
 */
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import type { MemoryHealthRouteConfig } from './memory-health-types.js'

export type { HealthProvider, MemoryHealthRouteConfig } from './memory-health-types.js'

export function createMemoryHealthRoutes(config: MemoryHealthRouteConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // GET /health — Return provider health metrics
  app.get('/health', (c) => {
    const metrics = config.retriever.health()
    const overall = metrics.length > 0
      ? metrics.reduce((sum, m) => sum + m.successRate, 0) / metrics.length
      : 1

    return c.json({
      data: {
        status: overall >= 0.5 ? 'healthy' : 'degraded',
        overallSuccessRate: Math.round(overall * 100) / 100,
        providers: metrics.map(m => ({
          ...m,
          lastFailure: m.lastFailure
            ? { error: m.lastFailure.error, timestamp: m.lastFailure.timestamp.toISOString() }
            : null,
        })),
      },
    })
  })

  return app
}
