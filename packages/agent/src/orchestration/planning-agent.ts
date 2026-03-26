/**
 * PlanningAgent — decomposes complex goals into a dependency DAG
 * and executes tasks in topological order via DelegatingSupervisor.
 *
 * Supports both programmatic plan construction via `PlanningAgent.buildPlan()`
 * and LLM-powered decomposition via `decompose()`.
 *
 * Depends ONLY on sibling orchestration types + @forgeagent/core.
 */

import { z } from 'zod'
import type { DelegationResult } from './delegation.js'
import type { DelegatingSupervisor, TaskAssignment } from './delegating-supervisor.js'
import type { StructuredLLM } from '../structured/structured-output-engine.js'
import { generateStructured } from '../structured/structured-output-engine.js'
import { OrchestrationError } from './orchestration-error.js'

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

/** A single node in an execution plan DAG. */
export interface PlanNode {
  /** Unique identifier for this node */
  id: string
  /** Human-readable task description */
  task: string
  /** ID of the specialist agent to delegate to */
  specialistId: string
  /** Structured input for the specialist */
  input: Record<string, unknown>
  /** IDs of nodes that must complete before this one can start */
  dependsOn: string[]
}

/** A complete execution plan: a set of nodes forming a DAG. */
export interface ExecutionPlan {
  /** High-level goal this plan achieves */
  goal: string
  /** All nodes in the plan */
  nodes: PlanNode[]
  /** Execution order: groups of node IDs that can run in parallel */
  executionLevels: string[][]
}

/** Result of executing an entire plan. */
export interface PlanExecutionResult {
  /** The plan that was executed */
  plan: ExecutionPlan
  /** Results keyed by node ID */
  results: Map<string, DelegationResult>
  /** Whether all nodes succeeded */
  success: boolean
  /** Total wall-clock time (ms) */
  totalDurationMs: number
  /** IDs of nodes that failed (does not include skipped nodes) */
  failedNodes: string[]
  /** IDs of nodes that were skipped due to failed dependencies */
  skippedNodes: string[]
}

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

// ---------------------------------------------------------------------------
// PlanningAgent
// ---------------------------------------------------------------------------

/** Configuration for PlanningAgent. */
export interface PlanningAgentConfig {
  /** The supervisor to delegate tasks through */
  supervisor: DelegatingSupervisor
  /** Maximum parallel delegations per level (default: 5) */
  maxParallelism?: number
}

// ---------------------------------------------------------------------------
// Zod schemas for LLM-powered plan decomposition
// ---------------------------------------------------------------------------

/** Zod schema for a single node in an LLM-generated plan. */
export const PlanNodeSchema = z.object({
  id: z.string().describe('Unique node identifier like "node-1"'),
  task: z.string().describe('Clear description of what this node does'),
  specialistId: z.string().describe('ID of the specialist agent to execute this'),
  dependsOn: z.array(z.string()).default([]).describe('IDs of nodes that must complete first'),
})

/** Zod schema for a complete LLM-generated decomposition. */
export const DecompositionSchema = z.object({
  nodes: z.array(PlanNodeSchema).min(1).describe('Task nodes forming a DAG'),
})

/** Inferred type for a decomposition result from the LLM. */
export type DecompositionResult = z.infer<typeof DecompositionSchema>

/** Options for the LLM-powered decompose method. */
export interface DecomposeOptions {
  /** Maximum number of nodes the LLM may produce (default: 20) */
  maxNodes?: number
  /** Abort signal for cancellation */
  signal?: AbortSignal
}

/**
 * Executes pre-built execution plans in topological order.
 *
 * For each execution level, delegates all tasks in that level through the
 * supervisor. Results from earlier levels are injected as context into
 * dependent nodes. If a node fails, all downstream dependents are skipped.
 */
export class PlanningAgent {
  private readonly supervisor: DelegatingSupervisor
  private readonly maxParallelism: number

  constructor(config: PlanningAgentConfig) {
    this.supervisor = config.supervisor
    this.maxParallelism = config.maxParallelism ?? 5
  }

