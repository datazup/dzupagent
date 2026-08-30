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
import { spawnSubOrchestrator } from "./delegation/spawn-sub-orchestrator.js";
import {
  DEFAULT_ORCHESTRATION_FANOUT,
  runConcurrently,
} from "./concurrency-runner.js";
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
  PlanAndDelegateOptions,
  SubOrchestratorChildHierarchy,
  SubOrchestratorSpawnOptions,
  SupervisorHierarchy,
  TaskAssignment,
  SubOrchestratorChild,
} from "./delegating-supervisor-types.js";
import { assertDepthAllowed as assertOrchestrationDepthAllowed } from "./delegating-supervisor-types.js";

function supervisorAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function throwIfSupervisorAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw supervisorAbortReason(signal);
  }
}

function isAbortLike(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      (error.name === "AbortError" || error.name === "ModelCancellationError")
  );
}

export type { DuplicateSpecialistAssignmentIdMode } from "./assignment-validator.js";
export type {
  AggregatedDelegationResult,
  DelegateTaskOptions,
  PlanAndDelegateOptions,
  SubOrchestratorChildHierarchy,
  SubOrchestratorSpawnOptions,
  SupervisorHierarchy,
  TaskAssignment,
} from "./delegating-supervisor-types.js";
export {
  MAX_ORCHESTRATION_DEPTH,
  assertDepthAllowed,
} from "./delegating-supervisor-types.js";

/** Configuration for DelegatingSupervisor. */
export interface DelegatingSupervisorConfig {
  /** Map of specialist ID -> AgentExecutionSpec metadata */
  specialists: Map<string, AgentExecutionSpec>;
  /** The delegation tracker that executes delegations */
  tracker: DelegationTracker;
  /** Parent run context for delegation requests */
  parentContext?: DelegationContext;
  /** Event bus for lifecycle events */
  eventBus?: DzupEventBus;
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
  duplicateSpecialistAssignmentIdMode?: DuplicateSpecialistAssignmentIdMode;
  /**
   * Provider execution port for adapter-based execution.
   * When set, `delegateTask` routes through `providerPort.run()`
   * instead of the delegation tracker.
   */
  providerPort?: ProviderExecutionPort;
  /**
   * Pluggable routing policy for agent selection.
   * When not set, the existing keyword/LLM-based selection is used.
   */
  routingPolicy?: RoutingPolicy;
  /**
   * Pluggable merge strategy for combining parallel delegation results.
   * Defaults to UsePartialMergeStrategy behavior when not set.
   */
  mergeStrategy?: OrchestrationMergeStrategy;
  /**
   * Circuit breaker for excluding unhealthy agents from routing.
   * When set, agents with tripped circuits are filtered out before selection.
   */
  circuitBreaker?: AgentCircuitBreaker;
  /**
   * Builds the CHILD supervisor when `spawnSubOrchestrator` dispatches a
   * subtask to another `DelegatingSupervisor`.
   *
   * Optional: a supervisor with no factory cannot spawn children and
   * `spawnSubOrchestrator` throws rather than guessing the child's wiring. Can
   * also be supplied per-call.
   */
  subOrchestratorFactory?: SubOrchestratorFactory;
  // ── Hierarchy (ORCHESTRATION_V2) ──
  /**
   * ID of the parent run when this supervisor is itself a sub-orchestrator.
   *
   * NOTE: this is the *orchestrator-hierarchy* parent and is a DIFFERENT
   * concept from {@link DelegationContext.parentRunId}, which identifies the
   * run issuing an individual delegation. See `DelegatingSupervisor.hierarchy`
   * for the full disambiguation.
   */
  parentRunId?: string;
  /** Branch identifier when running inside a parallel/conditional tree. */
  branchId?: string;
  /**
   * Depth in orchestration hierarchy. Root = 0.
   *
   * Validated at construction time against {@link MAX_ORCHESTRATION_DEPTH};
   * constructing a supervisor at or beyond the limit throws.
   */
  depth?: number;
  /**
   * This supervisor's OWN run ID — a THIRD distinct identity, separate from
   * both {@link parentRunId} (its orchestrator parent) and
   * {@link DelegationContext.parentRunId} (the run issuing an individual
   * delegation).
   *
   * Required only to spawn a child sub-orchestrator: it becomes the child's
   * `SupervisorHierarchy.parentRunId`. Without it a supervisor cannot name
   * itself as anyone's parent, and `spawnSubOrchestrator` throws rather than
   * substituting a different identity.
   *
   * Deliberately NOT defaulted from `parentContext.parentRunId`: that field is
   * the DELEGATION parent (the run issuing a delegation to a specialist), which
   * is a different concept and would silently mis-attribute the tree.
   */
  runId?: string;
}

