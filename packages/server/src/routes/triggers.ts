/**
 * Trigger CRUD routes — create, list, get, delete, and toggle triggers.
 */
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import type { TriggerStore } from '../triggers/trigger-store.js'
import { TriggerCreateSchema, TriggerEnableSchema, validateBodyCompat } from './schemas.js'
import { getRequestingTenantId } from './tenant-scope.js'

export interface TriggerRouteConfig {
  triggerStore: TriggerStore
}

export function createTriggerRoutes(config: TriggerRouteConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // --- Create trigger ---
  app.post('/', async (c) => {
    const tenantId = getRequestingTenantId(c)
    const parsed = await validateBodyCompat(c, TriggerCreateSchema)
    if (parsed instanceof Response) return parsed
    const body = parsed

    const id = body.id ?? crypto.randomUUID()
    const trigger = await config.triggerStore.save({
      id,
      type: body.type,
      agentId: body.agentId,
      schedule: body.schedule,
      webhookSecret: body.webhookSecret,
      afterAgentId: body.afterAgentId,
      enabled: body.enabled ?? true,
      metadata: body.metadata,
      tenantId,
    })

    return c.json(trigger, 201)
  })

  // --- List triggers ---
  app.get('/', async (c) => {
    const agentId = c.req.query('agentId')
    const enabledStr = c.req.query('enabled')
    const tenantId = getRequestingTenantId(c)

    const filter: { agentId?: string; enabled?: boolean; tenantId: string } = { tenantId }
    if (agentId) filter.agentId = agentId
    if (enabledStr !== undefined && enabledStr !== null) {
      filter.enabled = enabledStr === 'true'
    }

    const triggers = await config.triggerStore.list(filter)
    return c.json({ triggers })
  })

  // --- Get trigger ---
  app.get('/:id', async (c) => {
    const trigger = await config.triggerStore.get(c.req.param('id'), getRequestingTenantId(c))
    if (!trigger) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Trigger not found' } }, 404)
    }
    return c.json(trigger)
  })

  // --- Delete trigger ---
  app.delete('/:id', async (c) => {
    const deleted = await config.triggerStore.delete(c.req.param('id'), getRequestingTenantId(c))
    if (!deleted) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Trigger not found' } }, 404)
    }
    return c.json({ deleted: true })
  })

  // --- Toggle enabled state ---
  app.patch('/:id/enable', async (c) => {
    const parsed = await validateBodyCompat(c, TriggerEnableSchema)
    if (parsed instanceof Response) return parsed

    const trigger = await config.triggerStore.setEnabled(
      c.req.param('id'),
      parsed.enabled,
      getRequestingTenantId(c),
    )
    if (!trigger) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Trigger not found' } }, 404)
    }
    return c.json(trigger)
  })

  return app
}
