/**
 * Specialist-selection helpers extracted from DelegatingSupervisor.
 *
 * Encapsulates three orthogonal responsibilities:
 *   1. `decomposeGoal` — split a high-level goal string into sub-task fragments.
 *   2. `matchSubtasksToSpecialists` — keyword-based matcher (default fallback).
 *   3. `routeSubtasksViaPolicy` — delegate matching to a `RoutingPolicy` and
 *      emit `supervisor:routing_decision` events for each selected agent.
 *
 * Plus a single shared utility:
 *   - `toAgentSpecs(specialists, circuitBreaker?)` — projects an
 *     `AgentExecutionSpec` registry into `AgentSpec[]` while filtering
 *     unhealthy agents through the optional circuit breaker.
 *
 * Depends only on `@dzupagent/core` types and sibling files.
 */

import type { AgentExecutionSpec, DzupEventBus } from '@dzupagent/core'
import type { AgentCircuitBreaker } from './circuit-breaker.js'
import type {
  AgentSpec,
  AgentTask,
  RoutingPolicy,
} from './routing-policy-types.js'
import { omitUndefined } from '../utils/exact-optional.js'

/** A single task assignment created by the matchers. */
export interface SelectionAssignment {
  task: string
  specialistId: string
  input: Record<string, unknown>
}

/**
 * Simple keyword map used by `matchSubtasksToSpecialists` to bridge sub-task
 * fragments to specialists based on metadata tags. Case-insensitive.
 */
export const KEYWORD_TAG_MAP: ReadonlyMap<string, readonly string[]> = new Map([
  ['database', ['database', 'db', 'sql', 'schema', 'migration']],
  ['api', ['api', 'backend', 'rest', 'endpoint', 'route', 'server']],
  ['ui', ['ui', 'frontend', 'component', 'page', 'view', 'css', 'style']],
  ['test', ['test', 'testing', 'spec', 'coverage', 'assertion']],
  ['security', ['security', 'auth', 'authentication', 'authorization', 'rbac']],
  ['deploy', ['deploy', 'deployment', 'ci', 'cd', 'infrastructure', 'devops']],
])

/**
 * Project the specialist registry into `AgentSpec[]` and apply optional
 * circuit-breaker filtering.
 */
export function toAgentSpecs(
  specialists: ReadonlyMap<string, AgentExecutionSpec>,
  circuitBreaker?: AgentCircuitBreaker,
): AgentSpec[] {
  let specs: AgentSpec[] = [...specialists.entries()].map(([id, def]) =>
    omitUndefined({
      id,
      name: def.name,
      tags: (def.metadata?.tags ?? []) as string[],
      metadata: def.metadata as Record<string, unknown> | undefined,
    }),
  )

  if (circuitBreaker) {
    specs = circuitBreaker.filterAvailable(specs)
  }

  return specs
}

/**
 * Split a goal string into sub-task fragments.
 * Splits on commas, " and ", semicolons, and newlines.
 */
export function decomposeGoal(goal: string): string[] {
  return goal
    .split(/[,;\n]|\band\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Score how well a subtask matches a specialist. Higher = better match.
 * Returns 0 for no match.
 */
export function scoreMatch(
  lowerSubtask: string,
  specialistId: string,
  def: AgentExecutionSpec,
): number {
  let score = 0

  if (lowerSubtask.includes(specialistId.toLowerCase())) {
    score += 3
  }
  if (specialistId.toLowerCase().split(/[-_]/).some((part) => lowerSubtask.includes(part))) {
    score += 2
  }

  if (def.name && lowerSubtask.includes(def.name.toLowerCase())) {
    score += 3
  }

  const tags = (def.metadata?.tags ?? []) as string[]
  for (const tag of tags) {
    if (lowerSubtask.includes(tag.toLowerCase())) {
      score += 4
    }
  }

  if (def.tools) {
    for (const tool of def.tools) {
      if (lowerSubtask.includes(tool.toLowerCase())) {
        score += 2
      }
    }
  }

  for (const [, keywords] of KEYWORD_TAG_MAP) {
    const matchesSubtask = keywords.some((kw) => lowerSubtask.includes(kw))
    if (matchesSubtask) {
      const matchesSpecialist =
        tags.some((tag) => keywords.includes(tag.toLowerCase())) ||
        keywords.some((kw) => specialistId.toLowerCase().includes(kw))

      if (matchesSpecialist) {
        score += 3
      }
    }
  }

  return score
}

/**
 * Default keyword-based matcher.
 * Picks the highest-scoring specialist for each subtask, dropping fragments
 * that fail to score above zero against any specialist.
 */
export function matchSubtasksToSpecialists(
  subtasks: readonly string[],
  specialists: ReadonlyMap<string, AgentExecutionSpec>,
): SelectionAssignment[] {
  const assignments: SelectionAssignment[] = []

  for (const subtask of subtasks) {
    const lowerSubtask = subtask.toLowerCase()
    let bestMatch: string | null = null
    let bestScore = 0

    for (const [id, def] of specialists) {
      const score = scoreMatch(lowerSubtask, id, def)
      if (score > bestScore) {
        bestScore = score
        bestMatch = id
      }
    }

    if (bestMatch) {
      assignments.push({
        task: subtask,
        specialistId: bestMatch,
        input: { subtask },
      })
    }
  }

  return assignments
}

/**
 * Route subtasks via the supplied `RoutingPolicy`. Emits a
 * `supervisor:routing_decision` event per selected agent.
 */
export function routeSubtasksViaPolicy(
  subtasks: readonly string[],
  routingPolicy: RoutingPolicy,
  candidates: AgentSpec[],
  eventBus?: DzupEventBus,
): SelectionAssignment[] {
  if (candidates.length === 0) return []

  const assignments: SelectionAssignment[] = []

  for (const subtask of subtasks) {
    const task: AgentTask = {
      taskId: `subtask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content: subtask,
    }

    const decision = routingPolicy.select(task, candidates)

    const selectedCandidates =
      decision.diagnostics?.selectedIds ?? decision.selected.map((agent) => agent.id)
    const candidateSpecialists =
      decision.diagnostics?.candidateIds ?? candidates.map((agent) => agent.id)

    for (const selected of decision.selected) {
      const routingEvent = omitUndefined({
        type: 'supervisor:routing_decision',
        agentId: selected.id,
        strategy: decision.strategy,
        reason: decision.reason,
        fallbackReason: decision.fallbackReason,
        selectedCandidates,
        candidateSpecialists,
        source: 'delegating-supervisor',
      } as const)
      eventBus?.emit(routingEvent)
    }

    for (const agent of decision.selected) {
      assignments.push({
        task: subtask,
        specialistId: agent.id,
        input: { subtask },
      })
    }
  }

  return assignments
}
