/**
 * Schedule CRUD routes — create, list, get, update, delete, and manually trigger schedules.
 *
 * Schedules are cron-based triggers with a name, cron expression, workflow text, and enabled flag.
 */
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import type { ScheduleStore } from '../schedules/schedule-store.js'
import { ScheduleCreateSchema, ScheduleUpdateSchema, validateBodyCompat } from './schemas.js'
import { getRequestingTenantId } from './tenant-scope.js'

export interface ScheduleRouteConfig {
  scheduleStore: ScheduleStore
  /** Optional callback invoked when a schedule is manually triggered via POST /:id/trigger. */
  onManualTrigger?: (schedule: { id: string; workflowText: string }) => Promise<void>
}

export function createScheduleRoutes(config: ScheduleRouteConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // --- Create schedule ---
  app.post('/', async (c) => {
    const tenantId = getRequestingTenantId(c)
    const parsed = await validateBodyCompat(c, ScheduleCreateSchema)
    if (parsed instanceof Response) return parsed
    const body = parsed

    const id = body.id ?? crypto.randomUUID()
    const schedule = await config.scheduleStore.save({
      id,
      name: body.name,
      cronExpression: body.cronExpression,
      workflowText: body.workflowText,
      enabled: body.enabled ?? true,
      metadata: body.metadata,
      tenantId,
    })

    return c.json(schedule, 201)
  })

  // --- List schedules ---
  app.get('/', async (c) => {
    const enabledStr = c.req.query('enabled')
    const tenantId = getRequestingTenantId(c)

    const filter: { enabled?: boolean; tenantId: string } = { tenantId }
    if (enabledStr !== undefined && enabledStr !== null) {
      filter.enabled = enabledStr === 'true'
    }

    const schedules = await config.scheduleStore.list(filter)
    return c.json({ schedules })
  })

  // --- Get schedule ---
  app.get('/:id', async (c) => {
    const schedule = await config.scheduleStore.get(c.req.param('id'), getRequestingTenantId(c))
    if (!schedule) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Schedule not found' } }, 404)
    }
    return c.json(schedule)
  })

  // --- Update schedule ---
  app.put('/:id', async (c) => {
    const parsed = await validateBodyCompat(c, ScheduleUpdateSchema)
    if (parsed instanceof Response) return parsed

    const schedule = await config.scheduleStore.update(
      c.req.param('id'),
      parsed,
      getRequestingTenantId(c),
    )
    if (!schedule) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Schedule not found' } }, 404)
    }
    return c.json(schedule)
  })

  // --- Delete schedule ---
  app.delete('/:id', async (c) => {
    const deleted = await config.scheduleStore.delete(c.req.param('id'), getRequestingTenantId(c))
    if (!deleted) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Schedule not found' } }, 404)
    }
    return c.json({ deleted: true })
  })

  // --- Manually trigger schedule ---
  app.post('/:id/trigger', async (c) => {
    const schedule = await config.scheduleStore.get(c.req.param('id'), getRequestingTenantId(c))
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
