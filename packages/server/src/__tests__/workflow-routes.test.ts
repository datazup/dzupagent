/**
 * Workflow route tests.
 *
 * Tests the /api/workflows/* endpoints for execute, dry-run, stream, and list.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import { InMemoryPersonaStore } from '../personas/persona-store.js'
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
// Mock @dzupagent/flow-compiler
//
// The compiled-flow branch of POST /api/workflows/execute calls
// `createFlowCompiler(...).compile(flow)`. We stub that so the tests never
// instantiate a real compiler — they just feed predetermined results.
//
// Textual workflow tests never touch this module, so the mock stays idle for
// them. `mockCompile.mockResolvedValueOnce(...)` is used per-test to set up
// the compile outcome.
// ---------------------------------------------------------------------------
const mockCompile = vi.fn()
const mockCreateFlowCompiler = vi.fn(() => ({ compile: mockCompile }))

vi.mock('@dzupagent/flow-compiler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dzupagent/flow-compiler')>()
  return {
    ...actual,
    createFlowCompiler: (...args: unknown[]) => mockCreateFlowCompiler(...args),
  }
})

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

  // -------------------------------------------------------------------------
  // POST /api/workflows/execute — compiled-flow branch
  // -------------------------------------------------------------------------

  describe('POST /api/workflows/execute (compiled flow)', () => {
    beforeEach(() => {
      mockCompile.mockReset()
      mockCreateFlowCompiler.mockClear()
    })

    /** Build a minimal successful compile result bound to a given chain name. */
    function successCompile(steps: Array<{ skillName: string }>, chainName = 'flow') {
      return {
        artifact: { name: chainName, steps },
        warnings: [] as string[],
        target: 'skill-chain' as const,
        compileId: 'cid-exec-1',
      }
    }

    it('returns 200 and executes the compiled skill-chain artifact', async () => {
      mockCompile.mockResolvedValueOnce(
        successCompile([{ skillName: 'summarize' }, { skillName: 'translate' }]),
      )

      const res = await req(app, 'POST', '/api/workflows/execute', {
        flow: { type: 'action', tool: 'summarize' },
        initialState: { userMessage: 'hi' },
      })

      expect(res.status).toBe(200)
      const json = (await res.json()) as {
        result: Record<string, unknown>
        compileId: string
        target: string
        warnings: unknown[]
      }
      expect(json.compileId).toBe('cid-exec-1')
      expect(json.target).toBe('skill-chain')
      expect(json.result['summarize']).toBe('done')
      expect(json.result['translate']).toBe('done')
      expect(Array.isArray(json.warnings)).toBe(true)

      // Compiler is constructed with the configured tool resolver (here none is
      // wired, so the no-op resolver is passed through).
      expect(mockCreateFlowCompiler).toHaveBeenCalledTimes(1)
    })

    it('accepts flow as a JSON-encoded string', async () => {
      mockCompile.mockResolvedValueOnce(
        successCompile([{ skillName: 'summarize' }]),
      )

      const res = await req(app, 'POST', '/api/workflows/execute', {
        flow: JSON.stringify({ type: 'action', tool: 'summarize' }),
      })
      expect(res.status).toBe(200)
    })

    it('accepts canonical workflow document input', async () => {
      mockCompile.mockResolvedValueOnce(
        successCompile([{ skillName: 'summarize' }]),
      )

      const res = await req(app, 'POST', '/api/workflows/execute', {
        document: {
          dsl: 'dzupflow/v1',
          id: 'doc_flow',
          version: 1,
          root: {
            type: 'sequence',
            id: 'root',
            nodes: [
              { type: 'complete', id: 'done', result: 'ok' },
            ],
          },
        },
      })
      expect(res.status).toBe(200)
    })

    it('accepts dzupflow DSL input and compiles the normalized root flow', async () => {
      mockCompile.mockResolvedValueOnce(
        successCompile([{ skillName: 'summarize' }]),
      )

      const res = await req(app, 'POST', '/api/workflows/execute', {
        dsl: `
dsl: dzupflow/v1
id: review_and_build
version: 1
steps:
  - complete:
      id: done
      result: ok
`,
      })
      expect(res.status).toBe(200)
      expect(mockCompile).toHaveBeenCalledWith({
        type: 'sequence',
        id: 'root',
        nodes: [
          { type: 'complete', id: 'done', result: 'ok' },
        ],
      })
    })

    it('returns 400 when both text and flow are provided', async () => {
      const res = await req(app, 'POST', '/api/workflows/execute', {
        text: 'summarize',
        flow: { type: 'action', tool: 'summarize' },
      })
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string; message: string } }
      expect(json.error.code).toBe('VALIDATION_ERROR')
      expect(json.error.message).toMatch(/one compile input/)
    })

    it('returns 400 when text is combined with a DSL compile input', async () => {
      const res = await req(app, 'POST', '/api/workflows/execute', {
        text: 'summarize',
        dsl: `
dsl: dzupflow/v1
id: review_and_build
version: 1
steps:
  - complete:
      id: done
      result: ok
`,
      })
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string; message: string } }
      expect(json.error.code).toBe('VALIDATION_ERROR')
      expect(json.error.message).toMatch(/one compile input/)
    })

    it('returns 400 when flow is a non-string, non-object primitive', async () => {
      const res = await req(app, 'POST', '/api/workflows/execute', { flow: 42 })
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 400 when target is an unknown value', async () => {
      const res = await req(app, 'POST', '/api/workflows/execute', {
        flow: { type: 'action', tool: 'summarize' },
        target: 'bogus-target',
      })
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string; message: string } }
      expect(json.error.code).toBe('VALIDATION_ERROR')
      expect(json.error.message).toMatch(/target must be one of/)
    })

    it('returns 400 when a non-executable target is requested', async () => {
      const res = await req(app, 'POST', '/api/workflows/execute', {
        flow: { type: 'action', tool: 'summarize' },
        target: 'pipeline',
      })
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string; message: string } }
      expect(json.error.code).toBe('VALIDATION_ERROR')
      expect(json.error.message).toMatch(/Only target="skill-chain"/)
    })

    it('returns 400 when compiler reports errors', async () => {
      mockCompile.mockResolvedValueOnce({
        errors: [
          { stage: 2, message: 'bad shape', nodePath: 'root' },
        ],
        compileId: 'cid-fail-1',
      })

      const res = await req(app, 'POST', '/api/workflows/execute', {
        flow: { type: 'action' },
      })
      expect(res.status).toBe(400)
      const json = (await res.json()) as {
        error: { code: string; message: string; stage: number; compileId: string }
      }
      expect(json.error.code).toBe('COMPILE_ERROR')
      expect(json.error.stage).toBe(2)
      expect(json.error.compileId).toBe('cid-fail-1')
      expect(json.error.message).toMatch(/bad shape/)
    })

    it('returns 400 when compiled target is not skill-chain', async () => {
      mockCompile.mockResolvedValueOnce({
        artifact: { nodes: [], edges: [] },
        warnings: [],
        target: 'pipeline' as const,
        compileId: 'cid-pipe-1',
      })

      const res = await req(app, 'POST', '/api/workflows/execute', {
        flow: { type: 'for_each', items: [], body: { type: 'action', tool: 'x' } },
      })
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string; message: string } }
      expect(json.error.code).toBe('VALIDATION_ERROR')
      expect(json.error.message).toMatch(/not executable here/)
    })

    it('returns 500 when compiler throws', async () => {
      mockCompile.mockRejectedValueOnce(new Error('boom'))
      const res = await req(app, 'POST', '/api/workflows/execute', {
        flow: { type: 'action', tool: 'summarize' },
      })
      expect(res.status).toBe(500)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe('COMPILE_ERROR')
    })

    it('returns 500 when skill execution fails', async () => {
      // Compiler returns a chain referencing a skill the resolver does NOT know.
      mockCompile.mockResolvedValueOnce(
        successCompile([{ skillName: 'nonexistent-skill' }]),
      )

      const res = await req(app, 'POST', '/api/workflows/execute', {
        flow: { type: 'action', tool: 'nonexistent-skill' },
      })
      expect(res.status).toBe(500)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe('EXECUTION_ERROR')
    })

    it('streams execution events as SSE when Accept: text/event-stream', async () => {
      mockCompile.mockResolvedValueOnce(
        successCompile([{ skillName: 'summarize' }]),
      )

      const res = await app.request('/api/workflows/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ flow: { type: 'action', tool: 'summarize' } }),
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')

      const body = await res.text()
      // The stream emits a synthetic compile:completed header event, then the
      // skill-chain step lifecycle, and finally a `done` sentinel.
      expect(body).toContain('event: compile:completed')
      expect(body).toContain('"compileId":"cid-exec-1"')
      expect(body).toContain('event: step:started')
      expect(body).toContain('event: done')
    })

    it('SSE surface emits an error event when compile reports errors', async () => {
      mockCompile.mockResolvedValueOnce({
        errors: [{ stage: 2, message: 'shape fail', nodePath: 'root' }],
        compileId: 'cid-sse-fail',
      })

      // Compile errors short-circuit BEFORE SSE negotiation (the helper
      // returns a 400 JSON response even when Accept is SSE) — verify that
      // contract so clients know the SSE upgrade never happens for bad input.
      const res = await app.request('/api/workflows/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ flow: { type: 'action' } }),
      })

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe('COMPILE_ERROR')
    })

    it('passes the configured compile.toolResolver through to createFlowCompiler', async () => {
      mockCompile.mockResolvedValueOnce(
        successCompile([{ skillName: 'summarize' }]),
      )

      const customResolver = {
        resolve: () => null,
        listAvailable: () => [],
      }

      const appWithCompile = createForgeApp({
        ...createTestConfig(),
        compile: { toolResolver: customResolver },
      })

      const res = await appWithCompile.request('/api/workflows/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow: { type: 'action', tool: 'summarize' } }),
      })
      expect(res.status).toBe(200)

      // Last constructor call receives our custom resolver.
      const lastCall = mockCreateFlowCompiler.mock.calls.at(-1)
      expect(lastCall).toBeDefined()
      const constructorArg = (lastCall as unknown[])[0] as { toolResolver: unknown }
      expect(constructorArg.toolResolver).toBe(customResolver)
    })

    it('derives compile.personaResolver from personaStore when no explicit resolver is provided', async () => {
      mockCompile.mockResolvedValueOnce(
        successCompile([{ skillName: 'summarize' }]),
      )

      const personaStore = new InMemoryPersonaStore()
      await personaStore.save({
        id: 'planner',
        name: 'Planner',
        instructions: 'Plan the work',
      })

      const appWithPersonas = createForgeApp({
        ...createTestConfig(),
        personaStore,
      })

      const res = await appWithPersonas.request('/api/workflows/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow: { type: 'action', tool: 'summarize' } }),
      })
      expect(res.status).toBe(200)

      const lastCall = mockCreateFlowCompiler.mock.calls.at(-1)
      expect(lastCall).toBeDefined()
      const constructorArg = (lastCall as unknown[])[0] as {
        personaResolver?: { resolve: (ref: string) => unknown }
      }
      expect(constructorArg.personaResolver).toBeDefined()
      expect(typeof constructorArg.personaResolver?.resolve).toBe('function')
    })

    it('prefers compile.personaResolver over personaStore-derived resolver', async () => {
      mockCompile.mockResolvedValueOnce(
        successCompile([{ skillName: 'summarize' }]),
      )

      const personaStore = new InMemoryPersonaStore()
      await personaStore.save({
        id: 'planner',
        name: 'Planner',
        instructions: 'Plan the work',
      })
      const personaResolver = { resolve: vi.fn().mockReturnValue(true) }

      const appWithCompile = createForgeApp({
        ...createTestConfig(),
        personaStore,
        compile: { personaResolver },
      })

      const res = await appWithCompile.request('/api/workflows/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow: { type: 'action', tool: 'summarize' } }),
      })
      expect(res.status).toBe(200)

      const lastCall = mockCreateFlowCompiler.mock.calls.at(-1)
      expect(lastCall).toBeDefined()
      const constructorArg = (lastCall as unknown[])[0] as { personaResolver?: unknown }
      expect(constructorArg.personaResolver).toBe(personaResolver)
    })
  })
})
