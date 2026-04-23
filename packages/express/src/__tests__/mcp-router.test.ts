import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import express, { type NextFunction, type Request, type Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { DzupAgentMCPServer } from '@dzupagent/core'
import { createMcpRouter } from '../mcp-router.js'
import type { MCPRequestHandler } from '../types.js'

type TestApp = ReturnType<typeof express>

type TestResponseState = {
  statusCode: number
  headers: Record<string, string>
  chunks: string[]
  ended: boolean
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

describe('createMcpRouter', () => {
  it('serves MCP helper routes and request hooks through a mounted Express app', async () => {
    const beforeRequest = vi.fn()
    const afterRequest = vi.fn()

    const server = new DzupAgentMCPServer({
      name: 'test-mcp',
      version: '1.0.0',
      tools: [{
        name: 'echo',
        description: 'Echo input',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
        },
        handler: async (args) => String(args['text'] ?? ''),
      }],
      resources: [{
        uri: 'memory://overview',
        name: 'Overview',
        read: async () => 'overview',
      }],
      resourceTemplates: [{
        uriTemplate: 'project://{projectId}/report',
        name: 'Report',
        read: async (uri) => ({ uri, text: 'report' }),
      }],
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
    app.use(createMcpRouter({
      server,
      hooks: {
        beforeRequest,
        afterRequest,
      },
    }))

    const unauthorizedReq = createRequest('GET', '/mcp/tools', undefined, {})
    const unauthorizedRes = createResponse(app)
    const unauthorizedState = await dispatch(app, unauthorizedReq, unauthorizedRes)
    expect(unauthorizedState.statusCode).toBe(401)

    const toolsReq = createRequest('GET', '/mcp/tools', undefined, { 'x-api-key': 'secret' })
    const toolsRes = createResponse(app)
    const toolsState = await dispatch(app, toolsReq, toolsRes)
    expect(toolsState.statusCode).toBe(200)
    expect(JSON.parse(toolsState.chunks.join(''))).toEqual({
      tools: [expect.objectContaining({ name: 'echo' })],
    })

    const resourcesReq = createRequest('GET', '/mcp/resources', undefined, { 'x-api-key': 'secret' })
    const resourcesRes = createResponse(app)
    const resourcesState = await dispatch(app, resourcesReq, resourcesRes)
    expect(resourcesState.statusCode).toBe(200)
    expect(JSON.parse(resourcesState.chunks.join(''))).toEqual({
      resources: [{ uri: 'memory://overview', name: 'Overview' }],
    })

    const templatesReq = createRequest('GET', '/mcp/resource-templates', undefined, { 'x-api-key': 'secret' })
    const templatesRes = createResponse(app)
    const templatesState = await dispatch(app, templatesReq, templatesRes)
    expect(templatesState.statusCode).toBe(200)
    expect(JSON.parse(templatesState.chunks.join(''))).toEqual({
      resourceTemplates: [{ uriTemplate: 'project://{projectId}/report', name: 'Report' }],
    })

    const initializePayload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    })
    const initializeReq = createRequest('POST', '/mcp', initializePayload, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(initializePayload)),
      'x-api-key': 'secret',
    })
    const initializeRes = createResponse(app)
    const initializeState = await dispatch(app, initializeReq, initializeRes)

    expect(initializeState.statusCode).toBe(200)
    expect(JSON.parse(initializeState.chunks.join(''))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: {
          name: 'test-mcp',
          version: '1.0.0',
        },
        capabilities: {
          tools: {},
          resources: {},
        },
      },
    })
    expect(beforeRequest).toHaveBeenCalledWith(expect.any(Object), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    })
    expect(afterRequest).toHaveBeenCalledWith(
      expect.any(Object),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
      },
      expect.objectContaining({ id: 1 }),
    )
  })

  it('returns a JSON-RPC invalid request error for malformed MCP payloads', async () => {
    const app = express()
    app.use(express.json())
    app.use(createMcpRouter({
      server: new DzupAgentMCPServer({
        name: 'test-mcp',
        version: '1.0.0',
      }),
    }))

    const payload = JSON.stringify({ hello: 'world' })
    const req = createRequest('POST', '/mcp', payload, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
    })
    const res = createResponse(app)
    const state = await dispatch(app, req, res)

    expect(state.statusCode).toBe(400)
    expect(JSON.parse(state.chunks.join(''))).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: 'Invalid MCP request',
      },
    })
  })

  it('returns 204 for notification requests that do not expect a response', async () => {
    const handler = vi.fn(async () => 'ok')
    const app = express()
    app.use(express.json())
    app.use(createMcpRouter({
      server: new DzupAgentMCPServer({
        name: 'test-mcp',
        version: '1.0.0',
        tools: [{
          name: 'echo',
          description: 'Echo input',
          inputSchema: { type: 'object', properties: {} },
          handler,
        }],
      }),
    }))

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'echo',
        arguments: { text: 'hi' },
      },
    })
    const req = createRequest('POST', '/mcp', payload, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
    })
    const res = createResponse(app)
    const state = await dispatch(app, req, res)

    expect(state.statusCode).toBe(204)
    expect(state.chunks).toEqual([])
    expect(handler).toHaveBeenCalledWith({ text: 'hi' })
  })

  it('returns a 500 JSON-RPC envelope when the server handler throws', async () => {
    const onError = vi.fn()
    const crashingServer: MCPRequestHandler = {
      handleRequest: vi.fn(async () => {
        throw new Error('boom')
      }),
      listTools: () => [],
    }

    const app = express()
    app.use(express.json())
    app.use(createMcpRouter({
      server: crashingServer,
      hooks: { onError },
    }))

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 'abc',
      method: 'initialize',
    })
    const req = createRequest('POST', '/mcp', payload, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
    })
    const res = createResponse(app)
    const state = await dispatch(app, req, res)

    expect(state.statusCode).toBe(500)
    expect(JSON.parse(state.chunks.join(''))).toEqual({
      jsonrpc: '2.0',
      id: 'abc',
      error: {
        code: -32603,
        message: 'boom',
      },
    })
    expect(onError).toHaveBeenCalledWith(expect.any(Object), expect.any(Error), 'abc')
  })

  it('supports request-scoped server resolution for tenant-aware publishers', async () => {
    const app = express()
    app.use(express.json())
    app.use((req: Request, _res: Response, next: NextFunction) => {
      ;(req as Request & { tenantName?: string }).tenantName = req.headers['x-tenant'] === 'beta' ? 'beta' : 'alpha'
      next()
    })
    app.use(createMcpRouter({
      server: async (req) => {
        const tenantName = (req as Request & { tenantName?: string }).tenantName ?? 'alpha'
        return new DzupAgentMCPServer({
          name: `${tenantName}-mcp`,
          version: '1.0.0',
          tools: [{
            name: `echo-${tenantName}`,
            description: 'Tenant scoped echo',
            inputSchema: { type: 'object', properties: {} },
            handler: async () => tenantName,
          }],
        })
      },
    }))

    const alphaReq = createRequest('GET', '/mcp/tools', undefined, {})
    const alphaRes = createResponse(app)
    const alphaState = await dispatch(app, alphaReq, alphaRes)
    expect(alphaState.statusCode).toBe(200)
    expect(JSON.parse(alphaState.chunks.join(''))).toEqual({
      tools: [expect.objectContaining({ name: 'echo-alpha', serverId: 'alpha-mcp' })],
    })

    const betaReq = createRequest('GET', '/mcp/tools', undefined, { 'x-tenant': 'beta' })
    const betaRes = createResponse(app)
    const betaState = await dispatch(app, betaReq, betaRes)
    expect(betaState.statusCode).toBe(200)
    expect(JSON.parse(betaState.chunks.join(''))).toEqual({
      tools: [expect.objectContaining({ name: 'echo-beta', serverId: 'beta-mcp' })],
    })
  })
})
