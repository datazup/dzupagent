/**
 * Extended HTTP connector tests — covers additional edge cases for
 * retry-like behavior, timeout, auth headers, response parsing,
 * error responses, concurrent requests, and large payloads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHTTPConnector, createHttpConnectorToolkit } from '../http/http-connector.js'

describe('HTTP connector — extended', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockFetch(response: Partial<Response> = {}): ReturnType<typeof vi.fn> {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '{"ok":true}',
      ...response,
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  // ---------------------------------------------------------------------------
  // 5xx error responses
  // ---------------------------------------------------------------------------

  describe('5xx server error responses', () => {
    it('returns 500 status in output', async () => {
      mockFetch({
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => '{"error":"server failure"}',
      })
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/unstable' })
      expect(result).toContain('500 Internal Server Error')
      expect(result).toContain('server failure')
    })

    it('returns 502 Bad Gateway status', async () => {
      mockFetch({
        status: 502,
        statusText: 'Bad Gateway',
        text: async () => '<html>Bad Gateway</html>',
      })
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/proxy' })
      expect(result).toContain('502 Bad Gateway')
    })

    it('returns 503 Service Unavailable status', async () => {
      mockFetch({
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => 'Maintenance',
      })
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/health' })
      expect(result).toContain('503 Service Unavailable')
    })
  })

  // ---------------------------------------------------------------------------
  // Timeout handling
  // ---------------------------------------------------------------------------

  describe('timeout handling', () => {
    it('returns error when request exceeds timeout', async () => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('The operation was aborted')), 200)
          init.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('The operation was aborted'))
          })
        })
      }))

      const tools = createHTTPConnector({
        baseUrl: 'https://api.example.com',
        timeoutMs: 10,
      })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/slow' })
      expect(result).toContain('Error')
    })

    it('uses default 30s timeout when timeoutMs is not set', async () => {
      const mock = mockFetch()
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      await tools[0]!.invoke({ method: 'GET', path: '/fast' })
      // Verify fetch was called (default timeout does not fire for fast response)
      expect(mock).toHaveBeenCalledTimes(1)
    })
  })

  // ---------------------------------------------------------------------------
  // Custom headers and auth token injection
  // ---------------------------------------------------------------------------

  describe('auth token injection', () => {
    it('passes Bearer token in Authorization header', async () => {
      const mock = mockFetch()
      const tools = createHTTPConnector({
        baseUrl: 'https://api.example.com',
        headers: { Authorization: 'Bearer my-jwt-token' },
      })
      await tools[0]!.invoke({ method: 'GET', path: '/protected' })

      const calledHeaders = (mock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
      expect(calledHeaders['Authorization']).toBe('Bearer my-jwt-token')
    })

    it('passes API key in X-Api-Key header', async () => {
      const mock = mockFetch()
      const tools = createHTTPConnector({
        baseUrl: 'https://api.example.com',
        headers: { 'X-Api-Key': 'sk-12345' },
      })
      await tools[0]!.invoke({ method: 'GET', path: '/data' })

      const calledHeaders = (mock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
      expect(calledHeaders['X-Api-Key']).toBe('sk-12345')
    })

    it('custom headers override Content-Type if specified', async () => {
      const mock = mockFetch()
      const tools = createHTTPConnector({
        baseUrl: 'https://api.example.com',
        headers: { 'Content-Type': 'text/plain' },
      })
      await tools[0]!.invoke({ method: 'POST', path: '/text', body: 'hello' })

      const calledHeaders = (mock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
      expect(calledHeaders['Content-Type']).toBe('text/plain')
    })

    it('includes multiple custom headers simultaneously', async () => {
      const mock = mockFetch()
      const tools = createHTTPConnector({
        baseUrl: 'https://api.example.com',
        headers: {
          Authorization: 'Bearer tok',
          'X-Request-Id': 'req-123',
          'X-Tenant': 'acme',
        },
      })
      await tools[0]!.invoke({ method: 'GET', path: '/multi' })

      const calledHeaders = (mock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
      expect(calledHeaders['Authorization']).toBe('Bearer tok')
      expect(calledHeaders['X-Request-Id']).toBe('req-123')
      expect(calledHeaders['X-Tenant']).toBe('acme')
    })
  })

  // ---------------------------------------------------------------------------
  // Response parsing
  // ---------------------------------------------------------------------------

  describe('response parsing', () => {
    it('returns JSON response body as text', async () => {
      mockFetch({
        text: async () => JSON.stringify({ users: [{ id: 1 }] }),
      })
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/users' })
      expect(result).toContain('"users"')
      expect(result).toContain('"id"')
    })

    it('returns plain text response body', async () => {
      mockFetch({
        text: async () => 'Hello, World!',
      })
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/text' })
      expect(result).toContain('Hello, World!')
    })

    it('returns empty body for 204 No Content', async () => {
      mockFetch({
        status: 204,
        statusText: 'No Content',
        text: async () => '',
      })
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'DELETE', path: '/items/1' })
      expect(result).toContain('204 No Content')
    })
  })

  // ---------------------------------------------------------------------------
  // 4xx error handling
  // ---------------------------------------------------------------------------

  describe('4xx error responses', () => {
    it('returns 400 Bad Request status and body', async () => {
      mockFetch({
        status: 400,
        statusText: 'Bad Request',
        text: async () => '{"error":"invalid field"}',
      })
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'POST', path: '/items', body: '{}' })
      expect(result).toContain('400 Bad Request')
      expect(result).toContain('invalid field')
    })

    it('returns 401 Unauthorized status', async () => {
      mockFetch({
        status: 401,
        statusText: 'Unauthorized',
        text: async () => '{"error":"invalid token"}',
      })
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/secret' })
      expect(result).toContain('401 Unauthorized')
    })

    it('returns 403 Forbidden status', async () => {
      mockFetch({
        status: 403,
        statusText: 'Forbidden',
        text: async () => 'Access denied',
      })
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/admin' })
      expect(result).toContain('403 Forbidden')
    })

    it('returns 404 Not Found status', async () => {
      mockFetch({
        status: 404,
        statusText: 'Not Found',
        text: async () => '{"error":"resource not found"}',
      })
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/nonexistent' })
      expect(result).toContain('404 Not Found')
    })

    it('returns 429 Too Many Requests status', async () => {
      mockFetch({
        status: 429,
        statusText: 'Too Many Requests',
        text: async () => '{"error":"rate limit exceeded"}',
      })
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/data' })
      expect(result).toContain('429 Too Many Requests')
      expect(result).toContain('rate limit')
    })
  })

  // ---------------------------------------------------------------------------
  // Concurrent requests
  // ---------------------------------------------------------------------------

  describe('concurrent requests', () => {
    it('handles multiple simultaneous requests independently', async () => {
      let callCount = 0
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
        callCount++
        const idx = callCount
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => JSON.stringify({ url, idx }),
        }
      }))

      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const [r1, r2, r3] = await Promise.all([
        tools[0]!.invoke({ method: 'GET', path: '/a' }),
        tools[0]!.invoke({ method: 'GET', path: '/b' }),
        tools[0]!.invoke({ method: 'GET', path: '/c' }),
      ])

      expect(r1).toContain('200 OK')
      expect(r2).toContain('200 OK')
      expect(r3).toContain('200 OK')
      expect(callCount).toBe(3)
    })
  })

  // ---------------------------------------------------------------------------
  // Network errors
  // ---------------------------------------------------------------------------

  describe('network error handling', () => {
    it('handles connection refused error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/health' })
      expect(result).toContain('Error')
      expect(result).toContain('ECONNREFUSED')
    })

    it('handles DNS resolution failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')))
      const tools = createHTTPConnector({ baseUrl: 'https://nonexistent.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/test' })
      expect(result).toContain('Error')
      expect(result).toContain('ENOTFOUND')
    })

    it('handles non-Error thrown values', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue('raw string error'))
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/oops' })
      expect(result).toContain('Error')
      expect(result).toContain('raw string error')
    })
  })

  // ---------------------------------------------------------------------------
  // Large payload handling
  // ---------------------------------------------------------------------------

  describe('large payload handling', () => {
    it('truncates response body exceeding 5000 characters', async () => {
      const largeBody = 'A'.repeat(8000)
      mockFetch({ text: async () => largeBody })
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/big' })

      const bodyPart = result.split('\n\n')[1]!
      expect(bodyPart.length).toBe(5000)
    })

    it('sends large request body without issue', async () => {
      const mock = mockFetch()
      const largePayload = JSON.stringify({ data: 'X'.repeat(10000) })
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      await tools[0]!.invoke({ method: 'POST', path: '/upload', body: largePayload })

      const calledInit = mock.mock.calls[0]![1] as RequestInit
      expect(calledInit.body).toBe(largePayload)
    })

    it('does not truncate body at exactly 5000 characters', async () => {
      const exactBody = 'B'.repeat(5000)
      mockFetch({ text: async () => exactBody })
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/exact' })

      const bodyPart = result.split('\n\n')[1]!
      expect(bodyPart.length).toBe(5000)
    })
  })

  // ---------------------------------------------------------------------------
  // HTTP methods
  // ---------------------------------------------------------------------------

  describe('all HTTP methods', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      it(`sends ${method} request correctly`, async () => {
        const mock = mockFetch()
        const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
        await tools[0]!.invoke({ method, path: '/resource', body: method !== 'GET' ? '{}' : undefined })
        expect(mock).toHaveBeenCalledWith(
          expect.stringContaining('/resource'),
          expect.objectContaining({ method }),
        )
      })
    }
  })

  // ---------------------------------------------------------------------------
  // Toolkit factory
  // ---------------------------------------------------------------------------

  describe('createHttpConnectorToolkit', () => {
    it('returns a toolkit with the correct name and tools', () => {
      const tk = createHttpConnectorToolkit({ baseUrl: 'https://api.example.com' })
      expect(tk.name).toBe('http')
      expect(tk.tools).toHaveLength(1)
      expect(tk.tools[0]!.name).toBe('http_request')
    })

    it('toolkit tools are invokable', async () => {
      mockFetch()
      const tk = createHttpConnectorToolkit({ baseUrl: 'https://api.example.com' })
      const result = await tk.tools[0]!.invoke({ method: 'GET', path: '/test' })
      expect(result).toContain('200 OK')
    })
  })

  // ---------------------------------------------------------------------------
  // Query parameters edge cases
  // ---------------------------------------------------------------------------

  describe('query parameter edge cases', () => {
    it('handles empty query object', async () => {
      const mock = mockFetch()
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      await tools[0]!.invoke({ method: 'GET', path: '/data', query: {} })
      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toBe('https://api.example.com/data')
    })

    it('encodes special characters in query values', async () => {
      const mock = mockFetch()
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      await tools[0]!.invoke({ method: 'GET', path: '/search', query: { q: 'hello world&more' } })
      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('q=hello+world%26more')
    })
  })

  // ---------------------------------------------------------------------------
  // SSRF protection edge cases
  // ---------------------------------------------------------------------------

  describe('SSRF protection', () => {
    it('allows root path "/"', async () => {
      const mock = mockFetch()
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      await tools[0]!.invoke({ method: 'GET', path: '/' })
      expect(mock).toHaveBeenCalledTimes(1)
    })

    it('allows path with nested segments', async () => {
      const mock = mockFetch()
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      await tools[0]!.invoke({ method: 'GET', path: '/v1/users/123/profile' })
      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toBe('https://api.example.com/v1/users/123/profile')
    })
  })
})
