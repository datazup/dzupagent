import { describe, expect, it } from 'vitest'

import type { FlowNode, HostToolRegistryEntry } from '@dzupagent/flow-ast'
import {
  collectFlowArtifactMetadata,
  createFlowCompiler,
  createToolResolverFromRegistry,
  validateHostToolRegistry,
} from '../index.js'

const registry: HostToolRegistryEntry[] = [
  {
    ref: 'tools.plan',
    kind: 'skill',
    inputSchema: {},
    outputSchema: { type: 'object' },
    aliases: ['tool.plan'],
    description: 'Generic planner tool',
    meta: { owner: 'host' },
  },
  {
    ref: 'tools.implement',
    kind: 'mcp-tool',
    inputSchema: {},
    handle: { toolName: 'tools.implement' },
  },
]

describe('generic host tool registry', () => {
  it('validates reusable registry entries without host-specific tool ids', () => {
    const result = validateHostToolRegistry(registry)
    expect(result.valid).toBe(true)
    expect(result.diagnostics).toEqual([])
  })

  it('creates a resolver that resolves aliases and suggests unknown tools', async () => {
    const compiler = createFlowCompiler({
      toolResolver: createToolResolverFromRegistry(registry),
    })

    const aliasResult = await compiler.compile({
      type: 'action',
      id: 'plan',
      toolRef: 'tool.plan',
      input: {},
    })
    expect('errors' in aliasResult).toBe(false)

    const unknownResult = await compiler.compile({
      type: 'action',
      id: 'missing',
      toolRef: 'tools.pln',
      input: {},
    })
    expect('errors' in unknownResult).toBe(true)
    if (!('errors' in unknownResult)) throw new Error('expected unknown tool failure')
    expect(unknownResult.errors[0]).toMatchObject({
      stage: 3,
      code: 'UNRESOLVED_TOOL_REF',
      category: 'registry',
      suggestion: 'tools.plan',
    })
    expect(unknownResult.diagnosticCountsByCategory).toMatchObject({ registry: 1 })
  })

  it('exposes review, provenance, artifact, resume, and mutation metadata to lowered hosts', async () => {
    const flow: FlowNode = {
      type: 'sequence',
      id: 'root',
      nodes: [
        {
          type: 'approval',
          id: 'review',
          question: 'Approve?',
          meta: {
            review: { gate: 'framework-maintainer' },
            artifacts: [{ path: 'outputs/generic.json', kind: 'json' }],
            resume: { mode: 'manual' },
            mutation: { policy: 'idempotent', idempotencyKey: 'run-1' },
          },
          onApprove: [
            {
              type: 'action',
              id: 'implement',
              toolRef: 'tools.implement',
              input: {},
              meta: {
                requires: ['review'],
                produces: ['artifact'],
                provenance: { sourceDocumentId: 'doc-001' },
              },
            },
          ],
        },
      ],
    }

    const metadata = collectFlowArtifactMetadata(flow)
    expect(metadata.nodes['root.nodes[0]']?.meta).toMatchObject({
      review: { gate: 'framework-maintainer' },
      artifacts: [{ path: 'outputs/generic.json', kind: 'json' }],
    })
    expect(metadata.nodes['root.nodes[0].onApprove[0]']?.meta).toMatchObject({
      requires: ['review'],
      provenance: { sourceDocumentId: 'doc-001' },
    })

    const compiler = createFlowCompiler({
      toolResolver: createToolResolverFromRegistry(registry),
    })
    const result = await compiler.compile(flow)
    expect('errors' in result).toBe(false)
    if ('errors' in result) throw new Error('expected metadata flow to compile')
    const artifact = result.artifact as { metadata?: { flow?: unknown } }
    expect(artifact.metadata?.flow).toMatchObject(metadata)
  })
})
