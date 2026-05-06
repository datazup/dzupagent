/**
 * QF-01 / SEC-01 regression test.
 *
 * Verifies that `POST /api/approvals/:runId/:approvalId/grant|reject` rejects
 * cross-tenant requests. Prior to the fix, any authenticated key could resolve
 * any other tenant's pending approval — fully bypassing HITL.
 *
 * The route now resolves the run via `RunStore.get(runId)` and returns 404
 * (intentional — see `requireOwnedRun` JSDoc; we do not expose 403 to avoid
 * tenant enumeration via status-code probing) when the caller's
 * `apiKey.tenantId` does not match the run's recorded tenant.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import { InMemoryApprovalStateStore } from '@dzupagent/hitl-kit'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import { createApprovalsRoutes } from '../routes/approvals.js'

function appWithApiKey(
  apiKey: { id: string; tenantId: string },
  routes: Hono,
): Hono {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('apiKey' as never, apiKey as never)
    await next()
  })
  app.route('/api/approvals', routes)
  return app
}

describe('Approvals routes — cross-tenant guard (QF-01 / SEC-01)', () => {
  let runStore: InMemoryRunStore
  let approvalStore: InMemoryApprovalStateStore
  let routes: Hono

  beforeEach(() => {
    runStore = new InMemoryRunStore()
    approvalStore = new InMemoryApprovalStateStore()
    routes = createApprovalsRoutes({
      approvalStore,
      eventBus: createEventBus(),
      runStore,
    })
  })

  it('Tenant A cannot grant Tenant B run (returns 404, store untouched)', async () => {
    // Arrange — tenant B owns the run + has a pending approval.
    const run = await runStore.create({
      agentId: 'agent-b',
      input: 'b',
      tenantId: 'tenant-b',
      ownerId: 'key-b',
    })
    await approvalStore.createPending(run.id, 'ap-1', { reason: 'review' })

    // Act — tenant A's key tries to grant.
    const app = appWithApiKey({ id: 'key-a', tenantId: 'tenant-a' }, routes)
    const res = await app.request(`/api/approvals/${run.id}/ap-1/grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: 'sneak-grant' }),
    })

    // Assert — request blocked, approval still pending.
    expect(res.status).toBe(404)
    expect(approvalStore.getPayload(run.id, 'ap-1')).toEqual({ reason: 'review' })

    // Sanity: tenant B's own key still works.
    const bApp = appWithApiKey({ id: 'key-b', tenantId: 'tenant-b' }, routes)
    const bRes = await bApp.request(`/api/approvals/${run.id}/ap-1/grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: 'ok' }),
    })
    expect(bRes.status).toBe(200)
  })

  it('Tenant A cannot reject Tenant B run (returns 404, store untouched)', async () => {
    const run = await runStore.create({
      agentId: 'agent-b',
      input: 'b',
      tenantId: 'tenant-b',
      ownerId: 'key-b',
    })
    await approvalStore.createPending(run.id, 'ap-2', { reason: 'review' })

    const app = appWithApiKey({ id: 'key-a', tenantId: 'tenant-a' }, routes)
    const res = await app.request(`/api/approvals/${run.id}/ap-2/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'no' }),
    })

    expect(res.status).toBe(404)
    // Approval entry must still be present (i.e., not transitioned).
    expect(approvalStore.getPayload(run.id, 'ap-2')).toEqual({ reason: 'review' })
  })

  it('returns 503 when runStore is not configured (safe default)', async () => {
    const noStoreRoutes = createApprovalsRoutes({
      approvalStore,
      eventBus: createEventBus(),
      // runStore omitted — must refuse all mutations.
    })

    await approvalStore.createPending('r-1', 'ap-1', { reason: 'review' })
    const app = appWithApiKey({ id: 'key-a', tenantId: 'tenant-a' }, noStoreRoutes)
    const res = await app.request('/api/approvals/r-1/ap-1/grant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(503)
    // Approval still pending.
    expect(approvalStore.getPayload('r-1', 'ap-1')).toEqual({ reason: 'review' })
  })

  it('enforces ownership through the mounted createForgeApp approvals route', async () => {
    const mountedRunStore = new InMemoryRunStore()
    const mountedApprovalStore = new InMemoryApprovalStateStore()
    const config: ForgeServerConfig = {
      runStore: mountedRunStore,
      agentStore: new InMemoryAgentStore(),
      eventBus: createEventBus(),
      modelRegistry: new ModelRegistry(),
      approvalStore: mountedApprovalStore,
      auth: {
        mode: 'api-key',
        validateKey: async (token) => {
          switch (token) {
            case 'tenant-a':
              return { id: 'key-a', tenantId: 'tenant-a', role: 'operator' }
            case 'tenant-b':
              return { id: 'key-b', tenantId: 'tenant-b', role: 'operator' }
            default:
              return null
          }
        },
      },
    }
    const app = createForgeApp(config)
    const run = await mountedRunStore.create({
      agentId: 'agent-b',
      input: 'b',
      tenantId: 'tenant-b',
      ownerId: 'key-b',
    })
    await mountedApprovalStore.createPending(run.id, 'ap-mounted', { reason: 'review' })

    const crossTenant = await app.request(`/api/approvals/${run.id}/ap-mounted/grant`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer tenant-a',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ response: 'sneak-grant' }),
    })

    expect(crossTenant.status).toBe(404)
    expect(mountedApprovalStore.getPayload(run.id, 'ap-mounted')).toEqual({ reason: 'review' })

    const owner = await app.request(`/api/approvals/${run.id}/ap-mounted/grant`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer tenant-b',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ response: 'ok' }),
    })

    expect(owner.status).toBe(200)
  })
})
