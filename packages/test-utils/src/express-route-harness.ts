import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { Express, Request, Response } from 'express'

export interface ExpressRouteHarnessState {
  statusCode: number
  headers: Record<string, string>
  chunks: string[]
  ended: boolean
}

export type ExpressRouteHarnessResponse = Response & {
  state: ExpressRouteHarnessState
  payload?: unknown
}

export interface ExpressRouteDispatchInput {
  method: string
  url: string
  body?: unknown
  headers?: Record<string, string>
  originalUrl?: string
  params?: Record<string, string>
  query?: Record<string, unknown>
  timeoutMs?: number
}

export interface ExpressRouteHarness {
  dispatch(input: ExpressRouteDispatchInput): Promise<ExpressRouteHarnessResponse>
}

export function createExpressRouteHarness(
  createApp: () => Express,
  options: {
    originalUrl?: (url: string) => string
    defaultTimeoutMs?: number
  } = {},
): ExpressRouteHarness {
  return {
    dispatch: async (input) => {
      const app = createApp()
      const req = createRequest({
        method: input.method,
        url: input.url,
        originalUrl: input.originalUrl ?? options.originalUrl?.(input.url) ?? input.url,
        body: input.body,
        headers: input.headers ?? {},
        params: input.params ?? {},
        query: input.query ?? {},
      })
      const res = createResponse(app)

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${input.method} ${input.url} to finish`))
        }, input.timeoutMs ?? options.defaultTimeoutMs ?? 1500)

        const onFinish = (): void => {
          clearTimeout(timeout)
          setImmediate(resolve)
        }

        res.once('finish', onFinish)
        res.once('error', (err) => {
          clearTimeout(timeout)
          reject(err)
        })

        ;(app as Express & {
          handle: (req: Request, res: Response, next: (err?: unknown) => void) => void
        }).handle(req, res, (err?: unknown) => {
          clearTimeout(timeout)
          if (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })
      })

      return res
    },
  }
}

function createRequest(input: {
  method: string
  url: string
  originalUrl: string
  body: unknown
  headers: Record<string, string>
  params: Record<string, string>
  query: Record<string, unknown>
}): Request {
  const stream = Readable.from([]) as Readable & Partial<Request>
  stream.method = input.method
  stream.url = input.url
  stream.originalUrl = input.originalUrl
  stream.body = input.body
  stream.headers = Object.fromEntries(
    Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value]),
  ) as Request['headers']
  stream.params = input.params
  stream.query = input.query as Request['query']
  return stream as Request
}

function createResponse(app: Express): ExpressRouteHarnessResponse {
  const emitter = new EventEmitter()
  const state: ExpressRouteHarnessState = {
    statusCode: 200,
    headers: {},
    chunks: [],
    ended: false,
  }

  const res = emitter as ExpressRouteHarnessResponse & {
    app: Express
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
      state.headers[name.toLowerCase()] = String(value)
    }
    return res
  }

  res.write = (chunk) => {
    if (chunk !== undefined && chunk !== null) {
      state.chunks.push(toChunkString(chunk))
    }
    return true
  }

  ;(res as Response & { json: (body: unknown) => Response }).json = (body: unknown) => {
    res.payload = body
    state.ended = true
    res.emit('finish')
    return res
  }

  res.end = (chunk?: unknown) => {
    if (chunk !== undefined && chunk !== null) {
      res.payload = chunk
      state.chunks.push(toChunkString(chunk))
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

function toChunkString(chunk: unknown): string {
  if (typeof chunk === 'string') {
    return chunk
  }

  return Buffer.from(chunk as Uint8Array).toString()
}
