/**
 * PlanningAgent — decomposes complex goals into a dependency DAG
 * and executes tasks in topological order via DelegatingSupervisor.
 *
 * Supports both programmatic plan construction via `PlanningAgent.buildPlan()`
 * and LLM-powered decomposition via `decompose()`.
 *
 * The class is a thin coordinator. Pure logic lives in sibling modules:
 * - `planning-types.ts` — interfaces and configuration types
 * - `planning-graph.ts` — topological sort + structural validation
 * - `planning-decomposition.ts` — Zod schemas + LLM-powered decomposition
 * - `planning-executor.ts` — DAG execution loop
 *
 * Re-exports here preserve the public API so existing imports continue to work.
 *
 * Depends ONLY on sibling orchestration types + @dzupagent/core.
 */

import type { StructuredLLM } from '../structured/structured-output-engine.js'
import { buildExecutionLevels } from './planning-graph.js'
import { decomposeGoal } from './planning-decomposition.js'
import { executePlanWithSupervisor } from './planning-executor.js'
import type {
  DecomposeOptions,
  ExecutionPlan,
  PlanExecutionResult,
  PlanNode,
  PlanningAgentConfig,
  PlanningSupervisor,
} from './planning-types.js'

// Re-export types and helpers so the public surface is unchanged.
export type {
  DanglingPlanDependencyDiagnostic,
  DecomposeOptions,
  ExecutionPlan,
  PlanExecutionResult,
  PlanNode,
  PlanningAgentConfig,
  PlanningSupervisor,
  PlanningDecompositionDiagnostics,
  RemovedPlanNodeDiagnostic,
} from './planning-types.js'
export { buildExecutionLevels, validatePlanStructure } from './planning-graph.js'
export {
  DecompositionSchema,
  PlanNodeSchema,
  type DecompositionResult,
} from './planning-decomposition.js'

/**
 * Executes pre-built execution plans in topological order.
 *
 * For each execution level, delegates all tasks in that level through the
 * supervisor. Results from earlier levels are injected as context into
 * dependent nodes. If a node fails, all downstream dependents are skipped.
 */
export class PlanningAgent {
  private readonly supervisor: PlanningSupervisor
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
    return executePlanWithSupervisor(this.supervisor, plan, {
      maxParallelism: this.maxParallelism,
    })
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
   * @param options - Optional configuration (maxNodes, signal, acknowledgeUnresolvedNodes).
   * @returns A validated ExecutionPlan.
   */
  async decompose(
    goal: string,
    llm: StructuredLLM,
    options?: DecomposeOptions,
  ): Promise<ExecutionPlan> {
    return decomposeGoal(this.supervisor, goal, llm, options)
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
