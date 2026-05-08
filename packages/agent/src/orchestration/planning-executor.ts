/**
 * Planning executor — runs an ExecutionPlan in topological order through a
 * DelegatingSupervisor, propagating predecessor results and skipping
 * downstream nodes when an ancestor fails.
 */

import type { DelegationResult } from './delegation.js'
import type { TaskAssignment } from './delegating-supervisor-types.js'
import { OrchestrationError } from './orchestration-error.js'
import { validatePlanStructure } from './planning-graph.js'
import type {
  ExecutionPlan,
  PlanExecutionResult,
  PlanNode,
  PlanningSupervisor,
} from './planning-types.js'

export interface PlanExecutorOptions {
  /** Maximum parallel delegations per level (default: 5) */
  maxParallelism?: number
}

/**
 * Execute a pre-built plan in topological order.
 *
 * Each execution level runs in parallel (up to maxParallelism).
 * Results from completed nodes are passed as `_predecessorResults`
 * in the input of dependent nodes.
 */
export async function executePlanWithSupervisor(
  supervisor: PlanningSupervisor,
  plan: ExecutionPlan,
  options: PlanExecutorOptions = {},
): Promise<PlanExecutionResult> {
  const start = Date.now()
  const maxParallelism = options.maxParallelism ?? 5

  // Validate
  const validationErrors = validatePlanStructure(plan, supervisor.specialistIds)
  if (validationErrors.length > 0) {
    throw new OrchestrationError(
      `Invalid plan: ${validationErrors.join('; ')}`,
      'delegation',
      { validationErrors },
    )
  }

  const nodeMap = new Map(plan.nodes.map((n) => [n.id, n]))
  const results = new Map<string, DelegationResult>()
  const failedNodes: string[] = []
  const skippedNodes: string[] = []
  /** Set of node IDs whose descendants should be skipped */
  const failedAncestors = new Set<string>()

  for (const level of plan.executionLevels) {
    const runnableIds = partitionRunnable(
      level,
      nodeMap,
      failedAncestors,
      results,
      skippedNodes,
    )

    // Execute runnable nodes in chunks of maxParallelism
    for (let i = 0; i < runnableIds.length; i += maxParallelism) {
      const chunk = runnableIds.slice(i, i + maxParallelism)
      const assignments = buildAssignments(chunk, nodeMap, results)
      const aggregated = await supervisor.delegateAndCollect(assignments)

      collectChunkResults(
        chunk,
        nodeMap,
        aggregated.results,
        results,
        failedNodes,
        failedAncestors,
      )
    }
  }

  return {
    plan,
    results,
    success: failedNodes.length === 0 && skippedNodes.length === 0,
    totalDurationMs: Date.now() - start,
    failedNodes,
    skippedNodes,
  }
}

/**
 * Partition the IDs in a level into runnable nodes; mark and record
 * skipped nodes whose dependencies have already failed.
 */
function partitionRunnable(
  level: string[],
  nodeMap: Map<string, PlanNode>,
  failedAncestors: Set<string>,
  results: Map<string, DelegationResult>,
  skippedNodes: string[],
): string[] {
  const runnableIds: string[] = []
  for (const nodeId of level) {
    const node = nodeMap.get(nodeId)!
    const hasFailedDep = node.dependsOn.some((dep) => failedAncestors.has(dep))
    if (hasFailedDep) {
      skippedNodes.push(nodeId)
      failedAncestors.add(nodeId) // propagate skip to downstream
      results.set(nodeId, {
        success: false,
        output: null,
        error: 'Skipped: upstream dependency failed',
      })
    } else {
      runnableIds.push(nodeId)
    }
  }
  return runnableIds
}

/**
 * Build TaskAssignments for a chunk of runnable node IDs, injecting predecessor
 * outputs as `_predecessorResults` on each assignment input.
 */
function buildAssignments(
  chunk: string[],
  nodeMap: Map<string, PlanNode>,
  results: Map<string, DelegationResult>,
): TaskAssignment[] {
  return chunk.map((nodeId) => {
    const node = nodeMap.get(nodeId)!
    const predecessorResults: Record<string, unknown> = {}
    for (const depId of node.dependsOn) {
      const depResult = results.get(depId)
      if (depResult) {
        predecessorResults[depId] = depResult.output
      }
    }
    return {
      id: nodeId,
      task: node.task,
      specialistId: node.specialistId,
      input: {
        ...node.input,
        _predecessorResults: predecessorResults,
        _nodeId: nodeId,
      },
    }
  })
}

/**
 * Apply aggregated supervisor results back onto the plan's results map and
 * record any failures for downstream skip propagation.
 */
function collectChunkResults(
  chunk: string[],
  nodeMap: Map<string, PlanNode>,
  aggregated: Map<string, DelegationResult>,
  results: Map<string, DelegationResult>,
  failedNodes: string[],
  failedAncestors: Set<string>,
): void {
  for (let j = 0; j < chunk.length; j++) {
    const nodeId = chunk[j]!
    const node = nodeMap.get(nodeId)!
    const result = aggregated.get(nodeId) ?? aggregated.get(node.specialistId)

    if (result) {
      results.set(nodeId, result)
      if (!result.success) {
        failedNodes.push(nodeId)
        failedAncestors.add(nodeId)
      }
    } else {
      // Should not happen, but handle defensively
      const fallbackResult: DelegationResult = {
        success: false,
        output: null,
        error: 'No result returned from delegation',
      }
      results.set(nodeId, fallbackResult)
      failedNodes.push(nodeId)
      failedAncestors.add(nodeId)
    }
  }
}
