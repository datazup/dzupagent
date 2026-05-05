/**
 * DelegatingSupervisor — wires SimpleDelegationTracker into the supervisor
 * orchestration pattern so a supervisor agent can delegate tasks to
 * specialist agents using the typed delegation protocol.
 *
 * This module depends ONLY on `@dzupagent/core` types (AgentExecutionSpec,
 * RunStore, DzupEventBus). It does NOT import from `@dzupagent/server`
 * or any other sibling package.
 */

import { typedEmit, type AgentExecutionSpec, type DzupEventBus } from '@dzupagent/core'
import { OrchestrationError } from './orchestration-error.js'
import type {
  DelegationTracker,
  DelegationRequest,
  DelegationResult,
  DelegationContext,
} from './delegation.js'
import type { StructuredLLM } from '../structured/structured-output-engine.js'
import type { ProviderExecutionPort } from './provider-adapter/provider-execution-port.js'
import type { RoutingPolicy, AgentSpec, AgentTask } from './routing-policy-types.js'
import type { OrchestrationMergeStrategy, AgentResult } from './orchestration-merge-strategy-types.js'
import type { AgentCircuitBreaker } from './circuit-breaker.js'
import { omitUndefined } from '../utils/exact-optional.js'

/** Options for LLM-powered planAndDelegate. */
export interface PlanAndDelegateOptions {
  /** LLM instance for goal decomposition. When provided, uses LLM-powered planning. */
  llm?: StructuredLLM
  /** Abort signal for cancellation */
  signal?: AbortSignal
  /**
   * Explicitly acknowledge unresolved LLM planning nodes/dependencies.
   *
   * By default, unresolved decomposition output fails before execution and this
   * supervisor falls back to keyword planning. When true, PlanningAgent removes
   * unresolved nodes/dependencies deterministically before execution.
   */
  acknowledgeUnresolvedNodes?: boolean
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single task assignment for parallel delegation. */
export interface TaskAssignment {
  /** Stable key for this assignment, used to aggregate duplicate-specialist batches. */
  id?: string
  /** Human-readable sub-task description */
  task: string
  /** ID of the specialist to delegate to */
  specialistId: string
  /** Structured input for the specialist */
  input: Record<string, unknown>
}

/** Aggregated result from delegateAndCollect. */
export interface AggregatedDelegationResult {
  /** Results keyed by assignment ID when provided, otherwise by specialist ID */
  results: Map<string, DelegationResult>
  /** Result keys that succeeded */
  succeeded: string[]
  /** Result keys that failed */
  failed: string[]
  /** Total wall-clock time for the parallel batch (ms) */
  totalDurationMs: number
}

/** Behavior when a parallel batch repeats a specialist without stable assignment IDs. */
export type DuplicateSpecialistAssignmentIdMode = 'allow' | 'warn' | 'strict'

/** Options for a single delegated task execution. */
export interface DelegateTaskOptions {
  /** Stable run ID to correlate provider-port execution. */
  runId?: string
  /** Abort signal for provider-port cancellation. */
  signal?: AbortSignal
}

/** Configuration for DelegatingSupervisor. */
export interface DelegatingSupervisorConfig {
  /** Map of specialist ID -> AgentExecutionSpec metadata */
  specialists: Map<string, AgentExecutionSpec>
  /** The delegation tracker that executes delegations */
  tracker: DelegationTracker
  /** Parent run context for delegation requests */
  parentContext?: DelegationContext
  /** Event bus for lifecycle events */
  eventBus?: DzupEventBus
  /**
   * Guard direct delegateAndCollect() callers from result-key collisions.
   *
   * PlanningAgent.executePlan() already passes TaskAssignment.id = node.id.
   * Direct callers that repeat the same specialist should pass stable IDs for
   * every assignment in the duplicate-specialist batch.
   *
   * Defaults to "warn" so legacy direct callers keep working while surfacing
   * the collision risk. Use "strict" to fail before delegation starts.
   */
  duplicateSpecialistAssignmentIdMode?: DuplicateSpecialistAssignmentIdMode
  /**
   * Provider execution port for adapter-based execution.
   * When set, `delegateTask` routes through `providerPort.run()`
   * instead of the delegation tracker.
   */
  providerPort?: ProviderExecutionPort
  /**
   * Pluggable routing policy for agent selection.
   * When not set, the existing keyword/LLM-based selection is used.
   */
  routingPolicy?: RoutingPolicy
  /**
   * Pluggable merge strategy for combining parallel delegation results.
   * Defaults to UsePartialMergeStrategy behavior when not set.
   */
  mergeStrategy?: OrchestrationMergeStrategy
  /**
   * Circuit breaker for excluding unhealthy agents from routing.
   * When set, agents with tripped circuits are filtered out before selection.
   */
  circuitBreaker?: AgentCircuitBreaker
  // ── Hierarchy (ORCHESTRATION_V2) ──
  /** ID of the parent run when this supervisor is itself a sub-orchestrator. */
  parentRunId?: string
  /** Branch identifier when running inside a parallel/conditional tree. */
  branchId?: string
  /** Depth in orchestration hierarchy. Root = 0. */
  depth?: number
}

// ─── Hierarchical sub-orchestrator support (ORCHESTRATION_V2) ────────────────

export const MAX_ORCHESTRATION_DEPTH = 3

export interface SubOrchestratorSpawnOptions {
  parentRunId: string
  branchId: string
  depth: number
  inputPrompt: string
  personaId?: string
  preferredProvider?: string
  budgetCents?: number
}

/**
 * Guard that enforces the maximum orchestration depth.
 * Call this before spawning any sub-orchestrator.
 * Throws if depth would exceed MAX_ORCHESTRATION_DEPTH.
 */
export function assertDepthAllowed(depth: number, max = MAX_ORCHESTRATION_DEPTH): void {
  if (depth >= max) {
    throw new Error(
      `Orchestration depth limit reached: depth=${depth} >= max=${max}. ` +
        'Cannot spawn another sub-orchestrator.',
    )
  }
}

// ---------------------------------------------------------------------------
// Keyword-to-tag mapping for planAndDelegate decomposition
// ---------------------------------------------------------------------------

/**
 * Simple keyword map used by planAndDelegate to match sub-tasks to
 * specialists based on metadata tags. Case-insensitive.
 */
const KEYWORD_TAG_MAP: ReadonlyMap<string, string[]> = new Map([
  ['database', ['database', 'db', 'sql', 'schema', 'migration']],
  ['api', ['api', 'backend', 'rest', 'endpoint', 'route', 'server']],
  ['ui', ['ui', 'frontend', 'component', 'page', 'view', 'css', 'style']],
  ['test', ['test', 'testing', 'spec', 'coverage', 'assertion']],
  ['security', ['security', 'auth', 'authentication', 'authorization', 'rbac']],
  ['deploy', ['deploy', 'deployment', 'ci', 'cd', 'infrastructure', 'devops']],
])

const CIRCUIT_BREAKER_RECORDED = Symbol('circuitBreakerRecorded')

interface DuplicateSpecialistAssignmentIdWarning {
  specialistId: string
  assignmentIndexes: number[]
  missingAssignmentIdIndexes: number[]
}

function isTimeoutError(message: string | undefined): boolean {
  return message?.toLowerCase().includes('timeout') ?? false
}

function markCircuitBreakerRecorded(error: unknown): void {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    try {
      Object.defineProperty(error, CIRCUIT_BREAKER_RECORDED, {
        value: true,
        configurable: true,
      })
    } catch {
      // Non-extensible thrown values still get recorded; they just cannot be tagged.
    }
  }
}

