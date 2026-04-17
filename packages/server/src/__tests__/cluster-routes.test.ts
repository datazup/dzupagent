/**
 * Integration tests for cluster HTTP routes.
 *
 * Covers: CRUD for clusters, role management, mail routing (point-to-point
 * and broadcast), and error cases (not found, bad request, conflict).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createClusterRoutes } from '../routes/clusters.js'
import { InMemoryClusterStore } from '../persistence/drizzle-cluster-store.js'
import { InMemoryMailboxStore } from '@dzupagent/agent'

function createApp() {
  const clusterStore = new InMemoryClusterStore()
  const mailboxStore = new InMemoryMailboxStore()
  const app = new Hono()
  app.route('/api/clusters', createClusterRoutes({ clusterStore, mailboxStore }))
  return { app, clusterStore, mailboxStore }
}

function json(res: Response) {
  return res.json()
}

describe('Cluster Routes', () => {
  let app: Hono
  let clusterStore: InMemoryClusterStore
  let mailboxStore: InMemoryMailboxStore

  beforeEach(() => {
    const ctx = createApp()
    app = ctx.app
    clusterStore = ctx.clusterStore
    mailboxStore = ctx.mailboxStore
  })

  // ── POST /api/clusters ────────────────────────────────────────────────

  describe('POST /api/clusters', () => {
    it('creates a cluster with provided id', async () => {
      const res = await app.request('/api/clusters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusterId: 'my-cluster', workspaceType: 'sandboxed' }),
      })

      expect(res.status).toBe(201)
      const body = await json(res)
      expect(body.id).toBe('my-cluster')
      expect(body.workspaceType).toBe('sandboxed')
    })

    it('auto-generates id if not provided', async () => {
      const res = await app.request('/api/clusters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(201)
      const body = await json(res)
      expect(body.id).toBeTruthy()
    })

    it('returns 409 on duplicate cluster id', async () => {
      await clusterStore.create({ id: 'dup' })

      const res = await app.request('/api/clusters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusterId: 'dup' }),
      })

      expect(res.status).toBe(409)
      const body = await json(res)
      expect(body.error.code).toBe('CONFLICT')
    })
  })

  // ── GET /api/clusters/:id ─────────────────────────────────────────────

  describe('GET /api/clusters/:id', () => {
    it('returns cluster info with roles', async () => {
      await clusterStore.create({ id: 'c1' })
      await clusterStore.addRole('c1', { roleId: 'planner', agentId: 'a1' })

      const res = await app.request('/api/clusters/c1')
      expect(res.status).toBe(200)

      const body = await json(res)
      expect(body.id).toBe('c1')
      expect(body.roles).toHaveLength(1)
      expect(body.roles[0].roleId).toBe('planner')
    })

    it('returns 404 for unknown cluster', async () => {
      const res = await app.request('/api/clusters/ghost')
      expect(res.status).toBe(404)
    })
  })

  // ── DELETE /api/clusters/:id ──────────────────────────────────────────

  describe('DELETE /api/clusters/:id', () => {
    it('deletes an existing cluster', async () => {
      await clusterStore.create({ id: 'c1' })

      const res = await app.request('/api/clusters/c1', { method: 'DELETE' })
      expect(res.status).toBe(204)

      const after = await clusterStore.findById('c1')
      expect(after).toBeNull()
    })

    it('returns 404 for unknown cluster', async () => {
      const res = await app.request('/api/clusters/ghost', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })
  })

  // ── POST /api/clusters/:id/roles ──────────────────────────────────────

  describe('POST /api/clusters/:id/roles', () => {
    it('adds a role to the cluster', async () => {
      await clusterStore.create({ id: 'c1' })

      const res = await app.request('/api/clusters/c1/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: 'coder', agentId: 'a2', capabilities: ['typescript'] }),
      })

      expect(res.status).toBe(201)
      const body = await json(res)
      expect(body.roleId).toBe('coder')
      expect(body.capabilities).toEqual(['typescript'])
    })

    it('returns 400 when roleId or agentId missing', async () => {
      await clusterStore.create({ id: 'c1' })

      const res = await app.request('/api/clusters/c1/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: 'coder' }), // missing agentId
      })

      expect(res.status).toBe(400)
    })

    it('returns 404 for unknown cluster', async () => {
      const res = await app.request('/api/clusters/ghost/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: 'x', agentId: 'y' }),
      })

      expect(res.status).toBe(404)
    })

    it('returns 409 on duplicate role', async () => {
      await clusterStore.create({ id: 'c1' })
      await clusterStore.addRole('c1', { roleId: 'coder', agentId: 'a1' })

      const res = await app.request('/api/clusters/c1/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: 'coder', agentId: 'a2' }),
      })

      expect(res.status).toBe(409)
    })
  })

  // ── DELETE /api/clusters/:id/roles/:roleId ────────────────────────────

  describe('DELETE /api/clusters/:id/roles/:roleId', () => {
    it('removes an existing role', async () => {
      await clusterStore.create({ id: 'c1' })
      await clusterStore.addRole('c1', { roleId: 'coder', agentId: 'a1' })

      const res = await app.request('/api/clusters/c1/roles/coder', { method: 'DELETE' })
      expect(res.status).toBe(204)

      const roles = await clusterStore.listRoles('c1')
      expect(roles).toHaveLength(0)
    })

    it('returns 404 for unknown role', async () => {
      await clusterStore.create({ id: 'c1' })

      const res = await app.request('/api/clusters/c1/roles/ghost', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })

    it('returns 404 for unknown cluster', async () => {
      const res = await app.request('/api/clusters/ghost/roles/x', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })
  })

  // ── POST /api/clusters/:id/mail ───────────────────────────────────────

  describe('POST /api/clusters/:id/mail', () => {
    beforeEach(async () => {
      await clusterStore.create({ id: 'c1' })
      await clusterStore.addRole('c1', { roleId: 'planner', agentId: 'agent-planner' })
      await clusterStore.addRole('c1', { roleId: 'coder', agentId: 'agent-coder' })
      await clusterStore.addRole('c1', { roleId: 'reviewer', agentId: 'agent-reviewer' })
    })

    it('routes mail from one role to another', async () => {
      const res = await app.request('/api/clusters/c1/mail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'planner',
          to: 'coder',
          message: { subject: 'Task', body: { task: 'implement X' } },
        }),
      })

      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.from).toBe('agent-planner')
      expect(body.to).toBe('agent-coder')
      expect(body.subject).toBe('Task')

      // Verify persisted in mailbox store
      const stored = await mailboxStore.findByRecipient('agent-coder')
      expect(stored).toHaveLength(1)
    })

    it('broadcasts with to: "*"', async () => {
      const res = await app.request('/api/clusters/c1/mail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'planner',
          to: '*',
          message: { subject: 'Standup', body: { status: 'ok' } },
        }),
      })

      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.delivered).toBe(2) // coder + reviewer
      expect(body.messages).toHaveLength(2)

      const recipients = body.messages.map((m: { to: string }) => m.to).sort()
      expect(recipients).toEqual(['agent-coder', 'agent-reviewer'])
    })

    it('returns 404 for unknown cluster', async () => {
      const res = await app.request('/api/clusters/ghost/mail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'planner',
          to: 'coder',
          message: { subject: 'x', body: {} },
        }),
      })

      expect(res.status).toBe(404)
    })

    it('returns 404 for unknown sender role', async () => {
      const res = await app.request('/api/clusters/c1/mail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'nonexistent',
          to: 'coder',
          message: { subject: 'x', body: {} },
        }),
      })

      expect(res.status).toBe(404)
      const body = await json(res)
      expect(body.error.message).toContain('Sender role')
    })

    it('returns 404 for unknown recipient role', async () => {
      const res = await app.request('/api/clusters/c1/mail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'planner',
          to: 'nonexistent',
          message: { subject: 'x', body: {} },
        }),
      })

      expect(res.status).toBe(404)
      const body = await json(res)
      expect(body.error.message).toContain('Recipient role')
    })

    it('returns 400 when from/to/message missing', async () => {
      const res = await app.request('/api/clusters/c1/mail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'planner' }), // missing to + message
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 when message lacks subject or body', async () => {
      const res = await app.request('/api/clusters/c1/mail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'planner',
          to: 'coder',
          message: { subject: 'x' }, // missing body
        }),
      })

      expect(res.status).toBe(400)
    })

    it('preserves ttl in routed mail', async () => {
      const res = await app.request('/api/clusters/c1/mail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'planner',
          to: 'coder',
          message: { subject: 'urgent', body: {}, ttl: 30 },
        }),
      })

      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.ttl).toBe(30)
    })
  })
})
