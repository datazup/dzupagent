/**
 * Registry REST API routes — ECO-052.
 *
 * Provides CRUD operations for the AgentRegistry, plus discovery
 * and stats endpoints.
 *
 * POST   /api/registry/agents       — register an agent
 * GET    /api/registry/agents       — list agents (paginated)
 * GET    /api/registry/agents/:id   — get single agent
 * DELETE /api/registry/agents/:id   — deregister agent
 * GET    /api/registry/discover     — query-based discovery
 * GET    /api/registry/stats        — registry statistics
 */

import { Hono } from 'hono'
import type { AgentRegistry, RegisterAgentInput, DiscoveryQuery, ForgeCapability, AgentHealthStatus } from '@forgeagent/core'

export interface RegistryRouteConfig {
  registry: AgentRegistry
}

export function createRegistryRoutes(config: RegistryRouteConfig): Hono {
  const app = new Hono()
  const { registry } = config

  // POST /api/registry/agents — Register
  app.post('/agents', async (c) => {
    try {
      const body = await c.req.json<{
        name: string
        description: string
        endpoint?: string
        protocols?: string[]
        capabilities: ForgeCapability[]
        version?: string
        ttlMs?: number
        metadata?: Record<string, unknown>
      }>()

      if (!body.name || !body.description) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: 'name and description are required' } },
          400,
        )
      }

      if (!body.capabilities || body.capabilities.length === 0) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: 'At least one capability is required' } },
          400,
        )
      }

      const input: RegisterAgentInput = {
        name: body.name,
        description: body.description,
        endpoint: body.endpoint,
        protocols: body.protocols,
        capabilities: body.capabilities,
        version: body.version,
        ttlMs: body.ttlMs,
        metadata: body.metadata,
      }

      const agent = await registry.register(input)
      return c.json({ data: agent }, 201)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'REGISTRY_ERROR', message } }, 500)
    }
  })

  // GET /api/registry/agents — List (paginated)
  app.get('/agents', async (c) => {
    try {
      const limit = parseInt(c.req.query('limit') ?? '100', 10)
      const offset = parseInt(c.req.query('offset') ?? '0', 10)

      const result = await registry.listAgents(
        Math.min(Math.max(limit, 1), 200),
        Math.max(offset, 0),
      )

      return c.json({ data: result.agents, total: result.total, limit, offset })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'REGISTRY_ERROR', message } }, 500)
    }
  })

  // GET /api/registry/agents/:id — Get single
  app.get('/agents/:id', async (c) => {
    try {
      const agent = await registry.getAgent(c.req.param('id'))
      if (!agent) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } }, 404)
      }
      return c.json({ data: agent })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'REGISTRY_ERROR', message } }, 500)
    }
  })

  // DELETE /api/registry/agents/:id — Deregister
  app.delete('/agents/:id', async (c) => {
    try {
      await registry.deregister(c.req.param('id'))
      return c.json({ data: { id: c.req.param('id'), deregistered: true } })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const status = message.includes('not found') ? 404 : 500
      return c.json({ error: { code: status === 404 ? 'NOT_FOUND' : 'REGISTRY_ERROR', message } }, status)
    }
  })

  // GET /api/registry/discover — Discovery
  app.get('/discover', async (c) => {
    try {
      const query: DiscoveryQuery = {}

      const capPrefix = c.req.query('capabilityPrefix')
      if (capPrefix) query.capabilityPrefix = capPrefix

      const capExact = c.req.query('capabilityExact')
      if (capExact) query.capabilityExact = { name: capExact }

      const semanticQ = c.req.query('q')
      if (semanticQ) query.semanticQuery = semanticQ

      const tags = c.req.query('tags')
      if (tags) query.tags = tags.split(',')

      const health = c.req.query('health')
      if (health) query.healthFilter = health.split(',') as AgentHealthStatus[]

      const protocols = c.req.query('protocols')
      if (protocols) query.protocols = protocols.split(',')

      const limit = c.req.query('limit')
      if (limit) query.limit = parseInt(limit, 10)

      const offset = c.req.query('offset')
      if (offset) query.offset = parseInt(offset, 10)

      const result = await registry.discover(query)
      return c.json({ data: result })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'REGISTRY_ERROR', message } }, 500)
    }
  })

  // GET /api/registry/stats — Stats
  app.get('/stats', async (c) => {
    try {
      const stats = await registry.stats()
      return c.json({ data: stats })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'REGISTRY_ERROR', message } }, 500)
    }
  })

  return app
}
