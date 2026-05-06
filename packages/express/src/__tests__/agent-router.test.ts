import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import express, { type Request, type Response } from 'express'
import { describe, it, expect, vi } from 'vitest'
import type { GenerateResult, DzupAgent } from '@dzupagent/agent'
import { createAgentRouter } from '../agent-router.js'

type TestApp = ReturnType<typeof express>

interface TestResponseState {
  statusCode: number
  headers: Record<string, string>
  chunks: string[]
  ended: boolean
}

function createMockAgent(overrides?: Partial<Pick<DzupAgent, 'generate' | 'stream'>>): DzupAgent {
  return {
    generate: vi.fn(),
    stream: vi.fn(),
    ...overrides,
  } as unknown as DzupAgent
}

function createRequest(
  method: string,
  url: string,
  body: string | undefined,
  headers: Record<string, string>,
): Request {
  const stream = Readable.from(body ? [body] : []) as Readable & Partial<Request>
  stream.method = method
  stream.url = url
  stream.originalUrl = url
  stream.headers = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  ) as Request['headers']
  return stream as Request
}

function createResponse(app: TestApp): Response & { state: TestResponseState } {
  const emitter = new EventEmitter()
  const state: TestResponseState = {
    statusCode: 200,
    headers: {},
    chunks: [],
    ended: false,
  }

  const res = emitter as Response & {
    state: TestResponseState
    app: TestApp
    req: Request
    locals: Record<string, unknown>
    statusCode: number
    setHeader: (name: string, value: string | number | readonly string[]) => Response
    getHeader: (name: string) => string | number | readonly string[] | undefined
    getHeaders: () => Record<string, string>
    writeHead: (statusCode: number, headers?: Record<string, string>) => Response
    write: (chunk: unknown) => boolean
    end: (chunk?: unknown) => Response
  }

  Object.setPrototypeOf(res, app.response)

  res.state = state
  res.app = app
  res.req = undefined as unknown as Request
  res.locals = {}

  Object.defineProperty(res, 'statusCode', {
    configurable: true,
    enumerable: true,
    get: () => state.statusCode,
    set: (value: number) => {
      state.statusCode = value
    },
  })

  res.setHeader = (name, value) => {
    state.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value)
    return res
  }

  res.getHeader = (name) => state.headers[name.toLowerCase()]
  res.getHeaders = () => ({ ...state.headers })

  res.writeHead = (statusCode, headers = {}) => {
    state.statusCode = statusCode
    for (const [name, value] of Object.entries(headers)) {
      state.headers[name.toLowerCase()] = value
    }
    return res
  }

  res.write = (chunk) => {
    if (chunk !== undefined && chunk !== null) {
      state.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as ArrayBufferView).toString())
    }
    return true
  }

  res.end = (chunk?: unknown) => {
    if (chunk !== undefined && chunk !== null) {
      state.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as ArrayBufferView).toString())
    }
    state.ended = true
    res.emit('finish')
    return res
  }

  Object.defineProperty(res, 'writableEnded', {
    configurable: true,
    enumerable: true,
    get: () => state.ended,
  })

  Object.defineProperty(res, 'headersSent', {
    configurable: true,
    enumerable: true,
    get: () => state.ended || Object.keys(state.headers).length > 0,
  })

  return res
}

function dispatch(
  app: TestApp,
  req: Request,
  res: Response & { state: TestResponseState },
): Promise<TestResponseState> {
  return new Promise((resolve, reject) => {
    const onFinish = (): void => {
      setImmediate(() => resolve(res.state))
    }
    const onError = (error: Error): void => reject(error)

    res.once('finish', onFinish)
    res.once('error', onError)

    app.handle(req, res, (error?: unknown) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      // Route not matched — finish with current state.
      setImmediate(() => resolve(res.state))
    })
  })
}

function buildApp(
  routerConfig: Parameters<typeof createAgentRouter>[0],
): TestApp {
  const app = express()
  app.use(createAgentRouter(routerConfig))
  return app
}

function jsonRequest(method: string, url: string, payload: unknown): Request {
  const body = JSON.stringify(payload)
  return createRequest(method, url, body, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  })
}

