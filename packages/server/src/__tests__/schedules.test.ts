/**
 * Tests for schedule CRUD routes and manual trigger.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { createScheduleRoutes } from '../routes/schedules.js'
import { InMemoryScheduleStore } from '../schedules/schedule-store.js'
import type { ScheduleRecord } from '../schedules/schedule-store.js'

function createTestApp(onManualTrigger?: (s: { id: string; workflowText: string }) => Promise<void>) {
  const store = new InMemoryScheduleStore()
  const routes = createScheduleRoutes({ scheduleStore: store, onManualTrigger })
  const app = new Hono()
  app.route('/api/schedules', routes)
  return { app, store }
}

describe('Schedule REST routes', () => {
  let app: Hono
  let store: InMemoryScheduleStore

  beforeEach(() => {
    const ctx = createTestApp()
    app = ctx.app
    store = ctx.store
  })

  it('POST /api/schedules creates a schedule', async () => {
    const res = await app.request('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Daily report',
        cronExpression: '0 9 * * *',
        workflowText: 'Generate daily report',
      }),
    })

    expect(res.status).toBe(201)
    const schedule = (await res.json()) as ScheduleRecord
    expect(schedule.name).toBe('Daily report')
    expect(schedule.cronExpression).toBe('0 9 * * *')
    expect(schedule.workflowText).toBe('Generate daily report')
    expect(schedule.enabled).toBe(true)
    expect(schedule.id).toBeTruthy()
  })

  it('POST /api/schedules returns 400 for missing fields', async () => {
    const res = await app.request('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No cron' }),
    })

    expect(res.status).toBe(400)
  })

  it('POST /api/schedules accepts custom id and enabled=false', async () => {
    const res = await app.request('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'custom-id',
        name: 'Test',
        cronExpression: '*/5 * * * *',
        workflowText: 'Run something',
        enabled: false,
      }),
    })

    expect(res.status).toBe(201)
    const schedule = (await res.json()) as ScheduleRecord
    expect(schedule.id).toBe('custom-id')
    expect(schedule.enabled).toBe(false)
  })

  it('GET /api/schedules lists all schedules', async () => {
    await app.request('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'S1', cronExpression: '* * * * *', workflowText: 'w1' }),
    })
    await app.request('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'S2', cronExpression: '*/10 * * * *', workflowText: 'w2' }),
    })

    const res = await app.request('/api/schedules')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { schedules: ScheduleRecord[] }
    expect(body.schedules).toHaveLength(2)
  })

  it('GET /api/schedules filters by enabled', async () => {
    await app.request('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Enabled', cronExpression: '* * * * *', workflowText: 'w1', enabled: true }),
    })
    await app.request('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Disabled', cronExpression: '* * * * *', workflowText: 'w2', enabled: false }),
    })

    const enabledRes = await app.request('/api/schedules?enabled=true')
    const enabledBody = (await enabledRes.json()) as { schedules: ScheduleRecord[] }
    expect(enabledBody.schedules).toHaveLength(1)
    expect(enabledBody.schedules[0]?.name).toBe('Enabled')

    const disabledRes = await app.request('/api/schedules?enabled=false')
    const disabledBody = (await disabledRes.json()) as { schedules: ScheduleRecord[] }
    expect(disabledBody.schedules).toHaveLength(1)
    expect(disabledBody.schedules[0]?.name).toBe('Disabled')
  })

  it('GET /api/schedules/:id returns a single schedule', async () => {
    const createRes = await app.request('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Fetch', cronExpression: '0 * * * *', workflowText: 'run' }),
    })
    const created = (await createRes.json()) as ScheduleRecord

    const res = await app.request(`/api/schedules/${created.id}`)
    expect(res.status).toBe(200)
    const schedule = (await res.json()) as ScheduleRecord
    expect(schedule.id).toBe(created.id)
    expect(schedule.name).toBe('Fetch')
  })

  it('GET /api/schedules/:id returns 404 for unknown', async () => {
    const res = await app.request('/api/schedules/nonexistent')
    expect(res.status).toBe(404)
  })

  it('PUT /api/schedules/:id updates a schedule', async () => {
    const createRes = await app.request('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Original', cronExpression: '0 * * * *', workflowText: 'old' }),
    })
    const created = (await createRes.json()) as ScheduleRecord

    const updateRes = await app.request(`/api/schedules/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated', workflowText: 'new', enabled: false }),
    })
    expect(updateRes.status).toBe(200)
    const updated = (await updateRes.json()) as ScheduleRecord
    expect(updated.name).toBe('Updated')
    expect(updated.workflowText).toBe('new')
    expect(updated.enabled).toBe(false)
    expect(updated.cronExpression).toBe('0 * * * *') // unchanged
  })

  it('PUT /api/schedules/:id returns 404 for unknown', async () => {
    const res = await app.request('/api/schedules/nonexistent', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Nope' }),
    })
    expect(res.status).toBe(404)
  })

  it('DELETE /api/schedules/:id removes a schedule', async () => {
    const createRes = await app.request('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ToDelete', cronExpression: '0 0 * * *', workflowText: 'x' }),
    })
    const created = (await createRes.json()) as ScheduleRecord

    const delRes = await app.request(`/api/schedules/${created.id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(200)
    const body = await delRes.json()
    expect(body).toEqual({ deleted: true })

    const getRes = await app.request(`/api/schedules/${created.id}`)
    expect(getRes.status).toBe(404)
  })

  it('DELETE /api/schedules/:id returns 404 for unknown', async () => {
    const res = await app.request('/api/schedules/nonexistent', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('Schedule manual trigger', () => {
  it('POST /api/schedules/:id/trigger invokes onManualTrigger callback', async () => {
    const onManualTrigger = vi.fn().mockResolvedValue(undefined)
    const { app } = createTestApp(onManualTrigger)

    const createRes = await app.request('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Manual', cronExpression: '0 0 * * *', workflowText: 'do stuff' }),
    })
    const created = (await createRes.json()) as ScheduleRecord

    const triggerRes = await app.request(`/api/schedules/${created.id}/trigger`, { method: 'POST' })
    expect(triggerRes.status).toBe(200)
    const body = await triggerRes.json()
    expect(body).toEqual({ triggered: true, scheduleId: created.id })
    expect(onManualTrigger).toHaveBeenCalledWith({ id: created.id, workflowText: 'do stuff' })
  })

  it('POST /api/schedules/:id/trigger returns 404 for unknown', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/schedules/nonexistent/trigger', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('POST /api/schedules/:id/trigger works without callback', async () => {
    const { app } = createTestApp()

    const createRes = await app.request('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No CB', cronExpression: '0 0 * * *', workflowText: 'test' }),
    })
    const created = (await createRes.json()) as ScheduleRecord

    const triggerRes = await app.request(`/api/schedules/${created.id}/trigger`, { method: 'POST' })
    expect(triggerRes.status).toBe(200)
  })
})
