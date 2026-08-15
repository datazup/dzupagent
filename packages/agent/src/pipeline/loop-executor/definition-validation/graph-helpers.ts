import type { PipelineEdge, PipelineNode, PipelineValidationError } from "@dzupagent/core/pipeline";

import { projectValidationEdgeTargets } from "../edge-target-projections.js";

export function findUnsupportedForkBranchShape(
  forkNodeId: string,
  owningJoinNodeId: string,
  nodeMap: ReadonlyMap<string, PipelineNode>,
  edges: readonly PipelineEdge[],
): { nodeId: string; kind: string } | undefined {
  const forkEdges = edges.filter(edge => edge.sourceNodeId === forkNodeId)
  if (forkEdges.length === 0) {
    return { nodeId: forkNodeId, kind: 'fork has no branch starts' }
  }
  if (forkEdges.some(edge => edge.type !== 'sequential')) {
    return { nodeId: forkNodeId, kind: 'fork uses conditional or error routing' }
  }

  const branchStartIds = forkEdges.flatMap(edge =>
    edge.type === 'sequential' ? [edge.targetNodeId] : [],
  )
  if (
    new Set(branchStartIds).size !== branchStartIds.length ||
    branchStartIds.includes(owningJoinNodeId)
  ) {
    return { nodeId: forkNodeId, kind: 'fork branch starts are duplicate or empty' }
  }

  const branchOwner = new Map<string, string>()
  const expectedPredecessor = new Map<string, string>()
  const branchEndIds = new Set<string>()

  for (const branchStartId of branchStartIds) {
    let currentId = branchStartId
    let predecessorId = forkNodeId
    const branchVisited = new Set<string>()

    while (currentId !== owningJoinNodeId) {
      if (branchVisited.has(currentId)) {
        return { nodeId: currentId, kind: 'branch cycles before its owning join' }
      }
      branchVisited.add(currentId)

      const existingOwner = branchOwner.get(currentId)
      if (existingOwner !== undefined && existingOwner !== branchStartId) {
        return { nodeId: currentId, kind: 'branches overlap before their owning join' }
      }
      branchOwner.set(currentId, branchStartId)
      expectedPredecessor.set(currentId, predecessorId)

      const node = nodeMap.get(currentId)
      if (node === undefined) {
        return { nodeId: currentId, kind: 'branch reaches a missing node' }
      }
      if (node.type === 'fork') return { nodeId: currentId, kind: 'nested fork' }
      if (node.type === 'join') return { nodeId: currentId, kind: 'nested or foreign join' }
      if (node.type === 'loop') return { nodeId: currentId, kind: 'loop control' }
      if (node.type === 'suspend') {
        return { nodeId: currentId, kind: 'suspension or terminal control' }
      }
      if (node.type === 'gate' && node.gateType === 'approval') {
        return { nodeId: currentId, kind: 'approval suspension' }
      }

      const outgoing = edges.filter(edge => edge.sourceNodeId === currentId)
      if (outgoing.some(edge => edge.type === 'conditional')) {
        return { nodeId: currentId, kind: 'conditional branch control' }
      }
      if (outgoing.some(edge => edge.type === 'error')) {
        return { nodeId: currentId, kind: 'try/catch error control' }
      }
      if (outgoing.length !== 1 || outgoing[0]?.type !== 'sequential') {
        return { nodeId: currentId, kind: 'branch does not have exactly one sequential successor' }
      }

      const nextId = outgoing[0].targetNodeId
      if (nextId === owningJoinNodeId) branchEndIds.add(currentId)
      predecessorId = currentId
      currentId = nextId
    }
  }

  for (const [nodeId, predecessorId] of expectedPredecessor) {
    const incoming = edges.filter(edge => projectValidationEdgeTargets(edge).includes(nodeId))
    if (
      incoming.length !== 1 ||
      incoming[0]?.type !== 'sequential' ||
      incoming[0].sourceNodeId !== predecessorId
    ) {
      return { nodeId, kind: 'branch has an external or ambiguous predecessor' }
    }
  }

  const joinIncoming = edges.filter(edge => projectValidationEdgeTargets(edge).includes(owningJoinNodeId))
  if (
    joinIncoming.length !== branchEndIds.size ||
    joinIncoming.some(
      edge => edge.type !== 'sequential' || !branchEndIds.has(edge.sourceNodeId),
    )
  ) {
    return { nodeId: owningJoinNodeId, kind: 'join has an external or ambiguous predecessor' }
  }

  return undefined
}

export function bfsReachable(startId: string, adjacency: Map<string, Set<string>>): Set<string> {
  const visited = new Set<string>()
  const queue = [startId]
  visited.add(startId)

  while (queue.length > 0) {
    const current = queue.shift()!
    const neighbors = adjacency.get(current)
    if (neighbors) {
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor)
          queue.push(neighbor)
        }
      }
    }
  }

  return visited
}

/** DFS cycle detection using white/gray/black coloring */
export function detectCycles(
  adjacency: Map<string, Set<string>>,
  loopBodyNodeIds: Set<string>,
  errors: PipelineValidationError[],
): void {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2

  const color = new Map<string, number>()
  for (const nodeId of adjacency.keys()) {
    color.set(nodeId, WHITE)
  }

  function dfs(nodeId: string, path: string[]): void {
    color.set(nodeId, GRAY)
    path.push(nodeId)

    const neighbors = adjacency.get(nodeId)
    if (neighbors) {
      for (const neighbor of neighbors) {
        const neighborColor = color.get(neighbor)
        if (neighborColor === GRAY) {
          // Found a cycle — check if ALL nodes in the cycle are loop body nodes
          const cycleStart = path.indexOf(neighbor)
          const cycleNodes = path.slice(cycleStart)
          const allInLoopBody = cycleNodes.every(id => loopBodyNodeIds.has(id))
          if (!allInLoopBody) {
            errors.push({
              code: 'UNBOUNDED_CYCLE',
              message: `Cycle detected: ${[...cycleNodes, neighbor].join(' -> ')}`,
              nodeId: neighbor,
            })
          }
        } else if (neighborColor === WHITE) {
          dfs(neighbor, path)
        }
      }
    }

    path.pop()
    color.set(nodeId, BLACK)
  }

  for (const nodeId of adjacency.keys()) {
    if (color.get(nodeId) === WHITE) {
      dfs(nodeId, [])
    }
  }
}
