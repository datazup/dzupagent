import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { authMiddleware, type AuthConfig } from '../middleware/auth.js'

function createApp(config: AuthConfig): Hono {
  const app = new Hono()
  app.use('/api/*', authMiddleware(config))
  app.get('/api/agent-definitions', (c) => c.json({ ok: true }))
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.get('/api/health/ready', (c) => c.json({ ok: true }))
  return app
}

describe('authMiddleware', () => {
  // ----------- mode: none -----------

  it('passes all requests through when mode is "none"', async () => {
    const app = createApp({ mode: 'none' })
    const res = await app.request('/api/agent-definitions')
    expect(res.status).toBe(200)
  })

  // ----------- mode: api-key -----------

  it('returns 401 when Authorization header is missing', async () => {
    const app = createApp({
      mode: 'api-key',
      validateKey: async () => ({ id: 'k1' }),
    })
    const res = await app.request('/api/agent-definitions')
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns 401 when API key is invalid', async () => {
    const app = createApp({
      mode: 'api-key',
      validateKey: async () => null,
    })
    const res = await app.request('/api/agent-definitions', {
      headers: { Authorization: 'Bearer bad-key' },
    })
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('passes request through when API key is valid', async () => {
    const app = createApp({
      mode: 'api-key',
      validateKey: async (key) => (key === 'good-key' ? { id: 'k1' } : null),
    })
    const res = await app.request('/api/agent-definitions', {
      headers: { Authorization: 'Bearer good-key' },
    })
    expect(res.status).toBe(200)
  })

  it('returns 401 when Authorization header does not use Bearer scheme', async () => {
    const app = createApp({
      mode: 'api-key',
      validateKey: async (key) => (key === 'raw-token' ? { id: 'k2' } : null),
    })
    const res = await app.request('/api/agent-definitions', {
      headers: { Authorization: 'raw-token' },
    })
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(body.error.message).toBe('Authorization header must use Bearer scheme')
  })

  it('returns 401 for non-Bearer schemes such as Basic', async () => {
    const app = createApp({
      mode: 'api-key',
      validateKey: async () => ({ id: 'k1' }),
    })
    const res = await app.request('/api/agent-definitions', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    })
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toBe('Authorization header must use Bearer scheme')
  })

  it('skips auth for /api/health endpoints', async () => {
    const app = createApp({
      mode: 'api-key',
      validateKey: async () => null, // would reject any key
    })
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
  })

  it('skips auth for /api/health/ready', async () => {
    const app = createApp({
      mode: 'api-key',
      validateKey: async () => null,
    })
    const res = await app.request('/api/health/ready')
    expect(res.status).toBe(200)
  })

  it('returns 503 when validateKey is not configured but mode is api-key', async () => {
    const app = createApp({ mode: 'api-key' })
    const res = await app.request('/api/agent-definitions', {
      headers: { Authorization: 'Bearer some-key' },
    })
    expect(res.status).toBe(503)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_CONFIG')
  })

  it('returns 401 when Authorization header is empty string', async () => {
    const app = createApp({
      mode: 'api-key',
      validateKey: async () => ({ id: 'k1' }),
    })
    const res = await app.request('/api/agent-definitions', {
      headers: { Authorization: '' },
    })
    expect(res.status).toBe(401)
  })
})
