/**
 * Deep coverage tests for the useApi composable.
 *
 * Covers: buildUrl, get/post/patch/del methods, handleResponse
 * error handling, ApiRequestError class, JSON parse failures,
 * custom headers, signal passing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildUrl, useApi, ApiRequestError } from '../composables/useApi.js'

// Mock global fetch
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response
}

function mockNonJsonResponse(status: number, text: string): Response {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error('not JSON')),
    text: () => Promise.resolve(text),
  } as Response
}

describe('useApi', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  // ── buildUrl ────────────────────────────────────────

  describe('buildUrl', () => {
    it('returns path unchanged when it starts with /', () => {
      expect(buildUrl('/api/health')).toBe('/api/health')
    })

    it('prepends / when path does not start with /', () => {
      expect(buildUrl('api/health')).toBe('/api/health')
    })
  })

  // ── ApiRequestError ─────────────────────────────────

  describe('ApiRequestError', () => {
    it('has correct properties', () => {
      const err = new ApiRequestError(404, 'NOT_FOUND', 'Resource not found')
      expect(err.status).toBe(404)
      expect(err.code).toBe('NOT_FOUND')
      expect(err.message).toBe('Resource not found')
      expect(err.name).toBe('ApiRequestError')
      expect(err).toBeInstanceOf(Error)
    })
  })

  // ── get ─────────────────────────────────────────────

  describe('get', () => {
    it('makes GET request and returns parsed JSON', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({ data: 'hello' }))
      const { get } = useApi()
      const result = await get<{ data: string }>('/api/test')
      expect(result).toEqual({ data: 'hello' })
      expect(fetchMock).toHaveBeenCalledWith('/api/test', expect.objectContaining({
        method: 'GET',
      }))
    })

    it('passes custom headers', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({ ok: true }))
      const { get } = useApi()
      await get('/api/test', { headers: { 'X-Custom': 'value' } })
      expect(fetchMock).toHaveBeenCalledWith('/api/test', expect.objectContaining({
        headers: expect.objectContaining({
          'X-Custom': 'value',
          'Content-Type': 'application/json',
        }),
      }))
    })

    it('passes abort signal', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({ ok: true }))
      const controller = new AbortController()
      const { get } = useApi()
      await get('/api/test', { signal: controller.signal })
      expect(fetchMock).toHaveBeenCalledWith('/api/test', expect.objectContaining({
        signal: controller.signal,
      }))
    })

    it('throws ApiRequestError on 4xx with JSON error body', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(
        { error: { code: 'NOT_FOUND', message: 'Agent not found' } },
        404,
      ))
      const { get } = useApi()
      await expect(get('/api/agents/missing')).rejects.toThrow(ApiRequestError)
      try {
        await get('/api/agents/missing')
      } catch (err) {
        // fetchMock returns different for second call, but the first throw was validated
      }
    })

    it('throws ApiRequestError with defaults on non-JSON error body', async () => {
      fetchMock.mockResolvedValueOnce(mockNonJsonResponse(500, 'Internal Server Error'))
      const { get } = useApi()
      try {
        await get('/api/broken')
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ApiRequestError)
        const apiErr = err as ApiRequestError
        expect(apiErr.status).toBe(500)
        expect(apiErr.code).toBe('UNKNOWN_ERROR')
        expect(apiErr.message).toContain('500')
      }
    })
  })

  // ── post ────────────────────────────────────────────

  describe('post', () => {
    it('makes POST request with JSON body', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({ id: '1' }))
      const { post } = useApi()
      const result = await post<{ id: string }>('/api/agents', { name: 'Test' })
      expect(result).toEqual({ id: '1' })
      expect(fetchMock).toHaveBeenCalledWith('/api/agents', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Test' }),
      }))
    })

    it('throws on error response', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(
        { error: { code: 'VALIDATION', message: 'Name required' } },
        400,
      ))
      const { post } = useApi()
      await expect(post('/api/agents', {})).rejects.toThrow('Name required')
    })
  })

  // ── patch ───────────────────────────────────────────

  describe('patch', () => {
    it('makes PATCH request with JSON body', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({ updated: true }))
      const { patch } = useApi()
      const result = await patch<{ updated: boolean }>('/api/agents/1', { name: 'New Name' })
      expect(result).toEqual({ updated: true })
      expect(fetchMock).toHaveBeenCalledWith('/api/agents/1', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ name: 'New Name' }),
      }))
    })
  })

  // ── del ─────────────────────────────────────────────

  describe('del', () => {
    it('makes DELETE request', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({ deleted: true }))
      const { del } = useApi()
      const result = await del<{ deleted: boolean }>('/api/agents/1')
      expect(result).toEqual({ deleted: true })
      expect(fetchMock).toHaveBeenCalledWith('/api/agents/1', expect.objectContaining({
        method: 'DELETE',
      }))
    })

    it('throws on error response', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(
        { error: { code: 'FORBIDDEN', message: 'Cannot delete' } },
        403,
      ))
      const { del } = useApi()
      await expect(del('/api/agents/1')).rejects.toThrow('Cannot delete')
    })
  })
})
