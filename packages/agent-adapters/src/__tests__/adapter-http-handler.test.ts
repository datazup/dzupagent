import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzipagent/core'
import type { DzipEventBus } from '@dzipagent/core'

import {
  AdapterHttpHandler,
  isStreamResponse,
  type HttpRequest,
  type HttpResponse,
  type HttpStreamResponse,
  type AdapterApprovalGate as HttpApprovalGate,
  type AdapterHttpConfig,
} from '../http/adapter-http-handler.js'
import type { OrchestratorFacade } from '../facade/orchestrator-facade.js'
import type {
  AdapterProviderId,
  AgentEvent,
  HealthStatus,
} from '../types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockOrchestrator(
  overrides: Partial<Record<string, unknown>> = {},
): OrchestratorFacade {
  return {
    run: vi.fn().mockResolvedValue({
      result: 'run result',
      providerId: 'claude',
      durationMs: 100,
    }),
    supervisor: vi.fn().mockResolvedValue({
      goal: 'test',
      subtaskResults: [],
      totalDurationMs: 50,
    }),
    parallel: vi.fn().mockResolvedValue({
      results: [],
      mergeStrategy: 'all',
      totalDurationMs: 30,
    }),
    bid: vi.fn().mockResolvedValue({
      winner: 'claude',
      result: 'bid result',
    }),
    chat: vi.fn().mockImplementation(async function* () {
      yield {
        type: 'adapter:completed' as const,
        providerId: 'claude' as AdapterProviderId,
        sessionId: 's1',
        result: 'chat result',
        durationMs: 50,
        timestamp: Date.now(),
      } satisfies AgentEvent
    }),
    getCostReport: vi.fn().mockReturnValue({
      totalCostCents: 42,
      providers: {},
    }),
    registry: {
      getHealthStatus: vi.fn().mockResolvedValue({
        claude: {
          healthy: true,
          providerId: 'claude',
          sdkInstalled: true,
          cliAvailable: true,
        } satisfies HealthStatus,
      }),
      listAdapters: vi.fn().mockReturnValue(['claude']),
    },
    ...overrides,
  } as unknown as OrchestratorFacade
}

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string | undefined> = {},
): HttpRequest {
  return { method, path, body, headers }
}

