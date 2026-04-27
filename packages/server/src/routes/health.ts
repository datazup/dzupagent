/**
 * Health check routes.
 *
 * GET /api/health         — Liveness probe (always 200)
 * GET /api/health/ready   — Readiness probe (checks DB, providers, MCP)
 * GET /api/health/metrics — Metrics endpoint (JSON format)
 */
import { Hono } from 'hono'
import type { ForgeServerConfig } from '../composition/types.js'

const startTime = Date.now()

export function createHealthRoutes(config: ForgeServerConfig): Hono {
  const app = new Hono()

  // Liveness — always healthy if the process is running
  app.get('/', (c) => {
    return c.json({
      status: 'ok',
      version: '0.1.0',
      uptime: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    })
  })

  // Readiness — check all subsystems
  app.get('/ready', async (c) => {
    const checks: Record<string, { status: string; latencyMs?: number; metadata?: Record<string, unknown> }> = {}

    // Check run store
    const runStart = Date.now()
    try {
      await config.runStore.list({ limit: 1 })
      checks['runStore'] = { status: 'ok', latencyMs: Date.now() - runStart }
    } catch {
      checks['runStore'] = { status: 'error' }
    }

    // Check agent store
    const agentStart = Date.now()
    try {
      await config.agentStore.list({ limit: 1 })
      checks['agentStore'] = { status: 'ok', latencyMs: Date.now() - agentStart }
    } catch {
      checks['agentStore'] = { status: 'error' }
    }

    // Check model registry — include per-provider circuit breaker status
    const providerHealth = config.modelRegistry.getProviderHealth()
    const providerEntries = Object.entries(providerHealth) as Array<[string, { state: string; provider: string }]>
    const providerCount = providerEntries.length
    const healthyProviders = providerEntries.filter(([, p]) => p.state === 'closed').length

    checks['modelRegistry'] = {
      status: providerCount === 0
        ? 'unconfigured'
        : healthyProviders === providerCount
          ? 'ok'
          : healthyProviders > 0
            ? 'degraded'
            : 'error',
      metadata: {
        providers: providerHealth,
        total: providerCount,
        healthy: healthyProviders,
      },
    }

    // Check run queue if available
    if (config.runQueue) {
      const stats = config.runQueue.stats()
      checks['runQueue'] = {
        status: 'ok',
        metadata: {
          pending: stats.pending,
          active: stats.active,
          completed: stats.completed,
          failed: stats.failed,
        },
      }
    }

    // Check graceful shutdown state
    if (config.shutdown) {
      const state = config.shutdown.getState()
      checks['shutdown'] = {
        status: state === 'running' ? 'ok' : state === 'draining' ? 'degraded' : 'error',
        metadata: { state },
      }
    }

    // Determine overall status
    const storeHealthy = checks['runStore']?.status === 'ok' && checks['agentStore']?.status === 'ok'
    const hasError = Object.values(checks).some(c => c.status === 'error')
    const hasDegraded = Object.values(checks).some(c => c.status === 'degraded')

    const status = hasError ? 'error' : !storeHealthy ? 'degraded' : hasDegraded ? 'degraded' : 'ok'

    return c.json(
      {
        status,
        checks,
        uptime: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      },
      status === 'ok' ? 200 : 503,
    )
  })

  // Metrics — JSON format (can be scraped by Prometheus with adapter)
  app.get('/metrics', (c) => {
    const metrics = config.metrics?.toJSON() ?? []
    return c.json({
      metrics,
      timestamp: new Date().toISOString(),
    })
  })

  return app
}
