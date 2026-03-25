/**
 * Tests for the HTTP connector — covers request building, method filtering,
 * query params, timeout, headers, error handling, and response truncation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHTTPConnector } from '../http/http-connector.js'

describe('HTTP connector', () => {
  const originalFetch = globalThis.fetch

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

  it('sends GET request to correct URL', async () => {
    const mock = mockFetch()
    const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
    await tools[0]!.invoke({ method: 'GET', path: '/users' })

    expect(mock).toHaveBeenCalledWith(
      'https://api.example.com/users',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('sends POST request with body', async () => {
    const mock = mockFetch()
    const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
    const body = JSON.stringify({ name: 'Test' })
    await tools[0]!.invoke({ method: 'POST', path: '/users', body })

    expect(mock).toHaveBeenCalledWith(
      'https://api.example.com/users',
      expect.objectContaining({ method: 'POST', body }),
    )
  })

  it('appends query parameters to URL', async () => {
    const mock = mockFetch()
    const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
    await tools[0]!.invoke({ method: 'GET', path: '/users', query: { page: '2', limit: '10' } })

    const calledUrl = mock.mock.calls[0]![0] as string
    expect(calledUrl).toContain('page=2')
    expect(calledUrl).toContain('limit=10')
  })

  it('includes custom headers in request', async () => {
    const mock = mockFetch()
    const tools = createHTTPConnector({
      baseUrl: 'https://api.example.com',
      headers: { 'X-Api-Key': 'secret-key' },
    })
    await tools[0]!.invoke({ method: 'GET', path: '/data' })

    const calledInit = mock.mock.calls[0]![1] as RequestInit
    const headers = calledInit.headers as Record<string, string>
    expect(headers['X-Api-Key']).toBe('secret-key')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('returns status code and body in response', async () => {
    mockFetch({
      status: 201,
      statusText: 'Created',
      text: async () => '{"id":42}',
    })
    const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
    const result = await tools[0]!.invoke({ method: 'POST', path: '/items', body: '{}' })

    expect(result).toContain('201 Created')
    expect(result).toContain('{"id":42}')
  })

  it('rejects disallowed HTTP method', async () => {
    const tools = createHTTPConnector({
      baseUrl: 'https://api.example.com',
      allowedMethods: ['GET', 'POST'],
    })
    const result = await tools[0]!.invoke({ method: 'DELETE', path: '/items/1' })

    expect(result).toContain('not allowed')
    expect(result).toContain('DELETE')
  })

  it('allows methods in the allowedMethods list', async () => {
    mockFetch()
    const tools = createHTTPConnector({
      baseUrl: 'https://api.example.com',
      allowedMethods: ['GET', 'PATCH'],
    })
    const result = await tools[0]!.invoke({ method: 'PATCH', path: '/items/1', body: '{}' })

    expect(result).toContain('200 OK')
  })

  it('handles fetch errors gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')))
    const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
    const result = await tools[0]!.invoke({ method: 'GET', path: '/health' })

    expect(result).toContain('Error')
    expect(result).toContain('Network failure')
  })

  it('truncates response body to 5000 characters', async () => {
    const longBody = 'x'.repeat(6000)
    mockFetch({ text: async () => longBody })
    const tools = createHTTPConnector({ baseUrl: 'https://api.example.com' })
    const result = await tools[0]!.invoke({ method: 'GET', path: '/large' })

    // Status line + \n\n + truncated body
    const bodyPart = result.split('\n\n')[1]!
    expect(bodyPart.length).toBe(5000)
  })

  it('handles abort timeout by returning error', async () => {
    // Simulate a request that takes too long by never resolving
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('The operation was aborted')), 50)
      }),
    ))
    const tools = createHTTPConnector({
      baseUrl: 'https://api.example.com',
      timeoutMs: 10,
    })
    const result = await tools[0]!.invoke({ method: 'GET', path: '/slow' })

    expect(result).toContain('Error')
  })
})
