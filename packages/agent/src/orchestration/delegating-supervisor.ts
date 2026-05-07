/**
 * DelegatingSupervisor — wires SimpleDelegationTracker into the supervisor
 * orchestration pattern so a supervisor agent can delegate tasks to
 * specialist agents using the typed delegation protocol.
 *
 * This module depends ONLY on `@dzupagent/core` types (AgentExecutionSpec,
 * RunStore, DzupEventBus). It does NOT import from `@dzupagent/server`
 * or any other sibling package.
 */

import type { AgentExecutionSpec } from '@dzupagent/core/persistence'
import type { DzupEventBus } from '@dzupagent/core/events'
import { OrchestrationError } from './orchestration-error.js'
import type {
  DelegationTracker,
  DelegationRequest,
  DelegationResult,
  DelegationContext,
} from './delegation.js'
import type { ProviderExecutionPort } from './provider-adapter/provider-execution-port.js'
import type { RoutingPolicy } from './routing-policy-types.js'
import type { OrchestrationMergeStrategy } from './orchestration-merge-strategy-types.js'
import type { AgentCircuitBreaker } from './circuit-breaker.js'
import { omitUndefined } from '../utils/exact-optional.js'
import {
  markCircuitBreakerRecorded,
  recordCircuitBreakerFailure,
} from './circuit-breaker-recorder.js'
import { aggregateSettledResults } from './parallel-delegation-aggregator.js'
import {
  guardDuplicateSpecialistAssignmentIds,
  type DuplicateSpecialistAssignmentIdMode,
} from './assignment-validator.js'
import {
  decomposeGoal,
  matchSubtasksToSpecialists,
  routeSubtasksViaPolicy,
  toAgentSpecs,
} from './specialist-selection.js'
import type {
  AggregatedDelegationResult,
  DelegateTaskOptions,
  DelegatingSupervisorConfig,
  PlanAndDelegateOptions,
  TaskAssignment,
} from './delegating-supervisor-types.js'

export type { DuplicateSpecialistAssignmentIdMode } from './assignment-validator.js'
export type {
  AggregatedDelegationResult,
  DelegateTaskOptions,
  DelegatingSupervisorConfig,
  PlanAndDelegateOptions,
  SubOrchestratorSpawnOptions,
  TaskAssignment,
} from './delegating-supervisor-types.js'
export {
  MAX_ORCHESTRATION_DEPTH,
  assertDepthAllowed,
} from './delegating-supervisor-types.js'

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
      } else {
        this.recordCircuitBreakerFailure(specialistId, result.error)
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

    guardDuplicateSpecialistAssignmentIds(
      effectiveTasks,
      this.duplicateSpecialistAssignmentIdMode,
      this.eventBus,
    )

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

    return aggregateSettledResults(
      omitUndefined({
        startedAt: start,
        assignments: effectiveTasks,
        settled,
        circuitBreaker: this.circuitBreaker,
        mergeStrategy: this.mergeStrategy,
        eventBus: this.eventBus,
      }),
    )
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
    const subtasks = decomposeGoal(goal)
    const assignments: TaskAssignment[] = this.routingPolicy
      ? routeSubtasksViaPolicy(
          subtasks,
          this.routingPolicy,
          toAgentSpecs(this.specialists, this.circuitBreaker),
          this.eventBus,
        )
      : matchSubtasksToSpecialists(subtasks, this.specialists)

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

  private recordCircuitBreakerFailure(specialistId: string, error: unknown): void {
    recordCircuitBreakerFailure(this.circuitBreaker, specialistId, error)
  }
}
