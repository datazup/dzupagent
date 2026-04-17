import { describe, it, expect, vi, afterEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
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

describe('App-level error handling', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('global error handler returns 500 with generic message', async () => {
    const config = createTestConfig()
    const app = createForgeApp(config)

    // Force an error by making agentStore.get throw
    vi.spyOn(config.agentStore, 'get').mockRejectedValue(new Error('unexpected DB error'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await app.request('/api/agents/some-id')
    expect(res.status).toBe(500)
    const data = await res.json() as { error: { code: string; message: string } }
    expect(data.error.code).toBe('INTERNAL_ERROR')
    expect(data.error.message).toBe('Internal server error')
  })

  it('global error handler logs the error', async () => {
    const config = createTestConfig()
    const app = createForgeApp(config)

    vi.spyOn(config.agentStore, 'get').mockRejectedValue(new Error('DB exploded'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await app.request('/api/agents/some-id')

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('DB exploded'),
    )
  })

  it('global error handler increments error metric when metrics configured', async () => {
    const mockMetrics = {
      increment: vi.fn(),
      observe: vi.fn(),
      gauge: vi.fn(),
      toJSON: vi.fn(() => []),
    }

    const config = createTestConfig({ metrics: mockMetrics as unknown as ForgeServerConfig['metrics'] })
    const app = createForgeApp(config)

    vi.spyOn(config.agentStore, 'get').mockRejectedValue(new Error('fail'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await app.request('/api/agents/some-id')

    expect(mockMetrics.increment).toHaveBeenCalledWith(
      'http_errors_total',
      expect.objectContaining({ path: '/api/agents/some-id' }),
    )
  })
})

describe('Shutdown guard middleware', () => {
  it('rejects new runs with 503 when server is draining', async () => {
    const mockShutdown = {
      getState: () => 'draining' as const,
      isAcceptingRuns: () => false,
      config: {},
    }

    const config = createTestConfig({ shutdown: mockShutdown as ForgeServerConfig['shutdown'] })
    await config.agentStore.save({ id: 'a1', name: 'A', instructions: 'i', modelTier: 'chat' })

    const app = createForgeApp(config)

    const res = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'a1', input: 'test' }),
    })
    expect(res.status).toBe(503)
    const data = await res.json() as { error: { code: string } }
    expect(data.error.code).toBe('SERVICE_UNAVAILABLE')
  })

  it('allows GET requests during shutdown', async () => {
    const mockShutdown = {
      getState: () => 'draining' as const,
      isAcceptingRuns: () => false,
      config: {},
    }

    const config = createTestConfig({ shutdown: mockShutdown as ForgeServerConfig['shutdown'] })
    const app = createForgeApp(config)

    const res = await app.request('/api/runs')
    expect(res.status).toBe(200)
  })
})

describe('Request metrics middleware', () => {
  it('records http_requests_total and http_request_duration_ms', async () => {
    const mockMetrics = {
      increment: vi.fn(),
      observe: vi.fn(),
      gauge: vi.fn(),
      toJSON: vi.fn(() => []),
    }

    const config = createTestConfig({ metrics: mockMetrics as unknown as ForgeServerConfig['metrics'] })
    const app = createForgeApp(config)

    await app.request('/api/health')

    expect(mockMetrics.increment).toHaveBeenCalledWith(
      'http_requests_total',
      expect.objectContaining({
        method: 'GET',
        path: '/api/health',
        status: '200',
      }),
    )
    expect(mockMetrics.observe).toHaveBeenCalledWith(
      'http_request_duration_ms',
      expect.any(Number),
      expect.objectContaining({ method: 'GET', path: '/api/health' }),
    )
  })
})

describe('Auth + rate limit integration', () => {
  it('blocks unauthenticated requests when auth is configured', async () => {
    const config = createTestConfig({
      auth: {
        mode: 'api-key',
        validateKey: async (key) => (key === 'valid' ? { id: 'k1' } : null),
      },
    })
    const app = createForgeApp(config)

    const res = await app.request('/api/agents')
    expect(res.status).toBe(401)
  })

  it('allows authenticated requests when auth is configured', async () => {
    const config = createTestConfig({
      auth: {
        mode: 'api-key',
        validateKey: async (key) => (key === 'valid' ? { id: 'k1' } : null),
      },
    })
    const app = createForgeApp(config)

    const res = await app.request('/api/agents', {
      headers: { Authorization: 'Bearer valid' },
    })
    expect(res.status).toBe(200)
  })
})
