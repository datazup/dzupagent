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

import { applyMiddleware } from '../middleware.js'
import { GracefulShutdown } from '../../lifecycle/graceful-shutdown.js'
import type { ForgeServerConfig } from '../types.js'

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
})

describe('composition/middleware', () => {
  it('warns when CORS is left open to all origins', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const app = new Hono()
    applyMiddleware(app, baseConfig())
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CORS is open to all origins'))
  })

  it('does not warn when corsOrigins is set to an explicit allow-list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const app = new Hono()
    applyMiddleware(app, baseConfig({ corsOrigins: 'https://app.example.com' }))
    expect(warn).not.toHaveBeenCalled()
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
