/**
 * SEC-M-06 — Deploy routes tenant isolation.
 *
 * Verifies that deployment history list, record, and outcome-update routes
 * enforce tenant scoping. Tenant A must not be able to enumerate Tenant B's
 * deployment records or mutate them.
 *
 * Cross-tenant access returns 404 (not 403) to avoid tenant enumeration.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createDeployRoutes } from '../routes/deploy.js'
import { InMemoryDeploymentHistoryStore } from '../deploy/deployment-history-store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appWithApiKey(
  apiKey: { id: string; tenantId: string },
  routes: Hono,
  mountPath = '/api/deploy',
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

const BASE_RECORD = {
  confidenceScore: 90,
  gateDecision: 'auto_deploy' as const,
  environment: 'production',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Deploy routes — tenant isolation (SEC-M-06)', () => {
  let historyStore: InMemoryDeploymentHistoryStore
  let routes: Hono

  beforeEach(() => {
    historyStore = new InMemoryDeploymentHistoryStore()
    routes = createDeployRoutes({ historyStore })
  })

  it('GET /history — Tenant A sees only its own deployment records', async () => {
    // Seed records directly to the store under different tenants.
    await historyStore.record({ id: 'deploy-b-1', ...BASE_RECORD, tenantId: 'tenant-b' })
    await historyStore.record({ id: 'deploy-a-1', ...BASE_RECORD, tenantId: 'tenant-a' })

    const app = appWithApiKey({ id: 'key-a', tenantId: 'tenant-a' }, routes)
    const res = await app.request('/api/deploy/history')
    expect(res.status).toBe(200)

    const body = await jsonBody<{ data: Array<{ id: string }> }>(res)
    const ids = body.data.map((r) => r.id)
    expect(ids).toContain('deploy-a-1')
    expect(ids).not.toContain('deploy-b-1')
  })

  it('POST /record — Tenant A creates a record scoped to its tenant', async () => {
    const app = appWithApiKey({ id: 'key-a', tenantId: 'tenant-a' }, routes)
    const res = await app.request('/api/deploy/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'deploy-a-new', ...BASE_RECORD }),
    })
    expect(res.status).toBe(201)

    // Verify the record is scoped to tenant-a in the store.
    const stored = await historyStore.getById('deploy-a-new')
    expect(stored?.tenantId).toBe('tenant-a')
  })

  it('PATCH /:id/outcome — Tenant A cannot update Tenant B deployment, returns 404', async () => {
    // Seed a record owned by tenant-b.
    await historyStore.record({ id: 'deploy-b-outcome', ...BASE_RECORD, tenantId: 'tenant-b' })

    const app = appWithApiKey({ id: 'key-a', tenantId: 'tenant-a' }, routes)
    const res = await app.request('/api/deploy/deploy-b-outcome/outcome', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'success' }),
    })
    expect(res.status).toBe(404)

    const body = await jsonBody<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('NOT_FOUND')

    // Verify the outcome was not changed.
    const unchanged = await historyStore.getById('deploy-b-outcome')
    expect(unchanged?.outcome).toBeNull()
  })

  it('PATCH /:id/outcome — Tenant A can update its own deployment outcome', async () => {
    await historyStore.record({ id: 'deploy-a-outcome', ...BASE_RECORD, tenantId: 'tenant-a' })

    const app = appWithApiKey({ id: 'key-a', tenantId: 'tenant-a' }, routes)
    const res = await app.request('/api/deploy/deploy-a-outcome/outcome', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'success' }),
    })
    expect(res.status).toBe(200)

    const body = await jsonBody<{ data: { outcome: string } }>(res)
    expect(body.data.outcome).toBe('success')
  })

  it('GET /history — list is empty when no records match requesting tenant', async () => {
    await historyStore.record({ id: 'deploy-b-only', ...BASE_RECORD, tenantId: 'tenant-b' })

    const app = appWithApiKey({ id: 'key-a', tenantId: 'tenant-a' }, routes)
    const res = await app.request('/api/deploy/history')
    expect(res.status).toBe(200)

    const body = await jsonBody<{ data: Array<unknown>; total: number }>(res)
    expect(body.data).toHaveLength(0)
    expect(body.total).toBe(0)
  })

  it('PATCH /:id/outcome — Tenant B cannot modify Tenant A deployment, run is untouched', async () => {
    await historyStore.record({ id: 'deploy-a-guard', ...BASE_RECORD, tenantId: 'tenant-a' })

    const appB = appWithApiKey({ id: 'key-b', tenantId: 'tenant-b' }, routes)
    const res = await appB.request('/api/deploy/deploy-a-guard/outcome', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'failure' }),
    })
    expect(res.status).toBe(404)

    // Verify owner can still read it unchanged.
    const record = await historyStore.getById('deploy-a-guard', 'tenant-a')
    expect(record?.outcome).toBeNull()
  })
})
