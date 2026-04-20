import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createCapabilityRoutes } from '../capabilities.js'
import {
  AdapterSkillRegistry,
  SkillCapabilityMatrixBuilder,
  ClaudeSkillCompiler,
} from '@dzupagent/agent-adapters'
import type { AdapterSkillBundle } from '@dzupagent/agent-adapters'

// --- Helpers ---

function makeBundle(bundleId: string, skillSetId = 'test-skill-set'): AdapterSkillBundle {
  return {
    bundleId,
    skillSetId,
    skillSetVersion: '1.0.0',
    constraints: {},
    promptSections: [
      { id: 'task-section', purpose: 'task', content: 'Do the task.', priority: 1 },
    ],
    toolBindings: [],
    metadata: {
      owner: 'test-owner',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  }
}

async function request(
  app: Hono,
  method: string,
  path: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
  })
  const json = (await response.json()) as Record<string, unknown>
  return { status: response.status, json }
}

// --- Tests ---

describe('Capability Routes', () => {
  let registry: AdapterSkillRegistry
  let app: Hono

  beforeEach(() => {
    registry = new AdapterSkillRegistry()
    // Register the Claude compiler so listProviders() returns at least one entry
    // and SkillCapabilityMatrixBuilder can produce a non-empty providers map.
    registry.register(new ClaudeSkillCompiler())

    const routes = createCapabilityRoutes({ skillRegistry: registry })
    app = new Hono()
    app.route('/api/v1/capabilities', routes)
  })

  describe('GET /api/v1/capabilities/:skillId', () => {
    it('returns 200 with matrix data for a registered skill', async () => {
      const bundle = makeBundle('skill-abc', 'my-skill-set')
      registry.registerBundle(bundle)

      const { status, json } = await request(app, 'GET', '/api/v1/capabilities/skill-abc')

      expect(status).toBe(200)
      const data = json['data'] as Record<string, unknown>
      expect(data).toBeDefined()
      expect(data['skillId']).toBe('skill-abc')
      expect(data['skillName']).toBe('my-skill-set')
      expect(data['providers']).toBeDefined()
    })

    it('includes provider capability rows in the matrix', async () => {
      const bundle = makeBundle('skill-providers', 'provider-skill')
      registry.registerBundle(bundle)

      const { status, json } = await request(app, 'GET', '/api/v1/capabilities/skill-providers')

      expect(status).toBe(200)
      const data = json['data'] as Record<string, unknown>
      const providers = data['providers'] as Record<string, unknown>

      // At least the 'claude' provider row must be present since we registered ClaudeSkillCompiler
      expect(providers['claude']).toBeDefined()
      const claudeRow = providers['claude'] as Record<string, unknown>
      expect(claudeRow['systemPrompt']).toBe('active')
      expect(claudeRow['toolBindings']).toBeDefined()
      expect(claudeRow['approvalMode']).toBeDefined()
      expect(claudeRow['networkPolicy']).toBeDefined()
      expect(claudeRow['budgetLimit']).toBeDefined()
    })

    it('returns 404 with NOT_FOUND error code for unknown skillId', async () => {
      const { status, json } = await request(app, 'GET', '/api/v1/capabilities/does-not-exist')

      expect(status).toBe(404)
      const error = json['error'] as Record<string, unknown>
      expect(error['code']).toBe('NOT_FOUND')
      expect(typeof error['message']).toBe('string')
    })

    it('NOT_FOUND message references the missing skill id', async () => {
      const { json } = await request(app, 'GET', '/api/v1/capabilities/missing-skill')

      const error = json['error'] as Record<string, unknown>
      expect(error['message']).toContain('missing-skill')
    })

    it('returns 404 for an empty registry', async () => {
      // Fresh registry with no bundles registered
      const emptyRegistry = new AdapterSkillRegistry()
      emptyRegistry.register(new ClaudeSkillCompiler())
      const routes = createCapabilityRoutes({ skillRegistry: emptyRegistry })
      const emptyApp = new Hono()
      emptyApp.route('/api/v1/capabilities', routes)

      const { status, json } = await request(emptyApp, 'GET', '/api/v1/capabilities/any-skill')

      expect(status).toBe(404)
      const error = json['error'] as Record<string, unknown>
      expect(error['code']).toBe('NOT_FOUND')
    })

    it('resolves multiple independently registered bundles', async () => {
      registry.registerBundle(makeBundle('bundle-one', 'skill-set-one'))
      registry.registerBundle(makeBundle('bundle-two', 'skill-set-two'))

      const { status: s1, json: j1 } = await request(app, 'GET', '/api/v1/capabilities/bundle-one')
      const { status: s2, json: j2 } = await request(app, 'GET', '/api/v1/capabilities/bundle-two')

      expect(s1).toBe(200)
      expect((j1['data'] as Record<string, unknown>)['skillId']).toBe('bundle-one')

      expect(s2).toBe(200)
      expect((j2['data'] as Record<string, unknown>)['skillId']).toBe('bundle-two')
    })

    it('matrix result matches SkillCapabilityMatrixBuilder output directly', async () => {
      const bundle = makeBundle('builder-check', 'builder-skill')
      registry.registerBundle(bundle)

      const { json } = await request(app, 'GET', '/api/v1/capabilities/builder-check')
      const routeMatrix = json['data'] as Record<string, unknown>

      // Build the matrix ourselves and compare
      const builder = new SkillCapabilityMatrixBuilder(registry)
      const expected = builder.buildForSkill(bundle)

      expect(routeMatrix['skillId']).toBe(expected.skillId)
      expect(routeMatrix['skillName']).toBe(expected.skillName)
      // Providers shape matches
      const routeProviders = routeMatrix['providers'] as Record<string, unknown>
      for (const [providerId, expectedRow] of Object.entries(expected.providers)) {
        expect(routeProviders[providerId]).toEqual(expectedRow)
      }
    })

    it('response wraps matrix under a "data" key', async () => {
      registry.registerBundle(makeBundle('wrap-check'))

      const { json } = await request(app, 'GET', '/api/v1/capabilities/wrap-check')

      // Top-level must only expose "data"; no accidental "error" key
      expect(json['data']).toBeDefined()
      expect(json['error']).toBeUndefined()
    })
  })
})
