/**
 * Agent definition management routes.
 *
 * Canonical path:
 * GET    /api/agent-definitions      — List agent definitions
 * POST   /api/agent-definitions      — Create agent definition
 * GET    /api/agent-definitions/:id  — Get agent definition by ID
 * PATCH  /api/agent-definitions/:id  — Update agent definition
 * DELETE /api/agent-definitions/:id  — Soft-delete agent definition
 *
 * Compatibility alias:
 * - `/api/agents/*`
 */
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import type { ForgeServerConfig } from '../composition/types.js'
import { AgentDefinitionService } from '../services/agent-definition-service.js'
import { AgentCreateSchema, AgentUpdateSchema, parseIntBounded } from './schemas.js'
import { body, data, notFound, tenantOf } from './crud-helpers.js'

const NOT_FOUND = 'Agent not found'

export function createAgentDefinitionRoutes(config: ForgeServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const service = new AgentDefinitionService({ agentStore: config.agentStore })

  // GET /api/agent-definitions — List agent definitions
  app.get('/', async (c) => {
    const active = c.req.query('active')
    const agents = await service.list({
      active: active !== undefined ? active === 'true' : undefined,
      limit: parseIntBounded(c.req.query('limit'), 100, 1, 500),
      tenantId: tenantOf(c),
    })
    return c.json({ data: agents, count: agents.length })
  })

  // POST /api/agent-definitions — Create agent definition
  app.post('/', async (c) => {
    const parsed = await body(c, AgentCreateSchema)
    if (!parsed.ok) return parsed.response
    return data(c, await service.create({ ...parsed.value, tenantId: tenantOf(c) }), 201)
  })

  // GET /api/agent-definitions/:id — Get agent definition
  app.get('/:id', async (c) => {
    const agent = await service.get(c.req.param('id'), tenantOf(c))
    return agent ? data(c, agent) : notFound(c, NOT_FOUND)
  })

  // PATCH /api/agent-definitions/:id — Update agent definition
  app.patch('/:id', async (c) => {
    const parsed = await body(c, AgentUpdateSchema)
    if (!parsed.ok) return parsed.response
    const updated = await service.update(c.req.param('id'), parsed.value, tenantOf(c))
    return updated ? data(c, updated) : notFound(c, NOT_FOUND)
  })

  // DELETE /api/agent-definitions/:id — Soft-delete agent definition
  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const deleted = await service.delete(id, tenantOf(c))
    return deleted ? data(c, { id, deleted: true }) : notFound(c, NOT_FOUND)
  })

  return app
}

/** @deprecated Use `createAgentDefinitionRoutes`. */
export const createAgentRoutes = createAgentDefinitionRoutes
