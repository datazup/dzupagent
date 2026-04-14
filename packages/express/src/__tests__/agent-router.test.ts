import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response } from 'express'
import type { DzupAgent } from '@dzupagent/agent'
import { createAgentRouter } from '../agent-router.js'

function createMockAgent(overrides?: Partial<DzupAgent>): DzupAgent {
  return {
    generate: vi.fn(),
    stream: vi.fn(),
    ...overrides,
  } as unknown as DzupAgent
}

/**
 * Simulate calling a route handler registered on the Express router.
 * Finds the route matching the given method + path and invokes it.
 */
function findRouteHandler(
  router: ReturnType<typeof createAgentRouter>,
  method: string,
  path: string,
): ((req: Request, res: Response) => Promise<void>) | undefined {
  const layer = router.stack.find(
    (l: { route?: { path?: string; methods?: Record<string, boolean> } }) =>
      l.route?.path === path && l.route?.methods?.[method],
  )
  return layer?.route?.stack?.[0]?.handle as
    | ((req: Request, res: Response) => Promise<void>)
    | undefined
}

interface MockResponseState {
  statusCode: number
  jsonBody: unknown
  headers: Record<string, string>
  chunks: string[]
  headersSent: boolean
  writableEnded: boolean
}

function createMockResponse(): { res: Response; state: MockResponseState } {
  const state: MockResponseState = {
    statusCode: 0,
    jsonBody: null,
    headers: {},
    chunks: [],
    headersSent: false,
    writableEnded: false,
  }

  const res = {
    headersSent: false,
    writableEnded: false,
    status(code: number) {
      state.statusCode = code
      return res
    },
    json(body: unknown) {
      state.jsonBody = body
      return res
    },
    writeHead(status: number, headers: Record<string, string>) {
      state.statusCode = status
      state.headers = headers
      state.headersSent = true
      ;(res as { headersSent: boolean }).headersSent = true
    },
    write(chunk: string) {
      state.chunks.push(chunk)
      return true
    },
    end() {
      state.writableEnded = true
      ;(res as { writableEnded: boolean }).writableEnded = true
    },
  } as unknown as Response

  return { res, state }
}

function createMockRequest(body?: Record<string, unknown>): Request {
  const req = new EventEmitter() as unknown as Request
  ;(req as { body: unknown }).body = body ?? {}
  return req
}