function rawRequest(method: string, url: string, body: string): Request {
  return createRequest(method, url, body, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  })
}

function parseJson(state: TestResponseState): unknown {
  return JSON.parse(state.chunks.join(''))
}

describe('createAgentRouter — route registration', () => {
  it('registers chat, sync, and health routes at root path', () => {
    const router = createAgentRouter({
      agents: { default: createMockAgent() },
      rateLimit: false,
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
      agents: { default: createMockAgent() },
      rateLimit: false,
    })

    const routePaths = router.stack
      .filter((layer: { route?: { path?: string } }) => layer.route)
      .map((layer: { route: { path: string } }) => layer.route.path)

    expect(routePaths).toContain('/api/agent/chat')
    expect(routePaths).toContain('/api/agent/chat/sync')
    expect(routePaths).toContain('/api/agent/health')
  })
})

describe('createAgentRouter — Zod validation', () => {
  it('returns 400 with VALIDATION_ERROR when message is missing', async () => {
    const app = buildApp({ agents: { default: createMockAgent() }, rateLimit: false })
    const state = await dispatch(app, jsonRequest('POST', '/chat', {}), createResponse(app))
    expect(state.statusCode).toBe(400)
    const body = parseJson(state) as { code: string; issues: Array<{ path: string }> }
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.issues.some((i) => i.path === 'message')).toBe(true)
  })

  it('returns 400 when message is an empty string', async () => {
    const app = buildApp({ agents: { default: createMockAgent() }, rateLimit: false })
    const state = await dispatch(app, jsonRequest('POST', '/chat', { message: '' }), createResponse(app))
    expect(state.statusCode).toBe(400)
    expect((parseJson(state) as { code: string }).code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when message exceeds 32 KB', async () => {
    const app = buildApp({ agents: { default: createMockAgent() }, rateLimit: false, bodyLimit: '1mb' })
    // 32_769 chars (one over the limit). Body itself fits in 1mb cap so it gets to Zod.
    const huge = 'a'.repeat(32_769)
    const state = await dispatch(app, jsonRequest('POST', '/chat', { message: huge }), createResponse(app))
    expect(state.statusCode).toBe(400)
    const body = parseJson(state) as { code: string; issues: Array<{ path: string }> }
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.issues.some((i) => i.path === 'message')).toBe(true)
  })

  it('returns 400 when /chat/sync receives no message', async () => {
    const app = buildApp({ agents: { default: createMockAgent() }, rateLimit: false })
    const state = await dispatch(app, jsonRequest('POST', '/chat/sync', {}), createResponse(app))
    expect(state.statusCode).toBe(400)
    expect((parseJson(state) as { code: string }).code).toBe('VALIDATION_ERROR')
  })
})

describe('createAgentRouter — body cap', () => {
  it('returns 413 BODY_TOO_LARGE when payload exceeds the 256kb default', async () => {
    const app = buildApp({ agents: { default: createMockAgent() }, rateLimit: false })
    // 300 KB raw body — exceeds default 256kb cap.
    const oversized = '"' + 'a'.repeat(300_000) + '"'
    const state = await dispatch(
      app,
      rawRequest('POST', '/chat', `{"message":${oversized}}`),
      createResponse(app),
    )
    expect(state.statusCode).toBe(413)
    expect((parseJson(state) as { code: string }).code).toBe('BODY_TOO_LARGE')
  })

  it('returns 400 INVALID_JSON when body is malformed', async () => {
    const app = buildApp({ agents: { default: createMockAgent() }, rateLimit: false })
    const state = await dispatch(
      app,
      rawRequest('POST', '/chat', '{not json'),
      createResponse(app),
    )
    expect(state.statusCode).toBe(400)
    expect((parseJson(state) as { code: string }).code).toBe('INVALID_JSON')
  })
})

