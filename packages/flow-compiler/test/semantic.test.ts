import type {
  ActionNode,
  FlowNode,
  PersonaNode,
  ResolvedTool,
  SequenceNode,
  ToolResolver,
} from '@dzupagent/flow-ast'
import { InMemoryDomainToolRegistry } from '@dzupagent/app-tools'
import { describe, expect, it } from 'vitest'

import { semanticResolve } from '../src/stages/semantic.js'
import type { PersonaResolver } from '../src/types.js'

// ---------------------------------------------------------------------------
// Fixture helpers — wrap the canonical InMemoryDomainToolRegistry from
// @dzupagent/app-tools in a thin synchronous ToolResolver adapter (no new
// mock invented; per session spec).
// ---------------------------------------------------------------------------

function makeResolver(toolNames: string[]): ToolResolver {
  const registry = new InMemoryDomainToolRegistry()
  for (const name of toolNames) {
    const namespace = name.split('.')[0] ?? name
    registry.register({
      name,
      description: `test ${name}`,
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

const action = (toolRef: string, personaRef?: string): ActionNode => ({
  type: 'action',
  toolRef,
  input: {},
  ...(personaRef !== undefined ? { personaRef } : {}),
})

const sequence = (...nodes: FlowNode[]): SequenceNode => ({ type: 'sequence', nodes })

const persona = (personaId: string, ...body: FlowNode[]): PersonaNode => ({
  type: 'persona',
  personaId,
  body,
})

// ---------------------------------------------------------------------------
// Tool resolution
// ---------------------------------------------------------------------------

describe('semanticResolve — tool resolution', () => {
  it('happy path: every toolRef resolves, no errors, side-table populated', async () => {
    const resolver = makeResolver(['pm.create_task', 'pm.update_task', 'docs.search'])
    const ast = sequence(
      action('pm.create_task'),
      action('pm.update_task'),
      action('docs.search'),
    )

    const result = await semanticResolve(ast, { toolResolver: resolver })

    expect(result.errors).toEqual([])
    expect(result.resolved.size).toBe(3)
    expect(result.resolved.get('root.nodes[0]')?.ref).toBe('pm.create_task')
    expect(result.resolved.get('root.nodes[1]')?.ref).toBe('pm.update_task')
    expect(result.resolved.get('root.nodes[2]')?.ref).toBe('docs.search')
    // AST identity preserved.
    expect(result.ast).toBe(ast)
  })

  it('side-table integrity: stored ResolvedTool is the resolver-returned instance', async () => {
    let captured: ResolvedTool | null = null
    const resolver: ToolResolver = {
      resolve(ref) {
        captured = { ref, kind: 'skill', inputSchema: {}, handle: { marker: 'unique' } }
        return captured
      },
      listAvailable: () => [],
    }
    const ast = sequence(action('any.tool'))

    const result = await semanticResolve(ast, { toolResolver: resolver })

    expect(result.resolved.get('root.nodes[0]')).toBe(captured)
  })

  it('unresolved ref far from any registered tool: error has no "Did you mean"', async () => {
    const resolver = makeResolver(['pm.create_task'])
    const ast = sequence(action('xx.yyy.zzz'))

    const result = await semanticResolve(ast, { toolResolver: resolver })

    expect(result.errors).toHaveLength(1)
    const [err] = result.errors
    expect(err?.code).toBe('UNRESOLVED_TOOL_REF')
    expect(err?.nodePath).toBe('root.nodes[0]')
    expect(err?.message).toBe('Unresolved tool reference: "xx.yyy.zzz".')
    expect(err?.message).not.toContain('Did you mean')
  })

  it('close miss: error message includes top "Did you mean" suggestion', async () => {
    const resolver = makeResolver(['pm.create_task', 'pm.create_topic', 'pm.delete_task'])
    const ast = sequence(action('pm.creat_task'))

    const result = await semanticResolve(ast, { toolResolver: resolver })

    expect(result.errors).toHaveLength(1)
    const message = result.errors[0]?.message ?? ''
    expect(message).toContain('Unresolved tool reference: "pm.creat_task".')
    expect(message).toContain('Did you mean: "pm.create_task"')
  })

  it('multiple unresolved refs: errors emitted in document order', async () => {
    const resolver = makeResolver(['pm.create_task'])
    const ast = sequence(
      action('alpha.one'),
      action('beta.two'),
      action('gamma.three'),
    )

    const result = await semanticResolve(ast, { toolResolver: resolver })

    expect(result.errors).toHaveLength(3)
    expect(result.errors.map((e) => e.nodePath)).toEqual([
      'root.nodes[0]',
      'root.nodes[1]',
      'root.nodes[2]',
    ])
    expect(result.errors.every((e) => e.code === 'UNRESOLVED_TOOL_REF')).toBe(true)
  })

  it('suggestionDistance: 0 disables "Did you mean" even on close misses', async () => {
    const resolver = makeResolver(['pm.create_task'])
    const ast = sequence(action('pm.creat_task'))

    const result = await semanticResolve(ast, {
      toolResolver: resolver,
      suggestionDistance: 0,
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.message).toBe('Unresolved tool reference: "pm.creat_task".')
  })

  it('listAvailable is called at most once per semanticResolve invocation', async () => {
    const registry = makeResolver(['pm.create_task'])
    let calls = 0
    const wrapped: ToolResolver = {
      resolve: (ref) => registry.resolve(ref),
      listAvailable: () => {
        calls += 1
        return registry.listAvailable()
      },
    }
    const ast = sequence(action('pm.x'), action('pm.y'), action('pm.z'))

    await semanticResolve(ast, { toolResolver: wrapped })

    expect(calls).toBeLessThanOrEqual(1)
  })

  it('sync fast-path: resolver returns a bare ResolvedTool, not a Promise', async () => {
    // Wave 11 duck-typed dispatch: when resolver.resolve() returns a bare
    // ResolvedTool (not a Promise), the compiler must not wrap it and must
    // not call .then on the return value. This test asserts that the
    // resolver's return value itself is non-Promise, which is the only
    // observable guarantee available now that the stage is unconditionally
    // async.
    const resolver = makeResolver(['pm.a'])
    let returnedValue: unknown = undefined
    const spied: ToolResolver = {
      resolve(ref) {
        returnedValue = resolver.resolve(ref)
        return returnedValue as ResolvedTool | null
      },
      listAvailable: () => resolver.listAvailable(),
    }

    const ast = sequence(action('pm.a'))
    const result = await semanticResolve(ast, { toolResolver: spied })

    expect(result.errors).toEqual([])
    expect(result.resolved.size).toBe(1)
    expect(returnedValue instanceof Promise).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Persona resolution
// ---------------------------------------------------------------------------

describe('semanticResolve — persona resolution', () => {
  it('persona resolver returns true: side-table populated, no error', async () => {
    const resolver = makeResolver(['pm.do_thing'])
    const personaResolver: PersonaResolver = { resolve: (ref) => ref === 'pm.lead' }
    const ast = sequence(persona('pm.lead', action('pm.do_thing')))

    const result = await semanticResolve(ast, {
      toolResolver: resolver,
      personaResolver,
    })

    expect(result.errors).toEqual([])
    expect(result.resolvedPersonas.get('root.nodes[0]')).toBe('pm.lead')
  })

  it('persona resolver returns false: emits UNRESOLVED_PERSONA_REF at node path', async () => {
    const resolver = makeResolver(['pm.do_thing'])
    const personaResolver: PersonaResolver = { resolve: () => false }
    const ast = sequence(persona('ghost.persona', action('pm.do_thing')))

    const result = await semanticResolve(ast, {
      toolResolver: resolver,
      personaResolver,
    })

    expect(result.errors).toHaveLength(1)
    const [err] = result.errors
    expect(err?.code).toBe('UNRESOLVED_PERSONA_REF')
    expect(err?.nodePath).toBe('root.nodes[0]')
    expect(err?.message).toContain('ghost.persona')
  })

  it('no persona resolver provided + AST has personas: single root error', async () => {
    const resolver = makeResolver(['pm.do_thing'])
    const ast = sequence(
      persona('pm.lead', action('pm.do_thing')),
      persona('pm.designer', action('pm.do_thing')),
      action('pm.do_thing', 'pm.qa'),
    )

    const result = await semanticResolve(ast, { toolResolver: resolver })

    expect(result.errors).toHaveLength(1)
    const [err] = result.errors
    expect(err?.code).toBe('UNRESOLVED_PERSONA_REF')
    expect(err?.nodePath).toBe('root')
    expect(err?.message).toBe('personaResolver not provided')
  })

  it('ActionNode.personaRef resolves independently of toolRef', async () => {
    const resolver = makeResolver(['pm.do_thing'])
    const personaResolver: PersonaResolver = { resolve: (ref) => ref === 'pm.lead' }
    const ast = sequence(action('pm.do_thing', 'pm.lead'))

    const result = await semanticResolve(ast, {
      toolResolver: resolver,
      personaResolver,
    })

    expect(result.errors).toEqual([])
    expect(result.resolved.size).toBe(1)
    expect(result.resolvedPersonas.get('root.nodes[0]')).toBe('pm.lead')
  })

  it('persona resolver with optional list(): suggestion appears for close miss', async () => {
    const resolver = makeResolver(['pm.do_thing'])
    const personaResolver: PersonaResolver & { list: () => string[] } = {
      resolve: (ref) => ref === 'pm.lead',
      list: () => ['pm.lead', 'pm.designer'],
    }
    const ast = sequence(persona('pm.led', action('pm.do_thing')))

    const result = await semanticResolve(ast, {
      toolResolver: resolver,
      personaResolver,
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.message).toContain('Did you mean: "pm.lead"')
  })
})
