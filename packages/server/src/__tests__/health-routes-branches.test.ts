/**
 * Branch coverage tests for health routes.
 *
 * Covers: all provider health transitions (ok, degraded, error, unconfigured),
 * shutdown state branches (draining, shutdown), provider health combinations,
 * metrics route with/without collector.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
  MetricsCollector,
} from '@dzupagent/core'

function createTestConfig(overrides?: Partial<ForgeServerConfig>): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    ...overrides,
  }
}

describe('health routes branch coverage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('modelRegistry status "error" when all providers are open', async () => {
    const registry = new ModelRegistry()
    vi.spyOn(registry, 'getProviderHealth').mockReturnValue({
      openai: { state: 'open', provider: 'openai' },
      anthropic: { state: 'open', provider: 'anthropic' },
    } as ReturnType<ModelRegistry['getProviderHealth']>)

    const app = createForgeApp(createTestConfig({ modelRegistry: registry }))
    const res = await app.request('/api/health/ready')
    const data = await res.json() as { status: string; checks: Record<string, { status: string }> }
    expect(data.checks['modelRegistry']?.status).toBe('error')
    expect(data.status).toBe('error')
    expect(res.status).toBe(503)
  })

  it('modelRegistry status "unconfigured" when no providers', async () => {
    const registry = new ModelRegistry()
    vi.spyOn(registry, 'getProviderHealth').mockReturnValue({})

    const app = createForgeApp(createTestConfig({ modelRegistry: registry }))
    const res = await app.request('/api/health/ready')
    const data = await res.json() as { checks: Record<string, { status: string; metadata?: Record<string, unknown> }> }
    expect(data.checks['modelRegistry']?.status).toBe('unconfigured')
    expect(data.checks['modelRegistry']?.metadata?.['total']).toBe(0)
  })

  it('modelRegistry status "ok" when every provider is closed', async () => {
    const registry = new ModelRegistry()
    vi.spyOn(registry, 'getProviderHealth').mockReturnValue({
      openai: { state: 'closed', provider: 'openai' },
      anthropic: { state: 'closed', provider: 'anthropic' },
    } as ReturnType<ModelRegistry['getProviderHealth']>)

    const app = createForgeApp(createTestConfig({ modelRegistry: registry }))
    const res = await app.request('/api/health/ready')
    const data = await res.json() as { status: string; checks: Record<string, { status: string }> }
    expect(data.checks['modelRegistry']?.status).toBe('ok')
  })

  it('shutdown state "draining" produces degraded check', async () => {
    const mockShutdown = {
      getState: () => 'draining' as const,
      isAcceptingRuns: () => false,
      config: {},
    }

    const app = createForgeApp(createTestConfig({
      shutdown: mockShutdown as ForgeServerConfig['shutdown'],
    }))
    const res = await app.request('/api/health/ready')
    const data = await res.json() as { status: string; checks: Record<string, { status: string }> }
    expect(data.checks['shutdown']?.status).toBe('degraded')
    expect(data.status).toBe('degraded')
    expect(res.status).toBe(503)
  })

  it('shutdown state "stopped" produces error check', async () => {
    const mockShutdown = {
      getState: () => 'stopped' as const,
      isAcceptingRuns: () => false,
      config: {},
    }

    const app = createForgeApp(createTestConfig({
      shutdown: mockShutdown as ForgeServerConfig['shutdown'],
    }))
    const res = await app.request('/api/health/ready')
    const data = await res.json() as { checks: Record<string, { status: string }> }
    expect(data.checks['shutdown']?.status).toBe('error')
  })

  it('GET /api/health/metrics returns empty array when no collector', async () => {
    const app = createForgeApp(createTestConfig())
    const res = await app.request('/api/health/metrics')
    const data = await res.json() as { metrics: unknown[] }
    expect(data.metrics).toEqual([])
  })

  it('GET /api/health/metrics includes provided metrics', async () => {
    const collector = new MetricsCollector()
    collector.increment('test_counter')

    const app = createForgeApp(createTestConfig({ metrics: collector }))
    const res = await app.request('/api/health/metrics')
    const data = await res.json() as { metrics: Array<{ name: string }> }
    expect(data.metrics.length).toBeGreaterThan(0)
    expect(data.metrics.some(m => m.name === 'test_counter')).toBe(true)
  })
})