describe('createAgentRouter', () => {
  it('registers chat, sync, and health routes at root path', () => {
    const router = createAgentRouter({
      agents: {
        default: createMockAgent(),
      },
    })

    const routes = router.stack
      .filter((layer: { route?: { path?: string; methods?: Record<string, boolean> } }) => layer.route)
      .map((layer: { route: { path: string; methods: Record<string, boolean> } }) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods).sort(),
      }))

    expect(routes).toContainEqual({ path: '/chat', methods: ['post'] })
    expect(routes).toContainEqual({ path: '/chat/sync', methods: ['post'] })
    expect(routes).toContainEqual({ path: '/health', methods: ['get'] })
  })

  it('applies basePath prefix to all routes', () => {
    const router = createAgentRouter({
      basePath: '/api/agent',
      agents: {
        default: createMockAgent(),
      },
    })

    const routePaths = router.stack
      .filter((layer: { route?: { path?: string } }) => layer.route)
      .map((layer: { route: { path: string } }) => layer.route.path)

    expect(routePaths).toContain('/api/agent/chat')
    expect(routePaths).toContain('/api/agent/chat/sync')
    expect(routePaths).toContain('/api/agent/health')
  })

  describe('POST /chat — missing or invalid request body', () => {
    it('returns 400 when message field is missing', async () => {
      const router = createAgentRouter({ agents: { default: createMockAgent() } })
      const handler = findRouteHandler(router, 'post', '/chat')!
      const req = createMockRequest({})
      const { res, state } = createMockResponse()

      await handler(req, res)

      expect(state.statusCode).toBe(400)
      expect(state.jsonBody).toEqual({
        error: 'Bad Request',
        message: '"message" field is required',
      })
    })

    it('returns 400 when message is not a string', async () => {
      const router = createAgentRouter({ agents: { default: createMockAgent() } })
      const handler = findRouteHandler(router, 'post', '/chat')!
      const req = createMockRequest({ message: 42 })
      const { res, state } = createMockResponse()

      await handler(req, res)

      expect(state.statusCode).toBe(400)
      expect(state.jsonBody).toEqual({
        error: 'Bad Request',
        message: '"message" field is required',
      })
    })

    it('returns 400 when message is an empty string', async () => {
      const router = createAgentRouter({ agents: { default: createMockAgent() } })
      const handler = findRouteHandler(router, 'post', '/chat')!
      const req = createMockRequest({ message: '' })
      const { res, state } = createMockResponse()

      await handler(req, res)

      expect(state.statusCode).toBe(400)
    })
  })

  describe('POST /chat — no agents configured', () => {
    it('returns 503 when agents map is empty', async () => {
      const router = createAgentRouter({ agents: {} })
      const handler = findRouteHandler(router, 'post', '/chat')!
      const req = createMockRequest({ message: 'hello' })
      const { res, state } = createMockResponse()

      await handler(req, res)

      expect(state.statusCode).toBe(503)
      expect(state.jsonBody).toEqual({
        error: 'Service Unavailable',
        message: 'No agents configured',
      })
    })
  })

  describe('POST /chat/sync — missing or invalid request body', () => {
    it('returns 400 when message is missing', async () => {
      const router = createAgentRouter({ agents: { default: createMockAgent() } })
      const handler = findRouteHandler(router, 'post', '/chat/sync')!
      const req = createMockRequest({})
      const { res, state } = createMockResponse()

      await handler(req, res)

      expect(state.statusCode).toBe(400)
      expect(state.jsonBody).toEqual({
        error: 'Bad Request',
        message: '"message" field is required',
      })
    })

    it('returns 503 when agents map is empty', async () => {
      const router = createAgentRouter({ agents: {} })
      const handler = findRouteHandler(router, 'post', '/chat/sync')!
      const req = createMockRequest({ message: 'hello' })
      const { res, state } = createMockResponse()

      await handler(req, res)

      expect(state.statusCode).toBe(503)
      expect(state.jsonBody).toEqual({
        error: 'Service Unavailable',
        message: 'No agents configured',
      })
    })
  })

  describe('POST /chat/sync — agent execution errors', () => {
    it('returns 500 and calls onError hook when agent.generate throws', async () => {
      const onError = vi.fn()
      const agent = createMockAgent({
        generate: vi.fn().mockRejectedValue(new Error('LLM failed')),
      })
      const router = createAgentRouter({
        agents: { default: agent },
        hooks: { onError },
      })
      const handler = findRouteHandler(router, 'post', '/chat/sync')!
      const req = createMockRequest({ message: 'hello' })
      const { res, state } = createMockResponse()

      await handler(req, res)

      expect(state.statusCode).toBe(500)
      expect(state.jsonBody).toEqual({
        error: 'Internal Server Error',
        message: 'LLM failed',
      })
      expect(onError).toHaveBeenCalledWith(req, expect.objectContaining({ message: 'LLM failed' }))
    })

    it('handles non-Error throws in sync route', async () => {
      const agent = createMockAgent({
        generate: vi.fn().mockRejectedValue('string error'),
      })
      const router = createAgentRouter({ agents: { default: agent } })
      const handler = findRouteHandler(router, 'post', '/chat/sync')!
      const req = createMockRequest({ message: 'hello' })
      const { res, state } = createMockResponse()

      await handler(req, res)

      expect(state.statusCode).toBe(500)
      expect(state.jsonBody).toEqual({
        error: 'Internal Server Error',
        message: 'string error',
      })
    })
  })

  describe('POST /chat — agent streaming errors', () => {
    it('returns 500 JSON when error occurs before SSE headers are sent', async () => {
      const agent = createMockAgent({
        stream: vi.fn().mockImplementation(() => {
          throw new Error('stream init failed')
        }),
      })
      const router = createAgentRouter({ agents: { default: agent } })
      const handler = findRouteHandler(router, 'post', '/chat')!
      const req = createMockRequest({ message: 'hello' })
      const { res, state } = createMockResponse()

      await handler(req, res)

      expect(state.statusCode).toBe(500)
      expect(state.jsonBody).toEqual({
        error: 'Internal Server Error',
        message: 'stream init failed',
      })
    })
  })

  describe('GET /health', () => {
    it('returns agent names and count', async () => {
      const router = createAgentRouter({
        agents: {
          alpha: createMockAgent(),
          beta: createMockAgent(),
        },
      })
      const handler = findRouteHandler(router, 'get', '/health')!
      const req = createMockRequest()
      const { res, state } = createMockResponse()

      await handler(req, res)

      expect(state.jsonBody).toEqual({
        status: 'ok',
        agents: ['alpha', 'beta'],
        count: 2,
      })
    })

    it('returns empty agents when none configured', async () => {
      const router = createAgentRouter({ agents: {} })
      const handler = findRouteHandler(router, 'get', '/health')!
      const req = createMockRequest()
      const { res, state } = createMockResponse()

      await handler(req, res)

      expect(state.jsonBody).toEqual({
        status: 'ok',
        agents: [],
        count: 0,
      })
    })
  })

  describe('agent resolution', () => {
    it('falls back to first agent when agentName is not found', async () => {
      const defaultAgent = createMockAgent({
        stream: vi.fn().mockReturnValue(
          (async function* () {
            /* empty stream */
          })(),
        ),
      })
      const router = createAgentRouter({ agents: { fallback: defaultAgent } })
      const handler = findRouteHandler(router, 'post', '/chat')!
      const req = createMockRequest({ message: 'hi', agentName: 'nonexistent' })
      const { res } = createMockResponse()

      await handler(req, res)

      expect(defaultAgent.stream).toHaveBeenCalled()
    })
  })
})