/**
 * Builds the CHILD supervisor for a sub-orchestrator dispatch.
 *
 * The spawning supervisor cannot invent the child's specialists or delegation
 * tracker — those are wiring decisions owned by the composition root — so it
 * derives only the hierarchy and delegates construction here. The factory is
 * responsible for passing `hierarchy` through onto the child config unchanged;
 * a factory that drops or rewrites it is rejected by `spawnSubOrchestrator`.
 *
 * Declared here rather than in `./delegating-supervisor-types.js` because it
 * names the concrete {@link DelegatingSupervisor} class; see that module's
 * layering rule.
 */
export type SubOrchestratorFactory = (args: {
  /** Pre-validated hierarchy the child MUST be constructed with. */
  hierarchy: SubOrchestratorChildHierarchy;
  /** The original spawn request, for persona/provider/budget wiring. */
  options: SubOrchestratorSpawnOptions;
}) => DelegatingSupervisor | Promise<DelegatingSupervisor>;

/**
 * Outcome of a sub-orchestrator dispatch.
 *
 * Carries the child's aggregated delegation result alongside the hierarchy the
 * child actually ran with, so a caller can assert tree position without
 * re-deriving it.
 *
 * Declared here rather than in `./delegating-supervisor-types.js` because it
 * names the concrete {@link DelegatingSupervisor} class; see that module's
 * layering rule.
 */
export interface SubOrchestratorSpawnResult {
  /** Hierarchy the child supervisor was constructed with. */
  hierarchy: SubOrchestratorChildHierarchy;
  /** The child supervisor instance, for follow-up dispatches. */
  supervisor: DelegatingSupervisor;
  /** Aggregated result of the child's own delegation batch. */
  result: AggregatedDelegationResult;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DelegatingSupervisor implements SubOrchestratorChild {
  private readonly specialists: Map<string, AgentExecutionSpec>;
  private readonly tracker: DelegationTracker;
  private readonly parentContext: DelegationContext | undefined;
  private readonly eventBus: DzupEventBus | undefined;
  private readonly providerPort: ProviderExecutionPort | undefined;
  private readonly routingPolicy: RoutingPolicy | undefined;
  private readonly mergeStrategy: OrchestrationMergeStrategy | undefined;
  private readonly circuitBreaker: AgentCircuitBreaker | undefined;
  private readonly duplicateSpecialistAssignmentIdMode: DuplicateSpecialistAssignmentIdMode;

  private readonly subOrchestratorFactory: SubOrchestratorFactory | undefined;

  // ── Hierarchy (ORCHESTRATION_V2) ──
  private readonly hierarchyParentRunId: string | undefined;
  private readonly hierarchyBranchId: string | undefined;
  private readonly hierarchyDepth: number;
  /** This supervisor's OWN run ID, used when naming itself a child's parent. */
  private readonly ownRunId: string | undefined;
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
    this.ownRunId = config.runId;

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
    this.subOrchestratorFactory = config.subOrchestratorFactory;
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

      // Mint the delegation identity BEFORE the provider call so the whole
      // lifecycle correlates on one key. Same convention as the tracker
      // (`delegation.ts`): a fresh UUID, and the DELEGATION parent resolved from
      // the parent context, falling back to the literal "unknown" when this
      // supervisor was built without one. `parentContext` is the provider-port
      // equivalent of the tracker's `request.context`.
      const delegationId = crypto.randomUUID();
      const parentRunId = this.parentContext?.parentRunId ?? "unknown";

      // Emitted before the provider call so no delegation can ever surface a
      // terminal event without a preceding start. Spread-when-present keeps a
      // root supervisor's payload byte-identical to a pre-change build.
      this.eventBus?.emit({
        type: "delegation:started",
        parentRunId,
        targetAgentId: specialistId,
        delegationId,
        ...(this.delegationHierarchy
          ? { hierarchy: this.delegationHierarchy }
          : {}),
      });

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
        // Terminal event before the existing circuit-breaker + rethrow, which
        // are preserved exactly: the error still propagates unchanged.
        //
        // Always `delegation:failed`, never `:timeout` or `:cancelled`. This
        // path owns no AbortController and starts no timer, so it cannot
        // reproduce the signals `finalizeFailure` classifies on: a timeout
        // there is detected via an abort reason the tracker's own setTimeout
        // wrote, and a cancellation via the tracker's `cancelledByUser` set.
        // Neither exists here, so the distinction would be fabricated.
        this.eventBus?.emit({
          type: "delegation:failed",
          parentRunId,
          targetAgentId: specialistId,
          delegationId,
          error: err instanceof Error ? err.message : String(err),
        });

        this.recordCircuitBreakerFailure(specialistId, err);
        markCircuitBreakerRecorded(err);
        throw err;
      }

