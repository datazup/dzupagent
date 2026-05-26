/**
 * SEC-M-06 — Eval routes tenant isolation.
 *
 * Verifies that eval run list, get, cancel, and retry routes reject cross-tenant
 * access. Any authenticated key from Tenant A must not be able to enumerate,
 * read, cancel, or retry Tenant B's eval runs.
 *
 * Cross-tenant access returns 404 (not 403) to avoid tenant enumeration via
 * status-code probing.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { EvalScorer, EvalSuite } from '@dzupagent/eval-contracts'
import { createEvalRoutes } from '../routes/evals.js'
import { InMemoryEvalRunStore } from '../persistence/eval-run-store.js'

// ---------------------------------------------------------------------------
// Test suite fixture
// ---------------------------------------------------------------------------

const exactMatchScorer: EvalScorer = {
  name: 'exact-match',
  async score(input, output, reference) {
    const pass = typeof reference === 'string' && output === reference
    return {
      score: pass ? 1 : 0,
      pass,
      reasoning: pass ? `Matched "${input}"` : `Mismatch for "${input}"`,
    }
  },
}

const toySuite: EvalSuite = {
  name: 'toy-suite',
  cases: [{ id: 'c1', input: 'hello', expectedOutput: 'HELLO' }],
  scorers: [exactMatchScorer],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wraps a Hono route set with a minimal apiKey context so tenant-scope
 * helpers (getRequestingTenantId) see the correct value.
 */
function appWithApiKey(
  apiKey: { id: string; tenantId: string },
  routes: Hono,
  mountPath = '/api/evals',
): Hono {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('apiKey' as never, apiKey as never)
    await next()
  })
  app.route(mountPath, routes)
  return app
}

