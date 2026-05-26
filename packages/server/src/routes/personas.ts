/**
 * Persona CRUD routes — create, list, get, update, and delete personas.
 *
 * A persona encapsulates a named set of instructions and optional model
 * configuration that can be applied to agent runs.
 */
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import type { PersonaStore } from '../personas/persona-store.js'
import { PersonaCreateSchema, PersonaUpdateSchema } from './schemas.js'
import { body, notFound, tenantOf } from './crud-helpers.js'

const NOT_FOUND = 'Persona not found'

export interface PersonaRouteConfig {
  personaStore: PersonaStore
}

export function createPersonaRoutes(config: PersonaRouteConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // --- Create persona ---
  app.post('/', async (c) => {
    const parsed = await body(c, PersonaCreateSchema)
    if (!parsed.ok) return parsed.response
    const b = parsed.value

    const persona = await config.personaStore.save({
      id: b.id ?? crypto.randomUUID(),
      name: b.name,
      instructions: b.instructions,
      modelId: b.modelId,
      temperature: b.temperature,
      metadata: b.metadata,
      tenantId: tenantOf(c),
    })
    return c.json(persona, 201)
  })

  // --- List personas ---
  app.get('/', async (c) => {
    const personas = await config.personaStore.list({ tenantId: tenantOf(c) })
    return c.json({ personas })
  })

  // --- Get persona ---
  app.get('/:id', async (c) => {
    const persona = await config.personaStore.get(c.req.param('id'), tenantOf(c))
    return persona ? c.json(persona) : notFound(c, NOT_FOUND)
  })

  // --- Update persona ---
  app.put('/:id', async (c) => {
    const parsed = await body(c, PersonaUpdateSchema)
    if (!parsed.ok) return parsed.response
    const persona = await config.personaStore.update(c.req.param('id'), parsed.value, tenantOf(c))
    return persona ? c.json(persona) : notFound(c, NOT_FOUND)
  })

  // --- Delete persona ---
  app.delete('/:id', async (c) => {
    const deleted = await config.personaStore.delete(c.req.param('id'), tenantOf(c))
    return deleted ? c.json({ deleted: true }) : notFound(c, NOT_FOUND)
  })

  return app
}
