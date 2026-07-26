/**
 * Public type declarations for {@link DelegatingSupervisor}.
 *
 * Co-located in their own module so the supervisor implementation file stays
 * focused on behavior. The runtime entry point re-exports these types for
 * backward compatibility.
 */

import type { AgentExecutionSpec } from "@dzupagent/core/persistence";
import type { DzupEventBus } from "@dzupagent/core/events";
import type { AgentCircuitBreaker } from "./circuit-breaker.js";
import type {
  DelegationContext,
  DelegationResult,
  DelegationTracker,
} from "./delegation.js";
import type { OrchestrationMergeStrategy } from "./orchestration-merge-strategy-types.js";
// Type-only, so this back-reference to the implementation module is erased at
// compile time and creates no runtime import cycle.
import type { DelegatingSupervisor } from "./delegating-supervisor.js";
import type { ProviderExecutionPort } from "./provider-adapter/provider-execution-port.js";
import type { RoutingPolicy } from "./routing-policy-types.js";
import type { StructuredLLM } from "../structured/structured-output-engine.js";
import type { DuplicateSpecialistAssignmentIdMode } from "./assignment-validator.js";

/** Options for LLM-powered planAndDelegate. */
export interface PlanAndDelegateOptions {
  /** LLM instance for goal decomposition. When provided, uses LLM-powered planning. */
  llm?: StructuredLLM;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /**
   * Explicitly acknowledge unresolved LLM planning nodes/dependencies.
   *
   * By default, unresolved decomposition output fails before execution and this
   * supervisor falls back to keyword planning. When true, PlanningAgent removes
   * unresolved nodes/dependencies deterministically before execution.
   */
  acknowledgeUnresolvedNodes?: boolean;
}

/** A single task assignment for parallel delegation. */
export interface TaskAssignment {
  /** Stable key for this assignment, used to aggregate duplicate-specialist batches. */
  id?: string;
  /** Human-readable sub-task description */
  task: string;
  /** ID of the specialist to delegate to */
  specialistId: string;
  /** Structured input for the specialist */
  input: Record<string, unknown>;
}

/** Aggregated result from delegateAndCollect. */
export interface AggregatedDelegationResult {
  /** Results keyed by assignment ID when provided, otherwise by specialist ID */
  results: Map<string, DelegationResult>;
  /** Result keys that succeeded */
  succeeded: string[];
  /** Result keys that failed */
  failed: string[];
  /** Total wall-clock time for the parallel batch (ms) */
  totalDurationMs: number;
}

/** Options for a single delegated task execution. */
export interface DelegateTaskOptions {
  /** Stable run ID to correlate provider-port execution. */
  runId?: string;
  /** Abort signal for provider-port cancellation. */
  signal?: AbortSignal;
}

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
 * Read-only view of a supervisor's position in the orchestration hierarchy.
 *
 * `parentRunId` here is the ORCHESTRATOR-hierarchy parent (the run of the
 * supervisor that spawned this one), NOT the per-delegation
 * {@link DelegationContext.parentRunId}.
 */
export interface SupervisorHierarchy {
  /** Orchestrator-hierarchy parent run ID, when this is a sub-orchestrator. */
  readonly parentRunId: string | undefined;
  /** Branch identifier when running inside a parallel/conditional tree. */
  readonly branchId: string | undefined;
  /** Depth in orchestration hierarchy. Root = 0. */
  readonly depth: number;
}

// ─── Hierarchical sub-orchestrator support (ORCHESTRATION_V2) ────────────────

export const MAX_ORCHESTRATION_DEPTH = 3;

/**
 * Request to dispatch a subtask to a CHILD {@link DelegatingSupervisor}.
 *
 * Consumed by `DelegatingSupervisor.spawnSubOrchestrator`, which enforces
 * {@link assertDepthAllowed} at the dispatch site and derives the child's
 * hierarchy from the spawning supervisor.
 *
 * ## Which fields are authoritative
 *
 * `parentRunId` and `depth` are NOT caller-authoritative. The spawning
 * supervisor is the only thing that knows its own position in the tree, so it
 * derives both (`parentRunId` = its own hierarchy parent-run identity, `depth` =
 * its own depth + 1) and *validates* any caller-supplied values against that
 * derivation, throwing on disagreement rather than silently trusting the
 * caller. They stay on this interface (rather than being dropped) so a caller
 * that already knows the intended position can assert it and get a loud failure
 * if the tree it believes in has drifted from the tree that exists.
 *
 * `branchId` and `inputPrompt` ARE caller-authoritative: only the caller knows
 * which branch of a parallel/conditional tree this subtask belongs to and what
 * the child should work on.
 */
export interface SubOrchestratorSpawnOptions {
  /**
   * Expected ORCHESTRATOR-hierarchy parent run of the child.
   *
   * This is concept (1) — see {@link SupervisorHierarchy}. It is NOT
   * {@link DelegationContext.parentRunId}, which identifies the run issuing an
   * individual delegation to a specialist. Validated against the spawning
   * supervisor's own run identity; a mismatch throws.
   */
  parentRunId: string;
  /** Branch identifier for the child, when spawning inside a parallel/conditional tree. */
  branchId: string;
  /**
   * Expected depth of the CHILD (i.e. spawner depth + 1).
   *
   * Validated against the spawner's actual depth + 1; a mismatch throws. The
   * depth ceiling is checked at the dispatch site before the child is built.
   */
  depth: number;
  /** The subtask the child supervisor should orchestrate. */
  inputPrompt: string;
  personaId?: string;
  preferredProvider?: string;
  budgetCents?: number;
}

/**
 * Hierarchy fields the spawning supervisor derives and hands to the factory.
 *
 * A factory MUST spread these onto the child's
 * {@link DelegatingSupervisorConfig} verbatim. They are pre-validated: the
 * depth ceiling has already been checked at the dispatch site, so the child
 * constructor's own `assertDepthAllowed` will pass.
 */
export interface SubOrchestratorChildHierarchy {
  /** ORCHESTRATOR-hierarchy parent run of the child (the spawner's run identity). */
  readonly parentRunId: string;
  /** Branch identifier, taken verbatim from the spawn options. */
  readonly branchId: string;
  /** Spawner depth + 1. */
  readonly depth: number;
}

/**
 * Builds the CHILD supervisor for a sub-orchestrator dispatch.
 *
 * The spawning supervisor cannot invent the child's specialists or delegation
 * tracker — those are wiring decisions owned by the composition root — so it
 * derives only the hierarchy and delegates construction here. The factory is
 * responsible for passing `hierarchy` through onto the child config unchanged;
 * a factory that drops or rewrites it is rejected by `spawnSubOrchestrator`.
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
 */
export interface SubOrchestratorSpawnResult {
  /** Hierarchy the child supervisor was constructed with. */
  hierarchy: SubOrchestratorChildHierarchy;
  /** The child supervisor instance, for follow-up dispatches. */
  supervisor: DelegatingSupervisor;
  /** Aggregated result of the child's own delegation batch. */
  result: AggregatedDelegationResult;
}

/**
 * Guard that enforces the maximum orchestration depth.
 * Call this before spawning any sub-orchestrator.
 * Throws if depth would exceed MAX_ORCHESTRATION_DEPTH.
 */
export function assertDepthAllowed(
  depth: number,
  max = MAX_ORCHESTRATION_DEPTH
): void {
  if (depth >= max) {
    throw new Error(
      `Orchestration depth limit reached: depth=${depth} >= max=${max}. ` +
        "Cannot spawn another sub-orchestrator."
    );
  }
}
