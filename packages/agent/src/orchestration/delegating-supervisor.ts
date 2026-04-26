/**
 * DelegatingSupervisor — wires SimpleDelegationTracker into the supervisor
 * orchestration pattern so a supervisor agent can delegate tasks to
 * specialist agents using the typed delegation protocol.
 *
 * This module depends ONLY on `@dzupagent/core` types (AgentExecutionSpec,
 * RunStore, DzupEventBus). It does NOT import from `@dzupagent/server`
 * or any other sibling package.
 */

import type { AgentExecutionSpec, DzupEventBus } from '@dzupagent/core'
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

/** Options for LLM-powered planAndDelegate. */
export interface PlanAndDelegateOptions {
  /** LLM instance for goal decomposition. When provided, uses LLM-powered planning. */
  llm?: StructuredLLM
  /** Abort signal for cancellation */
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single task assignment for parallel delegation. */
export interface TaskAssignment {
  /** Human-readable sub-task description */
  task: string
  /** ID of the specialist to delegate to */
  specialistId: string
  /** Structured input for the specialist */
  input: Record<string, unknown>
}

/** Aggregated result from delegateAndCollect. */
export interface AggregatedDelegationResult {
  /** Results keyed by specialist ID */
  results: Map<string, DelegationResult>
  /** IDs of specialists that succeeded */
  succeeded: string[]
  /** IDs of specialists that failed */
  failed: string[]
  /** Total wall-clock time for the parallel batch (ms) */
  totalDurationMs: number
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

  constructor(config: DelegatingSupervisorConfig) {
    this.specialists = config.specialists
    this.tracker = config.tracker
    this.parentContext = config.parentContext
    this.eventBus = config.eventBus
    this.providerPort = config.providerPort
    this.routingPolicy = config.routingPolicy
    this.mergeStrategy = config.mergeStrategy
    this.circuitBreaker = config.circuitBreaker
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
      const portResult = await this.providerPort.run(
        { prompt: task },
        {
          prompt: task,
          tags: tags.length > 0 ? tags : [specialistId],
        },
      )

      const delegationResult: DelegationResult = {
        success: true,
        output: portResult.content,
        metadata: {
          durationMs: 0,
        },
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

    const request: DelegationRequest = {
      targetAgentId: specialistId,
      task,
      input,
      context: this.parentContext,
    }

    const result = await this.tracker.delegate(request)

    // Record circuit breaker outcome
    if (this.circuitBreaker) {
      if (result.success) {
        this.circuitBreaker.recordSuccess(specialistId)
      } else if (result.error?.toLowerCase().includes('timeout')) {
        this.circuitBreaker.recordTimeout(specialistId)
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
      if (outcome.status === 'fulfilled') {
        results.set(assignment.specialistId, outcome.value)
        if (outcome.value.success) {
          succeeded.push(assignment.specialistId)
        } else {
          failed.push(assignment.specialistId)
        }
      } else {
        const errorMsg = outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason)
        results.set(assignment.specialistId, {
          success: false,
          output: null,
          error: errorMsg,
        })
        failed.push(assignment.specialistId)
      }
    }

    // Apply merge strategy if configured
    if (this.mergeStrategy && results.size > 0) {
      const agentResults: AgentResult[] = [...results.entries()].map(
        ([agentId, dr]) => ({
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
        const plan = await planner.decompose(goal, options.llm, {
          signal: options.signal,
        })

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
    let specs = [...this.specialists.entries()].map(([id, def]) => ({
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
      for (const selected of decision.selected) {
        this.eventBus?.emit({
          type: 'supervisor:routing_decision',
          agentId: selected.id,
          strategy: decision.strategy,
          reason: decision.reason,
        })
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
