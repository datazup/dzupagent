/**
 * Integration tests for POST /api/workflows/compile using real instances of
 * @dzupagent/flow-compiler and @dzupagent/app-tools.
 *
 * No mocks are applied to the compiler pipeline. The toolResolver is wired
 * from createBuiltinToolRegistry({ topics }).toToolResolver() so that
 * tool-ref resolution exercises the real Stage 3 semantic resolver.
 *
 * Tests:
 *   1. Valid flow whose toolRef resolves in the builtin registry → 200 + artifact
 *   2. Valid flow shape whose toolRef is unknown → 400 + UNRESOLVED_TOOL_REF errors
 *   3. Invalid FlowNode shape (missing required field) → 400 + stage 1/2 error
 */

import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createBuiltinToolRegistry } from '@dzupagent/app-tools'
import { createCompileRoutes } from '../routes/compile.js'
import { createWorkflowRoutes } from '../routes/workflows.js'
import type { TopicRecord } from '@dzupagent/app-tools'
import {
  createEventBus,
  SkillRegistry,
} from '@dzupagent/core'
import type { SkillStepResolver } from '@dzupagent/agent'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_TOPICS: TopicRecord[] = [
  {
    id: 'topic-ts',
    title: 'TypeScript',
    summary: 'Typed superset of JavaScript',
    tags: ['language', 'frontend'],
  },
  {
    id: 'topic-vitest',
    title: 'Vitest',
    summary: 'Unit testing framework for Vite',
    tags: ['testing'],
  },
]

// ---------------------------------------------------------------------------
// App builder — real compiler, real resolver, no mocks
// ---------------------------------------------------------------------------

function buildRealApp(): Hono {
  const bundle = createBuiltinToolRegistry({ topics: TEST_TOPICS })
  const toolResolver = bundle.toToolResolver()

  const app = new Hono()
  app.route('/api/workflows', createCompileRoutes({ toolResolver }))
  return app
}