  /**
   * Execute a pre-built plan in topological order.
   *
   * Each execution level runs in parallel (up to maxParallelism).
   * Results from completed nodes are passed as `_predecessorResults`
   * in the input of dependent nodes.
   */
  async executePlan(plan: ExecutionPlan): Promise<PlanExecutionResult> {
    const start = Date.now()

    // Validate
    const validationErrors = validatePlanStructure(
      plan,
      this.supervisor.specialistIds,
    )
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
      // Partition nodes into runnable vs skipped
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

      // Execute runnable nodes in chunks of maxParallelism
      for (let i = 0; i < runnableIds.length; i += this.maxParallelism) {
        const chunk = runnableIds.slice(i, i + this.maxParallelism)

        const assignments: TaskAssignment[] = chunk.map((nodeId) => {
          const node = nodeMap.get(nodeId)!

          // Build predecessor results context
          const predecessorResults: Record<string, unknown> = {}
          for (const depId of node.dependsOn) {
            const depResult = results.get(depId)
            if (depResult) {
              predecessorResults[depId] = depResult.output
            }
          }

          return {
            task: node.task,
            specialistId: node.specialistId,
            input: {
              ...node.input,
              _predecessorResults: predecessorResults,
              _nodeId: nodeId,
            },
          }
        })

        const aggregated = await this.supervisor.delegateAndCollect(assignments)

        // Map results back by node ID (assignments and chunk share indices)
        for (let j = 0; j < chunk.length; j++) {
          const nodeId = chunk[j]!
          const node = nodeMap.get(nodeId)!
          const result = aggregated.results.get(node.specialistId)

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
   * LLM-powered goal decomposition into an ExecutionPlan.
   *
   * Sends the goal and available specialist descriptions to the LLM,
   * asks it to decompose into a DAG of tasks, validates the output,
   * and returns an ExecutionPlan ready for `executePlan()`.
   *
   * @param goal - High-level goal description.
   * @param llm - LLM instance matching the StructuredLLM interface.
   * @param options - Optional configuration (maxNodes, signal).
   * @returns A validated ExecutionPlan.
   */
  async decompose(
    goal: string,
    llm: StructuredLLM,
    options?: DecomposeOptions,
  ): Promise<ExecutionPlan> {
    const maxNodes = options?.maxNodes ?? 20
    const specialistIds = this.supervisor.specialistIds
    const specialistDescriptions = this.buildSpecialistDescriptions()

    const systemPrompt = [
      'You are a task planner. Decompose the following goal into discrete tasks that can be assigned to specialist agents.',
      '',
      'Available specialists:',
      specialistDescriptions,
      '',
      'Rules:',
      '- Each task must map to exactly one specialist by specialistId',
      '- Use dependsOn to express ordering constraints (list of node IDs)',
      '- Minimize dependencies to maximize parallelism',
      '- Keep tasks focused and atomic',
      `- Produce at most ${maxNodes} nodes`,
      '- Use IDs like "node-0", "node-1", etc.',
    ].join('\n')

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: `Goal: ${goal}` },
    ]

    const result = await generateStructured(llm, messages, {
      schema: DecompositionSchema,
      maxRetries: 2,
      schemaName: 'DecompositionPlan',
      schemaDescription: 'A directed acyclic graph of tasks assigned to specialist agents',
    })

    // Validate and sanitize specialist IDs — filter out nodes with unknown specialists
    const validSpecialistSet = new Set(specialistIds)
    const validNodes: PlanNode[] = []
    const removedNodeIds = new Set<string>()

    for (const node of result.data.nodes.slice(0, maxNodes)) {
      if (validSpecialistSet.has(node.specialistId)) {
        validNodes.push({
          id: node.id,
          task: node.task,
          specialistId: node.specialistId,
          input: { task: node.task },
          dependsOn: node.dependsOn,
        })
      } else {
        removedNodeIds.add(node.id)
      }
    }

    if (validNodes.length === 0) {
      throw new OrchestrationError(
        `LLM decomposition produced no valid nodes. All specialist IDs were unrecognized. Available: ${specialistIds.join(', ')}`,
        'delegation',
        { goal, availableSpecialists: specialistIds },
      )
    }

    // Remove dangling dependency references to removed nodes
    for (const node of validNodes) {
      node.dependsOn = node.dependsOn.filter(
        (dep) => !removedNodeIds.has(dep) && validNodes.some((n) => n.id === dep),
      )
    }

    // Validate DAG (throws on cycles)
    const executionLevels = buildExecutionLevels(validNodes)

    return { goal, nodes: validNodes, executionLevels }
  }

  /**
   * Build a human-readable description of available specialists
   * for inclusion in the LLM system prompt.
   */
  private buildSpecialistDescriptions(): string {
    const lines: string[] = []
    for (const id of this.supervisor.specialistIds) {
      const specialist = this.supervisor.getSpecialist(id)
      if (specialist) {
        const tags = (specialist.metadata?.tags ?? []) as string[]
        const tagStr = tags.length > 0 ? ` [tags: ${tags.join(', ')}]` : ''
        const desc = specialist.description ?? specialist.name
        lines.push(`- ${id}: ${desc}${tagStr}`)
      } else {
        lines.push(`- ${id}`)
      }
    }
    return lines.join('\n')
  }

  /**
   * Build a plan from a structured task list (pure data, no LLM).
   *
   * Auto-generates IDs for tasks that don't have one and computes
   * execution levels via topological sort.
   */
  static buildPlan(
    goal: string,
    tasks: Array<Omit<PlanNode, 'id'> & { id?: string }>,
  ): ExecutionPlan {
    let counter = 0
    const nodes: PlanNode[] = tasks.map((t) => ({
      id: t.id ?? `node-${counter++}`,
      task: t.task,
      specialistId: t.specialistId,
      input: t.input,
      dependsOn: t.dependsOn,
    }))

    const executionLevels = buildExecutionLevels(nodes)

    return { goal, nodes, executionLevels }
  }
}