function hasCircuitBreakerRecorded(error: unknown): boolean {
  return Boolean(
    error &&
      (typeof error === 'object' || typeof error === 'function') &&
      (error as { [CIRCUIT_BREAKER_RECORDED]?: boolean })[CIRCUIT_BREAKER_RECORDED],
  )
}

function findDuplicateSpecialistAssignmentsWithoutIds(
  tasks: TaskAssignment[],
): DuplicateSpecialistAssignmentIdWarning[] {
  const bySpecialist = new Map<string, number[]>()

  tasks.forEach((task, index) => {
    const indexes = bySpecialist.get(task.specialistId)
    if (indexes) {
      indexes.push(index)
    } else {
      bySpecialist.set(task.specialistId, [index])
    }
  })

  const warnings: DuplicateSpecialistAssignmentIdWarning[] = []
  for (const [specialistId, assignmentIndexes] of bySpecialist) {
    if (assignmentIndexes.length < 2) continue

    const missingAssignmentIdIndexes = assignmentIndexes.filter((index) => {
      const id = tasks[index]?.id
      return id === undefined || id.length === 0
    })

    if (missingAssignmentIdIndexes.length === 0) continue
    warnings.push({
      specialistId,
      assignmentIndexes,
      missingAssignmentIdIndexes,
    })
  }

  return warnings
}

