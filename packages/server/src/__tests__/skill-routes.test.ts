/**
 * Adapter skill route tests.
 *
 * Tests the /api/skills/* endpoints using createDefaultSkillRegistry from @dzupagent/agent-adapters.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import { createDefaultSkillRegistry } from '@dzupagent/agent-adapters'
import type { AdapterSkillRegistry, AdapterSkillBundle } from '@dzupagent/agent-adapters'
import type { Hono } from 'hono'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestConfig(skillRegistry?: AdapterSkillRegistry): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    skillRegistry: skillRegistry ?? createDefaultSkillRegistry(),
  }
}

async function req(app: Hono, method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body) init.body = JSON.stringify(body)
  return app.request(path, init)
}

function testBundle(): AdapterSkillBundle {
  return {
    bundleId: 'test-bundle-1',
    skillSetId: 'test-skillset',
    skillSetVersion: '1.0.0',
    constraints: {
      approvalMode: 'auto',
      networkPolicy: 'off',
      toolPolicy: 'strict',
    },
    promptSections: [
      {
        id: 'task-section',
        purpose: 'task',
        content: 'You are a test agent.',
        priority: 1,
      },
    ],
    toolBindings: [
      { toolName: 'search', mode: 'required' },
    ],
    metadata: {
      owner: 'test-user',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Skill routes', () => {
  let app: Hono
  let registry: AdapterSkillRegistry

  beforeEach(() => {
    registry = createDefaultSkillRegistry()
    app = createForgeApp(createTestConfig(registry))
  })

  // --- List all skills ---

  it('GET /api/skills returns list of providers', async () => {
    const res = await req(app, 'GET', '/api/skills')
    expect(res.status).toBe(200)
    const json = await res.json() as { data: Array<{ providerId: string }>; count: number }
    expect(json.count).toBeGreaterThan(0)
    // Should include known providers
    const ids = json.data.map((d) => d.providerId)
    expect(ids).toContain('codex')
    expect(ids).toContain('claude')
  })

  // --- List skills by provider ---

  it('GET /api/skills/:provider returns compiler info for valid provider', async () => {
    const res = await req(app, 'GET', '/api/skills/codex')
    expect(res.status).toBe(200)
    const json = await res.json() as { data: { providerId: string } }
    expect(json.data.providerId).toBe('codex')
  })

  it('GET /api/skills/:provider returns 404 for unknown provider', async () => {
    const res = await req(app, 'GET', '/api/skills/unknown-provider')
    expect(res.status).toBe(404)
    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('NOT_FOUND')
  })

  // --- Get specific skill ---

  it('GET /api/skills/:provider/:skillId returns 404 (compiled skills are ephemeral)', async () => {
    const res = await req(app, 'GET', '/api/skills/codex/some-skill')
    expect(res.status).toBe(404)
  })

  // --- Compile ---

  it('POST /api/skills/compile compiles a bundle for all providers (201)', async () => {
    const res = await req(app, 'POST', '/api/skills/compile', {
      bundle: testBundle(),
    })
    expect(res.status).toBe(201)
    const json = await res.json() as { data: Record<string, { providerId: string; hash: string }> }
    expect(json.data['codex']).toBeDefined()
    expect(json.data['codex'].providerId).toBe('codex')
    expect(json.data['claude']).toBeDefined()
    expect(json.data['claude'].providerId).toBe('claude')
  })

  it('POST /api/skills/compile compiles for a specific provider', async () => {
    const res = await req(app, 'POST', '/api/skills/compile', {
      bundle: testBundle(),
      providerId: 'codex',
    })
    expect(res.status).toBe(201)
    const json = await res.json() as { data: Record<string, { providerId: string }> }
    expect(Object.keys(json.data)).toEqual(['codex'])
  })

  it('POST /api/skills/compile returns 400 for missing bundle', async () => {
    const res = await req(app, 'POST', '/api/skills/compile', {})
    expect(res.status).toBe(400)
    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('VALIDATION_ERROR')
  })

  // --- Registry stats ---

  it('GET /api/skills/registry/stats returns provider stats', async () => {
    const res = await req(app, 'GET', '/api/skills/registry/stats')
    expect(res.status).toBe(200)
    const json = await res.json() as { data: { providerCount: number; providers: string[] } }
    expect(json.data.providerCount).toBeGreaterThan(0)
    expect(json.data.providers).toContain('codex')
    expect(json.data.providers).toContain('claude')
  })

  // --- Service unavailable ---

  it('returns 404 when skillRegistry is not configured (routes not mounted)', async () => {
    const noSkillApp = createForgeApp({
      runStore: new InMemoryRunStore(),
      agentStore: new InMemoryAgentStore(),
      eventBus: createEventBus(),
      modelRegistry: new ModelRegistry(),
      // skillRegistry intentionally omitted
    })
    const res = await req(noSkillApp, 'GET', '/api/skills')
    expect(res.status).toBe(404)
  })
})
