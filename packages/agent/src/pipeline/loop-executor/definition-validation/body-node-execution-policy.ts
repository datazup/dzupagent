import type { PipelineDefinition, PipelineNode, PipelineValidationError } from '@dzupagent/core/pipeline'
import { projectValidationEdgeTargets } from '../edge-target-projections.js'

/**
 * Execution policy on body nodes fails closed (DZUPAGENT-AGENT-H-65).
 *
 * Only top-level standard dispatch enforces `executionPolicy`; loop,
 * for-each and fork branch executors call the node executor directly. A
 * body node carrying a policy would therefore run without its approval,
 * budget or time cap, so the definition is refused before anything runs.
 */
export function validateBodyNodeExecutionPolicy(
  definition: PipelineDefinition,
  nodeMap: Map<string, PipelineNode>,
  forkNodes: Array<Extract<PipelineNode, { type: 'fork' }>>,
  joinNodes: Array<Extract<PipelineNode, { type: 'join' }>>,
  errors: PipelineValidationError[],
): void {
  for (const [bodyNodeId, owner] of collectBodyNodeOwners(definition, nodeMap, forkNodes, joinNodes)) {
    const bodyNode = nodeMap.get(bodyNodeId)
    const policy = (bodyNode as { executionPolicy?: Record<string, unknown> } | undefined)?.executionPolicy
    if (policy === undefined || policy === null) continue
    const fields = Object.keys(policy).filter(key => policy[key] !== undefined)
    if (fields.length === 0) continue
    errors.push({
      code: 'EXECUTION_POLICY_ON_BODY_NODE',
      message:
        `Node "${bodyNodeId}" declares executionPolicy (${fields.join(', ')}) but runs as a body node of ` +
        `${owner}; executionPolicy is enforced for top-level nodes only`,
      nodeId: bodyNodeId,
    })
  }
}

/**
 * Map every node that executes only inside a loop/for-each body or a fork
 * branch to a description of its owner. Fork branches are the nodes reachable
 * over sequential/conditional edges (the edges the branch walk follows) from
 * the fork's outgoing targets before its matching join.
 */
function collectBodyNodeOwners(
  definition: PipelineDefinition,
  nodeMap: Map<string, PipelineNode>,
  forkNodes: Array<Extract<PipelineNode, { type: 'fork' }>>,
  joinNodes: Array<Extract<PipelineNode, { type: 'join' }>>,
): Map<string, string> {
  const owners = new Map<string, string>()
  for (const node of definition.nodes) {
    if (node.type !== 'loop') continue
    const kind = node.forEach !== undefined ? 'for-each' : 'loop'
    for (const bodyId of node.bodyNodeIds) {
      if (nodeMap.has(bodyId) && !owners.has(bodyId)) {
        owners.set(bodyId, `${kind} node "${node.id}"`)
      }
    }
  }

  const outgoing = new Map<string, string[]>()
  for (const edge of definition.edges) {
    if (edge.type !== 'sequential' && edge.type !== 'conditional') continue
    const targets = outgoing.get(edge.sourceNodeId) ?? []
    targets.push(...projectValidationEdgeTargets(edge))
    outgoing.set(edge.sourceNodeId, targets)
  }
  for (const fork of forkNodes) {
    const joinIds = new Set(joinNodes.filter(join => join.forkId === fork.forkId).map(join => join.id))
    const queue = [...(outgoing.get(fork.id) ?? [])]
    const visited = new Set<string>()
    while (queue.length > 0) {
      const id = queue.shift()!
      if (visited.has(id) || joinIds.has(id) || id === fork.id || !nodeMap.has(id)) continue
      visited.add(id)
      if (!owners.has(id)) owners.set(id, `fork node "${fork.id}"`)
      queue.push(...(outgoing.get(id) ?? []))
    }
  }
  return owners
}