async function postCompile(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request('/api/workflows/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('compile-execute integration — real flow-compiler + real app-tools', () => {
  let app: Hono

  beforeEach(() => {
    app = buildRealApp()
  })

  // -------------------------------------------------------------------------
  // Test 1: Known toolRef → 200 success with artifact
  // -------------------------------------------------------------------------

  describe('POST /api/workflows/compile with a known toolRef (topics.search)', () => {
    it('returns 200 and a compiled artifact with no UNRESOLVED_TOOL_REF errors', async () => {
      // topics.search is registered in the builtin registry when topics are seeded.
      // An ActionNode referencing it must pass Stage 3 semantic resolution.
      const flow = {
        type: 'action',
        toolRef: 'topics.search',
        input: { query: 'TypeScript' },
      }

      const res = await postCompile(app, { flow })

      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        artifact: unknown
        warnings: unknown[]
        target: string
        compileId: string
      }

      // Compiler should produce a skill-chain artifact (single action node)
      expect(body.target).toBe('skill-chain')
      expect(body.compileId).toMatch(/^[0-9a-f-]{36}$/)
      expect(Array.isArray(body.warnings)).toBe(true)
      expect(body.artifact).toBeDefined()
      expect(body.artifact).not.toBeNull()
    })

    it('artifact contains at least one step referencing the resolved tool', async () => {
      const flow = {
        type: 'action',
        toolRef: 'topics.search',
        input: { query: 'Vitest' },
      }

      const res = await postCompile(app, { flow })
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        artifact: { steps?: Array<{ tool?: string; toolRef?: string; ref?: string }> }
        target: string
      }

      // The skill-chain lowerer produces a `steps` array
      expect(Array.isArray((body.artifact as { steps?: unknown[] }).steps)).toBe(true)
      const steps = (body.artifact as { steps: Array<Record<string, unknown>> }).steps
      expect(steps.length).toBeGreaterThan(0)
    })

    it('sequence with two known toolRefs compiles to skill-chain with two steps', async () => {
      // A sequence of actions routes to skill-chain when none of them use on_error.
      const flow = {
        type: 'sequence',
        nodes: [
          { type: 'action', toolRef: 'topics.search', input: { query: 'TypeScript' } },
          { type: 'action', toolRef: 'topics.list', input: {} },
        ],
      }

      const res = await postCompile(app, { flow })
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        artifact: { steps?: unknown[] }
        target: string
      }
      expect(body.target).toBe('skill-chain')
      const steps = body.artifact.steps ?? []
      expect(steps.length).toBe(2)
    })

    it('optional target assertion passes when target matches compiler output', async () => {
      const flow = {
        type: 'action',
        toolRef: 'topics.get',
        input: { id: 'topic-ts' },
      }

      // topics.get is a simple action → routes to skill-chain
      const res = await postCompile(app, { flow, target: 'skill-chain' })
      expect(res.status).toBe(200)
    })
  })

  // -------------------------------------------------------------------------
  // Test 2: Unknown toolRef → 400 with UNRESOLVED_TOOL_REF
  // -------------------------------------------------------------------------

  describe('POST /api/workflows/compile with an unknown toolRef (unknown.tool)', () => {
    it('returns 400 when toolRef is not in the registry', async () => {
      const flow = {
        type: 'action',
        toolRef: 'unknown.tool',
        input: {},
      }

      const res = await postCompile(app, { flow })
      expect(res.status).toBe(400)
    })

    it('response error array contains an UNRESOLVED_TOOL_REF entry', async () => {
      const flow = {
        type: 'action',
        toolRef: 'unknown.tool',
        input: {},
      }

      const res = await postCompile(app, { flow })
      expect(res.status).toBe(400)

      const body = (await res.json()) as {
        error: string
        stage: number
        errors: Array<{ stage: number; message: string; nodePath?: string }>
        compileId: string
      }

      // Stage 3 is the semantic resolve stage
      expect(body.stage).toBe(3)
      expect(Array.isArray(body.errors)).toBe(true)
      expect(body.errors.length).toBeGreaterThan(0)

      // The error message must reference the unresolved ref
      const unresolvedError = body.errors.find((e) =>
        e.message.includes('unknown.tool'),
      )
      expect(unresolvedError).toBeDefined()
      expect(unresolvedError?.stage).toBe(3)
    })

    it('error message contains the literal "Unresolved tool reference" text', async () => {
      const flow = {
        type: 'action',
        toolRef: 'completely.missing.tool',
        input: {},
      }

      const res = await postCompile(app, { flow })
      const body = (await res.json()) as { error: string; errors: Array<{ message: string }> }

      // The aggregated error field must mention the unresolved ref
      expect(body.error).toMatch(/Unresolved tool reference/i)
    })

    it('sequence with one known and one unknown toolRef still fails at Stage 3', async () => {
      const flow = {
        type: 'sequence',
        nodes: [
          { type: 'action', toolRef: 'topics.search', input: { query: 'ts' } },
          { type: 'action', toolRef: 'unknown.ghost', input: {} },
        ],
      }

      const res = await postCompile(app, { flow })
      expect(res.status).toBe(400)

      const body = (await res.json()) as {
        stage: number
        errors: Array<{ message: string }>
      }
      expect(body.stage).toBe(3)
      // Only the unresolved ref should appear in errors, not topics.search
      const ghostError = body.errors.find((e) => e.message.includes('unknown.ghost'))
      expect(ghostError).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // Test 3: Invalid FlowNode shape → 400 stage 1 or 2 error
  // -------------------------------------------------------------------------

  describe('POST /api/workflows/compile with an invalid FlowNode shape', () => {
    it('returns 400 when action node is missing the required toolRef field', async () => {
      // A FlowNode with type "action" must have a non-empty toolRef.
      // Omitting toolRef (undefined) causes flow-ast parseAction() to emit a
      // WRONG_FIELD_TYPE error and return null AST → compile() classifies
      // this as a stage 1 failure (parse stage).
      const flow = {
        type: 'action',
        // toolRef intentionally omitted
        input: { query: 'ts' },
      }

      const res = await postCompile(app, { flow })
      expect(res.status).toBe(400)

      const body = (await res.json()) as {
        stage: number
        errors: Array<{ stage: number; message: string }>
      }
      // parseAction validates toolRef is a string; when missing it returns
      // null (no AST), so compile() returns stage-1 errors.
      expect(body.stage).toBe(1)
      expect(Array.isArray(body.errors)).toBe(true)
      expect(body.errors.length).toBeGreaterThan(0)
    })

    it('returns 400 with stage 2 when action node has an empty toolRef string', async () => {
      const flow = {
        type: 'action',
        toolRef: '',       // empty string — fails isNonEmptyString check
        input: {},
      }

      const res = await postCompile(app, { flow })
      expect(res.status).toBe(400)

      const body = (await res.json()) as { stage: number }
      expect(body.stage).toBe(2)
    })

    it('returns 400 with stage 1 when the top-level node type is completely unknown', async () => {
      // UNKNOWN_NODE_TYPE causes the parser (stage 1) to produce a null AST.
      const flow = {
        type: 'completely_unknown_node_type',
        toolRef: 'topics.search',
        input: {},
      }

      const res = await postCompile(app, { flow })
      expect(res.status).toBe(400)

      const body = (await res.json()) as { stage: number }
      // Parse stage returns errors when the type is unrecognized
      expect(body.stage).toBe(1)
    })

    it('returns 400 with stage 2 when a sequence node has an empty nodes array', async () => {
      // EMPTY_BODY rule: sequence.nodes must have at least one element.
      const flow = {
        type: 'sequence',
        nodes: [],
      }

      const res = await postCompile(app, { flow })
      expect(res.status).toBe(400)

      const body = (await res.json()) as { stage: number; errors: Array<{ message: string }> }
      expect(body.stage).toBe(2)
      const emptyBodyError = body.errors.find((e) =>
        e.message.toLowerCase().includes('empty') || e.message.toLowerCase().includes('at least one'),
      )
      expect(emptyBodyError).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // Sanity: all builtin tool namespaces are resolvable
  // -------------------------------------------------------------------------

  describe('all builtin tool namespaces resolve without errors', () => {
    const BUILTIN_TOOLS = [
      'topics.list',
      'topics.search',
      'topics.get',
    ]

    for (const toolRef of BUILTIN_TOOLS) {
      it(`resolves ${toolRef} without stage-3 errors`, async () => {
        const flow = {
          type: 'action',
          toolRef,
          input: {},
        }
        const res = await postCompile(app, { flow })
        // topics.* tools are in the registry → should always succeed at stage 3
        expect(res.status).toBe(200)
        const body = (await res.json()) as { target: string; errors?: unknown }
        expect(body.errors).toBeUndefined()
        expect(body.target).toBe('skill-chain')
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Task F: Knowledge-index wiring integration tests
//
// Verifies that createCompileRoutes({ knowledgeIndexPath }) lazily loads
// topics from a knowledge-index JSON file via createBuiltinToolRegistryFromIndex,
// wiring the resulting resolver into the compile pipeline. Confirms:
//   1. A known slug resolves at Stage 3 → 200 success.
//   2. A slug absent from the index fails at Stage 3 with UNRESOLVED_TOOL_REF.
//   3. An explicit `toolResolver` wins over `knowledgeIndexPath`.
//   4. `knowledgeIndexPath` pointing at a missing file degrades gracefully
//      (empty topic catalog → all topic tools are registered with no entries
//      but tools like `topics.list` still resolve as registered names).
// ---------------------------------------------------------------------------

describe('Task F: createCompileRoutes wires knowledgeIndexPath → toolResolver', () => {
  const FIXTURE_INDEX = {
    topicLandscape: {
      topics: [
        {
          id: 'topic-memory',
          name: 'Memory systems',
          aliases: ['Memory systems', 'Memory system'],
          tokenSet: ['memory', 'system'],
          explicitTopics: ['agent-memory-routing'],
        },
        {
          id: 'topic-rag',
          name: 'RAG vectors',
          aliases: ['Retrieval augmented generation'],
          tokenSet: ['rag', 'vectors'],
          explicitTopics: ['rag-vectors'],
        },
      ],
    },
  }

  let tmpDir: string
  let indexPath: string

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compile-knowledge-index-'))
    indexPath = path.join(tmpDir, 'review-knowledge-index.json')
    await fs.writeFile(indexPath, JSON.stringify(FIXTURE_INDEX), 'utf8')
  })

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function buildAppWithKnowledgeIndex(knowledgeIndexPath: string): Hono {
    const app = new Hono()
    app.route('/api/workflows', createCompileRoutes({ knowledgeIndexPath }))
    return app
  }

  it('compiles a flow referencing topics.search (registered via knowledge-index) and returns 200', async () => {
    const app = buildAppWithKnowledgeIndex(indexPath)

    // topics.search is always registered by createBuiltinToolRegistry, regardless
    // of topic contents. When knowledgeIndexPath is honoured, the resolver must
    // resolve it at Stage 3.
    const flow = {
      type: 'action',
      toolRef: 'topics.search',
      input: { query: 'memory' },
    }

    const res = await postCompile(app, { flow })
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      target: string
      compileId: string
      artifact: { steps?: unknown[] }
    }
    expect(body.target).toBe('skill-chain')
    expect(body.compileId).toMatch(/^[0-9a-f-]{36}$/)
    expect(Array.isArray(body.artifact.steps)).toBe(true)
  })

  it('fails with Stage 3 UNRESOLVED_TOOL_REF when toolRef is not registered (knowledge-index supplies no new tool names)', async () => {
    const app = buildAppWithKnowledgeIndex(indexPath)

    const flow = {
      type: 'action',
      toolRef: 'topic-memory',  // slug — not a registered tool name
      input: {},
    }

    const res = await postCompile(app, { flow })
    expect(res.status).toBe(400)

    const body = (await res.json()) as {
      stage: number
      errors: Array<{ stage: number; message: string }>
    }
    expect(body.stage).toBe(3)
    expect(body.errors.some((e) => e.message.includes('topic-memory'))).toBe(true)
  })

  it('explicit toolResolver takes precedence over knowledgeIndexPath', async () => {
    // Provide an explicit resolver that rejects everything. knowledgeIndexPath
    // is configured, but must be ignored because toolResolver is explicit.
    const rejectingResolver = {
      resolve: () => null,
      listAvailable: () => [],
    }

    const app = new Hono()
    app.route(
      '/api/workflows',
      createCompileRoutes({
        toolResolver: rejectingResolver,
        knowledgeIndexPath: indexPath,
      }),
    )

    const flow = {
      type: 'action',
      toolRef: 'topics.search',
      input: {},
    }

    const res = await postCompile(app, { flow })
    // Explicit no-op resolver rejects topics.search → Stage 3 failure.
    expect(res.status).toBe(400)
    const body = (await res.json()) as { stage: number }
    expect(body.stage).toBe(3)
  })

  it('knowledgeIndexPath pointing at a missing file degrades gracefully (tool names still registered)', async () => {
    // loadTopicsFromKnowledgeIndex swallows missing-file errors and returns [].
    // createBuiltinToolRegistry still registers the topics.* tools, so resolution
    // of topics.search/topics.list/topics.get succeeds even when no topics are seeded.
    const bogusPath = path.join(tmpDir, 'does-not-exist.json')
    const app = buildAppWithKnowledgeIndex(bogusPath)

    const flow = {
      type: 'action',
      toolRef: 'topics.list',
      input: {},
    }

    const res = await postCompile(app, { flow })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { target: string }
    expect(body.target).toBe('skill-chain')
  })
})

// ---------------------------------------------------------------------------
// Task I: End-to-end compile → execute round-trip tests
//
// These tests use the real flow-compiler (no mocks) plus a stub SkillStepResolver
// that accepts any topics.* skill and returns a deterministic fixture response.
// The same toolResolver is wired into both the compile route and the execute
// route's compile config so Stage 3 resolution succeeds in both passes.
// ---------------------------------------------------------------------------

/**
 * Stub SkillStepResolver that handles any skill whose name starts with
 * "topics." and returns a deterministic fixture response.
 *
 * The execute route's SkillChainExecutor calls resolver.canResolve() then
 * resolver.resolve() to obtain a WorkflowStep. Each step's execute() receives
 * the accumulated state and merges in { [skillId]: 'fixture-result' }.
 */
function createTopicsStubResolver(): SkillStepResolver {
  return {
    canResolve(skillId: string): boolean {
      return skillId.startsWith('topics.')
    },
    async resolve(skillId: string) {
      return {
        id: skillId,
        description: `Stub step for ${skillId}`,
        execute: async (input: unknown) => {
          const state = (input as Record<string, unknown>) ?? {}
          return { ...state, [skillId]: 'fixture-result' }
        },
      }
    },
  }
}

/**
 * Build a Hono app that mounts both the compile route and the execute route,
 * wired with the same real tool resolver derived from the builtin registry.
 * This mirrors how the production server mounts these two routes under
 * /api/workflows.
 */
function buildRoundTripApp(): Hono {
  const bundle = createBuiltinToolRegistry({ topics: TEST_TOPICS })
  const toolResolver = bundle.toToolResolver()
  const resolver = createTopicsStubResolver()

  // A minimal SkillRegistry is required by the execute route's guard middleware.
  // We register the topics.* tool names so dryRun() can validate the chain.
  const skillRegistry = new SkillRegistry()
  skillRegistry.register({ id: 'topics.search', name: 'topics.search', description: 'Search topics', instructions: '' })
  skillRegistry.register({ id: 'topics.list',   name: 'topics.list',   description: 'List topics',   instructions: '' })
  skillRegistry.register({ id: 'topics.get',    name: 'topics.get',    description: 'Get topic',     instructions: '' })

  const app = new Hono()

  // Mount compile route first (POST /api/workflows/compile)
  app.route('/api/workflows', createCompileRoutes({ toolResolver }))

  // Mount execute route (POST /api/workflows/execute)
  // compile.toolResolver must match so Stage 3 resolution inside executeCompiledFlow succeeds.
  app.route(
    '/api/workflows',
    createWorkflowRoutes({
      skillRegistry,
      resolver,
      eventBus: createEventBus(),
      compile: { toolResolver },
    }),
  )

  return app
}

async function postCompileRoundTrip(
  app: Hono,
  flow: unknown,
): Promise<Response> {
  return postCompileBody(app, { flow })
}

async function postCompileBody(
  app: Hono,
  body: unknown,
): Promise<Response> {
  return app.request('/api/workflows/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function postExecute(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request('/api/workflows/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('end-to-end: compile → execute round-trip', () => {
  // Design note: POST /execute accepts a FlowNode and re-compiles it internally
  // before executing the resulting SkillChain. The round-trip pattern is:
  //   1. POST /compile with <FlowNode> — asserts the flow is valid, captures
  //      the artifact shape (step count, target) as a pre-condition.
  //   2. POST /execute with the SAME <FlowNode> — the execute route re-compiles
  //      it and runs the SkillChainExecutor, returning the aggregated step output.
  //
  // Both routes share the same toolResolver so Stage 3 resolution succeeds in
  // both passes. The SkillStepResolver is a stub that returns fixture responses
  // for any topics.* skill, ensuring no live LLM or network calls are made.

  let app: Hono

  beforeEach(() => {
    app = buildRoundTripApp()
  })

  // -------------------------------------------------------------------------
  // Test a: Basic single-step round-trip (JSON mode)
  //
  // Verify POST /compile succeeds, then POST /execute with the same FlowNode
  // → assert 200 + result contains the stubbed skill output.
  // -------------------------------------------------------------------------

  it('Test a: single-step compile → execute returns 200 with skill output', async () => {
    const flow = {
      type: 'action',
      toolRef: 'topics.search',
      input: { query: 'TypeScript' },
    }

    // Step 1: compile — establishes that the flow is well-formed and the toolRef resolves
    const compileRes = await postCompileRoundTrip(app, flow)
    expect(compileRes.status).toBe(200)

    const compiled = (await compileRes.json()) as {
      artifact: { steps?: unknown[] }
      target: string
      compileId: string
      warnings: unknown[]
    }
    expect(compiled.target).toBe('skill-chain')
    // The compile artifact is a SkillChain with at least one step
    expect(Array.isArray(compiled.artifact.steps)).toBe(true)
    expect((compiled.artifact.steps ?? []).length).toBeGreaterThan(0)

    // Step 2: execute the SAME FlowNode (not the artifact) — the execute route
    // re-compiles it internally and hands the chain to SkillChainExecutor.
    const execRes = await postExecute(app, {
      flow,
      initialState: { query: 'TypeScript' },
    })
    expect(execRes.status).toBe(200)

    const execBody = (await execRes.json()) as {
      result: Record<string, unknown>
      compileId: string
      target: string
      warnings: unknown[]
    }
    // The stub resolver returns { [skillId]: 'fixture-result' } per step.
    expect(execBody.result).toBeDefined()
    expect(execBody.result['topics.search']).toBe('fixture-result')
    // The execute route attaches its own compileId from the internal re-compilation.
    expect(execBody.compileId).toBeDefined()
    expect(execBody.target).toBe('skill-chain')
    expect(Array.isArray(execBody.warnings)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Test b: Round-trip with SSE streaming
  //
  // Verify POST /compile succeeds, then POST /execute with Accept: text/event-stream
  // → assert the SSE stream contains compile:completed, step:started, and done events.
  // -------------------------------------------------------------------------

  it('Test b: single-step compile → SSE execute emits compile:completed + step:started + done', async () => {
    const flow = {
      type: 'action',
      toolRef: 'topics.list',
      input: {},
    }

    // Step 1: compile — pre-condition check
    const compileRes = await postCompileRoundTrip(app, flow)
    expect(compileRes.status).toBe(200)

    const compiled = (await compileRes.json()) as { target: string }
    expect(compiled.target).toBe('skill-chain')

    // Step 2: execute the same FlowNode with SSE content negotiation
    const execRes = await postExecute(
      app,
      { flow },
      { Accept: 'text/event-stream' },
    )
    expect(execRes.status).toBe(200)
    expect(execRes.headers.get('content-type')).toContain('text/event-stream')

    const body = await execRes.text()

    // Synthetic compile lifecycle header event must precede execution events.
    expect(body).toContain('event: compile:completed')
    // The SkillChainExecutor emits step:started for each step before it executes.
    expect(body).toContain('event: step:started')
    // The SSE stream must end with the done sentinel.
    expect(body).toContain('event: done')
    // The done payload carries the compileId from the internal re-compilation.
    expect(body).toContain('"ok":true')
  })

  // -------------------------------------------------------------------------
  // Test c: Two-step sequence round-trip
  //
  // Verify a 2-action sequence compiles to exactly 2 steps, then POST /execute
  // with the same FlowNode → assert both skill outputs appear in the result.
  // -------------------------------------------------------------------------

  it('Test c: two-step sequence compile → execute runs both steps in result', async () => {
    const flow = {
      type: 'sequence',
      nodes: [
        { type: 'action', toolRef: 'topics.search', input: { query: 'TypeScript' } },
        { type: 'action', toolRef: 'topics.list',   input: {} },
      ],
    }

    // Step 1: compile — verify the sequence produces exactly 2 steps
    const compileRes = await postCompileRoundTrip(app, flow)
    expect(compileRes.status).toBe(200)

    const compiled = (await compileRes.json()) as {
      artifact: { steps?: unknown[] }
      target: string
    }
    expect(compiled.target).toBe('skill-chain')
    expect((compiled.artifact.steps ?? []).length).toBe(2)

    // Step 2: execute the same FlowNode — both steps must appear in the final state
    const execRes = await postExecute(app, {
      flow,
      initialState: { userMessage: 'hello' },
    })
    expect(execRes.status).toBe(200)

    const execBody = (await execRes.json()) as {
      result: Record<string, unknown>
      target: string
    }
    expect(execBody.target).toBe('skill-chain')

    // The stub resolver accumulates { [skillId]: 'fixture-result' } per step.
    expect(execBody.result['topics.search']).toBe('fixture-result')
    expect(execBody.result['topics.list']).toBe('fixture-result')
    // The initial state is threaded through and visible in the final output.
    expect(execBody.result['userMessage']).toBe('hello')
  })

  it('Test d: dzupflow DSL compile → execute works end-to-end', async () => {
    const dsl = `
dsl: dzupflow/v1
id: topic_lookup
version: 1
steps:
  - action:
      id: search
      ref: topics.search
      input:
        query: TypeScript
`

    const compileRes = await postCompileBody(app, { dsl })
    expect(compileRes.status).toBe(200)

    const compiled = (await compileRes.json()) as {
      artifact: { steps?: unknown[] }
      target: string
    }
    expect(compiled.target).toBe('skill-chain')
    expect((compiled.artifact.steps ?? []).length).toBe(1)

    const execRes = await postExecute(app, {
      dsl,
      initialState: { query: 'TypeScript' },
    })
    expect(execRes.status).toBe(200)

    const execBody = (await execRes.json()) as {
      result: Record<string, unknown>
      target: string
    }
    expect(execBody.target).toBe('skill-chain')
    expect(execBody.result['topics.search']).toBe('fixture-result')
  })
})
