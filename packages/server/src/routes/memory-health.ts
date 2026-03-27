/**
 * Memory health routes — exposes retrieval provider health metrics.
 *
 * GET /api/memory/health — Returns provider health metrics from AdaptiveRetriever
 */
import { Hono } from 'hono'

/** Minimal interface matching AdaptiveRetriever.health() */
export interface HealthProvider {
  health(): Array<{
    source: string
    successCount: number
    failureCount: number
    totalLatencyMs: number
    avgLatencyMs: number
    successRate: number
    lastFailure?: { error: string; timestamp: Date }
  }>
}

export interface MemoryHealthRouteConfig {
  retriever: HealthProvider
}

export function createMemoryHealthRoutes(config: MemoryHealthRouteConfig): Hono {
  const app = new Hono()

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
