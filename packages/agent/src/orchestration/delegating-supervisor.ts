/**
 * DelegatingSupervisor — wires SimpleDelegationTracker into the supervisor
 * orchestration pattern so a supervisor agent can delegate tasks to
 * specialist agents using the typed delegation protocol.
 *
 * This module depends ONLY on `@dzupagent/core` types (AgentExecutionSpec,
 * RunStore, DzupEventBus). It does NOT import from `@dzupagent/server`
 * or any other sibling package.
 */

import type { AgentExecutionSpec } from "@dzupagent/core/persistence";
import type { DzupEventBus } from "@dzupagent/core/events";
import { OrchestrationError } from "./orchestration-error.js";
import type {
  DelegationTracker,
  DelegationRequest,
  DelegationResult,
  DelegationContext,
  DelegationHierarchy,
} from "./delegation.js";
import type { ProviderExecutionPort } from "./provider-adapter/provider-execution-port.js";
import type { RoutingPolicy } from "./routing-policy-types.js";
import type { OrchestrationMergeStrategy } from "./orchestration-merge-strategy-types.js";
import type { AgentCircuitBreaker } from "./circuit-breaker.js";
import { omitUndefined } from "../utils/exact-optional.js";
import {
  markCircuitBreakerRecorded,
  recordCircuitBreakerFailure,
} from "./circuit-breaker-recorder.js";
import { aggregateSettledResults } from "./parallel-delegation-aggregator.js";
import {
  guardDuplicateSpecialistAssignmentIds,
  type DuplicateSpecialistAssignmentIdMode,
} from "./assignment-validator.js";
import {
  decomposeGoal,
  matchSubtasksToSpecialists,
  routeSubtasksViaPolicy,
  toAgentSpecs,
} from "./specialist-selection.js";
import type {
  AggregatedDelegationResult,
  DelegateTaskOptions,
  DelegatingSupervisorConfig,
  PlanAndDelegateOptions,
  SupervisorHierarchy,
  TaskAssignment,
} from "./delegating-supervisor-types.js";
import { assertDepthAllowed as assertOrchestrationDepthAllowed } from "./delegating-supervisor-types.js";