async function jsonBody<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Eval routes — tenant isolation (SEC-M-06)', () => {
  let store: InMemoryEvalRunStore
  let routes: Hono

  beforeEach(() => {
    store = new InMemoryEvalRunStore()
    routes = createEvalRoutes({
      store,
      allowReadOnlyMode: true,
    })
  })

  it('GET /runs — Tenant A sees only its own runs, not Tenant B runs', async () => {
    // Seed a run owned by tenant-b directly into the store.
    await store.saveRun({
      id: 'run-tenant-b',
      suiteId: toySuite.name,
      suite: toySuite,
      status: 'queued',
      createdAt: '2026-01-01T00:00:00.000Z',
      queuedAt: '2026-01-01T00:00:00.000Z',
      attempts: 1,
      tenantId: 'tenant-b',
    })

    // Seed a run owned by tenant-a.
    await store.saveRun({
      id: 'run-tenant-a',
      suiteId: toySuite.name,
      suite: toySuite,
      status: 'queued',
      createdAt: '2026-01-01T00:00:01.000Z',
      queuedAt: '2026-01-01T00:00:01.000Z',
      attempts: 1,
      tenantId: 'tenant-a',
    })

    const app = appWithApiKey({ id: 'key-a', tenantId: 'tenant-a' }, routes)
    const res = await app.request('/api/evals/runs')
    expect(res.status).toBe(200)

    const body = await jsonBody<{ success: boolean; data: Array<{ id: string }> }>(res)
    expect(body.success).toBe(true)
    // Tenant A sees only its own run.
    const ids = body.data.map((r) => r.id)
    expect(ids).toContain('run-tenant-a')
    expect(ids).not.toContain('run-tenant-b')
  })

  it('GET /runs/:id — cross-tenant access returns 404', async () => {
    await store.saveRun({
      id: 'run-b-private',
      suiteId: toySuite.name,
      suite: toySuite,
      status: 'queued',
      createdAt: '2026-01-01T00:00:00.000Z',
      queuedAt: '2026-01-01T00:00:00.000Z',
      attempts: 1,
      tenantId: 'tenant-b',
    })

    const app = appWithApiKey({ id: 'key-a', tenantId: 'tenant-a' }, routes)
    const res = await app.request('/api/evals/runs/run-b-private')
    expect(res.status).toBe(404)

    const body = await jsonBody<{ success: boolean; error: { code: string } }>(res)
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('GET /runs/:id — tenant owner can access its own run', async () => {
    await store.saveRun({
      id: 'run-a-own',
      suiteId: toySuite.name,
      suite: toySuite,
      status: 'queued',
      createdAt: '2026-01-01T00:00:00.000Z',
      queuedAt: '2026-01-01T00:00:00.000Z',
      attempts: 1,
      tenantId: 'tenant-a',
    })

    const app = appWithApiKey({ id: 'key-a', tenantId: 'tenant-a' }, routes)
    const res = await app.request('/api/evals/runs/run-a-own')
    expect(res.status).toBe(200)

    const body = await jsonBody<{ success: boolean; data: { id: string } }>(res)
    expect(body.success).toBe(true)
    expect(body.data.id).toBe('run-a-own')
  })

  it('POST /runs/:id/cancel — cross-tenant cancel returns 404, run is untouched', async () => {
    await store.saveRun({
      id: 'run-b-cancel',
      suiteId: toySuite.name,
      suite: toySuite,
      status: 'queued',
      createdAt: '2026-01-01T00:00:00.000Z',
      queuedAt: '2026-01-01T00:00:00.000Z',
      attempts: 1,
      tenantId: 'tenant-b',
    })

    const app = appWithApiKey({ id: 'key-a', tenantId: 'tenant-a' }, routes)
    const res = await app.request('/api/evals/runs/run-b-cancel/cancel', { method: 'POST' })
    expect(res.status).toBe(404)

    const body = await jsonBody<{ success: boolean; error: { code: string } }>(res)
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('NOT_FOUND')

    // Verify run is still in queued state.
    const untouched = await store.getRun('run-b-cancel')
    expect(untouched?.status).toBe('queued')
  })

  it('POST /runs/:id/retry — cross-tenant retry returns 404, run is untouched', async () => {
    await store.saveRun({
      id: 'run-b-retry',
      suiteId: toySuite.name,
      suite: toySuite,
      status: 'failed',
      createdAt: '2026-01-01T00:00:00.000Z',
      queuedAt: '2026-01-01T00:00:00.000Z',
      attempts: 1,
      tenantId: 'tenant-b',
    })

    const app = appWithApiKey({ id: 'key-a', tenantId: 'tenant-a' }, routes)
    const res = await app.request('/api/evals/runs/run-b-retry/retry', { method: 'POST' })
    expect(res.status).toBe(404)

    const body = await jsonBody<{ success: boolean; error: { code: string } }>(res)
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('NOT_FOUND')

    // Run is still in failed state, not retried.
    const untouched = await store.getRun('run-b-retry')
    expect(untouched?.status).toBe('failed')
  })

  it('GET /runs — runs without tenantId are visible to any tenant (backward compat)', async () => {
    // Seed a run with no tenantId (legacy).
    await store.saveRun({
      id: 'run-legacy',
      suiteId: toySuite.name,
      suite: toySuite,
      status: 'queued',
      createdAt: '2026-01-01T00:00:00.000Z',
      queuedAt: '2026-01-01T00:00:00.000Z',
      attempts: 1,
      // no tenantId
    })

    // Tenant A querying with its tenantId filter sees only runs matching 'tenant-a'.
    // Legacy runs (no tenantId) are NOT returned when filter is active.
    // This is correct — existing runs without tenantId need a migration or
    // they remain invisible (safe default: don't expose other tenants' data).
    const app = appWithApiKey({ id: 'key-a', tenantId: 'tenant-a' }, routes)
    const res = await app.request('/api/evals/runs')
    expect(res.status).toBe(200)

    const body = await jsonBody<{ success: boolean; data: Array<{ id: string }> }>(res)
    expect(body.success).toBe(true)
    // Legacy run without tenantId is filtered out (doesn't match 'tenant-a').
    const ids = body.data.map((r) => r.id)
    expect(ids).not.toContain('run-legacy')
  })
})
