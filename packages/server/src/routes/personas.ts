/**
 * Persona CRUD routes — create, list, get, update, and delete personas.
 *
 * A persona encapsulates a named set of instructions and optional model
 * configuration that can be applied to agent runs.
 */
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import type { PersonaStore } from '../personas/persona-store.js'
import { PersonaCreateSchema, PersonaUpdateSchema, validateBodyCompat } from './schemas.js'
import { getRequestingTenantId } from './tenant-scope.js'

export interface PersonaRouteConfig {
  personaStore: PersonaStore
}

export function createPersonaRoutes(config: PersonaRouteConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // --- Create persona ---
  app.post('/', async (c) => {
    const tenantId = getRequestingTenantId(c)
    const parsed = await validateBodyCompat(c, PersonaCreateSchema)
    if (parsed instanceof Response) return parsed
    const body = parsed

    const id = body.id ?? crypto.randomUUID()
    const persona = await config.personaStore.save({
      id,
      name: body.name,
      instructions: body.instructions,
      modelId: body.modelId,
      temperature: body.temperature,
      metadata: body.metadata,
      tenantId,
    })

    return c.json(persona, 201)
  })

  // --- List personas ---
  app.get('/', async (c) => {
    const personas = await config.personaStore.list({ tenantId: getRequestingTenantId(c) })
    return c.json({ personas })
  })

  // --- Get persona ---
  app.get('/:id', async (c) => {
    const persona = await config.personaStore.get(c.req.param('id'), getRequestingTenantId(c))
    if (!persona) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Persona not found' } }, 404)
    }
    return c.json(persona)
  })

  // --- Update persona ---
  app.put('/:id', async (c) => {
    const parsed = await validateBodyCompat(c, PersonaUpdateSchema)
    if (parsed instanceof Response) return parsed

    const persona = await config.personaStore.update(
      c.req.param('id'),
      parsed,
      getRequestingTenantId(c),
    )
    if (!persona) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Persona not found' } }, 404)
    }
    return c.json(persona)
  })

  // --- Delete persona ---
  app.delete('/:id', async (c) => {
    const deleted = await config.personaStore.delete(c.req.param('id'), getRequestingTenantId(c))
    if (!deleted) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Persona not found' } }, 404)
    }
    return c.json({ deleted: true })
  })

  return app
}