function formatDuplicateSpecialistAssignmentIdMessage(
  warnings: DuplicateSpecialistAssignmentIdWarning[],
): string {
  const details = warnings
    .map((warning) => {
      const allIndexes = warning.assignmentIndexes.join(', ')
      const missingIndexes = warning.missingAssignmentIdIndexes.join(', ')
      return `${warning.specialistId} at indexes ${allIndexes} (missing IDs at ${missingIndexes})`
    })
    .join('; ')

  return `delegateAndCollect received duplicate specialist assignments without stable assignment IDs: ${details}. Provide TaskAssignment.id for every assignment in duplicate-specialist batches.`
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DelegatingSupervisor {
  private readonly specialists: Map<string, AgentExecutionSpec>
  private readonly tracker: DelegationTracker
  private readonly parentContext: DelegationContext | undefined
  private readonly eventBus: DzupEventBus | undefined
  private readonly providerPort: ProviderExecutionPort | undefined
  private readonly routingPolicy: RoutingPolicy | undefined
  private readonly mergeStrategy: OrchestrationMergeStrategy | undefined
  private readonly circuitBreaker: AgentCircuitBreaker | undefined
  private readonly duplicateSpecialistAssignmentIdMode: DuplicateSpecialistAssignmentIdMode

  constructor(config: DelegatingSupervisorConfig) {
    this.specialists = config.specialists
    this.tracker = config.tracker
    this.parentContext = config.parentContext
    this.eventBus = config.eventBus
    this.providerPort = config.providerPort
    this.routingPolicy = config.routingPolicy
    this.mergeStrategy = config.mergeStrategy
    this.circuitBreaker = config.circuitBreaker
    this.duplicateSpecialistAssignmentIdMode = config.duplicateSpecialistAssignmentIdMode ?? 'warn'
  }

  /**
   * Delegate a single task to a named specialist.
   *
   * Looks up the specialist from the registry, builds a DelegationRequest
   * with context from the parent run, and calls tracker.delegate().
   */
  async delegateTask(
    task: string,
    specialistId: string,
    input: Record<string, unknown>,
    options?: DelegateTaskOptions,
  ): Promise<DelegationResult> {
    const specialist = this.specialists.get(specialistId)
    if (!specialist) {
      throw new OrchestrationError(
        `Specialist "${specialistId}" not found. Available: ${[...this.specialists.keys()].join(', ')}`,
        'delegation',
        { specialistId, available: [...this.specialists.keys()] },
      )
    }

    this.eventBus?.emit({
      type: 'supervisor:delegating',
      specialistId,
      task,
    })

    // Route through provider port when configured
    if (this.providerPort) {
      const tags: string[] = (specialist.metadata?.tags ?? []) as string[]
      const startedAt = Date.now()
      let portResult: Awaited<ReturnType<ProviderExecutionPort['run']>>
      try {
        portResult = await this.providerPort.run(
          {
            prompt: task,
            signal: options?.signal,
            correlationId: options?.runId ?? this.parentContext?.parentRunId,
            options: {
              delegation: omitUndefined({
                task,
                specialistId,
                input,
                context: this.parentContext,
              }),
            },
          },
          {
            prompt: task,
            tags: tags.length > 0 ? tags : [specialistId],
          },
          omitUndefined({
            runId: options?.runId,
            signal: options?.signal,
          }),
        )
      } catch (err: unknown) {
        this.recordCircuitBreakerFailure(specialistId, err)
        markCircuitBreakerRecorded(err)
        throw err
      }

      const delegationResult: DelegationResult = {
        success: true,
        output: portResult.content,
        metadata: omitUndefined({
          durationMs: Date.now() - startedAt,
          specialistId,
          providerId: portResult.providerId,
          attemptedProviders: [...portResult.attemptedProviders],
          fallbackAttempts: portResult.fallbackAttempts,
          providerMetadata: portResult.metadata,
        }),
      }

      this.circuitBreaker?.recordSuccess(specialistId)

      this.eventBus?.emit({
        type: 'supervisor:delegation_complete',
        specialistId,
        task,
        success: true,
      })

      return delegationResult
    }

    const request: DelegationRequest = omitUndefined({
      targetAgentId: specialistId,
      task,
      input,
      context: this.parentContext,
    })

    let result: DelegationResult
    try {
      result = await this.tracker.delegate(request)
    } catch (err: unknown) {
      this.recordCircuitBreakerFailure(specialistId, err)
      markCircuitBreakerRecorded(err)
      throw err
    }

    // Record circuit breaker outcome
    if (this.circuitBreaker) {
      if (result.success) {
        this.circuitBreaker.recordSuccess(specialistId)
      } else if (isTimeoutError(result.error)) {
        this.circuitBreaker.recordTimeout(specialistId)
      } else {
        this.circuitBreaker.recordFailure(specialistId)
      }
    }

    this.eventBus?.emit({
      type: 'supervisor:delegation_complete',
      specialistId,
      task,
      success: result.success,
    })

    return result
  }

  /**
   * Delegate multiple tasks in parallel and collect all results.
   *
   * Uses Promise.allSettled so one failure does not block others.
   */
  async delegateAndCollect(
    tasks: TaskAssignment[],
  ): Promise<AggregatedDelegationResult> {
    const start = Date.now()

    // Filter tasks through circuit breaker if configured
    let effectiveTasks = tasks
    if (this.circuitBreaker) {
      const availableIds = new Set(
        this.circuitBreaker
          .filterAvailable([...this.specialists.entries()].map(([id]) => ({ id })))
          .map((a) => a.id),
      )
      const filtered = tasks.filter((t) => availableIds.has(t.specialistId))
      if (filtered.length < tasks.length) {
        const skipped = tasks
          .filter((t) => !availableIds.has(t.specialistId))
          .map((t) => t.specialistId)
        this.eventBus?.emit({
          type: 'supervisor:circuit_breaker_filtered',
          skipped,
        })
      }
      effectiveTasks = filtered
    }

    this.guardDuplicateSpecialistAssignmentIds(effectiveTasks)

    // Validate all specialists exist before starting any work
    for (const assignment of effectiveTasks) {
      if (!this.specialists.has(assignment.specialistId)) {
        throw new OrchestrationError(
          `Specialist "${assignment.specialistId}" not found. Available: ${[...this.specialists.keys()].join(', ')}`,
          'delegation',
          { specialistId: assignment.specialistId, available: [...this.specialists.keys()] },
        )
      }
    }

    const settled = await Promise.allSettled(
      effectiveTasks.map((t) => this.delegateTask(t.task, t.specialistId, t.input)),
    )

    const results = new Map<string, DelegationResult>()
    const succeeded: string[] = []
    const failed: string[] = []

    for (const [i, outcome] of settled.entries()) {
      const assignment = effectiveTasks[i]!
      const resultKey = assignment.id ?? assignment.specialistId
      if (outcome.status === 'fulfilled') {
        const result: DelegationResult = {
          ...outcome.value,
          metadata: {
            ...outcome.value.metadata,
            durationMs: outcome.value.metadata?.durationMs ?? 0,
            assignmentId: resultKey,
            specialistId: assignment.specialistId,
          },
        }
        results.set(resultKey, result)
        if (outcome.value.success) {
          succeeded.push(resultKey)
        } else {
          failed.push(resultKey)
        }
      } else {
        const errorMsg = outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason)
        if (!hasCircuitBreakerRecorded(outcome.reason)) {
          this.recordCircuitBreakerFailure(assignment.specialistId, outcome.reason)
        }
        results.set(resultKey, {
          success: false,
          output: null,
          error: errorMsg,
          metadata: {
            durationMs: 0,
            assignmentId: resultKey,
            specialistId: assignment.specialistId,
          },
        })
        failed.push(resultKey)
      }
    }

    // Apply merge strategy if configured
    if (this.mergeStrategy && results.size > 0) {
      const agentResults: AgentResult[] = [...results.entries()].map(
        ([agentId, dr]) => omitUndefined({
          agentId,
          status: dr.success
            ? ('success' as const)
            : dr.error?.toLowerCase().includes('timeout')
              ? ('timeout' as const)
              : ('error' as const),
          output: dr.output,
          error: dr.error,
          durationMs: dr.metadata?.durationMs,
        }),
      )
      const merged = this.mergeStrategy.merge(agentResults)
      this.eventBus?.emit({
        type: 'supervisor:merge_complete',
        mergeStatus: merged.status,
        successCount: merged.successCount,
        errorCount: merged.errorCount,
      })
    }

    return {
      results,
      succeeded,
      failed,
      totalDurationMs: Date.now() - start,
    }
  }

  private guardDuplicateSpecialistAssignmentIds(tasks: TaskAssignment[]): void {
    if (this.duplicateSpecialistAssignmentIdMode === 'allow') return

    const warnings = findDuplicateSpecialistAssignmentsWithoutIds(tasks)
    if (warnings.length === 0) return

    const message = formatDuplicateSpecialistAssignmentIdMessage(warnings)
    if (this.duplicateSpecialistAssignmentIdMode === 'strict') {
      throw new OrchestrationError(message, 'delegation', {
        duplicateSpecialists: warnings,
      })
    }

    typedEmit(this.eventBus, {
      type: 'supervisor:duplicate_specialist_assignment_ids',
      mode: 'warn',
      duplicateSpecialists: warnings,
      message,
    })
  }

  /**
   * Break a high-level goal into sub-tasks, map them to specialists,
   * and delegate in parallel.
   *
   * When `options.llm` is provided, uses LLM-powered decomposition via
   * PlanningAgent.decompose() for intelligent task splitting. Falls back
   * to keyword-based decomposition if the LLM call fails.
   *
   * Without an LLM, splits the goal on common delimiters (commas, "and",
   * semicolons, newlines) and matches each fragment against specialist
   * metadata tags and the built-in keyword map.
   */
  async planAndDelegate(
    goal: string,
    options?: PlanAndDelegateOptions,
  ): Promise<AggregatedDelegationResult> {
    if (options?.llm) {
      try {
        const { PlanningAgent } = await import('./planning-agent.js')
        const planner = new PlanningAgent({ supervisor: this })
        const plan = await planner.decompose(goal, options.llm, omitUndefined({
          signal: options.signal,
          acknowledgeUnresolvedNodes: options.acknowledgeUnresolvedNodes,
        }))

        this.eventBus?.emit({
          type: 'supervisor:plan_created',
          goal,
          assignments: plan.nodes.map((n) => ({
            task: n.task,
            specialistId: n.specialistId,
          })),
          source: 'llm',
        })

        const result = await planner.executePlan(plan)

        // Convert PlanExecutionResult to AggregatedDelegationResult
        const succeeded: string[] = []
        const failed: string[] = []
        for (const [nodeId, delegationResult] of result.results) {
          if (delegationResult.success) {
            succeeded.push(nodeId)
          } else {
            failed.push(nodeId)
          }
        }

        return {
          results: result.results,
          succeeded,
          failed,
          totalDurationMs: result.totalDurationMs,
        }
      } catch (err: unknown) {
        // Fall back to keyword splitting on LLM failure
        this.eventBus?.emit({
          type: 'supervisor:llm_decompose_fallback',
          goal,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Use routing policy if configured, otherwise fall back to keyword matching
    const subtasks = this.decomposeGoal(goal)
    const assignments = this.routingPolicy
      ? this.routeSubtasksViaPolicy(subtasks)
      : this.matchSubtasksToSpecialists(subtasks)

    if (assignments.length === 0) {
      throw new OrchestrationError(
        `No specialists matched any sub-tasks from goal: "${goal}"`,
        'delegation',
        { subtasks, availableSpecialists: [...this.specialists.keys()] },
      )
    }

    this.eventBus?.emit({
      type: 'supervisor:plan_created',
      goal,
      assignments: assignments.map((a) => ({
        task: a.task,
        specialistId: a.specialistId,
      })),
      source: 'keyword',
    })

    return this.delegateAndCollect(assignments)
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Return the list of registered specialist IDs. */
  get specialistIds(): string[] {
    return [...this.specialists.keys()]
  }

  /** Return the specialist definition by ID, or undefined. */
  getSpecialist(id: string): AgentExecutionSpec | undefined {
    return this.specialists.get(id)
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Convert specialists to AgentSpec format for routing policy consumption.
   */
  private toAgentSpecs(): AgentSpec[] {
    let specs = [...this.specialists.entries()].map(([id, def]) => omitUndefined({
      id,
      name: def.name,
      tags: (def.metadata?.tags ?? []) as string[],
      metadata: def.metadata as Record<string, unknown> | undefined,
    }))

    // Filter through circuit breaker if configured
    if (this.circuitBreaker) {
      specs = this.circuitBreaker.filterAvailable(specs)
    }

    return specs
  }

  private recordCircuitBreakerFailure(specialistId: string, error: unknown): void {
    if (!this.circuitBreaker) return

    const message = error instanceof Error ? error.message : String(error)
    if (isTimeoutError(message)) {
      this.circuitBreaker.recordTimeout(specialistId)
      return
    }

    this.circuitBreaker.recordFailure(specialistId)
  }

  /**
   * Route subtasks to specialists using the configured RoutingPolicy.
   * Logs each routing decision via the event bus.
   */
  private routeSubtasksViaPolicy(subtasks: string[]): TaskAssignment[] {
    const candidates = this.toAgentSpecs()
    if (candidates.length === 0) return []

    const assignments: TaskAssignment[] = []

    for (const subtask of subtasks) {
      const task: AgentTask = {
        taskId: `subtask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content: subtask,
      }

      const decision = this.routingPolicy!.select(task, candidates)

      // Log routing decision
      const selectedCandidates = decision.diagnostics?.selectedIds ??
        decision.selected.map((agent) => agent.id)
      const candidateSpecialists = decision.diagnostics?.candidateIds ??
        candidates.map((agent) => agent.id)
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
        this.eventBus?.emit(routingEvent)
      }

      // Create assignments from the routing decision
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

  /**
   * Split a goal string into sub-task fragments.
   * Splits on commas, " and ", semicolons, and newlines.
   */
  private decomposeGoal(goal: string): string[] {
    return goal
      .split(/[,;\n]|\band\b/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }

  /**
   * Match sub-task fragments to specialists based on:
   * 1. Specialist metadata.tags (from AgentExecutionSpec.metadata)
   * 2. Specialist tools list
   * 3. Built-in keyword-to-tag map
   */
  private matchSubtasksToSpecialists(subtasks: string[]): TaskAssignment[] {
    const assignments: TaskAssignment[] = []

    for (const subtask of subtasks) {
      const lowerSubtask = subtask.toLowerCase()
      let bestMatch: string | null = null
      let bestScore = 0

      for (const [id, def] of this.specialists) {
        const score = this.scoreMatch(lowerSubtask, id, def)
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
   * Score how well a subtask matches a specialist.
   * Higher = better match. Returns 0 for no match.
   */
  private scoreMatch(
    lowerSubtask: string,
    specialistId: string,
    def: AgentExecutionSpec,
  ): number {
    let score = 0

    // Check specialist ID contains relevant keywords
    if (lowerSubtask.includes(specialistId.toLowerCase())) {
      score += 3
    }
    if (specialistId.toLowerCase().split(/[-_]/).some((part) => lowerSubtask.includes(part))) {
      score += 2
    }

    // Check agent name
    if (def.name && lowerSubtask.includes(def.name.toLowerCase())) {
      score += 3
    }

    // Check metadata tags
    const tags = (def.metadata?.tags ?? []) as string[]
    for (const tag of tags) {
      if (lowerSubtask.includes(tag.toLowerCase())) {
        score += 4
      }
    }

    // Check tools list for keyword overlap
    if (def.tools) {
      for (const tool of def.tools) {
        if (lowerSubtask.includes(tool.toLowerCase())) {
          score += 2
        }
      }
    }

    // Check built-in keyword map
    for (const [_category, keywords] of KEYWORD_TAG_MAP) {
      const matchesSubtask = keywords.some((kw) => lowerSubtask.includes(kw))
      if (matchesSubtask) {
        // Check if specialist tags or ID match this category
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
}
