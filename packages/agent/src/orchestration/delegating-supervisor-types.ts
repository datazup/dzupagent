/**
 * Public type declarations for {@link DelegatingSupervisor}.
 *
 * Co-located in their own module so the supervisor implementation file stays
 * focused on behavior. The runtime entry point re-exports these types for
 * backward compatibility.
 */

import type { AgentExecutionSpec } from '@dzupagent/core/persistence'
import type { DzupEventBus } from '@dzupagent/core/events'
import type { AgentCircuitBreaker } from './circuit-breaker.js'
import type {
  DelegationContext,
  DelegationResult,
  DelegationTracker,
} from './delegation.js'
import type {
  OrchestrationMergeStrategy,
} from './orchestration-merge-strategy-types.js'
import type { ProviderExecutionPort } from './provider-adapter/provider-execution-port.js'
import type { RoutingPolicy } from './routing-policy-types.js'
import type { StructuredLLM } from '../structured/structured-output-engine.js'
import type { DuplicateSpecialistAssignmentIdMode } from './assignment-validator.js'

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
