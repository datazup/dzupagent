import type { FlowNode, ResolvedTool, ToolResolver } from '@dzupagent/flow-ast'
import { InMemoryDomainToolRegistry } from '@dzupagent/app-tools'
import type { PipelineDefinition } from '@dzupagent/core/pipeline'
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
  it('lowers agent-only flows to planning-dag AgentNode artifacts', async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver([]) })

    const result = await compiler.compile(agentNode)

    expect('errors' in result).toBe(false)
    if ('errors' in result) throw new Error('expected compile success')
    expect(result.target).toBe('planning-dag')
    const artifact = result.artifact as PipelineDefinition
    expect(artifact.nodes).toEqual([
      expect.objectContaining({
        type: 'agent',
        agentId: 'reviewer',
        config: expect.objectContaining({
          instructions: 'Review the change.',
          output: { key: 'review', schema: { type: 'object' } },
        }),
      }),
    ])
  })

  it('lowers validate-only flows to planning-dag runtime tool nodes', async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver([]) })

    const result = await compiler.compile({
      type: 'validate',
      ref: 'schema.review',
      effectClass: 'db_write',
      idempotency: 'exactly-once-required',
      meta: {
        mutation: {
          policy: 'mutating',
          idempotencyKey: 'review-validate',
        },
      },
    })

    expect('errors' in result).toBe(false)
    if ('errors' in result) throw new Error('expected compile success')
    expect(result.target).toBe('planning-dag')
    const artifact = result.artifact as PipelineDefinition
    expect(artifact.nodes).toEqual([
      expect.objectContaining({
        type: 'tool',
        toolName: 'dzup.runtime.validate',
        arguments: { ref: 'schema.review' },
        declaredIdempotencyKey: 'review-validate',
        effectClass: 'db_write',
        idempotency: 'exactly-once-required',
      }),
    ])
  })

  it('lowers adapter runtime-only flows to planning-dag runtime tool nodes', async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver([]) })

    const result = await compiler.compile({
      type: 'adapter.run',
      provider: 'codex',
      instructions: 'Discuss the architecture.',
      output: 'adapterResult',
    })

    expect('errors' in result).toBe(false)
    if ('errors' in result) throw new Error('expected compile success')
    expect(result.target).toBe('planning-dag')
    const artifact = result.artifact as PipelineDefinition
    expect(artifact.nodes).toEqual([
      expect.objectContaining({
        type: 'tool',
        toolName: 'dzup.runtime.adapter.run',
        arguments: {
          provider: 'codex',
          instructions: 'Discuss the architecture.',
          output: 'adapterResult',
        },
      }),
    ])
  })

  it('lowers prompt nodes but still rejects return_to nodes in deterministic AST order', async () => {
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
      ['root.nodes[1]', expect.stringContaining('Node type "return_to"')],
    ])
  })

  it('lowers prompt-only flows to planning-dag runtime tool nodes', async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver([]) })

    const result = await compiler.compile({
      type: 'prompt',
      userPrompt: 'Collect requirements.',
      outputKey: 'requirements',
      provider: 'openai',
      model: 'gpt-4.1',
    })

    expect('errors' in result).toBe(false)
    if ('errors' in result) throw new Error('expected compile success')
    expect(result.target).toBe('planning-dag')
    const artifact = result.artifact as PipelineDefinition
    expect(artifact.nodes).toEqual([
      expect.objectContaining({
        type: 'tool',
        toolName: 'dzup.runtime.prompt',
        arguments: {
          userPrompt: 'Collect requirements.',
          outputKey: 'requirements',
          provider: 'openai',
          model: 'gpt-4.1',
        },
      }),
    ])
  })

  it('preserves source flow-node identity on lowered runtime tool nodes', async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver([]) })

    const result = await compiler.compileDocument({
      dsl: 'dzupflow/v1',
      id: 'source-runtime-node',
      version: 1,
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [
          {
            type: 'prompt',
            id: 'collect-requirements',
            userPrompt: 'Collect requirements.',
            outputKey: 'requirements',
          },
        ],
      },
    })

    expect('errors' in result).toBe(false)
    if ('errors' in result) throw new Error('expected compile success')
    expect(result.target).toBe('planning-dag')
    const artifact = result.artifact as PipelineDefinition
    expect(artifact.nodes[0]).toMatchObject({
      type: 'tool',
      toolName: 'dzup.runtime.prompt',
      source: {
        kind: 'flow-node',
        path: 'root.nodes[0]',
        nodeType: 'prompt',
        nodeId: 'collect-requirements',
      },
    })
  })

  it('lowers worker.dispatch-only flows to planning-dag runtime tool nodes', async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver([]) })

    const result = await compiler.compile({
      type: 'worker.dispatch',
      dispatchId: 'review-change',
      provider: 'codex',
      instructions: 'Review the current diff.',
      outputKey: 'workerReview',
    })

    expect('errors' in result).toBe(false)
    if ('errors' in result) throw new Error('expected compile success')
    expect(result.target).toBe('planning-dag')
    const artifact = result.artifact as PipelineDefinition
    expect(artifact.nodes).toEqual([
      expect.objectContaining({
        type: 'tool',
        toolName: 'dzup.runtime.worker.dispatch',
        arguments: {
          dispatchId: 'review-change',
          provider: 'codex',
          instructions: 'Review the current diff.',
          outputKey: 'workerReview',
        },
      }),
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

  it('routes worker dispatch runtime leaves alongside lowerable actions to planning-dag', async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver(['tasks.run']) })

    const ast: FlowNode = {
      type: 'sequence',
      nodes: [
        {
          type: 'worker.dispatch',
          dispatchId: 'review-change',
          provider: 'codex',
          instructions: 'Review the current diff.',
          outputKey: 'workerReview',
        },
        { type: 'action', toolRef: 'tasks.run', input: {} },
      ],
    }
    const result = await compiler.compile(ast)

    expect('errors' in result).toBe(false)
    if ('errors' in result) throw new Error('expected compile success')
    expect(result.target).toBe('planning-dag')
    const artifact = result.artifact as PipelineDefinition
    expect(artifact.nodes.map((node) => node.type)).toEqual(['tool', 'tool'])
    expect(artifact.nodes[0]).toMatchObject({
      type: 'tool',
      toolName: 'dzup.runtime.worker.dispatch',
    })
    expect(artifact.nodes[1]).toMatchObject({
      type: 'tool',
      toolName: 'tasks.run',
    })
    expect(collectUnsupportedRuntimeNodes(ast, 'skill-chain')).toEqual([
      { type: 'worker.dispatch', path: 'root.nodes[0]' },
    ])
  })

  it('exposes unsupported runtime nodes for route-level audits', () => {
    const nodes = collectUnsupportedRuntimeNodes({
      type: 'sequence',
      nodes: [
        agentNode,
        { type: 'validate', ref: 'schema.review' },
        {
          type: 'adapter.parallel',
          providers: ['claude', 'codex'],
          instructions: 'Compare approaches.',
          output: 'comparison',
        },
      ],
    }, 'skill-chain')

    expect(nodes).toEqual([
      { type: 'agent', path: 'root.nodes[0]' },
      { type: 'validate', path: 'root.nodes[1]' },
      { type: 'adapter.parallel', path: 'root.nodes[2]' },
    ])
  })
})
