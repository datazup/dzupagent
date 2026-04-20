/**
 * Tests for Wave 11 AsyncToolResolver support in Stage 3.
 *
 * Covers:
 *   - Duck-typed dispatch (sync vs async `resolve()` return type)
 *   - Rejection → `RESOLVER_INFRA_ERROR`
 *   - Mixed sync tool + sync persona resolvers still work
 *   - Async persona resolver returning `false` → UNRESOLVED_PERSONA_REF
 *   - Unknown ref from async resolver → UNRESOLVED_TOOL_REF with suggestions
 */

import type {
  ActionNode,
  AsyncToolResolver,
  FlowNode,
  ResolvedTool,
  SequenceNode,
  ToolResolver,
} from '@dzupagent/flow-ast'
import { describe, expect, it } from 'vitest'

import { semanticResolve } from '../src/stages/semantic.js'
import type { AsyncPersonaResolver, PersonaResolver } from '../src/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const action = (toolRef: string, personaRef?: string): ActionNode => ({
  type: 'action',
  toolRef,
  input: {},
  ...(personaRef !== undefined ? { personaRef } : {}),
})

const sequence = (...nodes: FlowNode[]): SequenceNode => ({ type: 'sequence', nodes })

function makeAsyncResolver(map: Record<string, ResolvedTool>): AsyncToolResolver {
  return {
    async resolve(ref) {
      return map[ref] ?? null
    },
    listAvailable: () => Object.keys(map),
  }
}

function resolvedTool(ref: string): ResolvedTool {
  return { ref, kind: 'skill', inputSchema: {}, handle: { ref } }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('semanticResolve — async resolver path', () => {
  it('awaits a Promise-returning resolve() and populates the side-table', async () => {
    const resolver = makeAsyncResolver({
      'pm.create_task': resolvedTool('pm.create_task'),
    })
    const ast = sequence(action('pm.create_task'))

    const result = await semanticResolve(ast, { toolResolver: resolver })

    expect(result.errors).toEqual([])
    expect(result.resolved.size).toBe(1)
    expect(result.resolved.get('root.nodes[0]')?.ref).toBe('pm.create_task')
  })

  it('works when resolve() returns Promise.resolve(null) — unresolved ref', async () => {
    const resolver: AsyncToolResolver = {
      resolve: async () => null,
      listAvailable: () => ['pm.known'],
    }
    const ast = sequence(action('pm.unknown'))

    const result = await semanticResolve(ast, { toolResolver: resolver })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('UNRESOLVED_TOOL_REF')
    expect(result.errors[0]?.nodePath).toBe('root.nodes[0]')
  })

  it('unknown async ref still sees "Did you mean" suggestions from listAvailable', async () => {
    const resolver: AsyncToolResolver = {
      resolve: async () => null,
      listAvailable: () => ['pm.create_task', 'pm.update_task'],
    }
    const ast = sequence(action('pm.creat_task'))

    const result = await semanticResolve(ast, { toolResolver: resolver })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.message).toContain('Did you mean: "pm.create_task"')
  })

  it('rejection surfaces as RESOLVER_INFRA_ERROR with original message', async () => {
    const resolver: AsyncToolResolver = {
      resolve: async () => {
        throw new Error('database connection refused')
      },
      listAvailable: () => [],
    }
    const ast = sequence(action('pm.whatever'))

    const result = await semanticResolve(ast, { toolResolver: resolver })

    expect(result.errors).toHaveLength(1)
    const [err] = result.errors
    expect(err?.code).toBe('RESOLVER_INFRA_ERROR')
    expect(err?.nodePath).toBe('root.nodes[0]')
    expect(err?.message).toBe('database connection refused')
  })

  it('rejection does not also emit UNRESOLVED_TOOL_REF on the same node', async () => {
    const resolver: AsyncToolResolver = {
      resolve: async () => {
        throw new Error('boom')
      },
      listAvailable: () => [],
    }
    const ast = sequence(action('pm.x'))

    const result = await semanticResolve(ast, { toolResolver: resolver })

    // Exactly one error — infra failure supersedes the unresolved-ref message.
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('RESOLVER_INFRA_ERROR')
  })

  it('non-Error rejection stringifies the thrown value', async () => {
    const resolver: AsyncToolResolver = {
      resolve: async () => {
        throw 'raw-string-cause'
      },
      listAvailable: () => [],
    }
    const ast = sequence(action('pm.x'))

    const result = await semanticResolve(ast, { toolResolver: resolver })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.message).toBe('raw-string-cause')
  })

  it('mixed resolvers: async tool resolver + sync persona resolver', async () => {
    const tool = makeAsyncResolver({
      'pm.run': resolvedTool('pm.run'),
    })
    const personaResolver: PersonaResolver = {
      resolve: (ref) => ref === 'pm.lead',
    }
    const ast = sequence(action('pm.run', 'pm.lead'))

    const result = await semanticResolve(ast, {
      toolResolver: tool,
      personaResolver,
    })

    expect(result.errors).toEqual([])
    expect(result.resolved.size).toBe(1)
    expect(result.resolvedPersonas.get('root.nodes[0]')).toBe('pm.lead')
  })

  it('async persona resolver returning false produces UNRESOLVED_PERSONA_REF', async () => {
    const tool = makeAsyncResolver({ 'pm.run': resolvedTool('pm.run') })
    const personaResolver: AsyncPersonaResolver = {
      resolve: async () => false,
    }
    const ast = sequence(action('pm.run', 'ghost'))

    const result = await semanticResolve(ast, {
      toolResolver: tool,
      personaResolver,
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('UNRESOLVED_PERSONA_REF')
    expect(result.errors[0]?.nodePath).toBe('root.nodes[0]')
  })

  it('async persona resolver rejection produces RESOLVER_INFRA_ERROR', async () => {
    const tool = makeAsyncResolver({ 'pm.run': resolvedTool('pm.run') })
    const personaResolver: AsyncPersonaResolver = {
      resolve: async () => {
        throw new Error('persona-store down')
      },
    }
    const ast = sequence(action('pm.run', 'pm.lead'))

    const result = await semanticResolve(ast, {
      toolResolver: tool,
      personaResolver,
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('RESOLVER_INFRA_ERROR')
    expect(result.errors[0]?.message).toBe('persona-store down')
  })

  it('sync resolver keeps working under the new async signature', async () => {
    // Regression coverage — confirm the sync path still functions identically.
    const resolver: ToolResolver = {
      resolve: (ref) => (ref === 'pm.run' ? resolvedTool('pm.run') : null),
      listAvailable: () => ['pm.run'],
    }
    const ast = sequence(action('pm.run'))

    const result = await semanticResolve(ast, { toolResolver: resolver })

    expect(result.errors).toEqual([])
    expect(result.resolved.size).toBe(1)
  })

  it('multiple async refs resolve in document order', async () => {
    const resolver = makeAsyncResolver({
      'a.one': resolvedTool('a.one'),
      'b.two': resolvedTool('b.two'),
      'c.three': resolvedTool('c.three'),
    })
    const ast = sequence(action('a.one'), action('b.two'), action('c.three'))

    const result = await semanticResolve(ast, { toolResolver: resolver })

    expect(result.errors).toEqual([])
    expect(result.resolved.size).toBe(3)
    expect(Array.from(result.resolved.keys())).toEqual([
      'root.nodes[0]',
      'root.nodes[1]',
      'root.nodes[2]',
    ])
  })
})