describe('createAgentRouter — agent allowlist', () => {
  it('returns 400 UNKNOWN_AGENT when agentName is not configured', async () => {
    const app = buildApp({ agents: { primary: createMockAgent() }, rateLimit: false })
    const state = await dispatch(
      app,
      jsonRequest('POST', '/chat', { message: 'hi', agentName: 'nonexistent' }),
      createResponse(app),
    )
    expect(state.statusCode).toBe(400)
    const body = parseJson(state) as { code: string; message: string }
    expect(body.code).toBe('UNKNOWN_AGENT')
    expect(body.message).toContain('nonexistent')
  })

  it('returns 503 NO_AGENTS when agents map is empty', async () => {
    const app = buildApp({ agents: {}, rateLimit: false })
    const state = await dispatch(
      app,
      jsonRequest('POST', '/chat', { message: 'hello' }),
      createResponse(app),
    )
    expect(state.statusCode).toBe(503)
    expect((parseJson(state) as { code: string }).code).toBe('NO_AGENTS')
  })
})

describe('createAgentRouter — rate limiting', () => {
  it('returns 429 RATE_LIMITED after exceeding the configured threshold', async () => {
    // Build app once; share the rate-limit store across requests.
    const app = buildApp({
      agents: {
        default: createMockAgent({
          generate: vi.fn().mockResolvedValue({
            content: 'ok',
            messages: [],
            usage: { totalInputTokens: 1, totalOutputTokens: 1, llmCalls: 1 },
            hitIterationLimit: false,
            stopReason: 'complete',
            toolStats: [],
          } satisfies GenerateResult),
        }),
      },
      rateLimit: { windowMs: 60_000, max: 2 },
    })

    const send = (): Promise<TestResponseState> =>
      dispatch(app, jsonRequest('POST', '/chat/sync', { message: 'hi' }), createResponse(app))

    // First two: allowed.
    const a = await send()
    const b = await send()
    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)

    // Third: rate limited.
    const c = await send()
    expect(c.statusCode).toBe(429)
    const body = parseJson(c) as { code: string }
    expect(body.code).toBe('RATE_LIMITED')
  })
})

describe('createAgentRouter — error sanitisation', () => {
  it('returns generic INTERNAL_ERROR (no err.message) when /chat/sync agent throws', async () => {
    const onError = vi.fn()
    const agent = createMockAgent({
      generate: vi.fn().mockRejectedValue(new Error('SECRET internal failure detail')),
    })
    const app = buildApp({
      agents: { default: agent },
      rateLimit: false,
      hooks: { onError },
      logger: { warn: vi.fn(), error: vi.fn() },
    })

    const state = await dispatch(
      app,
      jsonRequest('POST', '/chat/sync', { message: 'hi' }),
      createResponse(app),
    )

    expect(state.statusCode).toBe(500)
    const body = parseJson(state) as Record<string, unknown>
    expect(body).toEqual({ error: 'Internal error', code: 'INTERNAL_ERROR' })
    // Must not leak the inner error message.
    expect(JSON.stringify(body)).not.toContain('SECRET internal failure detail')
    expect(onError).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ message: 'SECRET internal failure detail' }))
  })

  it('logs the real error server-side via the structured logger', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    const agent = createMockAgent({
      generate: vi.fn().mockRejectedValue(new Error('inner detail X')),
    })
    const app = buildApp({
      agents: { default: agent },
      rateLimit: false,
      logger,
    })

    await dispatch(app, jsonRequest('POST', '/chat/sync', { message: 'hi' }), createResponse(app))

    expect(logger.error).toHaveBeenCalled()
    const calls = logger.error.mock.calls.flat()
    const serialised = JSON.stringify(calls)
    expect(serialised).toContain('inner detail X')
  })
})

describe('createAgentRouter — health route', () => {
  it('returns agent names and count', async () => {
    const app = buildApp({
      agents: { alpha: createMockAgent(), beta: createMockAgent() },
      rateLimit: false,
    })
    const state = await dispatch(
      app,
      createRequest('GET', '/health', undefined, {}),
      createResponse(app),
    )
    expect(state.statusCode).toBe(200)
    expect(parseJson(state)).toEqual({ status: 'ok', agents: ['alpha', 'beta'], count: 2 })
  })
})
