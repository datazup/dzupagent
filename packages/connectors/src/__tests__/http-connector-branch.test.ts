/**
 * Branch-coverage tests for the HTTP connector.
 *
 * Focused on paths that are not exercised by the happy-path suite:
 *  - non-Error rejections from fetch
 *  - query parameter merging
 *  - URL origin enforcement (SSRF guard)
 *  - allowedMethods filtering
 *  - body handling when `body` is undefined
 *  - clearTimeout runs in the finally branch
 *  - response body truncation at 5000 chars
 *  - toolkit wrapper
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHTTPConnector, createHttpConnectorToolkit } from '../http/http-connector.js'

describe('HTTP connector — branch coverage', () => {
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
      text: async () => 'body',
      ...response,
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  // -------------------------------------------------------------------------
  // Non-Error rejection from fetch (line 70 — String(err) branch)
  // -------------------------------------------------------------------------

  describe('non-Error rejections', () => {
    it('coerces string rejection via String() branch', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue('network borked'))
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/foo' })
      expect(result).toContain('Error: network borked')
    })

    it('coerces number rejection via String() branch', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(42))
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/foo' })
      expect(result).toContain('Error: 42')
    })

    it('coerces plain-object rejection via String() branch', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue({ code: 'boom' }))
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/foo' })
      expect(result).toContain('Error: [object Object]')
    })

    it('uses Error message when rejection is Error instance', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('real error')))
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/foo' })
      expect(result).toContain('Error: real error')
    })
  })

  // -------------------------------------------------------------------------
  // Method allow-list
  // -------------------------------------------------------------------------

  describe('allowedMethods enforcement', () => {
    it('rejects non-allowed method', async () => {
      mockFetch()
      const tools = createHTTPConnector({
        baseUrl: 'https://api.example.com',
        allowedMethods: ['GET'],
      })
      const result = await tools[0]!.invoke({ method: 'POST', path: '/create' })
      expect(result).toContain('Method POST not allowed')
      expect(result).toContain('Allowed: GET')
    })

    it('rejects DELETE when only GET/POST are allowed', async () => {
      mockFetch()
      const tools = createHTTPConnector({
        baseUrl: 'https://api.example.com',
        allowedMethods: ['GET', 'POST'],
      })
      const result = await tools[0]!.invoke({ method: 'DELETE', path: '/x' })
      expect(result).toContain('Method DELETE not allowed')
    })

    it('accepts all methods when allowedMethods not set', async () => {
      const mock = mockFetch()
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'PATCH', path: '/x' })
      expect(result).not.toContain('not allowed')
      expect(mock).toHaveBeenCalled()
    })

    it('description reflects allowedMethods', () => {
      const tools = createHTTPConnector({
        baseUrl: 'https://api.example.com',
        allowedMethods: ['GET', 'PATCH'],
      })
      expect(tools[0]!.description).toContain('GET, PATCH')
    })
  })

  // -------------------------------------------------------------------------
  // SSRF guard: URL origin enforcement
  // -------------------------------------------------------------------------

  describe('URL origin enforcement', () => {
    it('rejects absolute URL that escapes base origin', async () => {
      mockFetch()
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com/v1/' })
      const result = await tools[0]!.invoke({
        method: 'GET',
        path: 'https://attacker.example/cat',
      })
      expect(result).toContain('does not match base origin')
      expect(result).toContain('Absolute URLs are not allowed')
    })

    it('allows relative path within base', async () => {
      const mock = mockFetch()
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com/v1/' })
      await tools[0]!.invoke({ method: 'GET', path: 'users/1' })
      const calledUrl = mock.mock.calls[0]?.[0] as string
      expect(calledUrl).toContain('api.example.com')
      expect(calledUrl).toContain('users/1')
    })

    it('allows absolute path on same origin', async () => {
      const mock = mockFetch()
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com/v1/' })
      await tools[0]!.invoke({ method: 'GET', path: '/health' })
      const calledUrl = mock.mock.calls[0]?.[0] as string
      expect(calledUrl).toContain('api.example.com/health')
    })
  })

  // -------------------------------------------------------------------------
  // Query parameter merging
  // -------------------------------------------------------------------------

  describe('query parameter handling', () => {
    it('applies multiple query params', async () => {
      const mock = mockFetch()
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      await tools[0]!.invoke({
        method: 'GET',
        path: '/search',
        query: { q: 'dogs', limit: '20', page: '3' },
      })
      const calledUrl = new URL(mock.mock.calls[0]?.[0] as string)
      expect(calledUrl.searchParams.get('q')).toBe('dogs')
      expect(calledUrl.searchParams.get('limit')).toBe('20')
      expect(calledUrl.searchParams.get('page')).toBe('3')
    })

    it('works without query parameter', async () => {
      const mock = mockFetch()
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      await tools[0]!.invoke({ method: 'GET', path: '/no-query' })
      const calledUrl = new URL(mock.mock.calls[0]?.[0] as string)
      expect(calledUrl.search).toBe('')
    })

    it('handles empty query object', async () => {
      const mock = mockFetch()
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      await tools[0]!.invoke({ method: 'GET', path: '/path', query: {} })
      const calledUrl = new URL(mock.mock.calls[0]?.[0] as string)
      expect(calledUrl.search).toBe('')
    })
  })

  // -------------------------------------------------------------------------
  // Body handling branches
  // -------------------------------------------------------------------------

  describe('request body handling', () => {
    it('sends undefined body when not provided', async () => {
      const mock = mockFetch()
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      await tools[0]!.invoke({ method: 'POST', path: '/x' })
      const init = mock.mock.calls[0]?.[1] as RequestInit
      expect(init.body).toBeUndefined()
    })

    it('sends the provided body string', async () => {
      const mock = mockFetch()
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      await tools[0]!.invoke({
        method: 'POST',
        path: '/x',
        body: '{"name":"alice"}',
      })
      const init = mock.mock.calls[0]?.[1] as RequestInit
      expect(init.body).toBe('{"name":"alice"}')
    })
  })

  // -------------------------------------------------------------------------
  // Response body truncation
  // -------------------------------------------------------------------------

  describe('response body truncation', () => {
    it('truncates responses longer than 5000 chars', async () => {
      const huge = 'x'.repeat(10_000)
      mockFetch({ text: async () => huge })
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/big' })
      const body = result.split('\n\n')[1] ?? ''
      expect(body.length).toBe(5000)
    })

    it('keeps responses shorter than 5000 chars intact', async () => {
      mockFetch({ text: async () => 'hello world' })
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      const result = await tools[0]!.invoke({ method: 'GET', path: '/small' })
      expect(result).toContain('hello world')
    })
  })

  // -------------------------------------------------------------------------
  // clearTimeout happens in finally regardless of success/failure
  // -------------------------------------------------------------------------

  describe('timeout cleanup', () => {
    it('clears timeout on success', async () => {
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
      mockFetch()
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      await tools[0]!.invoke({ method: 'GET', path: '/ok' })
      expect(clearSpy).toHaveBeenCalled()
      clearSpy.mockRestore()
    })

    it('clears timeout on failure', async () => {
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('nope')))
      const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
      await tools[0]!.invoke({ method: 'GET', path: '/err' })
      expect(clearSpy).toHaveBeenCalled()
      clearSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // Toolkit wrapper
  // -------------------------------------------------------------------------

  describe('createHttpConnectorToolkit', () => {
    it('returns a toolkit with name "http"', () => {
      const kit = createHttpConnectorToolkit({ baseUrl: 'https://api.example.com' })
      expect(kit.name).toBe('http')
      expect(kit.tools).toHaveLength(1)
      expect(kit.tools[0]!.name).toBe('http_request')
    })

    it('respects allowedMethods through the toolkit factory', () => {
      const kit = createHttpConnectorToolkit({
        baseUrl: 'https://api.example.com',
        allowedMethods: ['GET'],
      })
      expect(kit.tools[0]!.description).toContain('GET')
      expect(kit.tools[0]!.description).not.toContain('POST')
    })
  })
})
