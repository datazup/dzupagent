/**
 * Persona CRUD routes — create, list, get, update, and delete personas.
 *
 * A persona encapsulates a named set of instructions and optional model
 * configuration that can be applied to agent runs.
 */
import { Hono } from 'hono'
import type { PersonaStore } from '../personas/persona-store.js'

export interface PersonaRouteConfig {
  personaStore: PersonaStore
}

export function createPersonaRoutes(config: PersonaRouteConfig): Hono {
  const app = new Hono()

  // --- Create persona ---
  app.post('/', async (c) => {
    const body = await c.req.json<{
      id?: string
      name: string
      instructions: string
      modelId?: string
      temperature?: number
      metadata?: Record<string, unknown>
    }>()

    if (!body.name || !body.instructions) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'name and instructions are required' } },
        400,
      )
    }

    const id = body.id ?? crypto.randomUUID()
    const persona = await config.personaStore.save({
      id,
      name: body.name,
      instructions: body.instructions,
      modelId: body.modelId,
      temperature: body.temperature,
      metadata: body.metadata,
    })

    return c.json(persona, 201)
  })

  // --- List personas ---
  app.get('/', async (c) => {
    const personas = await config.personaStore.list()
    return c.json({ personas })
  })

  // --- Get persona ---
  app.get('/:id', async (c) => {
    const persona = await config.personaStore.get(c.req.param('id'))
    if (!persona) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Persona not found' } }, 404)
    }
    return c.json(persona)
  })

  // --- Update persona ---
  app.put('/:id', async (c) => {
    const body = await c.req.json<{
      name?: string
      instructions?: string
      modelId?: string
      temperature?: number
      metadata?: Record<string, unknown>
    }>()

    const persona = await config.personaStore.update(c.req.param('id'), body)
    if (!persona) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Persona not found' } }, 404)
    }
    return c.json(persona)
  })

  // --- Delete persona ---
  app.delete('/:id', async (c) => {
    const deleted = await config.personaStore.delete(c.req.param('id'))
    if (!deleted) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Persona not found' } }, 404)
    }
    return c.json({ deleted: true })
  })

  return app
}
