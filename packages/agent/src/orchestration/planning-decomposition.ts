/**
 * Planning decomposition — Zod schemas, LLM prompting, and post-decomposition
 * cleanup for the PlanningAgent's `decompose()` method.
 */

import { z } from 'zod'
import type { StructuredLLM } from '../structured/structured-output-engine.js'
import { generateStructured } from '../structured/structured-output-engine.js'
import { OrchestrationError } from './orchestration-error.js'
import { buildExecutionLevels } from './planning-graph.js'
import type {
  DanglingPlanDependencyDiagnostic,
  DecomposeOptions,
  ExecutionPlan,
  PlanNode,
  PlanningDecompositionDiagnostics,
  PlanningSupervisor,
  RemovedPlanNodeDiagnostic,
} from './planning-types.js'

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

// ---------------------------------------------------------------------------
// Specialist description rendering (for system prompts)
// ---------------------------------------------------------------------------

/**
 * Build a human-readable description of available specialists
 * for inclusion in the LLM system prompt.
 */
export function buildSpecialistDescriptions(supervisor: PlanningSupervisor): string {
  const lines: string[] = []
  for (const id of supervisor.specialistIds) {
    const specialist = supervisor.getSpecialist(id)
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

// ---------------------------------------------------------------------------
// LLM-powered decomposition pipeline
// ---------------------------------------------------------------------------

/**
 * Decompose a goal into an ExecutionPlan using an LLM.
 *
 * Sends the goal and available specialist descriptions to the LLM,
 * asks it to decompose into a DAG of tasks, validates the output,
 * and returns an ExecutionPlan ready for `executePlan()`.
 */
export async function decomposeGoal(
  supervisor: PlanningSupervisor,
  goal: string,
  llm: StructuredLLM,
  options?: DecomposeOptions,
): Promise<ExecutionPlan> {
  const maxNodes = options?.maxNodes ?? 20
  const specialistIds = supervisor.specialistIds
  const specialistDescriptions = buildSpecialistDescriptions(supervisor)

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
    agentId: 'planning-agent',
    intent: 'planning:decompose-goal',
    capabilities: {
      preferredStrategy: 'generic-parse',
      schemaProvider: 'generic',
      fallbackStrategies: ['fallback-prompt'],
    },
    schemaProvider: 'generic',
    schemaName: 'DecompositionPlan',
    schemaDescription: 'A directed acyclic graph of tasks assigned to specialist agents',
  })

  return refineDecomposition(goal, result.data, specialistIds, options)
}

/**
 * Validate, partition, and clean up a raw LLM decomposition into an ExecutionPlan.
 *
 * - Removes nodes whose specialistId is unknown
 * - Records dangling dependency references
 * - Optionally cleans them up after explicit caller acknowledgement
 * - Throws OrchestrationError if cleanup is unacknowledged or no nodes remain
 *
 * Exported for testability; consumers normally call `decomposeGoal`.
 */
export function refineDecomposition(
  goal: string,
  decomposition: DecompositionResult,
  specialistIds: string[],
  options?: DecomposeOptions,
): ExecutionPlan {
  const maxNodes = options?.maxNodes ?? 20
  const validSpecialistSet = new Set(specialistIds)
  const generatedNodes = decomposition.nodes.slice(0, maxNodes)
  const validNodes: PlanNode[] = []
  const removedNodeIds = new Set<string>()
  const removedNodeSpecialists = new Map<string, string>()

  for (const node of generatedNodes) {
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
      removedNodeSpecialists.set(node.id, node.specialistId)
    }
  }

  const validNodeIds = new Set(validNodes.map((node) => node.id))
  const danglingDependencies: DanglingPlanDependencyDiagnostic[] = []

  for (const node of validNodes) {
    for (const dependencyId of node.dependsOn) {
      if (!validNodeIds.has(dependencyId)) {
        const dependencySpecialistId = removedNodeSpecialists.get(dependencyId)
        danglingDependencies.push({
          nodeId: node.id,
          specialistId: node.specialistId,
          dependencyId,
          ...(dependencySpecialistId ? { dependencySpecialistId } : {}),
        })
      }
    }
  }

  const removedNodes: RemovedPlanNodeDiagnostic[] = [...removedNodeSpecialists].map(
    ([nodeId, specialistId]) => ({
      nodeId,
      specialistId,
      reason: 'unknown-specialist',
      affectedDependencies: danglingDependencies
        .filter((dependency) => dependency.dependencyId === nodeId)
        .map((dependency) => ({
          nodeId: dependency.nodeId,
          specialistId: dependency.specialistId,
          dependencyId: dependency.dependencyId,
        })),
    }),
  )

  const hasUnresolvedNodes = removedNodes.length > 0 || danglingDependencies.length > 0
  const removedDetails = removedNodes.map(
    (node) => `${node.nodeId} (${node.specialistId})`,
  )
  const dependencyDetails = danglingDependencies.map(
    (dependency) => [
      `${dependency.nodeId} (${dependency.specialistId}) -> ${dependency.dependencyId}`,
      dependency.dependencySpecialistId ? ` (${dependency.dependencySpecialistId})` : '',
    ].join(''),
  )

  if (validNodes.length === 0) {
    throw new OrchestrationError(
      [
        `LLM decomposition produced no valid nodes. All specialist IDs were unrecognized. Available: ${specialistIds.join(', ')}`,
        removedDetails.length > 0
          ? `Unknown-specialist nodes: ${removedDetails.join(', ')}`
          : undefined,
      ].filter(Boolean).join(' '),
      'delegation',
      {
        goal,
        availableSpecialists: specialistIds,
        diagnostics: {
          availableSpecialists: specialistIds,
          removedNodes,
          danglingDependencies,
          acknowledged: options?.acknowledgeUnresolvedNodes === true,
        } satisfies PlanningDecompositionDiagnostics,
      },
    )
  }

  if (hasUnresolvedNodes && !options?.acknowledgeUnresolvedNodes) {
    throw new OrchestrationError(
      [
        'LLM decomposition contains unresolved planning nodes or dependencies.',
        removedDetails.length > 0
          ? `Unknown-specialist nodes: ${removedDetails.join(', ')}`
          : undefined,
        dependencyDetails.length > 0
          ? `Dangling dependencies: ${dependencyDetails.join(', ')}`
          : undefined,
        'Pass acknowledgeUnresolvedNodes: true to remove them deterministically before execution.',
      ].filter(Boolean).join(' '),
      'delegation',
      {
        goal,
        availableSpecialists: specialistIds,
        diagnostics: {
          availableSpecialists: specialistIds,
          removedNodes,
          danglingDependencies,
          acknowledged: false,
        } satisfies PlanningDecompositionDiagnostics,
      },
    )
  }

  if (options?.acknowledgeUnresolvedNodes) {
    // Remove dangling dependency references after explicit caller acknowledgement.
    for (const node of validNodes) {
      node.dependsOn = node.dependsOn.filter(
        (dep) => !removedNodeIds.has(dep) && validNodeIds.has(dep),
      )
    }
  }

  // Validate DAG (throws on cycles)
  const executionLevels = buildExecutionLevels(validNodes)

  const plan: ExecutionPlan = {
    goal,
    nodes: validNodes,
    executionLevels,
  }

  if (!hasUnresolvedNodes) {
    return plan
  }

  return {
    ...plan,
    decompositionDiagnostics: {
      availableSpecialists: specialistIds,
      removedNodes,
      danglingDependencies,
      acknowledged: true,
    },
  }
}
