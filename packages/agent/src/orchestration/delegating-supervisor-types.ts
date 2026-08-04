/**
 * Public type declarations for `DelegatingSupervisor`.
 *
 * Co-located in their own module so the supervisor implementation file stays
 * focused on behavior. The runtime entry point re-exports these types for
 * backward compatibility.
 *
 * ## Layering rule
 *
 * This module MUST NOT import from `./delegating-supervisor.js` (or any other
 * non-`*-types` sibling that imports it back). A `*-types.ts` module is a leaf.
 * The two declarations that genuinely need the concrete `DelegatingSupervisor`
 * class type — `SubOrchestratorFactory` and `SubOrchestratorSpawnResult` —
 * therefore live in `delegating-supervisor.ts` alongside the class, and are
 * re-exported from there. `import type` is erased at runtime, but it is still a
 * dependency edge for every static analyser, and it formed a 3-module cycle
 * with `parallel-delegation-aggregator.ts`.
 */

import type { DelegationContext, DelegationResult } from "./delegation.js";
import type { StructuredLLM } from "../structured/structured-output-engine.js";

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
 * Structural surface required from a spawned child supervisor.
 *
 * Keeping this contract in the leaf type module avoids naming the concrete
 * `DelegatingSupervisor` class while still allowing the implementation to
 * prove that it provides the child orchestration surface.
 */
export interface SubOrchestratorChild {
  readonly hierarchy: SupervisorHierarchy;
  planAndDelegate(
    goal: string,
    options?: PlanAndDelegateOptions
  ): Promise<AggregatedDelegationResult>;
}

// `SubOrchestratorFactory` and `SubOrchestratorSpawnResult` are declared in
// `./delegating-supervisor.js` — both name the concrete `DelegatingSupervisor`
// class, and this module may not import it (see the layering rule above).
// `orchestration/index.ts` already re-exports them from there, so the package's
// public surface is unaffected.

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
