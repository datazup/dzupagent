/**
 * Unit tests for createApprovalsRoutes — grant/reject success paths,
 * 404 on unknown approval, event bus emission, and no-runStore guard.
 *
 * Cross-tenant isolation is already thoroughly covered in
 * approvals-cross-tenant.test.ts; this file focuses on the happy-path
 * decision flows and event emission contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { InMemoryRunStore, createEventBus } from '@dzupagent/core'
import { InMemoryApprovalStateStore } from '@dzupagent/hitl-kit'
import { createApprovalsRoutes } from '../routes/approvals.js'

/**
 * Wrap an approvals route in a minimal Hono app that injects an apiKey
 * context matching the given tenant so requireOwnedRun passes ownership checks.
 */
function buildApp(
  runStore: InMemoryRunStore,
  approvalStore: InMemoryApprovalStateStore,
  tenantId = 'tenant-1',
  keyId = 'key-1',
) {
  const eventBus = createEventBus()
  const routes = createApprovalsRoutes({ approvalStore, eventBus, runStore })

  const app = new Hono()
  // Inject API-key context the same way auth middleware does in production.
  app.use('*', async (c, next) => {
    c.set('apiKey' as never, { id: keyId, tenantId } as never)
    await next()
  })
  app.route('/api/approvals', routes)
  return { app, eventBus }
}

