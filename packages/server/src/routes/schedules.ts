/**
 * Schedule CRUD routes — create, list, get, update, delete, and manually trigger schedules.
 *
 * Schedules are cron-based triggers with a name, cron expression, workflow text, and enabled flag.
 */
import { Hono } from 'hono'
import type { ScheduleStore } from '../schedules/schedule-store.js'

export interface ScheduleRouteConfig {
  scheduleStore: ScheduleStore
  /** Optional callback invoked when a schedule is manually triggered via POST /:id/trigger. */
  onManualTrigger?: (schedule: { id: string; workflowText: string }) => Promise<void>
}

export function createScheduleRoutes(config: ScheduleRouteConfig): Hono {
  const app = new Hono()

  // --- Create schedule ---
  app.post('/', async (c) => {
    const body = await c.req.json<{
      id?: string
      name: string
      cronExpression: string
      workflowText: string
      enabled?: boolean
      metadata?: Record<string, unknown>
    }>()

    if (!body.name || !body.cronExpression || !body.workflowText) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'name, cronExpression, and workflowText are required' } },
        400,
      )
    }

    const id = body.id ?? crypto.randomUUID()
    const schedule = await config.scheduleStore.save({
      id,
      name: body.name,
      cronExpression: body.cronExpression,
      workflowText: body.workflowText,
      enabled: body.enabled ?? true,
      metadata: body.metadata,
    })

    return c.json(schedule, 201)
  })

  // --- List schedules ---
  app.get('/', async (c) => {
    const enabledStr = c.req.query('enabled')

    const filter: { enabled?: boolean } = {}
    if (enabledStr !== undefined && enabledStr !== null) {
      filter.enabled = enabledStr === 'true'
    }

    const schedules = await config.scheduleStore.list(
      Object.keys(filter).length > 0 ? filter : undefined,
    )
    return c.json({ schedules })
  })

  // --- Get schedule ---
  app.get('/:id', async (c) => {
    const schedule = await config.scheduleStore.get(c.req.param('id'))
    if (!schedule) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Schedule not found' } }, 404)
    }
    return c.json(schedule)
  })

  // --- Update schedule ---
  app.put('/:id', async (c) => {
    const body = await c.req.json<{
      name?: string
      cronExpression?: string
      workflowText?: string
      enabled?: boolean
      metadata?: Record<string, unknown>
    }>()

    const schedule = await config.scheduleStore.update(c.req.param('id'), body)
    if (!schedule) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Schedule not found' } }, 404)
    }
    return c.json(schedule)
  })

  // --- Delete schedule ---
  app.delete('/:id', async (c) => {
    const deleted = await config.scheduleStore.delete(c.req.param('id'))
    if (!deleted) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Schedule not found' } }, 404)
    }
    return c.json({ deleted: true })
  })

  // --- Manually trigger schedule ---
  app.post('/:id/trigger', async (c) => {
    const schedule = await config.scheduleStore.get(c.req.param('id'))
    if (!schedule) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Schedule not found' } }, 404)
    }

    if (config.onManualTrigger) {
      await config.onManualTrigger({ id: schedule.id, workflowText: schedule.workflowText })
    }

    return c.json({ triggered: true, scheduleId: schedule.id })
  })

  return app
}
