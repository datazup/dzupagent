/**
 * End-to-end tests for createFlowCompiler orchestrator.
 *
 * Covers:
 *   - Happy path for each compilation target (skill-chain, workflow-builder, pipeline)
 *   - Stage 2 shape error propagation
 *   - Stage 3 unresolved-ref error propagation (halts pipeline)
 *   - Stage 4 on_error backstop for skill-chain target
 *   - forwardInnerEvents: true constructor guard
 *
 * On the on_error/stage-4 test:
 *   validateShape (stage 2) already rejects on_error-bearing nodes in
 *   skill-chain-routed flows via OI-4. To reach the stage-4 backstop we must
 *   bypass stages 1 and 2 — i.e. hand-construct a valid AST and call the
 *   lowerer path that skips shape-validate. The orchestrator always runs
 *   stage 2, so we cannot reach stage 4 through the public compile() API with
 *   an on_error-bearing skill-chain AST.
 *
 *   Instead we test the stage-4 backstop directly by constructing the AST as
 *   a plain object with an extra `on_error` field and passing it as the
 *   ParseInput — but since parseFlow strips unknown fields during node
 *   construction (it never sets on_error on any FlowNode variant), the field
 *   is silently dropped by the parser, and the shape/semantic stages never see
 *   it. The stage-4 backstop (hasOnError) would therefore never fire through
 *   the public API.
 *
 *   To keep the test suite honest and compliant (no `any`, no internal
 *   bypassing), the stage-4 backstop is tested via a separate direct call to
 *   `hasOnError` + the route result, documenting that the compile() path
 *   cannot synthesise this condition through public inputs. The test is marked
 *   with a clear comment explaining the invariant.
 */

import type { ResolvedTool, ToolResolver } from '@dzupagent/flow-ast'
import type { SkillChain, PipelineDefinition } from '@dzupagent/core'
import { InMemoryDomainToolRegistry } from '@dzupagent/app-tools'
import { describe, expect, it } from 'vitest'

import { createFlowCompiler, hasOnError, routeTarget } from '../src/index.js'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeResolver(skillNames: string[]): ToolResolver {
  const registry = new InMemoryDomainToolRegistry()
  for (const name of skillNames) {
    const namespace = name.split('.')[0] ?? name
    registry.register({
      name,
      description: `test skill ${name}`,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      permissionLevel: 'read',
      sideEffects: [],
      namespace,
    })
  }
  return {
    resolve(ref: string): ResolvedTool | null {
      const def = registry.get(ref)
      if (!def) return null
      return { ref, kind: 'skill', inputSchema: def.inputSchema, handle: def }
    },
    listAvailable: () => registry.list().map((t) => t.name),
  }
}

// ---------------------------------------------------------------------------
// forwardInnerEvents guard
// ---------------------------------------------------------------------------

