/**
 * Unit tests for lower-pipeline-loop Stage 4 lowerer.
 *
 * Gold-file tests:
 *   1. for_each containing an action → PipelineDefinition with LoopNode +
 *      ToolNode siblings; LoopNode.bodyNodeIds references the body action's ID.
 *   2. for_each inside a branch.then → outer structure produced without error.
 *
 * ID generation is injected via `idGen` for snapshot stability.
 */

import type {
  ActionNode,
  BranchNode,
  FlowNode,
  ForEachNode,
  ResolvedTool,
  SequenceNode,
  ToolResolver,
} from '@dzupagent/flow-ast'
import type { LoopNode, PipelineDefinition, ToolNode } from '@dzupagent/core'
import { InMemoryDomainToolRegistry } from '@dzupagent/app-tools'
import { describe, expect, it } from 'vitest'

import { lowerPipelineLoop } from '../src/lower/lower-pipeline-loop.js'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Deterministic ID sequence: "id-0", "id-1", … */
function makeIdGen(): () => string {
  let counter = 0
  return () => `id-${counter++}`
}

function makeResolver(toolNames: string[]): ToolResolver {
  const registry = new InMemoryDomainToolRegistry()
  for (const name of toolNames) {
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

function buildResolved(
  resolver: ToolResolver,
  entries: Array<{ nodePath: string; toolRef: string }>,
): Map<string, ResolvedTool> {
  const map = new Map<string, ResolvedTool>()
  for (const { nodePath, toolRef } of entries) {
    const rt = resolver.resolve(toolRef)
    if (rt !== null) {
      map.set(nodePath, rt)
    }
  }
  return map
}

const action = (toolRef: string): ActionNode => ({
  type: 'action',
  toolRef,
  input: {},
})

const forEach = (source: string, as_: string, ...body: FlowNode[]): ForEachNode => ({
  type: 'for_each',
  source,
  as: as_,
  body,
})

const sequence = (...nodes: FlowNode[]): SequenceNode => ({
  type: 'sequence',
  nodes,
})

const branch = (condition: string, then_: FlowNode[], else_?: FlowNode[]): BranchNode => ({
  type: 'branch',
  condition,
  then: then_,
  ...(else_ !== undefined ? { else: else_ } : {}),
})

// ---------------------------------------------------------------------------
// Test 1: for_each containing a single action
// ---------------------------------------------------------------------------

describe('lowerPipelineLoop', () => {
  it('gold-file: for_each with one action body → LoopNode + ToolNode as siblings', () => {
    const resolver = makeResolver(['items.process'])
    const idGen = makeIdGen()

    // AST: for_each over "items", body = [action('items.process')]
    const ast = forEach('$.items', 'item', action('items.process'))

    // Resolved side-table:
    //   - the action is at path "root.body[0]"
    //     (lowerForEach calls lowerSequence(node.body, ctx, "root.body")
    //      which maps child idx 0 to "root.body[0]")
    const resolved = buildResolved(resolver, [
      { nodePath: 'root.body[0]', toolRef: 'items.process' },
    ])

    const { artifact, warnings } = lowerPipelineLoop({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      idGen,
      name: 'loop-test',
      version: '1.0.0',
      id: 'pipeline-loop-gold',
    })

    // Pipeline shape
    expect(artifact.id).toBe('pipeline-loop-gold')
    expect(artifact.name).toBe('loop-test')
    expect(artifact.version).toBe('1.0.0')
    expect(artifact.schemaVersion).toBe('1.0.0')

    // Two nodes: LoopNode (first, as entry) + ToolNode (body)
    expect(artifact.nodes).toHaveLength(2)
    expect(warnings).toEqual([])

    const [loopNode, bodyNode] = artifact.nodes as [LoopNode, ToolNode]

    // LoopNode shape
    expect(loopNode.type).toBe('loop')
    expect(loopNode.name).toBe('forEach:item')
    expect(loopNode.maxIterations).toBe(1000)
    expect(loopNode.continuePredicateName).toBe('forEach__item__predicate')

    // ToolNode shape
    expect(bodyNode.type).toBe('tool')
    expect(bodyNode.toolName).toBe('items.process')

    // Core invariant: LoopNode.bodyNodeIds references the body action's ID
    expect(loopNode.bodyNodeIds).toEqual([bodyNode.id])

    // Entry node is the LoopNode
    expect(artifact.entryNodeId).toBe(loopNode.id)

    // A single-node body has no internal edges
    expect(artifact.edges).toHaveLength(0)
  })

  // ---------------------------------------------------------------------------
  // Test 2: for_each with a multi-action body → edges chain body nodes
  // ---------------------------------------------------------------------------

  it('for_each with two-action body → body nodes are edge-chained and referenced by LoopNode', () => {
    const resolver = makeResolver(['items.fetch', 'items.transform'])
    const idGen = makeIdGen()

    const ast = forEach(
      '$.records',
      'rec',
      action('items.fetch'),
      action('items.transform'),
    )

    const resolved = buildResolved(resolver, [
      { nodePath: 'root.body[0]', toolRef: 'items.fetch' },
      { nodePath: 'root.body[1]', toolRef: 'items.transform' },
    ])

    const { artifact, warnings } = lowerPipelineLoop({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      idGen,
      name: 'multi-body-loop',
    })

    expect(warnings).toEqual([])

    // Three nodes: LoopNode + 2 body ToolNodes
    expect(artifact.nodes).toHaveLength(3)

    const [loopNode, fetchNode, transformNode] = artifact.nodes as [LoopNode, ToolNode, ToolNode]

    expect(loopNode.type).toBe('loop')
    expect(loopNode.bodyNodeIds).toEqual([fetchNode.id, transformNode.id])

    // One sequential edge between the two body nodes
    expect(artifact.edges).toHaveLength(1)
    expect(artifact.edges[0]).toEqual({
      type: 'sequential',
      sourceNodeId: fetchNode.id,
      targetNodeId: transformNode.id,
    })
  })

  // ---------------------------------------------------------------------------
  // Test 3: for_each inside branch.then → outer structure works without crash
  // ---------------------------------------------------------------------------

  it('for_each inside branch.then → outer branch+gate structure is valid, no crash', () => {
    const resolver = makeResolver(['tasks.run'])
    const idGen = makeIdGen()

    // AST: branch( condition, then=[for_each(body=[action])], else=[] )
    const ast = branch(
      'tasks.length > 0',
      [forEach('$.tasks', 'task', action('tasks.run'))],
    )

    const resolved = buildResolved(resolver, [
      // path: root.then[0] = for_each node — no lookup needed for for_each itself
      // path: root.then[0].body[0] = the action inside the body
      { nodePath: 'root.then[0].body[0]', toolRef: 'tasks.run' },
    ])

    // We don't assert exact node paths for the branch sub-case (path building
    // for branch.then goes through lowerSequence with "root.then" prefix), but
    // the important contract is: no exception, produces a PipelineDefinition,
    // at least one LoopNode is present.
    let artifact: PipelineDefinition
    let warnings: string[]
    expect(() => {
      const result = lowerPipelineLoop({
        ast,
        resolved,
        resolvedPersonas: new Map(),
        idGen,
        name: 'branch-with-loop',
      })
      artifact = result.artifact
      warnings = result.warnings
    }).not.toThrow()

    // Verify a LoopNode was produced somewhere in the flat node list
    const loopNodes = artifact!.nodes.filter((n) => n.type === 'loop')
    expect(loopNodes.length).toBeGreaterThanOrEqual(1)

    const loop = loopNodes[0] as LoopNode
    expect(loop.bodyNodeIds).toHaveLength(1)

    // The outer GateNode is the entry
    const gateNode = artifact!.nodes.find((n) => n.type === 'gate')
    expect(gateNode).toBeDefined()
    expect(artifact!.entryNodeId).toBe(gateNode!.id)

    expect(warnings).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // Test 4: throws when AST produces no nodes
  // ---------------------------------------------------------------------------

  it('throws when the AST produces no pipeline nodes (empty sequence)', () => {
    const ast: SequenceNode = { type: 'sequence', nodes: [] }

    expect(() =>
      lowerPipelineLoop({
        ast,
        resolved: new Map(),
        resolvedPersonas: new Map(),
        name: 'empty',
      }),
    ).toThrow(/no nodes produced/)
  })

  // ---------------------------------------------------------------------------
  // Test 5: defaults (no name/version/id provided)
  // ---------------------------------------------------------------------------

  it('defaults name to "flow-pipeline" and version to "0.0.0" when not provided', () => {
    const resolver = makeResolver(['svc.run'])
    const idGen = makeIdGen()
    const ast = forEach('$.items', 'x', action('svc.run'))
    const resolved = buildResolved(resolver, [
      { nodePath: 'root.body[0]', toolRef: 'svc.run' },
    ])

    const { artifact } = lowerPipelineLoop({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      idGen,
    })

    expect(artifact.name).toBe('flow-pipeline')
    expect(artifact.version).toBe('0.0.0')
    expect(typeof artifact.id).toBe('string')
    expect(artifact.id.length).toBeGreaterThan(0)
  })
})
