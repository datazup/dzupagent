/**
 * Planning types — data structures for the PlanningAgent's DAG-based execution plans.
 *
 * Pure type definitions; no runtime dependencies beyond sibling orchestration types.
 */

import type { AgentExecutionSpec } from '@dzupagent/core/persistence'
import type { DelegationResult } from './delegation.js'
import type {
  AggregatedDelegationResult,
  TaskAssignment,
} from './delegating-supervisor-types.js'

// ---------------------------------------------------------------------------
// Plan data structures
// ---------------------------------------------------------------------------

/** A single node in an execution plan DAG. */
export interface PlanNode {
  /** Unique identifier for this node */
  id: string
  /** Human-readable task description */
  task: string
  /** ID of the specialist agent to delegate to */
  specialistId: string
  /** Structured input for the specialist */
  input: Record<string, unknown>
  /** IDs of nodes that must complete before this one can start */
  dependsOn: string[]
}

/** A complete execution plan: a set of nodes forming a DAG. */
export interface ExecutionPlan {
  /** High-level goal this plan achieves */
  goal: string
  /** All nodes in the plan */
  nodes: PlanNode[]
  /** Execution order: groups of node IDs that can run in parallel */
  executionLevels: string[][]
  /** Diagnostics from acknowledged LLM decomposition cleanup, if any */
  decompositionDiagnostics?: PlanningDecompositionDiagnostics
}

/** Result of executing an entire plan. */
export interface PlanExecutionResult {
  /** The plan that was executed */
  plan: ExecutionPlan
  /** Results keyed by node ID */
  results: Map<string, DelegationResult>
  /** Whether all nodes succeeded */
  success: boolean
  /** Total wall-clock time (ms) */
  totalDurationMs: number
  /** IDs of nodes that failed (does not include skipped nodes) */
  failedNodes: string[]
  /** IDs of nodes that were skipped due to failed dependencies */
  skippedNodes: string[]
}

// ---------------------------------------------------------------------------
// Decomposition diagnostics
// ---------------------------------------------------------------------------

/** A generated decomposition node removed before plan execution. */
export interface RemovedPlanNodeDiagnostic {
  /** ID of the removed node */
  nodeId: string
  /** Specialist ID emitted for the removed node */
  specialistId: string
  /** Reason the node cannot be executed */
  reason: 'unknown-specialist'
  /** Remaining nodes that referenced this removed node as a dependency */
  affectedDependencies: Array<{
    /** Node that had the dependency reference */
    nodeId: string
    /** Specialist assigned to the affected node */
    specialistId: string
    /** Removed dependency node ID */
    dependencyId: string
  }>
}

/** A dependency reference that cannot be resolved to an executable node. */
export interface DanglingPlanDependencyDiagnostic {
  /** Node that contains the unresolved dependency */
  nodeId: string
  /** Specialist assigned to the affected node */
  specialistId: string
  /** Missing dependency node ID */
  dependencyId: string
  /** Specialist ID of the missing dependency when it was removed from the plan */
  dependencySpecialistId?: string
}

/** Diagnostics for LLM decomposition nodes/dependencies that were not executable. */
export interface PlanningDecompositionDiagnostics {
  /** Available specialist IDs at decomposition time */
  availableSpecialists: string[]
  /** Generated nodes removed because they cannot be executed */
  removedNodes: RemovedPlanNodeDiagnostic[]
  /** Dependency references removed because no executable node satisfied them */
  danglingDependencies: DanglingPlanDependencyDiagnostic[]
  /** Whether the caller explicitly acknowledged deterministic cleanup */
  acknowledged: boolean
}

// ---------------------------------------------------------------------------
// PlanningAgent configuration
// ---------------------------------------------------------------------------

/** Structural supervisor surface required by PlanningAgent helpers. */
export interface PlanningSupervisor {
  specialistIds: string[]
  getSpecialist(id: string): AgentExecutionSpec | undefined
  delegateAndCollect(tasks: TaskAssignment[]): Promise<AggregatedDelegationResult>
}

/** Configuration for PlanningAgent. */
export interface PlanningAgentConfig {
  /** The supervisor to delegate tasks through */
  supervisor: PlanningSupervisor
  /** Maximum parallel delegations per level (default: 5) */
  maxParallelism?: number
}

/** Options for the LLM-powered decompose method. */
export interface DecomposeOptions {
  /** Maximum number of nodes the LLM may produce (default: 20) */
  maxNodes?: number
  /** Abort signal for cancellation */
  signal?: AbortSignal
  /**
   * Explicitly acknowledge unresolved generated nodes/dependencies.
   *
   * By default, unknown-specialist nodes and dangling dependencies fail
   * decomposition before execution. When true, those nodes/dependencies are
   * removed deterministically and diagnostics are attached to the returned plan.
   */
  acknowledgeUnresolvedNodes?: boolean
}
