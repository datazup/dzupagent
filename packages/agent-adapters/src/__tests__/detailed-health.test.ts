import { describe, it, expect, vi, beforeEach } from 'vitest'

import { AdapterRegistry } from '../registry/adapter-registry.js'
import type { DetailedHealthStatus } from '../registry/adapter-registry.js'
import {
  AdapterHttpHandler,
  isStreamResponse,
  type HttpRequest,
  type HttpResponse,
} from '../http/adapter-http-handler.js'
import type { OrchestratorFacade } from '../facade/orchestrator-facade.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  HealthStatus,
} from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAdapter(
  providerId: AdapterProviderId,
  healthy = true,
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:completed',
        providerId,
        sessionId: `s-${providerId}`,
        result: 'ok',
        durationMs: 10,
        timestamp: Date.now(),
      }
    },
    async *resumeSession(
      _sessionId: string,
      _input: AgentInput,
    ): AsyncGenerator<AgentEvent, void, undefined> {
      return
    },
    interrupt() {},
    async healthCheck(): Promise<HealthStatus> {
      return {
        healthy,
        providerId,
        sdkInstalled: healthy,
        cliAvailable: healthy,
        lastError: healthy ? undefined : 'unreachable',
      }
    },
    configure() {},
  }
}

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string | undefined> = {},
): HttpRequest {
  return { method, path, body, headers }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Detailed Health', () => {
  let registry: AdapterRegistry

  beforeEach(() => {
    registry = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 60_000 },
    })
  })

  it('getDetailedHealth returns circuit breaker state', async () => {
    registry.register(createMockAdapter('claude'))

    const health = await registry.getDetailedHealth()

    expect(health.adapters['claude']).toBeDefined()
    expect(health.adapters['claude']!.circuitState).toBe('closed')
  })

  it('getDetailedHealth returns success/failure timestamps', async () => {
    registry.register(createMockAdapter('claude'))

    // Record a success
    registry.recordSuccess('claude')
    const afterSuccess = await registry.getDetailedHealth()
    expect(afterSuccess.adapters['claude']!.lastSuccessAt).toBeTypeOf('number')
    expect(afterSuccess.adapters['claude']!.consecutiveFailures).toBe(0)

    // Record a failure
    registry.recordFailure('claude', new Error('test error'))
    const afterFailure = await registry.getDetailedHealth()
    expect(afterFailure.adapters['claude']!.lastFailureAt).toBeTypeOf('number')
    expect(afterFailure.adapters['claude']!.consecutiveFailures).toBe(1)
  })

  it('status is healthy when all adapters healthy', async () => {
    registry.register(createMockAdapter('claude'))
    registry.register(createMockAdapter('codex'))

    const health = await registry.getDetailedHealth()

    expect(health.status).toBe('healthy')
    expect(health.timestamp).toBeTypeOf('number')
  })

  it('status is degraded when some adapters unhealthy', async () => {
    registry.register(createMockAdapter('claude', true))
    registry.register(createMockAdapter('codex', false))

    const health = await registry.getDetailedHealth()

    expect(health.status).toBe('degraded')
  })

  it('status is unhealthy when no adapters healthy', async () => {
    registry.register(createMockAdapter('claude', false))
    registry.register(createMockAdapter('codex', false))

    const health = await registry.getDetailedHealth()

    expect(health.status).toBe('unhealthy')
  })

  it('circuit breaker state reflects open after repeated failures', async () => {
    registry.register(createMockAdapter('claude'))

    // Threshold is 2 — two failures should open the circuit
    registry.recordFailure('claude', new Error('fail 1'))
    registry.recordFailure('claude', new Error('fail 2'))

    const health = await registry.getDetailedHealth()

    expect(health.adapters['claude']!.circuitState).toBe('open')
    expect(health.adapters['claude']!.consecutiveFailures).toBe(2)
  })

  it('/health/detailed endpoint returns detailed status', async () => {
    const mockRegistry = {
      getHealthStatus: vi.fn().mockResolvedValue({
        claude: {
          healthy: true,
          providerId: 'claude',
          sdkInstalled: true,
          cliAvailable: true,
        } satisfies HealthStatus,
      }),
      getDetailedHealth: vi.fn().mockResolvedValue({
        status: 'healthy',
        adapters: {
          claude: {
            healthy: true,
            providerId: 'claude',
            sdkInstalled: true,
            cliAvailable: true,
            circuitState: 'closed',
            consecutiveFailures: 0,
            lastSuccessAt: Date.now(),
          },
        },
        timestamp: Date.now(),
      } satisfies DetailedHealthStatus),
      listAdapters: vi.fn().mockReturnValue(['claude']),
    }

    const orchestrator = {
      run: vi.fn(),
      supervisor: vi.fn(),
      parallel: vi.fn(),
      bid: vi.fn(),
      chat: vi.fn(),
      getCostReport: vi.fn().mockReturnValue(null),
      registry: mockRegistry,
    } as unknown as OrchestratorFacade

    const handler = new AdapterHttpHandler({ orchestrator })
    const result = await handler.handle(makeRequest('GET', '/health/detailed'))

    expect(isStreamResponse(result)).toBe(false)
    const json = result as HttpResponse
    expect(json.status).toBe(200)

    const body = json.body as DetailedHealthStatus
    expect(body.status).toBe('healthy')
    expect(body.adapters['claude']).toBeDefined()
    expect(body.adapters['claude']!.circuitState).toBe('closed')
    expect(mockRegistry.getDetailedHealth).toHaveBeenCalled()
  })

  it('/health/detailed falls back to basic health when getDetailedHealth is unavailable', async () => {
    const mockRegistry = {
      getHealthStatus: vi.fn().mockResolvedValue({
        claude: {
          healthy: true,
          providerId: 'claude',
          sdkInstalled: true,
          cliAvailable: true,
        } satisfies HealthStatus,
      }),
      listAdapters: vi.fn().mockReturnValue(['claude']),
      // No getDetailedHealth method
    }

    const orchestrator = {
      run: vi.fn(),
      supervisor: vi.fn(),
      parallel: vi.fn(),
      bid: vi.fn(),
      chat: vi.fn(),
      getCostReport: vi.fn().mockReturnValue({ totalCostCents: 0, providers: {} }),
      registry: mockRegistry,
    } as unknown as OrchestratorFacade

    const handler = new AdapterHttpHandler({ orchestrator })
    const result = await handler.handle(makeRequest('GET', '/health/detailed'))

    expect(isStreamResponse(result)).toBe(false)
    const json = result as HttpResponse
    expect(json.status).toBe(200)

    // Should fall back to basic health response
    const body = json.body as Record<string, unknown>
    expect(body['status']).toBe('ok')
    expect(body['adapters']).toBeDefined()
  })
})