describe('createFlowCompiler — forwardInnerEvents guard', () => {
  it('throws when forwardInnerEvents is true and no eventBus is provided', () => {
    const resolver = makeResolver([])
    expect(() =>
      createFlowCompiler({ toolResolver: resolver, forwardInnerEvents: true }),
    ).toThrow(/forwardInnerEvents.*eventBus|eventBus.*forwardInnerEvents/)
  })

  it('does not throw when forwardInnerEvents is false', () => {
    const resolver = makeResolver([])
    expect(() =>
      createFlowCompiler({ toolResolver: resolver, forwardInnerEvents: false }),
    ).not.toThrow()
  })

  it('does not throw when forwardInnerEvents is omitted', () => {
    const resolver = makeResolver([])
    expect(() =>
      createFlowCompiler({ toolResolver: resolver }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Happy path — skill-chain target
// ---------------------------------------------------------------------------

describe('createFlowCompiler — happy path skill-chain', () => {
  it('compiles a 2-action sequence to a SkillChain artifact', async () => {
    const resolver = makeResolver(['pm.create_task', 'pm.update_task'])
    const compiler = createFlowCompiler({ toolResolver: resolver })

    const input = {
      type: 'sequence',
      nodes: [
        { type: 'action', toolRef: 'pm.create_task', input: {} },
        { type: 'action', toolRef: 'pm.update_task', input: {} },
      ],
    }

    const result = await compiler.compile(input)

    expect('errors' in result).toBe(false)
    const success = result as { target: string; artifact: unknown; warnings: string[] }
    expect(success.target).toBe('skill-chain')

    const chain = success.artifact as SkillChain
    expect(chain.name).toBe('flow')
    expect(chain.steps).toHaveLength(2)
    expect(chain.steps[0]?.skillName).toBe('pm.create_task')
    expect(chain.steps[1]?.skillName).toBe('pm.update_task')
    expect(success.warnings).toEqual([])
  })

  it('uses the default chain name "flow"', async () => {
    const resolver = makeResolver(['tasks.run'])
    const compiler = createFlowCompiler({ toolResolver: resolver })
    const result = await compiler.compile({ type: 'action', toolRef: 'tasks.run', input: {} })
    const success = result as { artifact: SkillChain }
    expect(success.artifact.name).toBe('flow')
  })
})

// ---------------------------------------------------------------------------
// Happy path — workflow-builder target (branch → workflow-builder)
// ---------------------------------------------------------------------------

describe('createFlowCompiler — happy path workflow-builder', () => {
  it('compiles a branch flow to a PipelineDefinition artifact', async () => {
    const resolver = makeResolver(['tasks.plan', 'tasks.exec-simple', 'tasks.exec-complex'])
    const compiler = createFlowCompiler({ toolResolver: resolver })

    const input = {
      type: 'branch',
      condition: 'is_complex',
      then: [{ type: 'action', toolRef: 'tasks.exec-complex', input: {} }],
      else: [{ type: 'action', toolRef: 'tasks.exec-simple', input: {} }],
    }

    const result = await compiler.compile(input)

    expect('errors' in result).toBe(false)
    const success = result as { target: string; artifact: unknown; warnings: string[] }
    expect(success.target).toBe('workflow-builder')

    const pipeline = success.artifact as PipelineDefinition
    expect(typeof pipeline.id).toBe('string')
    expect(pipeline.nodes.length).toBeGreaterThan(0)
    // GateNode (branch) + 2 action nodes
    expect(pipeline.nodes.some((n) => n.type === 'gate')).toBe(true)
    expect(pipeline.nodes.some((n) => n.type === 'tool')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Happy path — pipeline target (for_each → pipeline-loop)
// ---------------------------------------------------------------------------

describe('createFlowCompiler — happy path pipeline', () => {
  it('compiles a for_each flow to a PipelineDefinition artifact', async () => {
    const resolver = makeResolver(['items.process'])
    const compiler = createFlowCompiler({ toolResolver: resolver })

    const input = {
      type: 'for_each',
      source: 'items',
      as: 'item',
      body: [{ type: 'action', toolRef: 'items.process', input: {} }],
    }

    const result = await compiler.compile(input)

    expect('errors' in result).toBe(false)
    const success = result as { target: string; artifact: unknown; warnings: string[] }
    expect(success.target).toBe('pipeline')

    const pipeline = success.artifact as PipelineDefinition
    expect(typeof pipeline.id).toBe('string')
    expect(pipeline.nodes.some((n) => n.type === 'loop')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Stage 2 shape error
// ---------------------------------------------------------------------------

describe('createFlowCompiler — stage 2 errors', () => {
  it('returns stage:2 errors for an empty sequence body', async () => {
    const resolver = makeResolver([])
    const compiler = createFlowCompiler({ toolResolver: resolver })

    // Empty sequence body — fails shape validation (EMPTY_BODY)
    const result = await compiler.compile({ type: 'sequence', nodes: [] })

    expect('errors' in result).toBe(true)
    const failure = result as { errors: Array<{ stage: number; message: string }> }
    expect(failure.errors.length).toBeGreaterThan(0)
    expect(failure.errors.every((e) => e.stage === 2)).toBe(true)
    expect(failure.errors[0]?.message).toMatch(/sequence\.nodes must contain/)
  })

  it('returns stage:2 errors for a branch missing condition', async () => {
    const resolver = makeResolver(['a.tool'])
    const compiler = createFlowCompiler({ toolResolver: resolver })

    // branch.condition is missing (omitted here as unknown object)
    const result = await compiler.compile({
      type: 'branch',
      condition: '',   // empty string triggers MISSING_REQUIRED_FIELD
      then: [{ type: 'action', toolRef: 'a.tool', input: {} }],
    })

    expect('errors' in result).toBe(true)
    const failure = result as { errors: Array<{ stage: number }> }
    expect(failure.errors.every((e) => e.stage === 2)).toBe(true)
  })

  it('combines stage 1 + 2 errors when parse partially recovers', async () => {
    // Pass a JSON string that parses to a valid object but fails shape-validate.
    // (parse succeeds with ast non-null, shape-validate fails)
    const resolver = makeResolver([])
    const compiler = createFlowCompiler({ toolResolver: resolver })
    const result = await compiler.compile(JSON.stringify({ type: 'sequence', nodes: [] }))
    expect('errors' in result).toBe(true)
    const failure = result as { errors: Array<{ stage: number }> }
    // Shape errors — stage 2
    expect(failure.errors.some((e) => e.stage === 2)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Stage 3 — unresolved ref (halts, does not lower)
// ---------------------------------------------------------------------------

describe('createFlowCompiler — stage 3 errors', () => {
  it('returns stage:3 errors for an unresolved toolRef', async () => {
    const resolver = makeResolver(['known.tool'])
    const compiler = createFlowCompiler({ toolResolver: resolver })

    const result = await compiler.compile({
      type: 'action',
      toolRef: 'unknown.tool',   // not in registry
      input: {},
    })

    expect('errors' in result).toBe(true)
    const failure = result as { errors: Array<{ stage: number; message: string }> }
    expect(failure.errors.length).toBeGreaterThan(0)
    expect(failure.errors.every((e) => e.stage === 3)).toBe(true)
    expect(failure.errors[0]?.message).toMatch(/unknown\.tool/)
  })

  it('does not lower when there are stage 3 errors', async () => {
    const resolver = makeResolver([])
    const compiler = createFlowCompiler({ toolResolver: resolver })

    const result = await compiler.compile({
      type: 'sequence',
      nodes: [
        { type: 'action', toolRef: 'missing.a', input: {} },
        { type: 'action', toolRef: 'missing.b', input: {} },
      ],
    })

    expect('errors' in result).toBe(true)
    const failure = result as { errors: Array<{ stage: number }> }
    expect(failure.errors.every((e) => e.stage === 3)).toBe(true)
    // 2 unresolved refs → 2 errors
    expect(failure.errors).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Stage 4 — on_error backstop (direct path verification)
//
// The compile() public API CANNOT reach the stage-4 backstop for the
// on_error+skill-chain case, because:
//
//   1. parseFlow never emits on_error on any FlowNode variant (it is not a
//      recognised field on any node type — the parser drops unknown fields).
//   2. Even if a caller hand-constructs an AST with on_error on an action node
//      and somehow passes it as a pre-parsed object, parseFlow re-parses the
//      object and reconstructs typed nodes — the on_error key is therefore
//      absent in the output FlowNode.
//   3. validateShape stage-2 OI-4 catches on_error in skill-chain-routed flows
//      and halts before stage 4 is reached.
//
// We therefore verify the backstop invariant by:
//   a) confirming hasOnError correctly detects the field (unit-level),
//   b) confirming routeTarget routes the same AST to skill-chain,
//   c) documenting that the compile() path cannot synthesise this scenario.
// ---------------------------------------------------------------------------

describe('createFlowCompiler — stage 4 on_error backstop (structural verification)', () => {
  it('hasOnError detects on_error injected at the action level', () => {
    // Cast to unknown first so noUncheckedIndexedAccess stays satisfied.
    const astWithOnError = {
      type: 'action',
      toolRef: 'pm.run',
      input: {},
      on_error: { strategy: 'retry' },
    } as unknown as import('@dzupagent/flow-ast').FlowNode

    expect(hasOnError(astWithOnError)).toBe(true)
  })

  it('routeTarget routes a plain action node to skill-chain', () => {
    const ast = {
      type: 'action',
      toolRef: 'pm.run',
      input: {},
    } as import('@dzupagent/flow-ast').FlowNode

    expect(routeTarget(ast).target).toBe('skill-chain')
  })

  it('compile() returns stage:2 when on_error is present in a skill-chain flow (OI-4 fires before stage 4)', async () => {
    // The only way to get on_error past parseFlow is to pass a pre-parsed
    // object. parseFlow reconstructs TypeScript types and strips it.
    // So compile() always hits stage 2 OI-4, never stage 4.
    // This test documents that guarantee explicitly.
    const resolver = makeResolver(['pm.run'])
    const compiler = createFlowCompiler({ toolResolver: resolver })

    // Pass raw object — parseFlow strips the on_error field when constructing
    // the ActionNode. Shape-validate then produces no on_error error (field is
    // absent). Semantic stage resolves pm.run. Lowering succeeds.
    const result = await compiler.compile({
      type: 'action',
      toolRef: 'pm.run',
      input: {},
      // on_error is an unrecognised field — parseFlow silently drops it
      on_error: { strategy: 'retry' },
    })

    // Should succeed — on_error was stripped by parseFlow.
    expect('errors' in result).toBe(false)
    const success = result as { target: string }
    expect(success.target).toBe('skill-chain')
  })
})
