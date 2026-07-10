import type {
  FlowNode,
  ResolvedTool,
  ToolResolver,
} from '@dzupagent/flow-ast'
import { describe, expect, it } from 'vitest'

import {
  createFlowCompiler,
  resolveHostReadiness,
  type HostCapabilityManifest,
} from '../index.js'
import type { CompilationTarget } from '../types.js'

const resolver: ToolResolver = {
  resolve(ref: string): ResolvedTool | null {
    if (ref !== 'tasks.run') return null
    return {
      ref,
      kind: 'skill',
      inputSchema: { type: 'object' },
      handle: { name: ref },
    }
  },
  listAvailable: () => ['tasks.run'],
}

const fixtureHost: HostCapabilityManifest = {
  schema: 'dzupagent.hostCapabilityManifest/v1',
  host: 'flow-compiler.combination-fixtures',
  version: '1.0.0',
  targets: ['skill-chain', 'workflow-builder', 'pipeline', 'planning-dag'],
  capabilities: [
    'flow.target.skill-chain@1',
    'flow.target.workflow-builder@1',
    'flow.target.pipeline@1',
    'flow.target.planning-dag@1',
    'flow.runtime.complete@1',
    'flow.runtime.loop@1',
    'flow.runtime.checkpoint@1',
    'flow.runtime.restore@1',
    'flow.runtime.set@1',
    'flow.runtime.agent@1',
  ],
}

interface CombinationFixture {
  name: string
  ast: FlowNode
  target: CompilationTarget
  nodeKinds: FlowNode['type'][]
}

const fixtures: CombinationFixture[] = [
  {
    name: 'sequence plus completion',
    target: 'skill-chain',
    nodeKinds: ['action', 'complete', 'sequence'],
    ast: {
      type: 'sequence',
      nodes: [
        { type: 'action', id: 'run', toolRef: 'tasks.run', input: {} },
        { type: 'complete', id: 'done', result: '{{ state.run }}' },
      ],
    },
  },
  {
    name: 'branch plus suspension',
    target: 'workflow-builder',
    nodeKinds: ['action', 'approval', 'branch'],
    ast: {
      type: 'branch',
      condition: '{{ state.requiresApproval }}',
      then: [
        {
          type: 'approval',
          question: 'Continue?',
          onApprove: [{ type: 'action', toolRef: 'tasks.run', input: {} }],
        },
      ],
      else: [{ type: 'action', toolRef: 'tasks.run', input: {} }],
    },
  },
  {
    name: 'parallel plus agent',
    target: 'planning-dag',
    nodeKinds: ['agent', 'parallel'],
    ast: {
      type: 'parallel',
      branches: [
        [
          {
            type: 'agent',
            agentId: 'reviewer',
            instructions: 'Review the change.',
            output: { key: 'review', schema: { type: 'object' } },
          },
        ],
        [
          {
            type: 'agent',
            agentId: 'tester',
            instructions: 'Inspect validation coverage.',
            output: { key: 'tests', schema: { type: 'object' } },
          },
        ],
      ],
    },
  },
  {
    name: 'for_each plus runtime leaf',
    target: 'pipeline',
    nodeKinds: ['for_each', 'set'],
    ast: {
      type: 'for_each',
      source: '{{ state.items }}',
      as: 'item',
      collect: { from: 'normalized', into: 'normalizedItems' },
      body: [
        {
          type: 'set',
          assign: { normalized: '{{ state.item }}' },
        },
      ],
    },
  },
  {
    name: 'loop plus progress policy',
    target: 'pipeline',
    nodeKinds: ['loop', 'set'],
    ast: {
      type: 'loop',
      condition: '{{ state.remaining }}',
      maxIterations: 5,
      progressKey: 'remaining',
      body: [
        {
          type: 'set',
          assign: { remaining: '{{ state.remaining - 1 }}' },
        },
      ],
    },
  },
  {
    name: 'checkpoint and restore plus agent',
    target: 'planning-dag',
    nodeKinds: ['agent', 'checkpoint', 'restore', 'sequence'],
    ast: {
      type: 'sequence',
      nodes: [
        {
          type: 'agent',
          id: 'draft',
          agentId: 'writer',
          instructions: 'Draft the change.',
          output: { key: 'draft', schema: { type: 'object' } },
        },
        {
          type: 'checkpoint',
          id: 'saved-draft',
          label: 'draft-ready',
          captureOutputOf: 'draft',
        },
        {
          type: 'restore',
          id: 'restore-draft',
          checkpointLabel: 'draft-ready',
        },
      ],
    },
  },
]

describe('cross-feature conformance combinations', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} passes compiler and runtime-readiness gates`, async () => {
      const result = await createFlowCompiler({ toolResolver: resolver }).compile(fixture.ast)

      if ('errors' in result) {
        throw new Error(`expected ${fixture.name} to compile: ${JSON.stringify(result.errors)}`)
      }

      expect(result.target).toBe(fixture.target)
      expect(result.requirements.nodeKinds).toEqual([...fixture.nodeKinds].sort())
      expect(result.requirements.semanticHash).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(result.evidence.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(result.evidence.semanticHash).toBe(result.requirements.semanticHash)
      expect(resolveHostReadiness(result.requirements, fixtureHost)).toMatchObject({
        status: 'ready',
        host: fixtureHost.host,
        target: fixture.target,
        diagnostics: [],
      })
    })
  }

  it('durable suspension and explicit resume readiness remain visible in evidence', async () => {
    const result = await createFlowCompiler({ toolResolver: resolver }).compileDocument({
      dsl: 'dzupflow/v1',
      id: 'durable-approval-resume',
      version: 1,
      durability: {
        mode: 'durable',
        checkpoint: { strategy: 'after_each_node', storeRef: 'fixture://checkpoints' },
      },
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [
          {
            type: 'approval',
            id: 'approve',
            resumePoint: true,
            question: 'Deploy the validated artifact?',
            onApprove: [
              {
                type: 'action',
                id: 'deploy',
                toolRef: 'tasks.run',
                input: {},
              },
            ],
          },
        ],
      },
    })

    if ('errors' in result) {
      throw new Error(`expected durable suspension fixture to compile: ${JSON.stringify(result.errors)}`)
    }
    expect(result.target).toBe('workflow-builder')
    expect(result.documentDurability).toMatchObject({
      mode: 'durable',
      checkpoint: { strategy: 'after_each_node', storeRef: 'fixture://checkpoints' },
    })
    expect(result.evidence.canonicalNodePaths).toMatchObject({
      'root.nodes[0]': { type: 'approval', id: 'approve' },
      'root.nodes[0].onApprove[0]': { type: 'action', id: 'deploy' },
    })
    expect(resolveHostReadiness(result.requirements, fixtureHost).status).toBe('ready')
  })
})
