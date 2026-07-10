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

  it('lowers prompt and return_to nodes as host-required planning-dag leaves', async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver(['tasks.run']) })

    const result = await compiler.compile({
      type: 'sequence',
      nodes: [
        { type: 'prompt', userPrompt: 'Collect requirements.' },
        { type: 'return_to', targetId: 'collect', condition: '{{ state.needsMore }}' },
        { type: 'action', toolRef: 'tasks.run', input: {} },
      ],
    })

    expect('errors' in result).toBe(false)
    if ('errors' in result) throw new Error('expected compile success')
    expect(result.target).toBe('planning-dag')
    expect(result.requirements.requiredCapabilities).toContain('flow.runtime.return_to@1')
    const artifact = result.artifact as PipelineDefinition
    expect(artifact.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool',
          toolName: 'dzup.runtime.return_to',
          arguments: {
            targetId: 'collect',
            condition: '{{ state.needsMore }}',
          },
        }),
      ]),
    )
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

  it('lowers every runtime leaf node shape used by compile-to-run fixtures', async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver([]) })

    const result = await compiler.compile({
      type: 'sequence',
      nodes: [
        {
          type: 'prompt',
          userPrompt: 'Collect requirements.',
          outputKey: 'requirements',
        },
        {
          type: 'worker.dispatch',
          dispatchId: 'review-change',
          provider: 'codex',
          instructions: 'Review the diff.',
          outputKey: 'workerReview',
        },
        {
          type: 'adapter.run',
          provider: 'claude',
          instructions: 'Run a review.',
          output: 'adapterResult',
        },
        {
          type: 'adapter.race',
          providers: ['claude', 'codex'],
          instructions: 'Race providers.',
          output: 'raceResult',
        },
        {
          type: 'adapter.parallel',
          providers: ['claude', 'codex'],
          merge: 'all',
          instructions: 'Compare providers.',
          output: 'parallelResult',
        },
        {
          type: 'adapter.supervisor',
          goal: 'Coordinate review.',
          specialists: ['architect'],
          output: 'supervisorResult',
        },
        {
          type: 'shell.run',
          command: 'yarn test',
          output: 'shellValidation',
        },
        {
          type: 'validate.schema',
          source: 'adapterResult',
          schema: 'review.schema',
          output: 'schemaValidation',
        },
        {
          type: 'spdd.agent_swarm',
          spddRunId: 'run-1',
          subTasks: [
            { role: 'review', personaRef: 'reviewer', input: { artifactRef: 'artifact-1' } },
          ],
          outputKey: 'swarmResult',
        },
        {
          type: 'validate',
          ref: 'runtime.suite',
        },
      ],
    })

    expect('errors' in result).toBe(false)
    if ('errors' in result) throw new Error('expected compile success')
    expect(result.target).toBe('planning-dag')
    const artifact = result.artifact as PipelineDefinition
    expect(artifact.nodes.map((node) => node.type)).toEqual([
      'tool',
      'tool',
      'tool',
      'tool',
      'tool',
      'tool',
      'tool',
      'tool',
      'tool',
      'tool',
    ])
    expect(artifact.nodes.map((node) => 'toolName' in node ? node.toolName : undefined)).toEqual([
      'dzup.runtime.prompt',
      'dzup.runtime.worker.dispatch',
      'dzup.runtime.adapter.run',
      'dzup.runtime.adapter.race',
      'dzup.runtime.adapter.parallel',
      'dzup.runtime.adapter.supervisor',
      'dzup.runtime.shell.run',
      'dzup.runtime.validate.schema',
      'dzup.runtime.spdd.agent_swarm',
      'dzup.runtime.validate',
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
