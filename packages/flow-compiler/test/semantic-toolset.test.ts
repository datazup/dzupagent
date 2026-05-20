/**
 * Stage 2 — toolset compile-time expansion.
 *
 * Covers the four documented acceptance cases:
 *   1. known toolset                 → tools[] expanded
 *   2. unknown toolset               → UNRESOLVED_TOOLSET_REF
 *   3. mixed inline + toolset        → de-duplicated union, inline first
 *   4. empty toolset                 → tools[] unchanged (or empty), no error
 *
 * Plus the negative paths the implementation must handle gracefully:
 *   • toolset declared but no resolver supplied  → MISSING_TOOLSET_RESOLVER once
 *   • resolver throws                            → TOOLSET_RESOLVER_INFRA_ERROR
 *   • resolver returns non-array / non-string    → INVALID_TOOLSET_RESOLVER_RESULT
 *   • async resolver returns a Promise           → awaited correctly
 *   • no toolset field                           → executor untouched
 */
import type {
  AgentNode,
  AsyncToolsetResolver,
  FlowNode,
  ResolvedTool,
  SequenceNode,
  ToolResolver,
  ToolsetResolver,
} from '@dzupagent/flow-ast'
import { describe, expect, it } from 'vitest'

import {
  createToolsetResolverFromCatalog,
  validateToolsetCatalog,
} from '../src/host-tool-registry.js'
import { semanticResolve } from '../src/stages/semantic.js'

const emptyToolResolver = (): ToolResolver => ({
  resolve: (ref: string): ResolvedTool | null => null,
  listAvailable: () => [],
})

const agentWith = (overrides: Partial<AgentNode>): AgentNode => ({
  type: 'agent',
  agentId: 'planner',
  instructions: 'do the work',
  output: { key: 'plan', schemaRef: 'plan.v1' },
  ...overrides,
})

const sequence = (...nodes: FlowNode[]): SequenceNode => ({ type: 'sequence', nodes })