      // One measurement shared by the event and the result metadata, so the
      // emitted durationMs can never disagree with metadata.durationMs.
      const durationMs = Date.now() - startedAt;

      const delegationResult: DelegationResult = {
        success: true,
        output: portResult.content,
        metadata: omitUndefined({
          durationMs,
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
        type: "delegation:completed",
        parentRunId,
        targetAgentId: specialistId,
        delegationId,
        durationMs,
        success: true,
      });

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
   * One failure does not block others. Fan-out is capped at
   * `options.maxConcurrency` (default {@link DEFAULT_ORCHESTRATION_FANOUT});
   * callers that already chunk their own work — `planning-executor.ts` sizes
   * batches by `maxParallelism` — can pass a larger cap to opt out of the
   * second layer of bounding.
   */
  async delegateAndCollect(
    tasks: TaskAssignment[],
    options?: { maxConcurrency?: number; signal?: AbortSignal }
  ): Promise<AggregatedDelegationResult> {
    throwIfSupervisorAborted(options?.signal);
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

    // ORCH-DSL-L1-H-07 — bounded fan-out. `delegateTask` is a full model /
    // provider-port invocation, and this previously dispatched one per task
    // simultaneously with no cap. `runConcurrently` is the allSettled half of
    // the pair and preserves input order, which `aggregateSettledResults`
    // depends on to pair `settled[i]` with `assignments[i]`.
    const settled = await runConcurrently(
      effectiveTasks.map(
        (t) => (runnerSignal) => {
          throwIfSupervisorAborted(runnerSignal);
          return runnerSignal
            ? this.delegateTask(t.task, t.specialistId, t.input, {
                signal: runnerSignal,
              })
            : this.delegateTask(t.task, t.specialistId, t.input);
        }
      ),
      options?.maxConcurrency ?? DEFAULT_ORCHESTRATION_FANOUT,
      options?.signal ? { signal: options.signal } : undefined
    );
    throwIfSupervisorAborted(options?.signal);

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
    throwIfSupervisorAborted(options?.signal);

    if (options?.llm) {
      const planned = await (async () => {
        try {
          const { PlanningAgent } = await import("./planning-agent.js");
          const planner = new PlanningAgent({ supervisor: this });
          const plan = await planner.decompose(
            goal,
            options.llm!,
            omitUndefined({
              signal: options.signal,
              acknowledgeUnresolvedNodes: options.acknowledgeUnresolvedNodes,
            })
          );
          return { planner, plan };
        } catch (err: unknown) {
          if (options.signal?.aborted) {
            throw supervisorAbortReason(options.signal);
          }
          if (isAbortLike(err)) {
            throw err;
          }
          // Fall back to keyword splitting on genuine decomposition failure.
          this.eventBus?.emit({
            type: "supervisor:llm_decompose_fallback",
            goal,
            error: err instanceof Error ? err.message : String(err),
          });
          return undefined;
        }
      })();

      if (planned) {
        throwIfSupervisorAborted(options.signal);
        this.eventBus?.emit({
          type: "supervisor:plan_created",
          goal,
          assignments: planned.plan.nodes.map((n) => ({
            task: n.task,
            specialistId: n.specialistId,
          })),
          source: "llm",
        });

        const result = options.signal
          ? await planned.planner.executePlan(planned.plan, {
              signal: options.signal,
            })
          : await planned.planner.executePlan(planned.plan);
        throwIfSupervisorAborted(options.signal);

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
      }
    }

    throwIfSupervisorAborted(options?.signal);
    // Use routing policy if configured, otherwise fall back to keyword matching
    const subtasks = decomposeGoal(goal);
    const assignments: TaskAssignment[] = this.routingPolicy
      ? routeSubtasksViaPolicy(
          subtasks,
          this.routingPolicy,
          toAgentSpecs(this.specialists, this.circuitBreaker),
          this.eventBus,
          options?.routingTask
        )
      : matchSubtasksToSpecialists(subtasks, this.specialists);

    if (assignments.length === 0) {
      throw new OrchestrationError(
        `No specialists matched any sub-tasks from goal: "${goal}"`,
        "delegation",
        { subtasks, availableSpecialists: [...this.specialists.keys()] }
      );
    }

    throwIfSupervisorAborted(options?.signal);
    this.eventBus?.emit({
      type: "supervisor:plan_created",
      goal,
      assignments: assignments.map((a) => ({
        task: a.task,
        specialistId: a.specialistId,
      })),
      source: "keyword",
    });

    const result = options?.signal
      ? await this.delegateAndCollect(assignments, { signal: options.signal })
      : await this.delegateAndCollect(assignments);
    throwIfSupervisorAborted(options?.signal);
    return result;
  }

  // -------------------------------------------------------------------------
  // Recursive sub-orchestration (ORCHESTRATION_V2)
  // -------------------------------------------------------------------------

  /**
   * Dispatch a subtask to a CHILD `DelegatingSupervisor`, descending one
   * orchestrator level. See `delegation/spawn-sub-orchestrator.ts` for the
   * hierarchy-derivation rules and the depth-guard reasoning.
   */
  async spawnSubOrchestrator(
    options: SubOrchestratorSpawnOptions,
    factory?: SubOrchestratorFactory
  ): Promise<SubOrchestratorSpawnResult> {
    return spawnSubOrchestrator(
      {
        hierarchyDepth: this.hierarchyDepth,
        ownRunId: this.ownRunId,
        subOrchestratorFactory: this.subOrchestratorFactory,
      },
      options,
      factory
    );
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
   * - `delegation:started` event payload — emitted as a nested `hierarchy`
   *   object by `startDelegation` on the tracker path and by `delegateTask`
   *   itself on the provider-port path, so an OUT-OF-PROCESS observer can
   *   rebuild the orchestration tree from the event stream alone.
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
   * ## Provider-port lifecycle
   *
   * The provider-port path (`delegateTask` early-returns when `providerPort` is
   * configured) emits a `delegation:*` lifecycle of its own, in addition to the
   * `supervisor:delegating` / `supervisor:delegation_complete` pair it has
   * always emitted. Without it, every delegation routed through a provider port
   * was invisible to the `forge_delegation_*_total` metrics in
   * `@dzupagent/otel`, which are driven exclusively off `delegation:*` events.
   *
   * It mints its own `delegationId` (fresh UUID) and resolves `parentRunId` from
   * `parentContext?.parentRunId`, falling back to `"unknown"` — the same
   * convention `SimpleDelegationTracker.delegate` uses, so both paths produce
   * indistinguishable event identities. `delegation:started` is emitted before
   * the provider call and the terminal event after it, so no delegation ever
   * appears with a terminal event and no start. Its `delegation:started` carries
   * `hierarchy` on the same spread-when-present basis as the tracker path.
   *
   * Only two of the five events are reachable here: `delegation:started` and
   * then either `delegation:completed` or `delegation:failed`.
   * `delegation:timeout` and `delegation:cancelled` are deliberately NOT
   * emitted. This path owns no `AbortController` and starts no timer, so it
   * cannot reproduce either signal `finalizeFailure` classifies on — a timeout
   * there is recognized by an abort reason written by the tracker's own
   * `setTimeout`, and a cancellation by the tracker's `cancelledByUser` set.
   * The caller-supplied `options.signal` aborting surfaces here as an ordinary
   * throw with no reliable provenance, so classifying it would be fabricating a
   * distinction the path cannot actually observe. An abort therefore counts as
   * `delegation:failed`; `forge_delegation_timeout_total` and
   * `forge_delegation_cancelled_total` stay at zero for provider-port
   * delegations by design, not by omission.
   *
   * Beyond `started`, the terminal `delegation:*` events do not carry
   * `hierarchy` on either path. They are unreachable without a preceding
   * `started` event bearing the same `delegationId` on the same bus, so the
   * tree position is already correlatable and extra copies of an immutable
   * value would be redundancy, not information. That path additionally
   * attributes the tree position via `DelegationMetadata.hierarchy` on its
   * returned result. Overloading `DelegationContext.parentRunId` to carry
   * concept (1) remains explicitly rejected.
   *
   * ## Sub-orchestrator spawning
   *
   * {@link spawnSubOrchestrator} dispatches a subtask to a CHILD
   * `DelegatingSupervisor`, so the tree now descends through orchestrator
   * levels and not only into specialist leaves. `SubOrchestratorSpawnOptions`
   * is no longer a forward declaration: it is that method's request type.
   *
   * The depth guard is consequently enforced at two independent places, and
   * they check different things:
   *
   * - **Dispatch site** (`spawnSubOrchestrator`) — `assertDepthAllowed` on the
   *   *child's prospective* depth, before the factory runs. Makes the
   *   dispatch-site verdict truthful: past the guard, the child is
   *   constructable. Deepest depth a supervisor may spawn FROM is 1.
   * - **Construction** (the constructor) — `assertDepthAllowed` on the
   *   supervisor's *own* depth, unchanged. Still fails fast on a too-deep
   *   supervisor built directly, bypassing any spawn. Deepest depth a
   *   supervisor may exist AT is 2.
   *
   * The child's `parentRunId` is concept (1) above — the spawner's OWN run ID,
   * supplied as `DelegatingSupervisorConfig.runId`, a third identity distinct
   * from both this supervisor's `hierarchy.parentRunId` and its
   * `parentContext.parentRunId`. A supervisor without `runId` cannot spawn:
   * `spawnSubOrchestrator` throws rather than substituting concept (2), which
   * would mis-attribute the tree. Overloading (2) to carry (1) remains
   * explicitly rejected here as everywhere else.
   *
   * ### Events deliberately NOT emitted
   *
   * A sub-orchestrator dispatch emits NO event of its own, and this is a
   * decision rather than an omission. The only established shapes are
   * `delegation:*` and `supervisor:*`, and neither can describe this truthfully:
   *
   * - `delegation:*` drives the `forge_delegation_*_total` metrics in
   *   `@dzupagent/otel`, which count delegations to specialist agents. A child
   *   orchestrator is not a specialist, and its `targetAgentId` would name
   *   something absent from any `specialists` map — inflating those counters
   *   with a different kind of event.
   * - `supervisor:delegating` / `supervisor:delegation_complete` are keyed on
   *   `specialistId`, with the same problem.
   *
   * Inventing a `suborchestrator:*` family, or widening the shared union to
   * accommodate this one call site, was rejected. It is also unnecessary: the
   * spawn is already fully observable without it, because the child stamps
   * `hierarchy` = `{ parentRunId: <spawner run>, branchId, depth }` onto every
   * `delegation:started` it emits. An out-of-process observer therefore
   * reconstructs the parent→child edge from the child's own event stream, which
   * is the same mechanism used for every other tree attribution here.
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