async function post(app: Hono, path: string, body?: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

describe('Approvals routes — grant / reject decision flows', () => {
  let runStore: InMemoryRunStore
  let approvalStore: InMemoryApprovalStateStore

  beforeEach(() => {
    runStore = new InMemoryRunStore()
    approvalStore = new InMemoryApprovalStateStore()
  })

  // --- grant ---

  describe('POST /:runId/:approvalId/grant', () => {
    it('returns 200 with decision=granted on success', async () => {
      const run = await runStore.create({
        agentId: 'a1',
        input: 'test',
        tenantId: 'tenant-1',
        ownerId: 'key-1',
      })
      await approvalStore.createPending(run.id, 'ap-1', { question: 'approve?' })

      const { app } = buildApp(runStore, approvalStore)
      const res = await post(app, `/api/approvals/${run.id}/ap-1/grant`, { response: 'yes' })

      expect(res.status).toBe(200)
      const body = await res.json() as { data: { decision: string; runId: string; approvalId: string } }
      expect(body.data.decision).toBe('granted')
      expect(body.data.runId).toBe(run.id)
      expect(body.data.approvalId).toBe('ap-1')
    })

    it('returns 404 when run does not exist', async () => {
      const { app } = buildApp(runStore, approvalStore)
      const res = await post(app, '/api/approvals/nonexistent-run/ap-1/grant', {})
      expect(res.status).toBe(404)
    })

    it('returns 404 when approval id is unknown for an existing run', async () => {
      const run = await runStore.create({
        agentId: 'a1',
        input: 'test',
        tenantId: 'tenant-1',
        ownerId: 'key-1',
      })
      // No createPending — approval id is unknown in the store.
      const { app } = buildApp(runStore, approvalStore)
      const res = await post(app, `/api/approvals/${run.id}/no-such-approval/grant`, {})
      expect(res.status).toBe(404)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('NOT_FOUND')
    })

    it('emits approval:granted event with runId', async () => {
      const run = await runStore.create({
        agentId: 'a1',
        input: 'x',
        tenantId: 'tenant-1',
        ownerId: 'key-1',
      })
      await approvalStore.createPending(run.id, 'ap-2', {})

      const { app, eventBus } = buildApp(runStore, approvalStore)
      const emitted: unknown[] = []
      eventBus.onAny((e) => emitted.push(e))

      await post(app, `/api/approvals/${run.id}/ap-2/grant`, { approvedBy: 'operator' })

      const granted = emitted.find((e) => (e as { type: string }).type === 'approval:granted')
      expect(granted).toBeDefined()
      expect((granted as { runId: string }).runId).toBe(run.id)
      expect((granted as { approvedBy?: string }).approvedBy).toBe('operator')
    })

    it('accepts grant with no request body (malformed JSON falls back to empty)', async () => {
      const run = await runStore.create({
        agentId: 'a1',
        input: 'x',
        tenantId: 'tenant-1',
        ownerId: 'key-1',
      })
      await approvalStore.createPending(run.id, 'ap-3', {})
      const { app } = buildApp(runStore, approvalStore)

      const res = await app.request(`/api/approvals/${run.id}/ap-3/grant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      })
      expect(res.status).toBe(200)
    })

    it('returns 503 when runStore is not provided', async () => {
      await approvalStore.createPending('r1', 'ap-1', {})
      const routes = createApprovalsRoutes({ approvalStore, eventBus: createEventBus() })
      const app = new Hono()
      app.route('/api/approvals', routes)

      const res = await app.request('/api/approvals/r1/ap-1/grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(503)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE')
    })
  })

  // --- reject ---

  describe('POST /:runId/:approvalId/reject', () => {
    it('returns 200 with decision=rejected and the supplied reason', async () => {
      const run = await runStore.create({
        agentId: 'a1',
        input: 'test',
        tenantId: 'tenant-1',
        ownerId: 'key-1',
      })
      await approvalStore.createPending(run.id, 'ap-r1', {})

      const { app } = buildApp(runStore, approvalStore)
      const res = await post(app, `/api/approvals/${run.id}/ap-r1/reject`, {
        reason: 'too risky',
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { data: { decision: string; reason: string } }
      expect(body.data.decision).toBe('rejected')
      expect(body.data.reason).toBe('too risky')
    })

    it('uses default reason when none supplied', async () => {
      const run = await runStore.create({
        agentId: 'a1',
        input: 'test',
        tenantId: 'tenant-1',
        ownerId: 'key-1',
      })
      await approvalStore.createPending(run.id, 'ap-r2', {})

      const { app } = buildApp(runStore, approvalStore)
      const res = await post(app, `/api/approvals/${run.id}/ap-r2/reject`, {})

      expect(res.status).toBe(200)
      const body = await res.json() as { data: { reason: string } }
      expect(body.data.reason).toBe('Rejected by operator')
    })

    it('returns 404 when run does not exist', async () => {
      const { app } = buildApp(runStore, approvalStore)
      const res = await post(app, '/api/approvals/ghost-run/ap-r3/reject', { reason: 'n/a' })
      expect(res.status).toBe(404)
    })

    it('returns 404 when approval id is unknown', async () => {
      const run = await runStore.create({
        agentId: 'a1',
        input: 'x',
        tenantId: 'tenant-1',
        ownerId: 'key-1',
      })
      const { app } = buildApp(runStore, approvalStore)
      const res = await post(app, `/api/approvals/${run.id}/ghost-ap/reject`, { reason: 'n' })
      expect(res.status).toBe(404)
    })

    it('emits approval:rejected event with reason', async () => {
      const run = await runStore.create({
        agentId: 'a1',
        input: 'x',
        tenantId: 'tenant-1',
        ownerId: 'key-1',
      })
      await approvalStore.createPending(run.id, 'ap-r4', {})

      const { app, eventBus } = buildApp(runStore, approvalStore)
      const emitted: unknown[] = []
      eventBus.onAny((e) => emitted.push(e))

      await post(app, `/api/approvals/${run.id}/ap-r4/reject`, { reason: 'cost too high' })

      const rejected = emitted.find((e) => (e as { type: string }).type === 'approval:rejected')
      expect(rejected).toBeDefined()
      expect((rejected as { reason: string }).reason).toBe('cost too high')
    })

    it('returns 503 when runStore is not provided', async () => {
      const routes = createApprovalsRoutes({ approvalStore, eventBus: createEventBus() })
      const app = new Hono()
      app.route('/api/approvals', routes)

      const res = await app.request('/api/approvals/r1/ap-1/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'denied' }),
      })
      expect(res.status).toBe(503)
    })
  })

  // --- cross-tenant isolation ---

  describe('cross-tenant isolation', () => {
    it('tenant-2 cannot grant an approval owned by tenant-1 (returns 404)', async () => {
      const run = await runStore.create({
        agentId: 'a1',
        input: 'x',
        tenantId: 'tenant-1',
        ownerId: 'key-1',
      })
      await approvalStore.createPending(run.id, 'ap-iso', {})

      // Build an app authenticated as tenant-2
      const { app } = buildApp(runStore, approvalStore, 'tenant-2', 'key-2')
      const res = await post(app, `/api/approvals/${run.id}/ap-iso/grant`, {})

      expect(res.status).toBe(404)
      // Approval must remain pending (not resolved)
      expect(approvalStore.getPayload(run.id, 'ap-iso')).toBeDefined()
    })

    it('the owning tenant can successfully grant their own approval', async () => {
      const run = await runStore.create({
        agentId: 'a1',
        input: 'x',
        tenantId: 'tenant-1',
        ownerId: 'key-1',
      })
      await approvalStore.createPending(run.id, 'ap-own', {})

      const { app } = buildApp(runStore, approvalStore, 'tenant-1', 'key-1')
      const res = await post(app, `/api/approvals/${run.id}/ap-own/grant`, { response: 'ok' })

      expect(res.status).toBe(200)
    })
  })
})
