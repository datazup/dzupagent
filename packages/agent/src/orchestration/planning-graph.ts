/**
 * Planning graph utilities — topological sort and structural validation
 * for PlanningAgent execution plans.
 */

import type { ExecutionPlan, PlanNode } from './planning-types.js'
import { OrchestrationError } from './orchestration-error.js'

// ---------------------------------------------------------------------------
// Utility: topological sort into parallel levels
// ---------------------------------------------------------------------------

/**
 * Build execution levels from a set of plan nodes using Kahn's algorithm.
 *
 * Each level contains node IDs whose dependencies are all satisfied by
 * earlier levels. Nodes within a level can execute in parallel.
 *
 * Throws if the graph contains a cycle.
 */
export function buildExecutionLevels(nodes: PlanNode[]): string[][] {
  const nodeMap = new Map<string, PlanNode>()
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const node of nodes) {
    nodeMap.set(node.id, node)
    inDegree.set(node.id, 0)
    dependents.set(node.id, [])
  }

  // Build in-degree counts and reverse adjacency list
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!nodeMap.has(dep)) {
        // Ignore deps on nodes not in the plan — validated separately
        continue
      }
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1)
      dependents.get(dep)!.push(node.id)
    }
  }

  const levels: string[][] = []
  let queue = [...nodeMap.keys()].filter((id) => inDegree.get(id) === 0)
  let processed = 0

  while (queue.length > 0) {
    levels.push([...queue])
    processed += queue.length

    const nextQueue: string[] = []
    for (const nodeId of queue) {
      for (const dep of dependents.get(nodeId) ?? []) {
        const newDeg = (inDegree.get(dep) ?? 1) - 1
        inDegree.set(dep, newDeg)
        if (newDeg === 0) {
          nextQueue.push(dep)
        }
      }
    }
    queue = nextQueue
  }

  if (processed < nodes.length) {
    const remaining = [...nodeMap.keys()].filter(
      (id) => (inDegree.get(id) ?? 0) > 0,
    )
    throw new OrchestrationError(
      `Cycle detected in plan DAG. Nodes involved: ${remaining.join(', ')}`,
      'delegation',
      { cycleNodes: remaining },
    )
  }

  return levels
}

// ---------------------------------------------------------------------------
// Utility: plan validation
// ---------------------------------------------------------------------------

/**
 * Validate an execution plan. Returns an array of error strings.
 * An empty array means the plan is valid.
 */
export function validatePlanStructure(
  plan: ExecutionPlan,
  availableSpecialists?: string[],
): string[] {
  const errors: string[] = []
  const nodeIds = new Set(plan.nodes.map((n) => n.id))

  // Check for duplicate IDs
  if (nodeIds.size !== plan.nodes.length) {
    const seen = new Set<string>()
    for (const node of plan.nodes) {
      if (seen.has(node.id)) {
        errors.push(`Duplicate node ID: "${node.id}"`)
      }
      seen.add(node.id)
    }
  }

  // Check for missing dependencies
  for (const node of plan.nodes) {
    for (const dep of node.dependsOn) {
      if (!nodeIds.has(dep)) {
        errors.push(
          `Node "${node.id}" depends on unknown node "${dep}"`,
        )
      }
    }
  }

  // Check for self-dependencies
  for (const node of plan.nodes) {
    if (node.dependsOn.includes(node.id)) {
      errors.push(`Node "${node.id}" depends on itself`)
    }
  }

  // Check for unknown specialists
  if (availableSpecialists) {
    const specialistSet = new Set(availableSpecialists)
    for (const node of plan.nodes) {
      if (!specialistSet.has(node.specialistId)) {
        errors.push(
          `Node "${node.id}" references unknown specialist "${node.specialistId}". Available: ${availableSpecialists.join(', ')}`,
        )
      }
    }
  }

  // Check for cycles (use buildExecutionLevels which throws on cycle)
  if (errors.length === 0) {
    try {
      buildExecutionLevels(plan.nodes)
    } catch (err: unknown) {
      if (err instanceof OrchestrationError) {
        errors.push(err.message)
      }
    }
  }

  // Validate executionLevels matches computed levels if provided
  if (plan.executionLevels.length > 0 && errors.length === 0) {
    const allLevelNodeIds = new Set(plan.executionLevels.flat())
    for (const id of nodeIds) {
      if (!allLevelNodeIds.has(id)) {
        errors.push(
          `Node "${id}" is not present in executionLevels`,
        )
      }
    }
  }

  return errors
}