export type { DuplicateSpecialistAssignmentIdMode } from "./assignment-validator.js";
export type {
  AggregatedDelegationResult,
  DelegateTaskOptions,
  DelegatingSupervisorConfig,
  PlanAndDelegateOptions,
  SubOrchestratorSpawnOptions,
  SupervisorHierarchy,
  TaskAssignment,
} from "./delegating-supervisor-types.js";
export {
  MAX_ORCHESTRATION_DEPTH,
  assertDepthAllowed,
} from "./delegating-supervisor-types.js";

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DelegatingSupervisor {
  private readonly specialists: Map<string, AgentExecutionSpec>;
  private readonly tracker: DelegationTracker;
  private readonly parentContext: DelegationContext | undefined;
  private readonly eventBus: DzupEventBus | undefined;
  private readonly providerPort: ProviderExecutionPort | undefined;
  private readonly routingPolicy: RoutingPolicy | undefined;
  private readonly mergeStrategy: OrchestrationMergeStrategy | undefined;
  private readonly circuitBreaker: AgentCircuitBreaker | undefined;
  private readonly duplicateSpecialistAssignmentIdMode: DuplicateSpecialistAssignmentIdMode;

  // ── Hierarchy (ORCHESTRATION_V2) ──
  private readonly hierarchyParentRunId: string | undefined;
  private readonly hierarchyBranchId: string | undefined;
  private readonly hierarchyDepth: number;
  /**
   * Pre-resolved hierarchy stamped onto every delegation this supervisor
   * issues, or `undefined` for a root supervisor with no hierarchy configured.
   *
   * Kept `undefined` (rather than `{ depth: 0 }`) in the root case so that
   * requests and metadata omit the `hierarchy` key entirely and stay
   * byte-identical to a pre-hierarchy build — the dominant caller shape.
   */
  private readonly delegationHierarchy: DelegationHierarchy | undefined;

  constructor(config: DelegatingSupervisorConfig) {
    // Enforce the orchestration depth ceiling before any wiring happens, so a
    // too-deep supervisor fails fast at construction rather than at delegation
    // time. Root supervisors (depth unset) normalize to 0 and always pass.
    this.hierarchyDepth = config.depth ?? 0;
    assertOrchestrationDepthAllowed(this.hierarchyDepth);

    this.hierarchyParentRunId = config.parentRunId;
    this.hierarchyBranchId = config.branchId;

    // Resolve the hierarchy stamped onto issued delegations exactly once.
    // A supervisor with NO hierarchy signal at all (root: no parentRunId, no
    // branchId, no explicit depth) stamps nothing, so its delegations are
    // byte-identical to a pre-hierarchy build. An explicit `depth: 0` is a
    // deliberate signal and is preserved.
    const hasHierarchySignal =
      config.parentRunId !== undefined ||
      config.branchId !== undefined ||
      config.depth !== undefined;
    this.delegationHierarchy = hasHierarchySignal
      ? omitUndefined({
          parentRunId: config.parentRunId,
          branchId: config.branchId,
          // The issuing supervisor's OWN depth — a delegation targets a
          // specialist leaf, not another orchestrator level, so this is not
          // incremented. See DelegationHierarchy.depth.
          depth: this.hierarchyDepth,
        })
      : undefined;

    this.specialists = config.specialists;
    this.tracker = config.tracker;
    this.parentContext = config.parentContext;
    this.eventBus = config.eventBus;
    this.providerPort = config.providerPort;
    this.routingPolicy = config.routingPolicy;
    this.mergeStrategy = config.mergeStrategy;
    this.circuitBreaker = config.circuitBreaker;
    this.duplicateSpecialistAssignmentIdMode =
      config.duplicateSpecialistAssignmentIdMode ?? "warn";
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
    options?: DelegateTaskOptions
  ): Promise<DelegationResult> {
    const specialist = this.specialists.get(specialistId);
    if (!specialist) {
      throw new OrchestrationError(
        `Specialist "${specialistId}" not found. Available: ${[
          ...this.specialists.keys(),
        ].join(", ")}`,
        "delegation",
        { specialistId, available: [...this.specialists.keys()] }
      );
    }

    this.eventBus?.emit({
      type: "supervisor:delegating",
      specialistId,
      task,
    });

    // Route through provider port when configured
    if (this.providerPort) {
      const tags: string[] = (specialist.metadata?.tags ?? []) as string[];
      const startedAt = Date.now();
      let portResult: Awaited<ReturnType<ProviderExecutionPort["run"]>>;
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
          })
        );
      } catch (err: unknown) {
        this.recordCircuitBreakerFailure(specialistId, err);
        markCircuitBreakerRecorded(err);
        throw err;
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
          // Provider-port execution bypasses the tracker lifecycle, so stamp
          // the same tree attribution here. `undefined` for root supervisors,
          // which omitUndefined then drops entirely.
          hierarchy: this.delegationHierarchy,
        }),
      };

      this.circuitBreaker?.recordSuccess(specialistId);

      this.eventBus?.emit({
        type: "supervisor:delegation_complete",
        specialistId,
        task,
        success: true,
      });

      return delegationResult;
    }

    // `context` and `hierarchy` are independent siblings: the caller-supplied
    // parentContext (carrying the per-delegation parentRunId) is passed through
    // untouched, while the orchestrator-hierarchy parent travels under
    // `hierarchy`. Neither can clobber the other.
    const request: DelegationRequest = omitUndefined({
      targetAgentId: specialistId,
      task,
      input,
      context: this.parentContext,
      hierarchy: this.delegationHierarchy,
    });

    let result: DelegationResult;
    try {
      result = await this.tracker.delegate(request);
    } catch (err: unknown) {
      this.recordCircuitBreakerFailure(specialistId, err);
      markCircuitBreakerRecorded(err);
      throw err;
    }

    // Record circuit breaker outcome
    if (this.circuitBreaker) {
      if (result.success) {
        this.circuitBreaker.recordSuccess(specialistId);
      } else {
        this.recordCircuitBreakerFailure(specialistId, result.error);
      }
    }

    this.eventBus?.emit({
      type: "supervisor:delegation_complete",
      specialistId,
      task,
      success: result.success,
    });

    return result;
  }

  /**
   * Delegate multiple tasks in parallel and collect all results.
   *
   * Uses Promise.allSettled so one failure does not block others.
   */
  async delegateAndCollect(
    tasks: TaskAssignment[]
  ): Promise<AggregatedDelegationResult> {
    const start = Date.now();

    // Filter tasks through circuit breaker if configured
    let effectiveTasks = tasks;
    if (this.circuitBreaker) {
      const availableIds = new Set(
        this.circuitBreaker
          .filterAvailable(
            [...this.specialists.entries()].map(([id]) => ({ id }))
          )
          .map((a) => a.id)
      );
      const filtered = tasks.filter((t) => availableIds.has(t.specialistId));
      if (filtered.length < tasks.length) {
        const skipped = tasks
          .filter((t) => !availableIds.has(t.specialistId))
          .map((t) => t.specialistId);
        this.eventBus?.emit({
          type: "supervisor:circuit_breaker_filtered",
          skipped,
        });
      }
      effectiveTasks = filtered;
    }

    guardDuplicateSpecialistAssignmentIds(
      effectiveTasks,
      this.duplicateSpecialistAssignmentIdMode,
      this.eventBus
    );

    // Validate all specialists exist before starting any work
    for (const assignment of effectiveTasks) {
      if (!this.specialists.has(assignment.specialistId)) {
        throw new OrchestrationError(
          `Specialist "${assignment.specialistId}" not found. Available: ${[
            ...this.specialists.keys(),
          ].join(", ")}`,
          "delegation",
          {
            specialistId: assignment.specialistId,
            available: [...this.specialists.keys()],
          }
        );
      }
    }

    const settled = await Promise.allSettled(
      effectiveTasks.map((t) =>
        this.delegateTask(t.task, t.specialistId, t.input)
      )
    );

    return aggregateSettledResults(
      omitUndefined({
        startedAt: start,
        assignments: effectiveTasks,
        settled,
        circuitBreaker: this.circuitBreaker,
        mergeStrategy: this.mergeStrategy,
        eventBus: this.eventBus,
      })
    );
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
    options?: PlanAndDelegateOptions
  ): Promise<AggregatedDelegationResult> {
    if (options?.llm) {
      try {
        const { PlanningAgent } = await import("./planning-agent.js");
        const planner = new PlanningAgent({ supervisor: this });
        const plan = await planner.decompose(
          goal,
          options.llm,
          omitUndefined({
            signal: options.signal,
            acknowledgeUnresolvedNodes: options.acknowledgeUnresolvedNodes,
          })
        );

        this.eventBus?.emit({
          type: "supervisor:plan_created",
          goal,
          assignments: plan.nodes.map((n) => ({
            task: n.task,
            specialistId: n.specialistId,
          })),
          source: "llm",
        });

        const result = await planner.executePlan(plan);

        // Convert PlanExecutionResult to AggregatedDelegationResult
        const succeeded: string[] = [];
        const failed: string[] = [];
        for (const [nodeId, delegationResult] of result.results) {
          if (delegationResult.success) {
            succeeded.push(nodeId);
          } else {
            failed.push(nodeId);
          }
        }

        return {
          results: result.results,
          succeeded,
          failed,
          totalDurationMs: result.totalDurationMs,
        };
      } catch (err: unknown) {
        // Fall back to keyword splitting on LLM failure
        this.eventBus?.emit({
          type: "supervisor:llm_decompose_fallback",
          goal,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Use routing policy if configured, otherwise fall back to keyword matching
    const subtasks = decomposeGoal(goal);
    const assignments: TaskAssignment[] = this.routingPolicy
      ? routeSubtasksViaPolicy(
          subtasks,
          this.routingPolicy,
          toAgentSpecs(this.specialists, this.circuitBreaker),
          this.eventBus
        )
      : matchSubtasksToSpecialists(subtasks, this.specialists);

    if (assignments.length === 0) {
      throw new OrchestrationError(
        `No specialists matched any sub-tasks from goal: "${goal}"`,
        "delegation",
        { subtasks, availableSpecialists: [...this.specialists.keys()] }
      );
    }

    this.eventBus?.emit({
      type: "supervisor:plan_created",
      goal,
      assignments: assignments.map((a) => ({
        task: a.task,
        specialistId: a.specialistId,
      })),
      source: "keyword",
    });

    return this.delegateAndCollect(assignments);
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Return the list of registered specialist IDs. */
  get specialistIds(): string[] {
    return [...this.specialists.keys()];
  }

  /** Return the specialist definition by ID, or undefined. */
  getSpecialist(id: string): AgentExecutionSpec | undefined {
    return this.specialists.get(id);
  }

  /**
   * This supervisor's position in the orchestration hierarchy
   * (ORCHESTRATION_V2).
   *
   * ## parentRunId disambiguation
   *
   * There are two distinct `parentRunId` concepts in this package and they
   * MUST NOT be conflated:
   *
   * 1. `hierarchy.parentRunId` (this one) — the ORCHESTRATOR-hierarchy parent:
   *    the run of the supervisor that spawned *this supervisor* as a
   *    sub-orchestrator. Supplied via `DelegatingSupervisorConfig.parentRunId`.
   *    `undefined` for root supervisors.
   *
   * 2. `DelegationContext.parentRunId` — the DELEGATION parent: the run that is
   *    issuing an individual delegation to a specialist. Supplied via
   *    `DelegatingSupervisorConfig.parentContext` and consumed by
   *    `SimpleDelegationTracker` (see `delegation.ts`, which reads
   *    `request.context?.parentRunId`) to stamp run metadata and
   *    `delegation:*` events.
   *
   * For a root supervisor these are unrelated: (2) is typically set while
   * (1) is not.
   *
   * ## What is propagated
   *
   * All three fields are propagated into delegation records as a nested
   * {@link DelegationHierarchy} object, kept strictly separate from (2):
   *
   * - `DelegationRequest.hierarchy` — stamped on every delegation this
   *   supervisor issues, alongside (never merged into) `context`.
   * - `RunStore` run metadata — stamped by `startDelegation`.
   * - `DelegationMetadata.hierarchy` — echoed onto the result by
   *   `finalizeSuccess` / `finalizeFailure`, and by the provider-port path,
   *   so a completed or failed delegation carries its tree position.
   *
   * A supervisor with no hierarchy signal at all (no `parentRunId`, no
   * `branchId`, no explicit `depth`) stamps nothing: the `hierarchy` key is
   * omitted entirely and its delegation records are byte-identical to a
   * pre-hierarchy build. An explicit `depth: 0` is treated as a deliberate
   * signal and is preserved.
   *
   * `hierarchy.depth` on a delegation is the *issuing supervisor's own* depth,
   * not that depth plus one: a delegation targets a specialist leaf rather
   * than another orchestrator level, so it does not descend the tree.
   *
   * ## Still not wired
   *
   * The `delegation:*` event payloads in `@dzupagent/core/events` still carry
   * no hierarchy fields; adding them is a cross-package contract change and
   * remains out of scope. Overloading `DelegationContext.parentRunId` to carry
   * concept (1) is explicitly rejected.
   *
   * Likewise, no recursive sub-orchestrator spawning exists yet — this
   * supervisor delegates only to *specialist agents*, never to another
   * `DelegatingSupervisor` — so the depth guard is enforced at construction
   * time (fail fast on a too-deep supervisor) rather than at a child-dispatch
   * site, because no such site exists. See `SubOrchestratorSpawnOptions`,
   * which remains an unimplemented forward declaration.
   */
  get hierarchy(): SupervisorHierarchy {
    return {
      parentRunId: this.hierarchyParentRunId,
      branchId: this.hierarchyBranchId,
      depth: this.hierarchyDepth,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private recordCircuitBreakerFailure(
    specialistId: string,
    error: unknown
  ): void {
    recordCircuitBreakerFailure(this.circuitBreaker, specialistId, error);
  }
}
