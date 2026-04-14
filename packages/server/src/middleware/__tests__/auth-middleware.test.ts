import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { authMiddleware, type AuthConfig } from '../auth.js'

function createApp(config: AuthConfig) {
  const app = new Hono()
  app.use('*', authMiddleware(config))
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.get('/protected', (c) => c.json({ ok: true }))
  return app
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('authMiddleware', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const validateKey = vi.fn().mockResolvedValue({ id: 'key-meta' })
    const app = createApp({ mode: 'api-key', validateKey })

    const res = await app.request('/protected')

    expect(res.status).toBe(401)
    expect(validateKey).not.toHaveBeenCalled()
    await expect(res.json()).resolves.toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing Authorization header',
      },
    })
  })

  it('returns 401 when the API key is invalid', async () => {
    const validateKey = vi.fn().mockResolvedValue(null)
    const app = createApp({ mode: 'api-key', validateKey })

    const res = await app.request('/protected', {
      headers: { Authorization: 'Bearer bad-key' },
    })

    expect(res.status).toBe(401)
    expect(validateKey).toHaveBeenCalledOnce()
    expect(validateKey).toHaveBeenCalledWith('bad-key')
    await expect(res.json()).resolves.toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid API key',
      },
    })
  })

  it('allows requests with a valid API key', async () => {
    const validateKey = vi.fn().mockResolvedValue({ id: 'key-meta', role: 'admin' })
    const app = createApp({ mode: 'api-key', validateKey })

    const res = await app.request('/protected', {
      headers: { Authorization: 'Bearer good-key' },
    })

    expect(res.status).toBe(200)
    expect(validateKey).toHaveBeenCalledOnce()
    expect(validateKey).toHaveBeenCalledWith('good-key')
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  it('returns 503 when api-key mode is configured without validateKey', async () => {
    const app = createApp({ mode: 'api-key' })

    const res = await app.request('/protected')

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: 'INVALID_CONFIG',
        message: 'API key auth is enabled but no validateKey function was configured',
      },
    })
  })

  it('still bypasses health endpoints when validateKey is missing', async () => {
    const app = createApp({ mode: 'api-key' })

    const res = await app.request('/api/health')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  it('preserves passthrough behavior when mode is none', async () => {
    const app = createApp({ mode: 'none' })

    const res = await app.request('/protected')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })
})
