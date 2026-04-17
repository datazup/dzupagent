import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createTriggerRoutes } from '../routes/triggers.js'
import { InMemoryTriggerStore } from '../triggers/trigger-store.js'

function createApp() {
  const store = new InMemoryTriggerStore()
  const routes = createTriggerRoutes({ triggerStore: store })
  const app = new Hono()
  app.route('/api/triggers', routes)
  return { app, store }
}

async function req(app: Hono, method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body) init.body = JSON.stringify(body)
  return app.request(path, init)
}

describe('Trigger routes', () => {
  let app: Hono
  let store: InMemoryTriggerStore

  beforeEach(() => {
    const ctx = createApp()
    app = ctx.app
    store = ctx.store
  })

  it('POST /api/triggers creates a trigger', async () => {
    const res = await req(app, 'POST', '/api/triggers', {
      type: 'cron',
      agentId: 'agent-1',
      schedule: '0 * * * *',
    })
    expect(res.status).toBe(201)
    const data = await res.json() as { id: string; type: string; agentId: string }
    expect(data.type).toBe('cron')
    expect(data.agentId).toBe('agent-1')
    expect(data.id).toBeTruthy()
  })

  it('POST /api/triggers returns 400 without type or agentId', async () => {
    const res = await req(app, 'POST', '/api/triggers', { type: 'cron' })
    expect(res.status).toBe(400)
  })

  it('GET /api/triggers lists all triggers', async () => {
    await store.save({ id: 't1', type: 'cron', agentId: 'a1', enabled: true })
    await store.save({ id: 't2', type: 'webhook', agentId: 'a2', enabled: false })

    const res = await app.request('/api/triggers')
    expect(res.status).toBe(200)
    const data = await res.json() as { triggers: unknown[] }
    expect(data.triggers).toHaveLength(2)
  })

  it('GET /api/triggers filters by agentId', async () => {
    await store.save({ id: 't1', type: 'cron', agentId: 'a1', enabled: true })
    await store.save({ id: 't2', type: 'webhook', agentId: 'a2', enabled: true })

    const res = await app.request('/api/triggers?agentId=a1')
    const data = await res.json() as { triggers: Array<{ agentId: string }> }
    expect(data.triggers).toHaveLength(1)
    expect(data.triggers[0]?.agentId).toBe('a1')
  })

  it('GET /api/triggers filters by enabled', async () => {
    await store.save({ id: 't1', type: 'cron', agentId: 'a1', enabled: true })
    await store.save({ id: 't2', type: 'webhook', agentId: 'a2', enabled: false })

    const res = await app.request('/api/triggers?enabled=true')
    const data = await res.json() as { triggers: Array<{ enabled: boolean }> }
    expect(data.triggers).toHaveLength(1)
    expect(data.triggers[0]?.enabled).toBe(true)
  })

  it('GET /api/triggers/:id returns a trigger', async () => {
    await store.save({ id: 't1', type: 'cron', agentId: 'a1', enabled: true })

    const res = await app.request('/api/triggers/t1')
    expect(res.status).toBe(200)
    const data = await res.json() as { id: string }
    expect(data.id).toBe('t1')
  })

  it('GET /api/triggers/:id returns 404 for unknown', async () => {
    const res = await app.request('/api/triggers/nonexistent')
    expect(res.status).toBe(404)
  })

  it('DELETE /api/triggers/:id deletes a trigger', async () => {
    await store.save({ id: 't1', type: 'cron', agentId: 'a1', enabled: true })

    const res = await req(app, 'DELETE', '/api/triggers/t1')
    expect(res.status).toBe(200)
    const data = await res.json() as { deleted: boolean }
    expect(data.deleted).toBe(true)
  })

  it('DELETE /api/triggers/:id returns 404 for unknown', async () => {
    const res = await req(app, 'DELETE', '/api/triggers/nonexistent')
    expect(res.status).toBe(404)
  })

  it('PATCH /api/triggers/:id/enable toggles enabled state', async () => {
    await store.save({ id: 't1', type: 'cron', agentId: 'a1', enabled: true })

    const res = await req(app, 'PATCH', '/api/triggers/t1/enable', { enabled: false })
    expect(res.status).toBe(200)
    const data = await res.json() as { enabled: boolean }
    expect(data.enabled).toBe(false)
  })

  it('PATCH /api/triggers/:id/enable returns 400 without boolean enabled', async () => {
    await store.save({ id: 't1', type: 'cron', agentId: 'a1', enabled: true })

    const res = await req(app, 'PATCH', '/api/triggers/t1/enable', { enabled: 'yes' })
    expect(res.status).toBe(400)
  })

  it('PATCH /api/triggers/:id/enable returns 404 for unknown', async () => {
    const res = await req(app, 'PATCH', '/api/triggers/nonexistent/enable', { enabled: true })
    expect(res.status).toBe(404)
  })
})
