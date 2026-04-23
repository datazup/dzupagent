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
import type { ForgeServerConfig } from '../app.js'
import { AgentDefinitionService } from '../services/agent-definition-service.js'

export function createAgentDefinitionRoutes(config: ForgeServerConfig): Hono {
  const app = new Hono()
  const service = new AgentDefinitionService({ agentStore: config.agentStore })

  // GET /api/agent-definitions — List agent definitions
  app.get('/', async (c) => {
    const active = c.req.query('active')
    const limit = parseInt(c.req.query('limit') ?? '100', 10)

    const agents = await service.list({
      active: active !== undefined ? active === 'true' : undefined,
      limit,
    })

    return c.json({ data: agents, count: agents.length })
  })

  // POST /api/agent-definitions — Create agent definition
  app.post('/', async (c) => {
    const body = await c.req.json<{
      id?: string
      name: string
      instructions: string
      modelTier: string
      description?: string
      tools?: string[]
      guardrails?: Record<string, unknown>
      approval?: 'auto' | 'required' | 'conditional'
      metadata?: Record<string, unknown>
    }>()

    if (!body.name || !body.instructions || !body.modelTier) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'name, instructions, and modelTier are required' } },
        400,
      )
    }

    const saved = await service.create(body)
    return c.json({ data: saved }, 201)
  })

  // GET /api/agent-definitions/:id — Get agent definition
  app.get('/:id', async (c) => {
    const agent = await service.get(c.req.param('id'))
    if (!agent) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } }, 404)
    }
    return c.json({ data: agent })
  })

  // PATCH /api/agent-definitions/:id — Update agent definition
  app.patch('/:id', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json<Partial<{
      name: string
      description: string
      instructions: string
      modelTier: string
      tools: string[]
      guardrails: Record<string, unknown>
      approval: 'auto' | 'required' | 'conditional'
      metadata: Record<string, unknown>
    }>>()

    const updated = await service.update(id, body)
    if (!updated) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } }, 404)
    }
    return c.json({ data: updated })
  })

  // DELETE /api/agent-definitions/:id — Soft-delete agent definition
  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const deleted = await service.delete(id)
    if (!deleted) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } }, 404)
    }
    return c.json({ data: { id, deleted: true } })
  })

  return app
}

/** @deprecated Use `createAgentDefinitionRoutes`. */
export const createAgentRoutes = createAgentDefinitionRoutes
