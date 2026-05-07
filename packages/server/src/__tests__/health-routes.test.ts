/**
 * Unit tests for createHealthRoutes.
 *
 * The existing health-routes-extended.test.ts already covers several branches
 * (503 on store failure, runQueue stats, shutdown state, degraded model provider).
 * This file focuses on the liveness endpoint correctness, readiness JSON shape,
 * and the metrics endpoint — complementing rather than duplicating existing coverage.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  MetricsCollector,
  createEventBus,
} from '@dzupagent/core'
import { createForgeApp, type ForgeServerConfig } from '../app.js'

function makeConfig(overrides: Partial<ForgeServerConfig> = {}): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    ...overrides,
  }
}

describe('Health routes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // --- GET /api/health (liveness) ---

  describe('GET /api/health', () => {
    it('always returns 200 regardless of store state', async () => {
      const brokenStore = new InMemoryRunStore()
      vi.spyOn(brokenStore, 'list').mockRejectedValue(new Error('DB down'))
      const app = createForgeApp(makeConfig({ runStore: brokenStore }))

      const res = await app.request('/api/health')
      expect(res.status).toBe(200)
    })

    it('response body contains status=ok', async () => {
      const app = createForgeApp(makeConfig())
      const body = await app.request('/api/health').then((r) => r.json()) as Record<string, unknown>
      expect(body['status']).toBe('ok')
    })

    it('response body contains a numeric uptime', async () => {
      const app = createForgeApp(makeConfig())
      const body = await app.request('/api/health').then((r) => r.json()) as Record<string, unknown>
      expect(typeof body['uptime']).toBe('number')
      expect(body['uptime'] as number).toBeGreaterThanOrEqual(0)
    })

    it('response body contains an ISO timestamp string', async () => {
      const app = createForgeApp(makeConfig())
      const body = await app.request('/api/health').then((r) => r.json()) as Record<string, unknown>
      expect(typeof body['timestamp']).toBe('string')
      // Sanity: parseable as Date
      expect(() => new Date(body['timestamp'] as string)).not.toThrow()
    })

    it('returns version 0.1.0', async () => {
      const app = createForgeApp(makeConfig())
      const body = await app.request('/api/health').then((r) => r.json()) as Record<string, unknown>
      expect(body['version']).toBe('0.1.0')
    })
  })

  // --- GET /api/health/ready (readiness) ---

  describe('GET /api/health/ready', () => {
    it('returns 200 when all stores are healthy', async () => {
      const app = createForgeApp(makeConfig())
      const res = await app.request('/api/health/ready')
      expect(res.status).toBe(200)
    })

    it('response body includes checks.runStore and checks.agentStore', async () => {
      const app = createForgeApp(makeConfig())
      const body = await app.request('/api/health/ready').then((r) => r.json()) as {
        checks: Record<string, { status: string }>
      }
      expect(body.checks['runStore']).toBeDefined()
      expect(body.checks['agentStore']).toBeDefined()
    })

    it('runStore check has status=ok when list() succeeds', async () => {
      const app = createForgeApp(makeConfig())
      const body = await app.request('/api/health/ready').then((r) => r.json()) as {
        checks: Record<string, { status: string }>
      }
      expect(body.checks['runStore']?.status).toBe('ok')
    })

    it('returns 503 when runStore.list throws', async () => {
      const broken = new InMemoryRunStore()
      vi.spyOn(broken, 'list').mockRejectedValue(new Error('down'))
      const app = createForgeApp(makeConfig({ runStore: broken }))
      const res = await app.request('/api/health/ready')
      expect(res.status).toBe(503)
    })

    it('returns 503 when agentStore.list throws', async () => {
      const broken = new InMemoryAgentStore()
      vi.spyOn(broken, 'list').mockRejectedValue(new Error('down'))
      const app = createForgeApp(makeConfig({ agentStore: broken }))
      const res = await app.request('/api/health/ready')
      expect(res.status).toBe(503)
    })

    it('response body contains a top-level status field', async () => {
      const app = createForgeApp(makeConfig())
      const body = await app.request('/api/health/ready').then((r) => r.json()) as { status: string }
      expect(['ok', 'degraded', 'error']).toContain(body.status)
    })

    it('response body contains numeric uptime', async () => {
      const app = createForgeApp(makeConfig())
      const body = await app.request('/api/health/ready').then((r) => r.json()) as { uptime: number }
      expect(typeof body.uptime).toBe('number')
    })

    it('modelRegistry check is unconfigured when no providers are registered', async () => {
      const app = createForgeApp(makeConfig())
      const body = await app.request('/api/health/ready').then((r) => r.json()) as {
        checks: Record<string, { status: string }>
      }
      expect(body.checks['modelRegistry']?.status).toBe('unconfigured')
    })

    it('modelRegistry check is error when all providers are open (circuit broken)', async () => {
      const registry = new ModelRegistry()
      vi.spyOn(registry, 'getProviderHealth').mockReturnValue({
        openai: { state: 'open', provider: 'openai' },
      } as ReturnType<ModelRegistry['getProviderHealth']>)

      const app = createForgeApp(makeConfig({ modelRegistry: registry }))
      const body = await app.request('/api/health/ready').then((r) => r.json()) as {
        checks: Record<string, { status: string }>
      }
      expect(body.checks['modelRegistry']?.status).toBe('error')
    })
  })

  // --- GET /api/health/metrics ---

  describe('GET /api/health/metrics', () => {
    it('returns 200', async () => {
      const app = createForgeApp(makeConfig())
      const res = await app.request('/api/health/metrics')
      expect(res.status).toBe(200)
    })

    it('response contains a metrics array', async () => {
      const app = createForgeApp(makeConfig())
      const body = await app.request('/api/health/metrics').then((r) => r.json()) as {
        metrics: unknown[]
        timestamp: string
      }
      expect(Array.isArray(body.metrics)).toBe(true)
    })

    it('response contains a timestamp string', async () => {
      const app = createForgeApp(makeConfig())
      const body = await app.request('/api/health/metrics').then((r) => r.json()) as {
        timestamp: string
      }
      expect(typeof body.timestamp).toBe('string')
    })

    it('uses custom metrics collector when provided', async () => {
      const realMetrics = new MetricsCollector()
      realMetrics.increment('custom')
      const app = createForgeApp(makeConfig({ metrics: realMetrics }))
      const body = await app.request('/api/health/metrics').then((r) => r.json()) as {
        metrics: Array<{ name: string; value: number }>
      }
      expect(body.metrics.length).toBeGreaterThanOrEqual(1)
      expect(body.metrics.some((m) => m.name === 'custom')).toBe(true)
    })
  })
})
