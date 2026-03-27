/**
 * Agent definition management routes.
 *
 * GET    /api/agents      — List agent definitions
 * POST   /api/agents      — Create agent definition
 * GET    /api/agents/:id  — Get agent by ID
 * PATCH  /api/agents/:id  — Update agent definition
 * DELETE /api/agents/:id  — Soft-delete agent (set active=false)
 */
import { Hono } from 'hono'
import type { ForgeServerConfig } from '../app.js'

export function createAgentRoutes(config: ForgeServerConfig): Hono {
  const app = new Hono()
  const { agentStore } = config

  // GET /api/agents — List agents
  app.get('/', async (c) => {
    const active = c.req.query('active')
    const limit = parseInt(c.req.query('limit') ?? '100', 10)

    const agents = await agentStore.list({
      active: active !== undefined ? active === 'true' : undefined,
      limit: Math.min(limit, 200),
    })

    return c.json({ data: agents, count: agents.length })
  })

  // POST /api/agents — Create agent
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

    const id = body.id ?? crypto.randomUUID()

    await agentStore.save({
      id,
      name: body.name,
      description: body.description,
      instructions: body.instructions,
      modelTier: body.modelTier,
      tools: body.tools,
      guardrails: body.guardrails,
      approval: body.approval,
      metadata: body.metadata,
      active: true,
    })

    const saved = await agentStore.get(id)
    return c.json({ data: saved }, 201)
  })

  // GET /api/agents/:id — Get agent
  app.get('/:id', async (c) => {
    const agent = await agentStore.get(c.req.param('id'))
    if (!agent) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } }, 404)
    }
    return c.json({ data: agent })
  })

  // PATCH /api/agents/:id — Update agent
  app.patch('/:id', async (c) => {
    const id = c.req.param('id')
    const existing = await agentStore.get(id)
    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } }, 404)
    }

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

    await agentStore.save({
      ...existing,
      ...body,
      id, // preserve original ID
    })

    const updated = await agentStore.get(id)
    return c.json({ data: updated })
  })

  // DELETE /api/agents/:id — Soft-delete agent
  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const existing = await agentStore.get(id)
    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } }, 404)
    }

    await agentStore.delete(id)
    return c.json({ data: { id, deleted: true } })
  })

  return app
}
