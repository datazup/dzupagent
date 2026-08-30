import type { PipelineEdge, PipelineNode, PipelineValidationError } from "@dzupagent/runtime-contracts/pipeline-artifact";

import { projectValidationEdgeTargets } from "../edge-target-projections.js";

export interface AdmittedForkBranchGraph {
  readonly branchOrdinal: number
  readonly branchStartNodeId: string
  readonly nodeIds: readonly string[]
  readonly normalExitNodeIds: readonly string[]
  readonly conditionalGateNodeId?: string
}

export interface AdmittedRecursiveForkGraph {
  readonly forkNodeId: string
  readonly joinNodeId: string
  readonly branches: readonly AdmittedForkBranchGraph[]
  readonly conditionalBranchOrdinal: number
}

type ForkShapeInspection =
  | { readonly kind: 'flat' }
  | { readonly kind: 'recursive-conditional'; readonly graph: AdmittedRecursiveForkGraph }
  | { readonly kind: 'unsupported'; readonly nodeId: string; readonly reason: string }

function unsupported(nodeId: string, reason: string): ForkShapeInspection {
  return { kind: 'unsupported', nodeId, reason }
}

function inspectForkBranchShape(
  forkNodeId: string,
  owningJoinNodeId: string,
  nodeMap: ReadonlyMap<string, PipelineNode>,
  edges: readonly PipelineEdge[],
): ForkShapeInspection {
  const forkEdges = edges.filter(edge => edge.sourceNodeId === forkNodeId)
  if (forkEdges.length === 0) {
    return unsupported(forkNodeId, 'fork has no branch starts')
  }
  if (forkEdges.some(edge => edge.type !== 'sequential')) {
    return unsupported(forkNodeId, 'fork uses conditional or error routing')
  }

  const branchStartIds = forkEdges.flatMap(edge =>
    edge.type === 'sequential' ? [edge.targetNodeId] : [],
  )
  if (
    new Set(branchStartIds).size !== branchStartIds.length ||
    branchStartIds.includes(owningJoinNodeId)
  ) {
    return unsupported(forkNodeId, 'fork branch starts are duplicate or empty')
  }

  const branchOwner = new Map<string, string>()
  const expectedPredecessors = new Map<string, Set<string>>()
  const branchEndIds = new Set<string>()
  const branches: AdmittedForkBranchGraph[] = []
  let conditionalBranchOrdinal: number | undefined

  const claimNode = (
    nodeId: string,
    branchStartId: string,
    predecessorIds: readonly string[],
  ): ForkShapeInspection | undefined => {
    const existingOwner = branchOwner.get(nodeId)
    if (existingOwner !== undefined && existingOwner !== branchStartId) {
      return unsupported(nodeId, 'branches overlap before their owning join')
    }
    branchOwner.set(nodeId, branchStartId)
    expectedPredecessors.set(nodeId, new Set(predecessorIds))
    return undefined
  }

  const inspectLeaf = (
    nodeId: string,
    branchStartId: string,
    predecessorId: string,
    visited: Set<string>,
    inventory: string[],
  ): { nextId: string } | ForkShapeInspection => {
    if (visited.has(nodeId)) {
      return unsupported(nodeId, 'branch cycles before its owning join')
    }
    visited.add(nodeId)
    const ownership = claimNode(nodeId, branchStartId, [predecessorId])
    if (ownership !== undefined) return ownership

    const node = nodeMap.get(nodeId)
    if (node === undefined) return unsupported(nodeId, 'branch reaches a missing node')
    if (node.type === 'fork') return unsupported(nodeId, 'nested fork')
    if (node.type === 'join') return unsupported(nodeId, 'nested or foreign join')
    if (node.type === 'loop') return unsupported(nodeId, 'loop control')
    if (node.type === 'suspend') return unsupported(nodeId, 'suspension or terminal control')
    if (node.type === 'gate' && node.gateType === 'approval') {
      return unsupported(nodeId, 'approval suspension')
    }

    const outgoing = edges.filter(edge => edge.sourceNodeId === nodeId)
    if (outgoing.some(edge => edge.type === 'conditional')) {
      return unsupported(nodeId, 'conditional branch control')
    }
    if (outgoing.some(edge => edge.type === 'error')) {
      return unsupported(nodeId, 'try/catch error control')
    }
    if (outgoing.length !== 1 || outgoing[0]?.type !== 'sequential') {
      return unsupported(nodeId, 'branch does not have exactly one sequential successor')
    }
    inventory.push(nodeId)
    return { nextId: outgoing[0].targetNodeId }
  }

  for (let branchOrdinal = 0; branchOrdinal < branchStartIds.length; branchOrdinal += 1) {
    const branchStartId = branchStartIds[branchOrdinal]!
    const startNode = nodeMap.get(branchStartId)
    if (startNode === undefined) {
      return unsupported(branchStartId, 'branch reaches a missing node')
    }
    const startOutgoing = edges.filter(edge => edge.sourceNodeId === branchStartId)
    const conditionalEdges = startOutgoing.filter(edge => edge.type === 'conditional')

    if (conditionalEdges.length > 0) {
      if (conditionalBranchOrdinal !== undefined) {
        return unsupported(branchStartId, 'more than one recursive conditional branch')
      }
      if (
        startNode.type !== 'gate' ||
        startNode.gateType === 'approval' ||
        startOutgoing.length !== 1 ||
        conditionalEdges.length !== 1
      ) {
        return unsupported(branchStartId, 'conditional branch entry is not one ordinary gate')
      }
      const conditional = conditionalEdges[0]!
      const branchKeys = Object.keys(conditional.branches).sort()
      if (
        branchKeys.length !== 2 ||
        branchKeys[0] !== 'false' ||
        branchKeys[1] !== 'true'
      ) {
        return unsupported(branchStartId, 'conditional branch must have exact true and false arms')
      }
      const armStartIds = [conditional.branches.true, conditional.branches.false]
      if (
        armStartIds.some(nodeId => nodeId === undefined || nodeId === owningJoinNodeId) ||
        new Set(armStartIds).size !== 2
      ) {
        return unsupported(branchStartId, 'conditional branch arms are empty or duplicate')
      }

      const gateOwnership = claimNode(branchStartId, branchStartId, [forkNodeId])
      if (gateOwnership !== undefined) return gateOwnership
      const inventory = [branchStartId]
      const exits: string[] = []
      for (const armStartId of armStartIds as string[]) {
        const visited = new Set<string>([branchStartId])
        let predecessorId = branchStartId
        let currentId = armStartId
        while (currentId !== owningJoinNodeId) {
          const inspected = inspectLeaf(
            currentId,
            branchStartId,
            predecessorId,
            visited,
            inventory,
          )
          if ('kind' in inspected) return inspected
          predecessorId = currentId
          currentId = inspected.nextId
        }
        exits.push(predecessorId)
        branchEndIds.add(predecessorId)
      }
      conditionalBranchOrdinal = branchOrdinal
      branches.push({
        branchOrdinal,
        branchStartNodeId: branchStartId,
        nodeIds: inventory,
        normalExitNodeIds: exits,
        conditionalGateNodeId: branchStartId,
      })
      continue
    }

    const visited = new Set<string>()
    const inventory: string[] = []
    let predecessorId = forkNodeId
    let currentId = branchStartId
    while (currentId !== owningJoinNodeId) {
      const inspected = inspectLeaf(
        currentId,
        branchStartId,
        predecessorId,
        visited,
        inventory,
      )
      if ('kind' in inspected) return inspected
      predecessorId = currentId
      currentId = inspected.nextId
    }
    branchEndIds.add(predecessorId)
    branches.push({
      branchOrdinal,
      branchStartNodeId: branchStartId,
      nodeIds: inventory,
      normalExitNodeIds: [predecessorId],
    })
  }

  for (const [nodeId, predecessors] of expectedPredecessors) {
    const incoming = edges.filter(edge => projectValidationEdgeTargets(edge).includes(nodeId))
    const actual = new Set(incoming.map(edge => edge.sourceNodeId))
    if (
      incoming.length !== predecessors.size ||
      actual.size !== predecessors.size ||
      [...predecessors].some(predecessor => !actual.has(predecessor))
    ) {
      return unsupported(nodeId, 'branch has an external or ambiguous predecessor')
    }
  }

  const joinIncoming = edges.filter(edge => projectValidationEdgeTargets(edge).includes(owningJoinNodeId))
  if (
    joinIncoming.length !== branchEndIds.size ||
    joinIncoming.some(
      edge => edge.type !== 'sequential' || !branchEndIds.has(edge.sourceNodeId),
    )
  ) {
    return unsupported(owningJoinNodeId, 'join has an external or ambiguous predecessor')
  }

  return conditionalBranchOrdinal === undefined
    ? { kind: 'flat' }
    : {
        kind: 'recursive-conditional',
        graph: {
          forkNodeId,
          joinNodeId: owningJoinNodeId,
          branches,
          conditionalBranchOrdinal,
        },
      }
}

export function findUnsupportedForkBranchShape(
  forkNodeId: string,
  owningJoinNodeId: string,
  nodeMap: ReadonlyMap<string, PipelineNode>,
  edges: readonly PipelineEdge[],
): { nodeId: string; kind: string } | undefined {
  const inspection = inspectForkBranchShape(
    forkNodeId,
    owningJoinNodeId,
    nodeMap,
    edges,
  )
  return inspection.kind === 'unsupported'
    ? { nodeId: inspection.nodeId, kind: inspection.reason }
    : undefined
}

export function findAdmittedRecursiveForkGraph(
  forkNodeId: string,
  owningJoinNodeId: string,
  nodeMap: ReadonlyMap<string, PipelineNode>,
  edges: readonly PipelineEdge[],
): AdmittedRecursiveForkGraph | undefined {
  const inspection = inspectForkBranchShape(
    forkNodeId,
    owningJoinNodeId,
    nodeMap,
    edges,
  )
  return inspection.kind === 'recursive-conditional' ? inspection.graph : undefined
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