describe('Stage 2 — toolset expansion', () => {
  it('expands a known toolset into tools[]', async () => {
    const node = agentWith({ toolset: 'planning' })
    const ast = sequence(node)
    const toolsetResolver = createToolsetResolverFromCatalog([
      { name: 'planning', tools: ['pm.create_task', 'pm.update_task'] },
    ])

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
      toolsetResolver,
    })

    expect(result.errors).toEqual([])
    expect(node.tools).toEqual(['pm.create_task', 'pm.update_task'])
    const path = 'root.nodes[0]'
    expect(result.expandedAgentTools.get(path)).toEqual([
      'pm.create_task',
      'pm.update_task',
    ])
  })

  it('emits UNRESOLVED_TOOLSET_REF for an unknown toolset name', async () => {
    const node = agentWith({ toolset: 'nope' })
    const ast = sequence(node)
    const toolsetResolver = createToolsetResolverFromCatalog([
      { name: 'planning', tools: ['pm.create_task'] },
    ])

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
      toolsetResolver,
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('UNRESOLVED_TOOLSET_REF')
    expect(result.errors[0]?.message).toContain('"nope"')
    expect(node.tools).toBeUndefined()
  })

  it('merges inline tools with toolset expansion (inline first, de-duplicated)', async () => {
    const node = agentWith({
      toolset: 'planning',
      tools: ['fs.read', 'pm.create_task'],
    })
    const ast = sequence(node)
    const toolsetResolver = createToolsetResolverFromCatalog([
      { name: 'planning', tools: ['pm.create_task', 'pm.update_task'] },
    ])

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
      toolsetResolver,
    })

    expect(result.errors).toEqual([])
    expect(node.tools).toEqual(['fs.read', 'pm.create_task', 'pm.update_task'])
  })

  it('leaves inline tools[] untouched when the toolset expands to an empty array', async () => {
    const node = agentWith({ toolset: 'empty', tools: ['fs.read'] })
    const ast = sequence(node)
    const toolsetResolver = createToolsetResolverFromCatalog([
      { name: 'empty', tools: [] },
    ])

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
      toolsetResolver,
    })

    expect(result.errors).toEqual([])
    expect(node.tools).toEqual(['fs.read'])
  })

  it('is a no-op when the node has no toolset field', async () => {
    const node = agentWith({ tools: ['fs.read'] })
    const ast = sequence(node)

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
    })

    expect(result.errors).toEqual([])
    expect(node.tools).toEqual(['fs.read'])
    expect(result.expandedAgentTools.size).toBe(0)
  })

  it('emits MISSING_TOOLSET_RESOLVER once when no resolver is supplied', async () => {
    const a = agentWith({ toolset: 'planning' })
    const b = agentWith({ agentId: 'reviewer', toolset: 'review' })
    const ast = sequence(a, b)

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
    })

    const missing = result.errors.filter((e) => e.code === 'MISSING_TOOLSET_RESOLVER')
    expect(missing).toHaveLength(1)
    expect(a.tools).toBeUndefined()
    expect(b.tools).toBeUndefined()
  })

  it('captures resolver throw as TOOLSET_RESOLVER_INFRA_ERROR', async () => {
    const node = agentWith({ toolset: 'planning' })
    const ast = sequence(node)
    const toolsetResolver: ToolsetResolver = {
      resolve: () => {
        throw new Error('catalogue offline')
      },
      listAvailable: () => [],
    }

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
      toolsetResolver,
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('TOOLSET_RESOLVER_INFRA_ERROR')
    expect(result.errors[0]?.message).toContain('catalogue offline')
  })

  it('rejects a non-string entry in the expanded list', async () => {
    const node = agentWith({ toolset: 'planning' })
    const ast = sequence(node)
    const toolsetResolver: ToolsetResolver = {
      resolve: () => ['pm.create_task', '', null as unknown as string],
      listAvailable: () => ['planning'],
    }

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
      toolsetResolver,
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('INVALID_TOOLSET_RESOLVER_RESULT')
    expect(node.tools).toBeUndefined()
  })

  it('awaits an async resolver', async () => {
    const node = agentWith({ toolset: 'planning' })
    const ast = sequence(node)
    const toolsetResolver: AsyncToolsetResolver = {
      resolve: async (ref) => (ref === 'planning' ? ['pm.create_task'] : null),
      listAvailable: () => ['planning'],
    }

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
      toolsetResolver,
    })

    expect(result.errors).toEqual([])
    expect(node.tools).toEqual(['pm.create_task'])
  })

  it('suggests "did you mean…?" when an unknown toolset is close to a known one', async () => {
    const node = agentWith({ toolset: 'planing' })
    const ast = sequence(node)
    const toolsetResolver = createToolsetResolverFromCatalog([
      { name: 'planning', tools: ['pm.create_task'] },
    ])

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
      toolsetResolver,
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.message).toContain('Did you mean')
    expect(result.errors[0]?.message).toContain('"planning"')
  })
})

describe('validateToolsetCatalog', () => {
  it('passes a clean catalogue', () => {
    const result = validateToolsetCatalog([
      { name: 'planning', tools: ['a'] },
      { name: 'review', tools: ['b', 'c'] },
    ])
    expect(result.valid).toBe(true)
    expect(result.diagnostics).toEqual([])
  })

  it('flags missing name, duplicate name, and bad tools entries', () => {
    const result = validateToolsetCatalog([
      { name: '', tools: ['a'] },
      { name: 'dup', tools: ['a'] },
      { name: 'dup', tools: ['b'] },
      { name: 'bad', tools: ['ok', ''] },
    ])
    expect(result.valid).toBe(false)
    const codes = result.diagnostics.map((d) => d.code).sort()
    expect(codes).toContain('INVALID_TOOLSET_CATALOG_ENTRY')
    expect(codes).toContain('DUPLICATE_TOOLSET_CATALOG_NAME')
  })
})
