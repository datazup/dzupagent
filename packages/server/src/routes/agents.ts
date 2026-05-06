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
import type { ForgeServerConfig } from '../composition/types.js'
import { AgentDefinitionService } from '../services/agent-definition-service.js'
import {
  AgentCreateSchema,
  AgentUpdateSchema,
  parseIntBounded,
  validateBodyCompat,
} from './schemas.js'
import { getRequestingTenantId } from './tenant-scope.js'

export function createAgentDefinitionRoutes(config: ForgeServerConfig): Hono {
  const app = new Hono()
  const service = new AgentDefinitionService({ agentStore: config.agentStore })

  // GET /api/agent-definitions — List agent definitions
  app.get('/', async (c) => {
    const active = c.req.query('active')
    const limit = parseIntBounded(c.req.query('limit'), 100, 1, 500)
    const tenantId = getRequestingTenantId(c)

    const agents = await service.list({
      active: active !== undefined ? active === 'true' : undefined,
      limit,
      tenantId,
    })

    return c.json({ data: agents, count: agents.length })
  })

  // POST /api/agent-definitions — Create agent definition
  app.post('/', async (c) => {
    const parsed = await validateBodyCompat(c, AgentCreateSchema)
    if (parsed instanceof Response) return parsed
    const body = parsed
    const tenantId = getRequestingTenantId(c)

    const saved = await service.create({ ...body, tenantId })
    return c.json({ data: saved }, 201)
  })

  // GET /api/agent-definitions/:id — Get agent definition
  app.get('/:id', async (c) => {
    const agent = await service.get(c.req.param('id'), getRequestingTenantId(c))
    if (!agent) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } }, 404)
    }
    return c.json({ data: agent })
  })

  // PATCH /api/agent-definitions/:id — Update agent definition
  app.patch('/:id', async (c) => {
    const id = c.req.param('id')
    const tenantId = getRequestingTenantId(c)
    const parsed = await validateBodyCompat(c, AgentUpdateSchema)
    if (parsed instanceof Response) return parsed

    const updated = await service.update(id, parsed, tenantId)
    if (!updated) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } }, 404)
    }
    return c.json({ data: updated })
  })

  // DELETE /api/agent-definitions/:id — Soft-delete agent definition
  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const deleted = await service.delete(id, getRequestingTenantId(c))
    if (!deleted) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } }, 404)
    }
    return c.json({ data: { id, deleted: true } })
  })

  return app
}

/** @deprecated Use `createAgentDefinitionRoutes`. */
export const createAgentRoutes = createAgentDefinitionRoutes
