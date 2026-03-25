/**
 * Pipeline definition validator — validates structural integrity
 * of a PipelineDefinition before execution.
 *
 * @module pipeline/pipeline-validator
 */

import type {
  PipelineDefinition,
  PipelineValidationResult,
  PipelineValidationError,
  PipelineValidationWarning,
  PipelineNode,
  PipelineEdge,
} from '@forgeagent/core'

/**
 * Validate a pipeline definition for structural correctness.
 *
 * Returns errors (prevent execution) and warnings (non-blocking hints).
 */
export function validatePipeline(definition: PipelineDefinition): PipelineValidationResult {
  const errors: PipelineValidationError[] = []
  const warnings: PipelineValidationWarning[] = []

  const nodeMap = new Map<string, PipelineNode>()

  // --- Duplicate node IDs ---
  const seenIds = new Set<string>()
  for (const node of definition.nodes) {
    if (seenIds.has(node.id)) {
      errors.push({
        code: 'DUPLICATE_NODE_ID',
        message: `Duplicate node ID: "${node.id}"`,
        nodeId: node.id,
      })
    } else {
      seenIds.add(node.id)
      nodeMap.set(node.id, node)
    }
  }

  // --- Missing entry node ---
  if (!nodeMap.has(definition.entryNodeId)) {
    errors.push({
      code: 'MISSING_ENTRY_NODE',
      message: `Entry node "${definition.entryNodeId}" not found in nodes`,
    })
  }

  // --- Dangling edges ---
  for (let i = 0; i < definition.edges.length; i++) {
    const edge = definition.edges[i]!
    const sourceExists = nodeMap.has(edge.sourceNodeId)
    if (!sourceExists) {
      errors.push({
        code: 'DANGLING_EDGE',
        message: `Edge ${i} references nonexistent source node "${edge.sourceNodeId}"`,
        edgeIndex: i,
      })
    }

    const targetIds = getEdgeTargets(edge)
    for (const targetId of targetIds) {
      if (!nodeMap.has(targetId)) {
        errors.push({
          code: 'DANGLING_EDGE',
          message: `Edge ${i} references nonexistent target node "${targetId}"`,
          edgeIndex: i,
        })
      }
    }
  }

  // --- Build adjacency for cycle detection and reachability ---
  const adjacency = new Map<string, Set<string>>()
  const connectedNodes = new Set<string>()

  for (const node of definition.nodes) {
    adjacency.set(node.id, new Set())
  }

  for (const edge of definition.edges) {
    const targets = getEdgeTargets(edge)
    const neighbors = adjacency.get(edge.sourceNodeId)
    if (neighbors) {
      for (const t of targets) {
        if (nodeMap.has(t)) {
          neighbors.add(t)
          connectedNodes.add(edge.sourceNodeId)
          connectedNodes.add(t)
        }
      }
    }
  }

  // --- Collect loop body node IDs (cycles within loop bodies are expected) ---
  const loopBodyNodeIds = new Set<string>()
  for (const node of definition.nodes) {
    if (node.type === 'loop') {
      for (const bodyId of node.bodyNodeIds) {
        loopBodyNodeIds.add(bodyId)
      }
      // The loop node itself is part of its own cycle structure
      loopBodyNodeIds.add(node.id)
    }
  }

  // --- Cycle detection (DFS coloring) ---
  detectCycles(adjacency, loopBodyNodeIds, errors)

  // --- Unbalanced fork/join ---
  const forkNodes = definition.nodes.filter((n): n is Extract<PipelineNode, { type: 'fork' }> => n.type === 'fork')
  const joinNodes = definition.nodes.filter((n): n is Extract<PipelineNode, { type: 'join' }> => n.type === 'join')

  const joinForkIds = new Set(joinNodes.map(j => j.forkId))
  for (const fork of forkNodes) {
    if (!joinForkIds.has(fork.forkId)) {
      errors.push({
        code: 'UNBALANCED_FORK_JOIN',
        message: `ForkNode "${fork.id}" with forkId "${fork.forkId}" has no matching JoinNode`,
        nodeId: fork.id,
      })
    }
  }

  const forkForkIds = new Set(forkNodes.map(f => f.forkId))
  for (const join of joinNodes) {
    if (!forkForkIds.has(join.forkId)) {
      errors.push({
        code: 'UNBALANCED_FORK_JOIN',
        message: `JoinNode "${join.id}" with forkId "${join.forkId}" has no matching ForkNode`,
        nodeId: join.id,
      })
    }
  }

  // --- Invalid loop body ---
  for (const node of definition.nodes) {
    if (node.type === 'loop') {
      for (const bodyId of node.bodyNodeIds) {
        if (!nodeMap.has(bodyId)) {
          errors.push({
            code: 'INVALID_LOOP_BODY',
            message: `LoopNode "${node.id}" references nonexistent body node "${bodyId}"`,
            nodeId: node.id,
          })
        }
      }
    }
  }

  // --- Orphan nodes (no edges, except entry) ---
  for (const node of definition.nodes) {
    if (node.id === definition.entryNodeId) continue
    if (!connectedNodes.has(node.id)) {
      // Check if node is referenced in a loop body
      let inLoopBody = false
      for (const n of definition.nodes) {
        if (n.type === 'loop' && n.bodyNodeIds.includes(node.id)) {
          inLoopBody = true
          break
        }
      }
      if (!inLoopBody) {
        warnings.push({
          code: 'UNREACHABLE_NODE',
          message: `Node "${node.id}" is not connected by any edge and is not reachable`,
          nodeId: node.id,
        })
      }
    }
  }

  // --- Unreachable nodes (BFS from entry) ---
  if (nodeMap.has(definition.entryNodeId)) {
    const reachable = bfsReachable(definition.entryNodeId, adjacency)
    // Also consider loop body nodes reachable if their loop node is reachable
    for (const node of definition.nodes) {
      if (node.type === 'loop' && reachable.has(node.id)) {
        for (const bodyId of node.bodyNodeIds) {
          reachable.add(bodyId)
        }
      }
    }
    for (const node of definition.nodes) {
      if (!reachable.has(node.id)) {
        // Only add if not already reported as orphan
        const alreadyReported = warnings.some(
          w => w.code === 'UNREACHABLE_NODE' && w.nodeId === node.id,
        )
        if (!alreadyReported) {
          warnings.push({
            code: 'UNREACHABLE_NODE',
            message: `Node "${node.id}" is not reachable from entry node "${definition.entryNodeId}"`,
            nodeId: node.id,
          })
        }
      }
    }
  }

  // --- No error handlers ---
  const hasErrorEdge = definition.edges.some(e => e.type === 'error')
  if (!hasErrorEdge) {
    warnings.push({
      code: 'NO_ERROR_HANDLERS',
      message: 'Pipeline has no error edges — failures will be unhandled',
    })
  }

  // --- High maxIterations ---
  for (const node of definition.nodes) {
    if (node.type === 'loop' && node.maxIterations > 100) {
      warnings.push({
        code: 'HIGH_MAX_ITERATIONS',
        message: `LoopNode "${node.id}" has maxIterations=${node.maxIterations} (> 100)`,
        nodeId: node.id,
      })
    }
  }

  // --- Missing timeouts ---
  for (const node of definition.nodes) {
    if (node.timeoutMs === undefined) {
      warnings.push({
        code: 'MISSING_TIMEOUT',
        message: `Node "${node.id}" has no timeoutMs configured`,
        nodeId: node.id,
      })
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEdgeTargets(edge: PipelineEdge): string[] {
  switch (edge.type) {
    case 'sequential':
    case 'error':
      return [edge.targetNodeId]
    case 'conditional':
      return Object.values(edge.branches)
  }
}

function bfsReachable(startId: string, adjacency: Map<string, Set<string>>): Set<string> {
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
function detectCycles(
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
