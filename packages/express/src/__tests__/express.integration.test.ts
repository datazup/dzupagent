import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import express, { type NextFunction, type Request, type Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamEvent, DzupAgent, GenerateResult } from '@dzupagent/agent'
import { createAgentRouter } from '../agent-router.js'

type TestApp = ReturnType<typeof express>

type TestResponseState = {
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
      }
    })
  })
}

async function* streamFromEvents(events: AgentStreamEvent[]): AsyncGenerator<AgentStreamEvent, void, undefined> {
  for (const event of events) {
    yield event
  }
}

describe('createAgentRouter integration', () => {
  let cleanup: (() => void) | undefined

  afterEach(() => {
    cleanup?.()
    cleanup = undefined
  })

  it('wires auth middleware, hooks, and sync/health routes through a mounted Express app', async () => {
    const beforeAgent = vi.fn()
    const afterAgent = vi.fn()
    const onError = vi.fn()

    const syncResult: GenerateResult = {
      content: 'synced response',
      messages: [],
      usage: {
        totalInputTokens: 11,
        totalOutputTokens: 7,
        llmCalls: 1,
      },
      hitIterationLimit: false,
      stopReason: 'complete',
      toolStats: [],
    }

    const primaryAgent = createMockAgent({
      generate: vi.fn().mockResolvedValue(syncResult),
    })
    const secondaryAgent = createMockAgent()

    const app = express()
    app.use(express.json())
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.headers['x-api-key'] !== 'secret') {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      next()
    })
    app.use(
      createAgentRouter({
        basePath: '/v1/agent',
        agents: {
          primary: primaryAgent,
          secondary: secondaryAgent,
        },
        hooks: {
          beforeAgent,
          afterAgent,
          onError,
        },
      }),
    )

    const unauthorizedReq = createRequest('GET', '/v1/agent/health', undefined, {})
    const unauthorizedRes = createResponse(app)
    const unauthorizedState = await dispatch(app, unauthorizedReq, unauthorizedRes)
    expect(unauthorizedState.statusCode).toBe(401)
    expect(unauthorizedState.chunks.join('')).toContain('Unauthorized')

    const healthReq = createRequest('GET', '/v1/agent/health', undefined, {
      'x-api-key': 'secret',
    })
    const healthRes = createResponse(app)
    const healthState = await dispatch(app, healthReq, healthRes)
    expect(healthState.statusCode).toBe(200)
    expect(JSON.parse(healthState.chunks.join(''))).toEqual({
      status: 'ok',
      agents: ['primary', 'secondary'],
      count: 2,
    })

    const syncReq = createRequest(
      'POST',
      '/v1/agent/chat/sync',
      JSON.stringify({
        message: 'hello from integration',
        agentName: 'primary',
      }),
      {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(JSON.stringify({
          message: 'hello from integration',
          agentName: 'primary',
        }))),
        'x-api-key': 'secret',
      },
    )
    const syncRes = createResponse(app)
    const syncState = await dispatch(app, syncReq, syncRes)

    expect(syncState.statusCode).toBe(200)
    expect(JSON.parse(syncState.chunks.join(''))).toEqual({
      content: 'synced response',
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
      },
      toolCalls: 0,
      durationMs: expect.any(Number),
    })
    expect(primaryAgent.generate).toHaveBeenCalledTimes(1)
    expect(beforeAgent).toHaveBeenCalledWith(expect.any(Object), 'primary')
    expect(afterAgent).toHaveBeenCalledWith(expect.any(Object), 'primary', syncResult)
    expect(onError).not.toHaveBeenCalled()
  })

  it('streams SSE events through the router and preserves middleware-selected agent state', async () => {
    const beforeAgent = vi.fn()
    const afterAgent = vi.fn()
    const onError = vi.fn()

    const streamAgent = createMockAgent({
      stream: vi.fn().mockReturnValue(
        streamFromEvents([
          { type: 'text', data: { content: 'hello ' } },
          { type: 'tool_call', data: { name: 'search', args: { q: 'express' } } },
          { type: 'tool_result', data: { name: 'search', result: { ok: true } } },
          { type: 'done', data: { content: 'streamed response' } },
        ]),
      ),
    })

    const app = express()
    app.use(express.json())
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.headers['x-api-key'] !== 'secret') {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      next()
    })
    app.use(
      createAgentRouter({
        basePath: '/v1/agent',
        agents: {
          stream: streamAgent,
        },
        hooks: {
          beforeAgent,
          afterAgent,
          onError,
        },
        sse: {
          keepAliveMs: 60_000,
        },
      }),
    )

    const streamReq = createRequest(
      'POST',
      '/v1/agent/chat',
      JSON.stringify({
        message: 'stream this',
        agentName: 'stream',
      }),
      {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(JSON.stringify({
          message: 'stream this',
          agentName: 'stream',
        }))),
        'x-api-key': 'secret',
        accept: 'text/event-stream',
      },
    )
    const streamRes = createResponse(app)
    const streamState = await dispatch(app, streamReq, streamRes)

    expect(streamState.statusCode).toBe(200)
    expect(streamState.headers['content-type']).toContain('text/event-stream')
    const body = streamState.chunks.join('')
    expect(body).toContain('event: chunk')
    expect(body).toContain('event: tool_call')
    expect(body).toContain('event: tool_result')
    expect(body).toContain('event: done')
    expect(body).toContain('hello ')

    expect(streamAgent.stream).toHaveBeenCalledTimes(1)
    expect(beforeAgent).toHaveBeenCalledWith(expect.any(Object), 'stream')
    expect(afterAgent).toHaveBeenCalledWith(
      expect.any(Object),
      'stream',
      expect.objectContaining({
        content: 'hello ',
        toolCalls: 1,
      }),
    )
    expect(onError).not.toHaveBeenCalled()
  })
})
