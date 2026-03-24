/**
 * Health check routes.
 *
 * GET /api/health       — Liveness probe (always 200)
 * GET /api/health/ready — Readiness probe (checks DB connectivity)
 */
import { Hono } from 'hono'
import type { ForgeServerConfig } from '../app.js'

export function createHealthRoutes(config: ForgeServerConfig): Hono {
  const app = new Hono()

  // Liveness — always healthy if the process is running
  app.get('/', (c) => {
    return c.json({
      status: 'ok',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    })
  })

  // Readiness — check that stores are accessible
  app.get('/ready', async (c) => {
    const checks: Record<string, { status: string; latencyMs?: number }> = {}

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

    // Check model registry
    checks['modelRegistry'] = {
      status: config.modelRegistry.isConfigured() ? 'ok' : 'unconfigured',
    }

    // Only stores must be healthy; model registry is informational
    const storeHealthy = checks['runStore']?.status === 'ok' && checks['agentStore']?.status === 'ok'

    return c.json(
      {
        status: storeHealthy ? 'ok' : 'degraded',
        checks,
        timestamp: new Date().toISOString(),
      },
      storeHealthy ? 200 : 503,
    )
  })

  return app
}
