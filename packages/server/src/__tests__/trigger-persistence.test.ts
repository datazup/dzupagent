/**
 * Tests for trigger persistence — CRUD routes and chain trigger wiring.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { createTriggerRoutes } from '../routes/triggers.js'
import { InMemoryTriggerStore } from '../triggers/trigger-store.js'
import type { TriggerConfigRecord } from '../triggers/trigger-store.js'
import { TriggerManager } from '../triggers/trigger-manager.js'

function createTestApp() {
  const store = new InMemoryTriggerStore()
  const routes = createTriggerRoutes({ triggerStore: store })
  const app = new Hono()
  app.route('/api/triggers', routes)
  return { app, store }
}

describe('Trigger REST routes', () => {
  let app: Hono
  let store: InMemoryTriggerStore

  beforeEach(() => {
    const ctx = createTestApp()
    app = ctx.app
    store = ctx.store
  })

  // 1
  it('POST /api/triggers creates a trigger', async () => {
    const res = await app.request('/api/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'cron',
        agentId: 'agent-1',
        schedule: '*/5 * * * *',
      }),
    })

    expect(res.status).toBe(201)
    const trigger = (await res.json()) as TriggerConfigRecord
    expect(trigger.type).toBe('cron')
    expect(trigger.agentId).toBe('agent-1')
    expect(trigger.schedule).toBe('*/5 * * * *')
    expect(trigger.enabled).toBe(true)
    expect(trigger.id).toBeTruthy()
  })

  // 2
  it('GET /api/triggers lists all triggers', async () => {
    await app.request('/api/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'cron', agentId: 'a1', schedule: '* * * * *' }),
    })
    await app.request('/api/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'webhook', agentId: 'a2' }),
    })

    const res = await app.request('/api/triggers')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { triggers: TriggerConfigRecord[] }
    expect(body.triggers).toHaveLength(2)
  })

  // 3
  it('GET /api/triggers filters by agentId', async () => {
    await app.request('/api/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'cron', agentId: 'a1', schedule: '* * * * *' }),
    })
    await app.request('/api/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'webhook', agentId: 'a2' }),
    })

    const res = await app.request('/api/triggers?agentId=a1')
    const body = (await res.json()) as { triggers: TriggerConfigRecord[] }
    expect(body.triggers).toHaveLength(1)
    expect(body.triggers[0]?.agentId).toBe('a1')
  })

  // 4
  it('GET /api/triggers/:id returns a single trigger', async () => {
    const createRes = await app.request('/api/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'webhook', agentId: 'a1' }),
    })
    const created = (await createRes.json()) as TriggerConfigRecord

    const res = await app.request(`/api/triggers/${created.id}`)
    expect(res.status).toBe(200)
    const trigger = (await res.json()) as TriggerConfigRecord
    expect(trigger.id).toBe(created.id)
  })

  // 5
  it('GET /api/triggers/:id returns 404 for unknown', async () => {
    const res = await app.request('/api/triggers/nonexistent')
    expect(res.status).toBe(404)
  })

  // 6
  it('DELETE /api/triggers/:id removes a trigger', async () => {
    const createRes = await app.request('/api/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'cron', agentId: 'a1', schedule: '*/10 * * * *' }),
    })
    const created = (await createRes.json()) as TriggerConfigRecord

    const delRes = await app.request(`/api/triggers/${created.id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(200)
    const body = await delRes.json()
    expect(body).toEqual({ deleted: true })

    // Verify it's gone
    const getRes = await app.request(`/api/triggers/${created.id}`)
    expect(getRes.status).toBe(404)
  })

  // 7
  it('DELETE /api/triggers/:id returns 404 for unknown', async () => {
    const res = await app.request('/api/triggers/nonexistent', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  // 8
  it('PATCH /api/triggers/:id/enable toggles enabled state', async () => {
    const createRes = await app.request('/api/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'webhook', agentId: 'a1', enabled: true }),
    })
    const created = (await createRes.json()) as TriggerConfigRecord
    expect(created.enabled).toBe(true)

    const disableRes = await app.request(`/api/triggers/${created.id}/enable`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(disableRes.status).toBe(200)
    const disabled = (await disableRes.json()) as TriggerConfigRecord
    expect(disabled.enabled).toBe(false)
  })

  // 9
  it('PATCH /api/triggers/:id/enable returns 404 for unknown', async () => {
    const res = await app.request('/api/triggers/nonexistent/enable', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(res.status).toBe(404)
  })

  // 10
  it('GET /api/triggers filters by enabled flag', async () => {
    await app.request('/api/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'cron', agentId: 'a1', schedule: '* * * * *', enabled: true }),
    })
    const createRes = await app.request('/api/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'webhook', agentId: 'a2', enabled: true }),
    })
    const second = (await createRes.json()) as TriggerConfigRecord

    // Disable the second
    await app.request(`/api/triggers/${second.id}/enable`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })

    const enabledRes = await app.request('/api/triggers?enabled=true')
    const enabledBody = (await enabledRes.json()) as { triggers: TriggerConfigRecord[] }
    expect(enabledBody.triggers).toHaveLength(1)

    const disabledRes = await app.request('/api/triggers?enabled=false')
    const disabledBody = (await disabledRes.json()) as { triggers: TriggerConfigRecord[] }
    expect(disabledBody.triggers).toHaveLength(1)
  })
})

describe('Chain trigger firing', () => {
  // 11 (bonus)
  it('TriggerManager.notifyCompletion fires chain triggers', async () => {
    const onTrigger = vi.fn().mockResolvedValue(undefined)
    const manager = new TriggerManager(onTrigger)

    manager.register({
      id: 'chain-1',
      type: 'chain',
      agentId: 'agent-b',
      enabled: true,
      afterAgentId: 'agent-a',
    })

    await manager.notifyCompletion('agent-a')

    expect(onTrigger).toHaveBeenCalledTimes(1)
    expect(onTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chain-1', agentId: 'agent-b' }),
    )
  })
})
