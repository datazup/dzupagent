/**
 * A `fetch`-compatible function over a unix domain socket
 * (DZUP-OPENAI-IMAGES-20261113-R2).
 *
 * It exists so {@link createOpenAIImagesProvider} can reach a local metering
 * proxy that listens on a socket instead of a TCP port, for example
 * `baseUrl: 'http://meter/openai/v1'` with
 * `fetchImpl: createUnixSocketFetch({ socketPath })`. The URL's host only
 * fills the `Host` header; every request goes to `socketPath`.
 *
 * Scope is what that provider needs: `http:` URLs, a method, headers, a
 * string or byte body, an `AbortSignal`, and a streamed `Response` body. It
 * follows no redirect, adds no header beyond `Host` and `Content-Length`, and
 * keeps no connection alive between calls.
 */
import http from 'node:http'
import { Readable } from 'node:stream'
import { ForgeError } from '../errors/forge-error.js'

export interface UnixSocketFetchOptions {
  /** Absolute path of the socket. */
  socketPath: string
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

function urlOf(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === 'string') return new URL(input)
  if (input instanceof URL) return new URL(input.href)
  return new URL(input.url)
}

function bodyOf(body: RequestInit['body']): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string' || body instanceof Uint8Array) return body
  throw new TypeError('unix socket fetch accepts only a string or byte body')
}

/** Build the socket-bound fetch. Rejects a socket path that is not absolute. */
export function createUnixSocketFetch(options: UnixSocketFetchOptions): typeof fetch {
  const socketPath = options?.socketPath
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || socketPath.includes('\0')) {
    throw new ForgeError({ code: 'INVALID_CONFIG', message: 'unix socket fetch needs an absolute socket path' })
  }

  const socketFetch = (input: Parameters<typeof fetch>[0], init: RequestInit = {}): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const signal = init.signal ?? undefined
      if (signal?.aborted) {
        reject(abortReason(signal))
        return
      }
      let url: URL
      let body: string | Uint8Array | undefined
      try {
        url = urlOf(input)
        if (url.protocol !== 'http:') throw new TypeError('unix socket fetch supports http URLs only')
        body = bodyOf(init.body)
      } catch (error) {
        reject(error)
        return
      }
      const method = (init.method ?? 'GET').toUpperCase()
      const headers: Record<string, string> = {}
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value
      })
      headers['host'] = url.host
      if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))

      const req = http.request({ socketPath, path: `${url.pathname}${url.search}`, method, headers, agent: false })
      let settled = false
      const onAbort = (): void => {
        req.destroy(signal ? (abortReason(signal) as Error) : undefined)
      }
      const detach = (): void => signal?.removeEventListener('abort', onAbort)
      signal?.addEventListener('abort', onAbort, { once: true })

      req.on('response', (res) => {
        settled = true
        res.once('close', detach)
        const status = res.statusCode ?? 0
        if (status < 200 || status > 599) {
          res.destroy()
          reject(new TypeError('unix socket fetch got an invalid status'))
          return
        }
        const responseHeaders = new Headers()
        const raw = res.rawHeaders
        for (let i = 0; i + 1 < raw.length; i += 2) {
          try {
            responseHeaders.append(raw[i] as string, raw[i + 1] as string)
          } catch {
            // A header the WHATWG Headers class cannot hold is dropped, as fetch would refuse it.
          }
        }
        const stream =
          NULL_BODY_STATUS.has(status) || method === 'HEAD'
            ? null
            : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>)
        if (stream === null) res.resume()
        resolve(new Response(stream, { status, statusText: res.statusMessage ?? '', headers: responseHeaders }))
      })
      req.on('error', (error) => {
        detach()
        if (settled) return
        settled = true
        reject(signal?.aborted ? abortReason(signal) : new TypeError('unix socket fetch failed', { cause: error }))
      })
      req.end(body)
    })

  return socketFetch as typeof fetch
}