function asJsonResponse(result: HttpResponse): {
  status: number
  body: Record<string, unknown>
} {
  return {
    status: result.status,
    body: result.body as Record<string, unknown>,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterHttpHandler', () => {
  let orchestrator: OrchestratorFacade
  let handler: AdapterHttpHandler

  beforeEach(() => {
    orchestrator = createMockOrchestrator()
    handler = new AdapterHttpHandler({ orchestrator })
  })

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  describe('routing', () => {
    it('POST /run returns JSON result', async () => {
      const result = await handler.handle(
        makeRequest('POST', '/run', { prompt: 'Fix the bug' }),
      )

      expect(isStreamResponse(result)).toBe(false)
      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(200)
      expect(json.body['result']).toBe('run result')

      expect(orchestrator.run).toHaveBeenCalledWith('Fix the bug', expect.objectContaining({
        tags: undefined,
      }))
    })

    it('POST /run with stream returns SSE stream', async () => {
      const result = await handler.handle(
        makeRequest('POST', '/run', { prompt: 'Fix the bug', stream: true }),
      )

      expect(isStreamResponse(result)).toBe(true)
      const stream = result as HttpStreamResponse
      expect(stream.status).toBe(200)
      expect(stream.headers['content-type']).toBe('text/event-stream')

      // Consume stream to verify it works
      const chunks: string[] = []
      for await (const chunk of stream.stream) {
        chunks.push(chunk)
      }
      expect(chunks.length).toBeGreaterThanOrEqual(0)
    })

    it('POST /supervisor returns result', async () => {
      const result = await handler.handle(
        makeRequest('POST', '/supervisor', { goal: 'Review the code' }),
      )

      expect(isStreamResponse(result)).toBe(false)
      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(200)
      expect(orchestrator.supervisor).toHaveBeenCalledWith('Review the code', expect.any(Object))
    })

    it('POST /parallel returns result', async () => {
      const result = await handler.handle(
        makeRequest('POST', '/parallel', { prompt: 'Solve this' }),
      )

      expect(isStreamResponse(result)).toBe(false)
      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(200)
      expect(orchestrator.parallel).toHaveBeenCalled()
    })

    it('POST /bid returns result', async () => {
      const result = await handler.handle(
        makeRequest('POST', '/bid', { prompt: 'Build a feature' }),
      )

      expect(isStreamResponse(result)).toBe(false)
      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(200)
      expect(orchestrator.bid).toHaveBeenCalledWith('Build a feature')
    })

    it('GET /health returns status', async () => {
      const result = await handler.handle(makeRequest('GET', '/health'))

      expect(isStreamResponse(result)).toBe(false)
      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(200)
      expect(json.body['status']).toBe('ok')
      expect(json.body['adapters']).toBeDefined()
    })

    it('GET /health returns degraded when some adapters unhealthy', async () => {
      const orch = createMockOrchestrator({
        registry: {
          getHealthStatus: vi.fn().mockResolvedValue({
            claude: {
              healthy: true,
              providerId: 'claude',
              sdkInstalled: true,
              cliAvailable: true,
            },
            codex: {
              healthy: false,
              providerId: 'codex',
              sdkInstalled: true,
              cliAvailable: false,
            },
          }),
        },
      })
      const h = new AdapterHttpHandler({ orchestrator: orch })

      const result = await h.handle(makeRequest('GET', '/health'))
      const json = asJsonResponse(result as HttpResponse)
      expect(json.body['status']).toBe('degraded')
    })

    it('GET /cost returns report', async () => {
      const result = await handler.handle(makeRequest('GET', '/cost'))

      expect(isStreamResponse(result)).toBe(false)
      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(200)
      expect(json.body['totalCostCents']).toBe(42)
    })

    it('GET /cost returns 404 when cost tracking disabled', async () => {
      const orch = createMockOrchestrator({
        getCostReport: vi.fn().mockReturnValue(undefined),
      })
      const h = new AdapterHttpHandler({ orchestrator: orch })

      const result = await h.handle(makeRequest('GET', '/cost'))
      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(404)
    })

    it('unknown route returns 404', async () => {
      const result = await handler.handle(makeRequest('GET', '/unknown'))

      expect(isStreamResponse(result)).toBe(false)
      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(404)
      expect(json.body['code']).toBe('NOT_FOUND')
    })
  })

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  describe('validation', () => {
    it('missing prompt returns 400', async () => {
      const result = await handler.handle(
        makeRequest('POST', '/run', { notAPrompt: 'hello' }),
      )

      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(400)
      expect(json.body['code']).toBe('MISSING_FIELDS')
    })

    it('empty prompt returns 400', async () => {
      const result = await handler.handle(
        makeRequest('POST', '/run', { prompt: '' }),
      )

      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(400)
      expect(json.body['code']).toBe('MISSING_FIELDS')
    })

    it('invalid body (null) returns 400', async () => {
      const result = await handler.handle(
        makeRequest('POST', '/run', null),
      )

      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(400)
      expect(json.body['code']).toBe('INVALID_BODY')
    })

    it('invalid body (string) returns 400', async () => {
      const result = await handler.handle(
        makeRequest('POST', '/run', 'just a string'),
      )

      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(400)
      expect(json.body['code']).toBe('INVALID_BODY')
    })

    it('missing goal for supervisor returns 400', async () => {
      const result = await handler.handle(
        makeRequest('POST', '/supervisor', { prompt: 'hello' }),
      )

      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(400)
    })
  })

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  describe('auth', () => {
    it('missing API key returns 401 when validateApiKey is configured', async () => {
      const authedHandler = new AdapterHttpHandler({
        orchestrator,
        validateApiKey: () => true,
      })

      const result = await authedHandler.handle(
        makeRequest('GET', '/health'),
      )

      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(401)
      expect(json.body['code']).toBe('UNAUTHORIZED')
    })

    it('invalid Authorization format returns 401', async () => {
      const authedHandler = new AdapterHttpHandler({
        orchestrator,
        validateApiKey: () => true,
      })

      const result = await authedHandler.handle(
        makeRequest('GET', '/health', undefined, { authorization: 'Basic abc123' }),
      )

      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(401)
    })

    it('invalid API key returns 401', async () => {
      const authedHandler = new AdapterHttpHandler({
        orchestrator,
        validateApiKey: (key) => key === 'valid-key',
      })

      const result = await authedHandler.handle(
        makeRequest('GET', '/health', undefined, {
          authorization: 'Bearer wrong-key',
        }),
      )

      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(401)
    })

    it('valid API key passes', async () => {
      const authedHandler = new AdapterHttpHandler({
        orchestrator,
        validateApiKey: (key) => key === 'valid-key',
      })

      const result = await authedHandler.handle(
        makeRequest('GET', '/health', undefined, {
          authorization: 'Bearer valid-key',
        }),
      )

      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(200)
    })

    it('async validateApiKey works', async () => {
      const authedHandler = new AdapterHttpHandler({
        orchestrator,
        validateApiKey: async (key) => key === 'async-key',
      })

      const result = await authedHandler.handle(
        makeRequest('POST', '/run', { prompt: 'hello' }, {
          authorization: 'Bearer async-key',
        }),
      )

      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(200)
    })
  })

  // -------------------------------------------------------------------------
  // Approval
  // -------------------------------------------------------------------------

  describe('approval', () => {
    it('POST /approve/:id with no gate returns 501', async () => {
      const result = await handler.handle(
        makeRequest('POST', '/approve/req-123', { approved: true }),
      )

      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(501)
      expect(json.body['code']).toBe('NO_APPROVAL_GATE')
    })

    it('POST /approve/:id grants request', async () => {
      const mockGate: HttpApprovalGate = {
        grant: vi.fn().mockResolvedValue(true),
        reject: vi.fn().mockResolvedValue(true),
      }

      const gatedHandler = new AdapterHttpHandler({
        orchestrator,
        approvalGate: mockGate,
      })

      const result = await gatedHandler.handle(
        makeRequest('POST', '/approve/req-123', {
          approved: true,
          approvedBy: 'admin',
        }),
      )

      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(200)
      expect(json.body['status']).toBe('approved')
      expect(mockGate.grant).toHaveBeenCalledWith('req-123', 'admin', undefined)
    })

    it('POST /approve/:id rejects request', async () => {
      const mockGate: HttpApprovalGate = {
        grant: vi.fn().mockResolvedValue(true),
        reject: vi.fn().mockResolvedValue(true),
      }

      const gatedHandler = new AdapterHttpHandler({
        orchestrator,
        approvalGate: mockGate,
      })

      const result = await gatedHandler.handle(
        makeRequest('POST', '/approve/req-456', {
          approved: false,
          reason: 'too risky',
        }),
      )

      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(200)
      expect(json.body['status']).toBe('rejected')
      expect(mockGate.reject).toHaveBeenCalledWith('req-456', 'too risky')
    })

    it('POST /approve/:id returns 404 if request not found', async () => {
      const mockGate: HttpApprovalGate = {
        grant: vi.fn().mockResolvedValue(false),
        reject: vi.fn().mockResolvedValue(false),
      }

      const gatedHandler = new AdapterHttpHandler({
        orchestrator,
        approvalGate: mockGate,
      })

      const result = await gatedHandler.handle(
        makeRequest('POST', '/approve/nonexistent', { approved: true }),
      )

      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(404)
      expect(json.body['code']).toBe('REQUEST_NOT_FOUND')
    })

    it('POST /approve with missing approved field returns 400', async () => {
      const mockGate: HttpApprovalGate = {
        grant: vi.fn().mockResolvedValue(true),
        reject: vi.fn().mockResolvedValue(true),
      }

      const gatedHandler = new AdapterHttpHandler({
        orchestrator,
        approvalGate: mockGate,
      })

      const result = await gatedHandler.handle(
        makeRequest('POST', '/approve/req-123', { reason: 'no approved field' }),
      )

      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(400)
    })
  })

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('returns 500 on orchestrator error', async () => {
      const failingOrch = createMockOrchestrator({
        run: vi.fn().mockRejectedValue(new Error('kaboom')),
      })
      const h = new AdapterHttpHandler({ orchestrator: failingOrch })

      const result = await h.handle(
        makeRequest('POST', '/run', { prompt: 'hello' }),
      )

      const json = asJsonResponse(result as HttpResponse)
      expect(json.status).toBe(500)
      expect(json.body['code']).toBe('INTERNAL_ERROR')
      expect((json.body['error'] as string)).toContain('kaboom')
    })

    it('emits error event on event bus', async () => {
      const bus = createEventBus()
      const emitted: unknown[] = []
      bus.onAny((e) => emitted.push(e))

      const failingOrch = createMockOrchestrator({
        run: vi.fn().mockRejectedValue(new Error('boom')),
      })
      const h = new AdapterHttpHandler({
        orchestrator: failingOrch,
        eventBus: bus,
      })

      await h.handle(makeRequest('POST', '/run', { prompt: 'hello' }))

      expect(emitted.length).toBeGreaterThanOrEqual(1)
    })
  })

  // -------------------------------------------------------------------------
  // isStreamResponse utility
  // -------------------------------------------------------------------------

  describe('isStreamResponse()', () => {
    it('returns true for stream responses', () => {
      const streamResult: HttpStreamResponse = {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        stream: (async function* () {})(),
      }
      expect(isStreamResponse(streamResult)).toBe(true)
    })

    it('returns false for JSON responses', () => {
      const jsonResult: HttpResponse = {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { ok: true },
      }
      expect(isStreamResponse(jsonResult)).toBe(false)
    })
  })
})
