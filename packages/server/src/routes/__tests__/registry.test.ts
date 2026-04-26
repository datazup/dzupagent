import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createRegistryRoutes } from '../registry.js'
import { InMemoryRegistry } from '@dzupagent/core'
import type { AgentRegistry, ForgeCapability } from '@dzupagent/core'

// --- Helpers ---

function makeCap(name: string): ForgeCapability {
  return { name, version: '1.0.0', description: `Cap: ${name}` }
}

async function request(
  app: Hono,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body) init.body = JSON.stringify(body)

  const response = await app.request(path, init)
  const json = await response.json() as Record<string, unknown>
  return { status: response.status, json }
}

// --- Tests ---

describe('Registry Routes', () => {
  let registry: AgentRegistry
  let app: Hono

  beforeEach(() => {
    registry = new InMemoryRegistry()
    const routes = createRegistryRoutes({ registry })
    app = new Hono()
    app.route('/api/registry', routes)
  })

  describe('POST /api/registry/agents', () => {
    it('registers a new agent', async () => {
      const { status, json } = await request(app, 'POST', '/api/registry/agents', {
        name: 'test-agent',
        description: 'Test agent',
        capabilities: [makeCap('code.review')],
        protocols: ['a2a'],
      })

      expect(status).toBe(201)
      const data = json['data'] as Record<string, unknown>
      expect(data['name']).toBe('test-agent')
      expect(data['id']).toBeDefined()
    })

    it('returns 400 for missing name', async () => {
      const { status, json } = await request(app, 'POST', '/api/registry/agents', {
        description: 'Test',
        capabilities: [makeCap('cap')],
      })

      expect(status).toBe(400)
      const error = json['error'] as Record<string, unknown>
      expect(error['code']).toBe('VALIDATION_ERROR')
    })

    it('returns 400 for missing capabilities', async () => {
      const { status } = await request(app, 'POST', '/api/registry/agents', {
        name: 'test',
        description: 'Test',
        capabilities: [],
      })

      expect(status).toBe(400)
    })
  })

  describe('GET /api/registry/agents', () => {
    it('lists agents (empty)', async () => {
      const { status, json } = await request(app, 'GET', '/api/registry/agents')
      expect(status).toBe(200)
      expect(json['data']).toEqual([])
      expect(json['total']).toBe(0)
    })

    it('lists registered agents', async () => {
      await registry.register({
        name: 'agent-1',
        description: 'First',
        capabilities: [makeCap('cap.1')],
      })

      const { status, json } = await request(app, 'GET', '/api/registry/agents')
      expect(status).toBe(200)
      const data = json['data'] as unknown[]
      expect(data.length).toBe(1)
    })

    it('respects limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await registry.register({
          name: `agent-${i}`,
          description: `Agent ${i}`,
          capabilities: [makeCap(`cap.${i}`)],
        })
      }

      const { json } = await request(app, 'GET', '/api/registry/agents?limit=2&offset=1')
      const data = json['data'] as unknown[]
      expect(data.length).toBe(2)
    })
  })

  describe('GET /api/registry/agents/:id', () => {
    it('returns a registered agent', async () => {
      const agent = await registry.register({
        name: 'agent-1',
        description: 'First',
        capabilities: [makeCap('cap.1')],
      })

      const { status, json } = await request(app, 'GET', `/api/registry/agents/${agent.id}`)
      expect(status).toBe(200)
      const data = json['data'] as Record<string, unknown>
      expect(data['id']).toBe(agent.id)
    })

    it('returns 404 for non-existent agent', async () => {
      const { status } = await request(app, 'GET', '/api/registry/agents/non-existent')
      expect(status).toBe(404)
    })
  })

  describe('DELETE /api/registry/agents/:id', () => {
    it('deregisters an agent', async () => {
      const agent = await registry.register({
        name: 'agent-1',
        description: 'First',
        capabilities: [makeCap('cap.1')],
      })

      const { status, json } = await request(app, 'DELETE', `/api/registry/agents/${agent.id}`)
      expect(status).toBe(200)
      const data = json['data'] as Record<string, unknown>
      expect(data['deregistered']).toBe(true)

      // Verify deleted
      const check = await registry.getAgent(agent.id)
      expect(check).toBeUndefined()
    })

    it('returns 404 for non-existent agent', async () => {
      const { status } = await request(app, 'DELETE', '/api/registry/agents/non-existent')
      expect(status).toBe(404)
    })
  })

  describe('GET /api/registry/discover', () => {
    it('discovers agents by capability prefix', async () => {
      await registry.register({
        name: 'code-agent',
        description: 'Code agent',
        capabilities: [makeCap('code.review')],
      })

      const { status, json } = await request(
        app, 'GET', '/api/registry/discover?capabilityPrefix=code',
      )
      expect(status).toBe(200)
      const data = json['data'] as Record<string, unknown>
      const results = data['results'] as unknown[]
      expect(results.length).toBe(1)
    })

    it('returns all agents with no filters', async () => {
      await registry.register({
        name: 'agent-1',
        description: 'First',
        capabilities: [makeCap('cap.1')],
      })

      const { status, json } = await request(app, 'GET', '/api/registry/discover')
      expect(status).toBe(200)
      const data = json['data'] as Record<string, unknown>
      const results = data['results'] as unknown[]
      expect(results.length).toBe(1)
    })
  })

  describe('GET /api/registry/stats', () => {
    it('returns registry stats', async () => {
      await registry.register({
        name: 'agent-1',
        description: 'First',
        capabilities: [makeCap('cap.1')],
        protocols: ['a2a'],
      })

      const { status, json } = await request(app, 'GET', '/api/registry/stats')
      expect(status).toBe(200)
      const data = json['data'] as Record<string, unknown>
      expect(data['totalAgents']).toBe(1)
      expect(data['capabilityCount']).toBe(1)
    })
  })

  describe('GET /api/registry/health', () => {
    it('returns empty fleet status when registry has no agents', async () => {
      const { status, json } = await request(app, 'GET', '/api/registry/health')
      expect(status).toBe(200)
      const data = json['data'] as Record<string, unknown>
      expect(data['status']).toBe('empty')
      const counts = data['counts'] as Record<string, number>
      expect(counts['total']).toBe(0)
      expect(counts['healthy']).toBe(0)
      expect(Array.isArray(data['agents'])).toBe(true)
      expect((data['agents'] as unknown[]).length).toBe(0)
      expect(typeof data['timestamp']).toBe('string')
    })

    it('returns healthy fleet status when all agents are healthy', async () => {
      const a1 = await registry.register({
        name: 'alpha',
        description: 'Alpha agent',
        capabilities: [makeCap('alpha.cap')],
      })
      // Default health status for newly registered agents is 'unknown';
      // update to healthy so fleet status can be asserted.
      await registry.updateHealth(a1.id, { status: 'healthy' })

      const { status, json } = await request(app, 'GET', '/api/registry/health')
      expect(status).toBe(200)
      const data = json['data'] as Record<string, unknown>
      expect(data['status']).toBe('healthy')
      const counts = data['counts'] as Record<string, number>
      expect(counts['total']).toBe(1)
      expect(counts['healthy']).toBe(1)
    })

    it('returns degraded fleet status when some agents are degraded', async () => {
      const a1 = await registry.register({
        name: 'alpha',
        description: 'Alpha',
        capabilities: [makeCap('alpha.cap')],
      })
      const a2 = await registry.register({
        name: 'beta',
        description: 'Beta',
        capabilities: [makeCap('beta.cap')],
      })
      await registry.updateHealth(a1.id, { status: 'healthy' })
      await registry.updateHealth(a2.id, { status: 'degraded' })

      const { status, json } = await request(app, 'GET', '/api/registry/health')
      expect(status).toBe(200)
      const data = json['data'] as Record<string, unknown>
      expect(data['status']).toBe('degraded')
      const counts = data['counts'] as Record<string, number>
      expect(counts['healthy']).toBe(1)
      expect(counts['degraded']).toBe(1)
    })

    it('returns unhealthy fleet status when all agents are unhealthy', async () => {
      const a1 = await registry.register({
        name: 'gamma',
        description: 'Gamma',
        capabilities: [makeCap('gamma.cap')],
      })
      await registry.updateHealth(a1.id, { status: 'unhealthy' })

      const { json } = await request(app, 'GET', '/api/registry/health')
      const data = json['data'] as Record<string, unknown>
      expect(data['status']).toBe('unhealthy')
    })

    it('includes per-agent health summaries with expected fields', async () => {
      const a1 = await registry.register({
        name: 'delta',
        description: 'Delta',
        capabilities: [makeCap('delta.cap')],
      })
      await registry.updateHealth(a1.id, {
        status: 'healthy',
        latencyP50Ms: 42,
        circuitState: 'closed',
      })

      const { json } = await request(app, 'GET', '/api/registry/health')
      const data = json['data'] as Record<string, unknown>
      const agents = data['agents'] as Array<Record<string, unknown>>
      expect(agents.length).toBe(1)
      const summary = agents[0]
      expect(summary['id']).toBe(a1.id)
      expect(summary['name']).toBe('delta')
      expect(summary['status']).toBe('healthy')
      expect(summary['latencyP50Ms']).toBe(42)
      expect(summary['circuitState']).toBe('closed')
    })
  })
})
