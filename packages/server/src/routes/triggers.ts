/**
 * Trigger CRUD routes — create, list, get, delete, and toggle triggers.
 */
import { Hono } from 'hono'
import type { TriggerStore, TriggerType } from '../triggers/trigger-store.js'

export interface TriggerRouteConfig {
  triggerStore: TriggerStore
}

export function createTriggerRoutes(config: TriggerRouteConfig): Hono {
  const app = new Hono()

  // --- Create trigger ---
  app.post('/', async (c) => {
    const body = await c.req.json<{
      id?: string
      type: TriggerType
      agentId: string
      schedule?: string
      webhookSecret?: string
      afterAgentId?: string
      enabled?: boolean
      metadata?: Record<string, unknown>
    }>()

    if (!body.type || !body.agentId) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'type and agentId are required' } },
        400,
      )
    }

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
    })

    return c.json(trigger, 201)
  })

  // --- List triggers ---
  app.get('/', async (c) => {
    const agentId = c.req.query('agentId')
    const enabledStr = c.req.query('enabled')

    const filter: { agentId?: string; enabled?: boolean } = {}
    if (agentId) filter.agentId = agentId
    if (enabledStr !== undefined && enabledStr !== null) {
      filter.enabled = enabledStr === 'true'
    }

    const triggers = await config.triggerStore.list(
      Object.keys(filter).length > 0 ? filter : undefined,
    )
    return c.json({ triggers })
  })

  // --- Get trigger ---
  app.get('/:id', async (c) => {
    const trigger = await config.triggerStore.get(c.req.param('id'))
    if (!trigger) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Trigger not found' } }, 404)
    }
    return c.json(trigger)
  })

  // --- Delete trigger ---
  app.delete('/:id', async (c) => {
    const deleted = await config.triggerStore.delete(c.req.param('id'))
    if (!deleted) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Trigger not found' } }, 404)
    }
    return c.json({ deleted: true })
  })

  // --- Toggle enabled state ---
  app.patch('/:id/enable', async (c) => {
    const body = await c.req.json<{ enabled: boolean }>()
    if (typeof body.enabled !== 'boolean') {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'enabled (boolean) is required' } },
        400,
      )
    }

    const trigger = await config.triggerStore.setEnabled(c.req.param('id'), body.enabled)
    if (!trigger) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Trigger not found' } }, 404)
    }
    return c.json(trigger)
  })

  return app
}
