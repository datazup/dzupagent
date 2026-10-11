import { describe, it, expect, vi, afterEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import { InMemoryClusterStore } from '../persistence/drizzle-cluster-store.js'
import { ClientSafeError } from '../routes/route-error.js'

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

    const res = await app.request('/api/agent-definitions/some-id')
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

    await app.request('/api/agent-definitions/some-id')

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

    await app.request('/api/agent-definitions/some-id')

    expect(mockMetrics.increment).toHaveBeenCalledWith(
      'http_errors_total',
      expect.objectContaining({ path: '/api/agent-definitions/some-id' }),
    )
  })
})

describe('Route error message disclosure (DZUPAGENT-ERR-H-03)', () => {
  const MARKER = 'duplicate key value violates "clusters_pkey" SECRET-MARKER-c0de'

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function clusterApp(createError: Error) {
    const clusterStore = new InMemoryClusterStore()
    vi.spyOn(clusterStore, 'create').mockRejectedValue(createError)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    return createForgeApp(createTestConfig({ clusterStore }))
  }

  async function postCluster(app: ReturnType<typeof createForgeApp>) {
    const res = await app.request('/api/clusters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceType: 'sandboxed' }),
    })
    const raw = await res.text()
    return { status: res.status, raw, body: JSON.parse(raw) as { error: { code: string; message: string } } }
  }

  it('keeps a Conflict-prefixed internal message out of the HTTP response', async () => {
    const consoleError = vi.spyOn(console, 'error')
    const app = clusterApp(new Error(`Conflict: ${MARKER}`))

    const res = await postCluster(app)

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT')
    expect(res.body.error.message).toBe('Resource conflict')
    expect(res.raw).not.toContain('SECRET-MARKER')
    // The internal diagnostic is still logged server-side.
    expect(consoleError.mock.calls.some(call => String(call[0]).includes('SECRET-MARKER'))).toBe(true)
  })

  it('keeps a Conflict* subclass message out of the HTTP response', async () => {
    class ConflictDriverError extends Error {}
    const app = clusterApp(new ConflictDriverError(MARKER))

    const res = await postCluster(app)

    expect(res.status).toBe(409)
    expect(res.raw).not.toContain('SECRET-MARKER')
  })

  it('returns the authored public message of a ClientSafeError', async () => {
    const app = clusterApp(
      new ClientSafeError('Cluster "c1" already exists', {
        code: 'CLUSTER_CONFLICT',
        internalMessage: MARKER,
      }),
    )

    const res = await postCluster(app)

    expect(res.status).toBe(409)
    expect(res.body.error.message).toBe('Cluster "c1" already exists')
    expect(res.raw).not.toContain('SECRET-MARKER')
  })
})

describe('Shutdown guard middleware', () => {
  it('rejects new runs with 503 when server is draining', async () => {
    const mockShutdown = {
      getState: () => 'draining' as const,
      isAcceptingRuns: () => false,
      config: {},
    }

    // Only the two guard reads are exercised; the rest of GracefulShutdown is
    // unreachable here, so the widening is explicit.
    const config = createTestConfig({
      shutdown: mockShutdown as unknown as ForgeServerConfig['shutdown'],
    })
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

    // Only the two guard reads are exercised; the rest of GracefulShutdown is
    // unreachable here, so the widening is explicit.
    const config = createTestConfig({
      shutdown: mockShutdown as unknown as ForgeServerConfig['shutdown'],
    })
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

    const res = await app.request('/api/agent-definitions')
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

    const res = await app.request('/api/agent-definitions', {
      headers: { Authorization: 'Bearer valid' },
    })
    expect(res.status).toBe(200)
  })
})
