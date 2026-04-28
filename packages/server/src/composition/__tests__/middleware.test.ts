/**
 * Focused tests for the middleware composition. Each test exercises a single
 * concern (CORS warning, shutdown guard, error handler, auth wiring) using a
 * fresh Hono instance, so a regression in one helper cannot mask another.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'

import { applyMiddleware, assertExplicitFrameworkApiAuth } from '../middleware.js'
import { GracefulShutdown } from '../../lifecycle/graceful-shutdown.js'
import type { ForgeServerConfig } from '../types.js'
import { createForgeApp } from '../../app.js'

function baseConfig(overrides: Partial<ForgeServerConfig> = {}): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('composition/middleware', () => {
  it('does not emit CORS headers by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const app = new Hono()
    applyMiddleware(app, baseConfig())
    app.get('/api/health', (c) => c.json({ ok: true }))

    const res = await app.request('/api/health', {
      headers: { Origin: 'https://app.example.com' },
    })

    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('access-control-allow-headers')).toBeNull()
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('CORS is open to all origins'))
  })

  it('does not warn when corsOrigins is set to an explicit allow-list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const app = new Hono()
    applyMiddleware(app, baseConfig({
      auth: { mode: 'api-key', validateKey: async () => null },
      corsOrigins: 'https://app.example.com',
    }))
    expect(warn).not.toHaveBeenCalled()
  })

  it('allows configured CORS allow-list origins', async () => {
    const app = new Hono()
    applyMiddleware(app, baseConfig({ corsOrigins: 'https://app.example.com' }))
    app.get('/api/health', (c) => c.json({ ok: true }))

    const allowed = await app.request('/api/health', {
      headers: { Origin: 'https://app.example.com' },
    })
    const denied = await app.request('/api/health', {
      headers: { Origin: 'https://evil.example.com' },
    })

    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('supports wildcard CORS only with an explicit compatibility opt-in', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const app = new Hono()
    applyMiddleware(app, baseConfig({ allowWildcardCors: true }))
    app.get('/api/health', (c) => c.json({ ok: true }))

    const res = await app.request('/api/health', {
      headers: { Origin: 'https://app.example.com' },
    })

    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CORS is open to all origins'))
  })

  it('rejects production wildcard CORS without the compatibility opt-in', () => {
    vi.stubEnv('NODE_ENV', 'production')

    expect(() => createForgeApp(baseConfig({
      auth: { mode: 'api-key', validateKey: async () => null },
      corsOrigins: '*',
    }))).toThrow(/Refusing wildcard CORS in production/)
  })

  it('answers CORS preflight for configured allow-list origins', async () => {
    const app = new Hono()
    applyMiddleware(app, baseConfig({ corsOrigins: ['https://app.example.com'] }))
    app.post('/api/runs', (c) => c.json({ ok: true }))

    const res = await app.request('/api/runs', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization')
  })

  it('warns when framework /api routes are created without explicit auth outside production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    assertExplicitFrameworkApiAuth(baseConfig())

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/api/* routes are running without authentication'))
  })

  it('throws a startup error when production framework /api routes omit auth', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => createForgeApp(baseConfig({ corsOrigins: 'https://app.example.com' })))
      .toThrow(/Refusing to start production framework \/api\/\* routes without explicit auth/)
    expect(warn).not.toHaveBeenCalled()
  })

  it('allows explicit auth none as a development or compatibility opt-out with a warning', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => createForgeApp(baseConfig({
      auth: { mode: 'none' },
      corsOrigins: 'https://app.example.com',
    }))).not.toThrow()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('auth.mode="none" only for local development'))
  })

  it('adds safe default security headers without removing CORS headers', async () => {
    const app = new Hono()
    applyMiddleware(app, baseConfig({ corsOrigins: 'https://app.example.com' }))
    app.get('/api/health', (c) => c.json({ ok: true }))

    const res = await app.request('/api/health', {
      headers: { Origin: 'https://app.example.com' },
    })

    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
  })

  it('allows hosts to override and disable individual security headers', async () => {
    const app = new Hono()
    applyMiddleware(app, baseConfig({
      securityHeaders: {
        xContentTypeOptions: false,
        referrerPolicy: 'same-origin',
        additionalHeaders: {
          'Permissions-Policy': 'geolocation=()',
        },
      },
    }))
    app.get('/api/health', (c) => c.json({ ok: true }))

    const res = await app.request('/api/health')

    expect(res.headers.get('x-content-type-options')).toBeNull()
    expect(res.headers.get('referrer-policy')).toBe('same-origin')
    expect(res.headers.get('permissions-policy')).toBe('geolocation=()')
  })

  it('allows hosts to disable security headers entirely', async () => {
    const app = new Hono()
    applyMiddleware(app, baseConfig({ securityHeaders: false }))
    app.get('/api/health', (c) => c.json({ ok: true }))

    const res = await app.request('/api/health')

    expect(res.headers.get('x-content-type-options')).toBeNull()
    expect(res.headers.get('referrer-policy')).toBeNull()
  })

  it('keeps auth middleware behavior while adding security headers to auth errors', async () => {
    const app = new Hono()
    applyMiddleware(app, baseConfig({
      auth: {
        mode: 'api-key',
        validateKey: async () => null,
      },
    }))
    app.get('/api/runs', (c) => c.json({ runs: [] }))

    const res = await app.request('/api/runs')
    const body = await res.json() as { error: { code: string } }

    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('returns 503 from POST /api/runs while shutdown is draining', async () => {
    const shutdown = new GracefulShutdown({
      drainTimeoutMs: 1_000,
      runStore: new InMemoryRunStore(),
      eventBus: createEventBus(),
    })
    // Force the guard predicate to report not accepting runs.
    vi.spyOn(shutdown, 'isAcceptingRuns').mockReturnValue(false)

    const app = new Hono()
    applyMiddleware(app, baseConfig({ shutdown }))
    // Provide a downstream POST handler so the guard's 503 is observable.
    app.post('/api/runs', (c) => c.json({ ok: true }))

    const res = await app.request('/api/runs', { method: 'POST' })
    expect(res.status).toBe(503)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE')
  })

  it('returns 500 with INTERNAL_ERROR envelope from the global error handler', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = new Hono()
    applyMiddleware(app, baseConfig())
    app.get('/boom', () => {
      throw new Error('kaboom')
    })

    const res = await app.request('/boom')
    expect(res.status).toBe(500)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(body.error.message).toBe('Internal server error')
    expect(errSpy).toHaveBeenCalled()
  })

  it('returns no auth when config.auth is omitted', () => {
    const app = new Hono()
    const { effectiveAuth } = applyMiddleware(app, baseConfig())
    expect(effectiveAuth).toBeUndefined()
  })

  it('threads apiKeyStore.validate into the resolved auth config when no validateKey was supplied', async () => {
    const app = new Hono()
    const validate = vi.fn(async (key: string) => key === 'good' ? { id: 'k1', role: 'user' } : null)
    const apiKeyStore = { validate } as unknown as ForgeServerConfig['apiKeyStore']

    const { effectiveAuth } = applyMiddleware(
      app,
      baseConfig({
        auth: { mode: 'api-key' },
        apiKeyStore,
      }),
    )
    expect(effectiveAuth?.mode).toBe('api-key')
    expect(typeof effectiveAuth?.validateKey).toBe('function')

    const out = await effectiveAuth!.validateKey!('good')
    expect(out).toMatchObject({ id: 'k1', role: 'user' })
    expect(validate).toHaveBeenCalledWith('good')
  })
})
