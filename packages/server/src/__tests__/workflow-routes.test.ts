/**
 * Workflow route tests.
 *
 * Tests the /api/workflows/* endpoints for execute, dry-run, stream, and list.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
  SkillRegistry,
  WorkflowRegistry,
  createSkillChain,
} from '@dzupagent/core'
import type { SkillStepResolver } from '@dzupagent/agent'
import type { Hono } from 'hono'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A minimal mock resolver that resolves skills from a known set.
 * Each resolved step returns { [skillId]: 'done' } as output.
 */
function createMockResolver(knownSkills: string[]): SkillStepResolver {
  return {
    canResolve(skillId: string) {
      return knownSkills.includes(skillId)
    },
    async resolve(skillId: string) {
      if (!knownSkills.includes(skillId)) {
        throw new Error(`Unknown skill: ${skillId}`)
      }
      return {
        id: skillId,
        description: `Mock step for ${skillId}`,
        execute: async (input: unknown) => {
          const state = (input as Record<string, unknown>) ?? {}
          return { ...state, [skillId]: 'done' }
        },
      }
    },
  }
}

function createTestConfig(overrides?: Partial<{
  coreSkillRegistry: SkillRegistry
  workflowRegistry: WorkflowRegistry
  resolver: SkillStepResolver
}>): ForgeServerConfig {
  const registry = new SkillRegistry()
  registry.register({ id: 'summarize', name: 'summarize', description: 'Summarize text', instructions: 'Summarize the input.' })
  registry.register({ id: 'translate', name: 'translate', description: 'Translate text', instructions: 'Translate the input.' })
  registry.register({ id: 'review', name: 'review', description: 'Review content', instructions: 'Review the input.' })

  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    coreSkillRegistry: overrides?.coreSkillRegistry ?? registry,
    workflowRegistry: overrides?.workflowRegistry,
    skillStepResolver: overrides?.resolver ?? createMockResolver(['summarize', 'translate', 'review']),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Workflow routes', () => {
  let app: Hono

  beforeEach(() => {
    app = createForgeApp(createTestConfig())
  })

  // --- POST /api/workflows/execute ---

  describe('POST /api/workflows/execute', () => {
    it('returns 200 with result for valid text workflow', async () => {
      const res = await req(app, 'POST', '/api/workflows/execute', {
        text: 'summarize -> translate',
        initialState: { userMessage: 'Hello world' },
      })
      expect(res.status).toBe(200)
      const json = await res.json() as { result: Record<string, unknown> }
      expect(json.result).toBeDefined()
      expect(json.result['summarize']).toBe('done')
      expect(json.result['translate']).toBe('done')
    })

    it('returns 400 for missing text', async () => {
      const res = await req(app, 'POST', '/api/workflows/execute', {})
      expect(res.status).toBe(400)
      const json = await res.json() as { error: { code: string } }
      expect(json.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 400 for empty text', async () => {
      const res = await req(app, 'POST', '/api/workflows/execute', { text: '  ' })
      expect(res.status).toBe(400)
      const json = await res.json() as { error: { code: string } }
      expect(json.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 400 for invalid JSON body', async () => {
      const res = await app.request('/api/workflows/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json',
      })
      expect(res.status).toBe(400)
    })

    it('returns 200 with default empty initialState when omitted', async () => {
      const res = await req(app, 'POST', '/api/workflows/execute', {
        text: 'summarize',
      })
      expect(res.status).toBe(200)
      const json = await res.json() as { result: Record<string, unknown> }
      expect(json.result['summarize']).toBe('done')
    })
  })

  // --- POST /api/workflows/dry-run ---

  describe('POST /api/workflows/dry-run', () => {
    it('returns DryRunResult for valid steps array', async () => {
      const res = await req(app, 'POST', '/api/workflows/dry-run', {
        steps: ['summarize', 'translate'],
      })
      expect(res.status).toBe(200)
      const json = await res.json() as { valid: boolean; steps: Array<{ skillId: string; resolved: boolean }>; errors: string[] }
      expect(json.valid).toBe(true)
      expect(json.steps).toHaveLength(2)
      expect(json.steps[0].skillId).toBe('summarize')
      expect(json.steps[0].resolved).toBe(true)
      expect(json.errors).toHaveLength(0)
    })

    it('returns DryRunResult with errors for unknown skills', async () => {
      const res = await req(app, 'POST', '/api/workflows/dry-run', {
        steps: ['summarize', 'nonexistent'],
      })
      expect(res.status).toBe(200)
      const json = await res.json() as { valid: boolean; steps: Array<{ skillId: string; resolved: boolean }>; errors: string[] }
      expect(json.valid).toBe(false)
      expect(json.steps[1].resolved).toBe(false)
      expect(json.errors.length).toBeGreaterThan(0)
    })

    it('parses text into steps for dry-run', async () => {
      const res = await req(app, 'POST', '/api/workflows/dry-run', {
        text: 'summarize -> translate',
      })
      expect(res.status).toBe(200)
      const json = await res.json() as { valid: boolean; steps: Array<{ skillId: string }> }
      expect(json.valid).toBe(true)
      expect(json.steps).toHaveLength(2)
    })

    it('returns 400 for missing steps and text', async () => {
      const res = await req(app, 'POST', '/api/workflows/dry-run', {})
      expect(res.status).toBe(400)
      const json = await res.json() as { error: { code: string } }
      expect(json.error.code).toBe('VALIDATION_ERROR')
    })
  })

  // --- GET /api/workflows/stream ---

  describe('GET /api/workflows/stream', () => {
    it('returns SSE stream for valid workflow text', async () => {
      const url = '/api/workflows/stream?text=summarize'
      const res = await app.request(url, { method: 'GET' })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')

      // Read the full SSE body
      const body = await res.text()
      // Should contain at least one step event and a done event
      expect(body).toContain('event: step:started')
      expect(body).toContain('event: done')
    })

    it('returns 400 for missing text parameter', async () => {
      const res = await app.request('/api/workflows/stream', { method: 'GET' })
      expect(res.status).toBe(400)
      const json = await res.json() as { error: { code: string } }
      expect(json.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 400 for invalid initialState JSON', async () => {
      const res = await app.request(
        '/api/workflows/stream?text=summarize&initialState=notjson',
        { method: 'GET' },
      )
      expect(res.status).toBe(400)
      const json = await res.json() as { error: { code: string } }
      expect(json.error.code).toBe('VALIDATION_ERROR')
    })
  })

  // --- GET /api/workflows ---

  describe('GET /api/workflows', () => {
    it('returns empty list when no workflow registry is configured', async () => {
      const res = await req(app, 'GET', '/api/workflows')
      expect(res.status).toBe(200)
      const json = await res.json() as { workflows: unknown[] }
      expect(json.workflows).toEqual([])
    })

    it('returns named workflows when registry has entries', async () => {
      const workflowRegistry = new WorkflowRegistry()
      workflowRegistry.register(
        'daily-report',
        createSkillChain('daily-report', [
          { skillName: 'summarize' },
          { skillName: 'translate' },
        ]),
        { description: 'Generate daily report', tags: ['daily', 'report'] },
      )

      const appWithRegistry = createForgeApp(createTestConfig({ workflowRegistry }))
      const res = await req(appWithRegistry, 'GET', '/api/workflows')
      expect(res.status).toBe(200)
      const json = await res.json() as { workflows: Array<{ name: string; description?: string; stepCount: number }> }
      expect(json.workflows).toHaveLength(1)
      expect(json.workflows[0].name).toBe('daily-report')
      expect(json.workflows[0].description).toBe('Generate daily report')
      expect(json.workflows[0].stepCount).toBe(2)
    })
  })

  // --- 503 / 404 when not configured ---

  describe('Service unavailable', () => {
    it('returns 404 when workflow routes are not mounted (no config)', async () => {
      const noWorkflowApp = createForgeApp({
        runStore: new InMemoryRunStore(),
        agentStore: new InMemoryAgentStore(),
        eventBus: createEventBus(),
        modelRegistry: new ModelRegistry(),
      })
      const res = await req(noWorkflowApp, 'POST', '/api/workflows/execute', { text: 'test' })
      expect(res.status).toBe(404)
    })

    it('returns 503 when skillRegistry is missing but resolver provided', async () => {
      const appMissingRegistry = createForgeApp({
        runStore: new InMemoryRunStore(),
        agentStore: new InMemoryAgentStore(),
        eventBus: createEventBus(),
        modelRegistry: new ModelRegistry(),
        skillStepResolver: createMockResolver(['summarize']),
        // coreSkillRegistry intentionally omitted
      })
      const res = await req(appMissingRegistry, 'POST', '/api/workflows/execute', { text: 'summarize' })
      expect(res.status).toBe(503)
    })
  })
})
