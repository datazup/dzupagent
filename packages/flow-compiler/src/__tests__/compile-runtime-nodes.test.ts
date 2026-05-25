import type { FlowNode, ResolvedTool, ToolResolver } from '@dzupagent/flow-ast'
import { InMemoryDomainToolRegistry } from '@dzupagent/app-tools'
import { describe, expect, it } from 'vitest'

import { collectUnsupportedRuntimeNodes, createFlowCompiler } from '../index.js'

function makeResolver(toolRefs: string[]): ToolResolver {
  const registry = new InMemoryDomainToolRegistry()
  for (const name of toolRefs) {
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
      return def
        ? {
            ref,
            kind: 'skill',
            inputSchema: def.inputSchema,
            handle: def,
          }
        : null
    },
    listAvailable: () => registry.list().map((tool) => tool.name),
  }
}

const agentNode: FlowNode = {
  type: 'agent',
  agentId: 'reviewer',
  instructions: 'Review the change.',
  output: {
    key: 'review',
    schema: { type: 'object' },
  },
}

describe('runtime-only compiler diagnostics', () => {
  it('fails agent-only flows with actionable lowering diagnostics', async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver([]) })

    const result = await compiler.compile(agentNode)

    expect('errors' in result).toBe(true)
    if (!('errors' in result)) throw new Error('expected compile failure')
    expect(result.errors).toEqual([
      expect.objectContaining({
        stage: 4,
        code: 'UNSUPPORTED_RUNTIME_NODE_FOR_TARGET',
        nodePath: 'root',
        category: 'lowering',
        message: expect.stringContaining('Node type "agent"'),
      }),
    ])
    expect(result.errors[0]?.message).toContain('"skill-chain" generic compiler target')
  })

  it('fails validate-only flows without silently emitting empty artifacts', async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver([]) })

    const result = await compiler.compile({
      type: 'validate',
      ref: 'schema.review',
    })

    expect('errors' in result).toBe(true)
    if (!('errors' in result)) throw new Error('expected compile failure')
    expect(result.errors[0]).toMatchObject({
      stage: 4,
      code: 'UNSUPPORTED_RUNTIME_NODE_FOR_TARGET',
      nodePath: 'root',
      category: 'lowering',
    })
    expect(result.errors[0]?.message).toContain('Node type "validate"')
  })

  it('names prompt and return_to nodes in deterministic AST order', async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver(['tasks.run']) })

    const result = await compiler.compile({
      type: 'sequence',
      nodes: [
        { type: 'prompt', userPrompt: 'Collect requirements.' },
        { type: 'return_to', targetId: 'collect', condition: '{{ state.needsMore }}' },
        { type: 'action', toolRef: 'tasks.run', input: {} },
      ],
    })

    expect('errors' in result).toBe(true)
    if (!('errors' in result)) throw new Error('expected compile failure')
    expect(result.errors.map((error) => [error.nodePath, error.message])).toEqual([
      ['root.nodes[0]', expect.stringContaining('Node type "prompt"')],
      ['root.nodes[1]', expect.stringContaining('Node type "return_to"')],
    ])
  })

  it('keeps supported action-only flows lowerable', async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver(['tasks.run']) })

    const result = await compiler.compile({
      type: 'action',
      toolRef: 'tasks.run',
      input: {},
    })

    expect('errors' in result).toBe(false)
    if ('errors' in result) throw new Error('expected compile success')
    expect(result.target).toBe('skill-chain')
    expect(result.warnings).toEqual([])
  })

  it('exposes unsupported runtime nodes for route-level audits', () => {
    const nodes = collectUnsupportedRuntimeNodes({
      type: 'sequence',
      nodes: [agentNode, { type: 'validate', ref: 'schema.review' }],
    }, 'skill-chain')

    expect(nodes).toEqual([
      { type: 'agent', path: 'root.nodes[0]' },
      { type: 'validate', path: 'root.nodes[1]' },
    ])
  })
})
