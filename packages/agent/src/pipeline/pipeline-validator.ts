/**
 * Pipeline definition validator — validates structural integrity
 * of a PipelineDefinition before execution.
 *
 * @module pipeline/pipeline-validator
 */

import type { PipelineDefinition, PipelineValidationResult, PipelineValidationError, PipelineValidationWarning, PipelineNode, PipelineEdge } from '@dzupagent/core/pipeline'
import { validatePipelineInteractionSpecV1 } from '@dzupagent/runtime-contracts'

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

  // --- Checkpoint-bound interaction protocol ---
  for (const node of definition.nodes) {
    if (
      (node.type !== 'gate' && node.type !== 'suspend') ||
      node.interaction === undefined
    ) {
      continue
    }
    if (definition.schemaVersion !== '1.1.0') {
      errors.push({
        code: 'INVALID_INTERACTION_SPEC',
        message: `Interaction node "${node.id}" requires pipeline schemaVersion 1.1.0`,
        nodeId: node.id,
      })
    }
    const validated = validatePipelineInteractionSpecV1(node.interaction)
    if (!validated.valid) {
      errors.push({
        code: 'INVALID_INTERACTION_SPEC',
        message: `Interaction node "${node.id}" is invalid: ${validated.issues
          .map(issue => `${issue.path}: ${issue.message}`)
          .join('; ')}`,
        nodeId: node.id,
      })
      continue
    }
    if (node.type === 'gate') {
      if (node.gateType !== 'approval' || node.interaction.kind !== 'approval') {
        errors.push({
          code: 'INVALID_INTERACTION_SPEC',
          message: `Interaction gate "${node.id}" must be an approval gate with an approval specification`,
          nodeId: node.id,
        })
        continue
      }
      const decisionEdges = definition.edges.filter(
        (edge): edge is Extract<PipelineEdge, { type: 'conditional' }> =>
          edge.type === 'conditional' && edge.sourceNodeId === node.id,
      )
      const decisionEdge = decisionEdges[0]
      if (
        decisionEdges.length !== 1 ||
        decisionEdge === undefined ||
        Object.keys(decisionEdge.branches).length !== 2 ||
        decisionEdge.branches.approved !==
          node.interaction.outcomeToSuccessor.approved ||
        decisionEdge.branches.rejected !==
          node.interaction.outcomeToSuccessor.rejected
      ) {
        errors.push({
          code: 'INVALID_INTERACTION_ROUTING',
          message: `Approval interaction "${node.id}" must have one exact approved/rejected conditional edge`,
          nodeId: node.id,
        })
      }
    } else if (node.interaction.kind !== 'clarification') {
      errors.push({
        code: 'INVALID_INTERACTION_SPEC',
        message: `Suspend interaction "${node.id}" must carry a clarification specification`,
        nodeId: node.id,
      })
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
      const bodyIds = new Set(node.bodyNodeIds)
      const interactionBodyIds = node.bodyNodeIds.filter(bodyId => {
        const bodyNode = nodeMap.get(bodyId)
        return (
          (bodyNode?.type === 'suspend' || bodyNode?.type === 'gate') &&
          bodyNode.interaction !== undefined
        )
      })
      for (const bodyId of node.bodyNodeIds) {
        if (!nodeMap.has(bodyId)) {
          errors.push({
            code: 'INVALID_LOOP_BODY',
            message: `LoopNode "${node.id}" references nonexistent body node "${bodyId}"`,
            nodeId: node.id,
          })
        }
      }
      if (node.bodyGraph !== undefined) {
        const exitInventories = [
          ['normal', node.bodyGraph.normalExitNodeIds],
          ['suspended', node.bodyGraph.suspendedExitNodeIds],
          ['terminal', node.bodyGraph.terminalExitNodeIds],
          ['error', node.bodyGraph.errorExitNodeIds],
        ] as const
        const suspensionSites = node.bodyGraph.suspensionSiteNodeIds ?? []
        if (
          new Set(suspensionSites).size !== suspensionSites.length ||
          interactionBodyIds.some(siteId => !suspensionSites.includes(siteId))
        ) {
          errors.push({
            code: 'INVALID_LOOP_BODY_GRAPH',
            message: `LoopNode "${node.id}" must inventory every interaction body node exactly once in suspensionSiteNodeIds`,
            nodeId: node.id,
          })
        }
        const classifiedExitIds = new Map<string, string>()
        for (const [kind, exitIds] of exitInventories) {
          for (const exitId of exitIds) {
            const previousKind = classifiedExitIds.get(exitId)
            if (previousKind !== undefined) {
              errors.push({
                code: 'INVALID_LOOP_BODY_GRAPH',
                message: `LoopNode "${node.id}" bodyGraph exit "${exitId}" is classified as both ${previousKind} and ${kind}`,
                nodeId: node.id,
              })
            } else if (previousKind === undefined) {
              classifiedExitIds.set(exitId, kind)
            }
          }
        }
        for (const exitId of node.bodyGraph.suspendedExitNodeIds) {
          const exitNode = nodeMap.get(exitId)
          if (
            exitNode !== undefined &&
            exitNode.type !== 'suspend' &&
            !(exitNode.type === 'gate' && exitNode.gateType === 'approval')
          ) {
            errors.push({
              code: 'INVALID_LOOP_BODY_GRAPH',
              message: `LoopNode "${node.id}" bodyGraph suspended exit "${exitId}" is not suspend-capable`,
              nodeId: node.id,
            })
          }
          const bodyContinuationEdges = definition.edges.filter(
            edge =>
              edge.type !== 'error' &&
              edge.sourceNodeId === exitId &&
              getEdgeTargets(edge).some(targetId => bodyIds.has(targetId)),
          )
          if (bodyContinuationEdges.length === 0) {
            errors.push({
              code: 'INVALID_LOOP_BODY_GRAPH',
              message: `LoopNode "${node.id}" bodyGraph suspended exit "${exitId}" has no resumable body continuation`,
              nodeId: node.id,
            })
          } else if (bodyContinuationEdges.length !== 1) {
            errors.push({
              code: 'INVALID_LOOP_BODY_GRAPH',
              message: `LoopNode "${node.id}" bodyGraph suspended exit "${exitId}" has multiple body continuations`,
              nodeId: node.id,
            })
          }
        }
        for (const siteId of suspensionSites) {
          const siteNode = nodeMap.get(siteId)
          if (
            siteNode === undefined ||
            !bodyIds.has(siteId) ||
            !(
              (siteNode.type === 'suspend' && siteNode.interaction !== undefined) ||
              (siteNode.type === 'gate' &&
                siteNode.gateType === 'approval' &&
                siteNode.interaction !== undefined)
            )
          ) {
            errors.push({
              code: 'INVALID_LOOP_BODY_GRAPH',
              message: `LoopNode "${node.id}" suspension site "${siteId}" is not an interaction-capable body node`,
              nodeId: node.id,
            })
          }
        }
        for (const exitId of node.bodyGraph.terminalExitNodeIds) {
          const exitNode = nodeMap.get(exitId)
          if (exitNode !== undefined && exitNode.type !== 'suspend') {
            errors.push({
              code: 'INVALID_LOOP_BODY_GRAPH',
              message: `LoopNode "${node.id}" bodyGraph terminal exit "${exitId}" is not a suspend node`,
              nodeId: node.id,
            })
          }
          const hasBodyContinuation = definition.edges.some(
            edge =>
              edge.type !== 'error' &&
              edge.sourceNodeId === exitId &&
              getEdgeTargets(edge).some(targetId => bodyIds.has(targetId)),
          )
          if (hasBodyContinuation) {
            errors.push({
              code: 'INVALID_LOOP_BODY_GRAPH',
              message: `LoopNode "${node.id}" bodyGraph terminal exit "${exitId}" has an outgoing body continuation`,
              nodeId: node.id,
            })
          }
        }
        const boundaryIds = [
          node.bodyGraph.entryNodeId,
          ...node.bodyGraph.normalExitNodeIds,
          ...node.bodyGraph.suspendedExitNodeIds,
          ...suspensionSites,
          ...node.bodyGraph.terminalExitNodeIds,
          ...node.bodyGraph.errorExitNodeIds,
        ]
        for (const boundaryId of boundaryIds) {
          if (!bodyIds.has(boundaryId)) {
            errors.push({
              code: 'INVALID_LOOP_BODY_GRAPH',
              message: `LoopNode "${node.id}" bodyGraph references node "${boundaryId}" outside bodyNodeIds`,
              nodeId: node.id,
            })
          }
        }
        for (const edge of definition.edges) {
          if (!bodyIds.has(edge.sourceNodeId)) continue
          for (const targetId of getEdgeTargets(edge)) {
            if (bodyIds.has(targetId)) continue
            errors.push({
              code: 'INVALID_LOOP_BODY_GRAPH',
              message: `LoopNode "${node.id}" body edge escapes to node "${targetId}" outside bodyNodeIds`,
              nodeId: node.id,
            })
          }
        }
      } else if (interactionBodyIds.length > 0) {
        errors.push({
          code: 'INVALID_LOOP_BODY_GRAPH',
          message: `LoopNode "${node.id}" cannot contain interaction nodes without a checkpoint-bound bodyGraph`,
          nodeId: node.id,
        })
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
