/**
 * Typed delegation protocol contracts shared by the delegation tracker and its
 * lifecycle helpers.
 *
 * This module depends ONLY on `@dzupagent/core` types. It contains no runtime
 * behavior — it is the contract surface consumed by the composition root at
 * `../delegation.ts` and by the lifecycle helpers.
 */

import type { RunStore } from "@dzupagent/core/persistence";
import type { DzupEventBus } from "@dzupagent/core/events";

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/**
 * Position of the *issuing orchestrator* within the orchestration tree.
 *
 * ## Why this is a nested object
 *
 * `parentRunId` is an overloaded name in this package. It denotes two distinct
 * concepts that must never be conflated:
 *
 * 1. {@link DelegationHierarchy.parentRunId} (this one) — the ORCHESTRATOR
 *    parent: the run of the supervisor that spawned the supervisor *issuing*
 *    this delegation as a sub-orchestrator. `undefined` for a root supervisor.
 * 2. {@link DelegationContext.parentRunId} — the DELEGATION parent: the run
 *    issuing this individual delegation to a specialist. Consumed by
 *    `SimpleDelegationTracker` to stamp run metadata and `delegation:*` events.
 *
 * For a root supervisor these are unrelated: (2) is typically set while (1) is
 * not. Nesting (1) under `hierarchy` makes the two unambiguous at every read
 * site — `hierarchy.parentRunId` can never be mistaken for
 * `context.parentRunId`, which three loose sibling fields would not guarantee.
 *
 * Every field is optional and purely additive: a delegation issued with no
 * hierarchy carries no `hierarchy` key at all.
 */
export interface DelegationHierarchy {
  /** Orchestrator-hierarchy parent run ID, when the issuer is a sub-orchestrator. */
  parentRunId?: string;
  /** Branch identifier when the issuer runs inside a parallel/conditional tree. */
  branchId?: string;
  /**
   * Depth of the *issuing orchestrator* in the orchestration tree. Root = 0.
   *
   * This is the issuer's own depth, NOT the depth of the delegated work. A
   * delegation issued by a supervisor at depth N is attributed depth N: the
   * delegation is an action *of* that supervisor, and its target is a
   * specialist agent (a leaf), not another orchestrator level. Depth only
   * increments when a supervisor spawns another `DelegatingSupervisor`, which
   * this package does not yet do.
   */
  depth?: number;
}

/** Typed contract for delegating work to a specialist agent. */
export interface DelegationRequest {
  /** ID of the specialist agent to delegate to */
  targetAgentId: string;
  /** The task to delegate */
  task: string;
  /** Structured input for the specialist */
  input: Record<string, unknown>;
  /** Context from the supervisor (prior decisions, constraints) */
  context?: DelegationContext;
  /**
   * Orchestration-tree position of the issuing supervisor.
   *
   * Distinct from {@link DelegationContext.parentRunId} — see
   * {@link DelegationHierarchy}. Omitted entirely by root supervisors.
   */
  hierarchy?: DelegationHierarchy;
  /** Max time to wait for specialist completion (ms, default: 300_000) */
  timeoutMs?: number;
  /**
   * Scheduling priority for the delegated run — **lower = more urgent**,
   * default 5.
   *
   * READ, unlike its same-named counterpart. `delegation/lifecycle.ts` resolves
   * an omitted value (`request.priority ?? 5`) and stamps the result onto the
   * created run's `metadata.priority`. This package does not itself order
   * anything by it; the ascending-is-urgent reading is realised downstream,
   * where `@dzupagent/server`'s run queue re-reads `metadata.priority` (again
   * defaulting to 5) and inserts jobs into a queue held in ASCENDING priority
   * order. So the direction documented here is load-bearing: it is the contract
   * the queue's comparator already assumes.
   *
   * ⚠️ OPPOSITE CONVENTION FROM `AgentTask.priority`. These two fields share a
   * name and invert each other's meaning:
   *
   *  - THIS field (`DelegationRequest.priority`): **lower = more urgent**,
   *    default 5, and it IS read (`delegation/lifecycle.ts` → run metadata →
   *    server run queue).
   *  - `AgentTask.priority` (`../routing-policy-types.ts`): **higher = more
   *    urgent**, and it is an UNENFORCED HINT — no built-in `RoutingPolicy`
   *    reads it at all.
   *
   * Do not copy a comparator between the two types, and do not assume a
   * `priority` value is portable across them: moving a number from one to the
   * other inverts its meaning silently, with no type error and no test failure
   * at the copy site. The hazard is asymmetric and therefore easy to get wrong
   * — because `AgentTask.priority` is currently unread, anyone implementing it
   * has no live comparator to imitate except this one, which runs the opposite
   * direction. Any such implementation must assert its direction explicitly
   * rather than inheriting this field's ordering.
   *
   * @see `../__tests__/agent-task-priority-unenforced.test.ts` — pins this
   * default and the direction clash, so neither docstring can rot independently.
   */
  priority?: number;
}

/** Contextual information passed from supervisor to specialist. */
export interface DelegationContext {
  /**
   * Run issuing this individual delegation.
   *
   * This is the DELEGATION parent, NOT the orchestrator-hierarchy parent — see
   * {@link DelegationHierarchy} for the disambiguation.
   */
  parentRunId: string;
  decisions: string[];
  constraints: string[];
  relevantFiles: string[];
}

/** Result returned from a completed delegation. */
export interface DelegationResult {
  /** Whether the delegation succeeded */
  success: boolean;
  /** Output from the specialist */
  output: unknown;
  /** Structured metadata from the specialist */
  metadata?: DelegationMetadata;
  /** Error if delegation failed */
  error?: string;
}

/** Metadata about a completed delegation. */
export interface DelegationMetadata {
  /** Stable assignment/node key used to aggregate batch delegation results. */
  assignmentId?: string;
  /** Specialist agent that executed this delegation. */
  specialistId?: string;
  /** Provider that completed provider-port execution. */
  providerId?: string;
  /** Providers attempted during provider-port execution. */
  attemptedProviders?: string[];
  /** Number of provider fallback attempts before success. */
  fallbackAttempts?: number;
  /** Additional provider-port metadata that is not part of the core contract. */
  providerMetadata?: Record<string, unknown>;
  /**
   * Orchestration-tree position of the supervisor that issued this delegation,
   * echoed from {@link DelegationRequest.hierarchy}.
   *
   * Present only when the issuing supervisor had hierarchy configured, so a
   * completed delegation can be attributed to its position in the tree. Absent
   * for root supervisors, which keeps their metadata byte-identical to a
   * pre-hierarchy build.
   */
  hierarchy?: DelegationHierarchy;
  modelTier?: string;
  tokenUsage?: { input: number; output: number };
  durationMs: number;
  filesModified?: string[];
}

// ---------------------------------------------------------------------------
// Status tracking
// ---------------------------------------------------------------------------

/** Delegation lifecycle status. */
export type DelegationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timeout";

/** An in-flight delegation entry visible via `getActiveDelegations()`. */
export interface ActiveDelegation {
  delegationId: string;
  runId: string;
  request: DelegationRequest;
  status: DelegationStatus;
  startedAt: Date;
}

// ---------------------------------------------------------------------------
// Tracker interface
// ---------------------------------------------------------------------------

/** Tracks and executes delegations from a supervisor to specialist agents. */
export interface DelegationTracker {
  /** Delegate work to a specialist. Resolves when the specialist finishes. */
  delegate(request: DelegationRequest): Promise<DelegationResult>;
  /** Return all currently active (pending/running) delegations. */
  getActiveDelegations(): ActiveDelegation[];
  /** Cancel an active delegation by target agent ID. Returns true if cancelled. */
  cancel(targetAgentId: string): boolean;
}

// ---------------------------------------------------------------------------
// Executor callback
// ---------------------------------------------------------------------------

/**
 * Callback that actually executes a delegated run.
 *
 * The tracker creates a Run record via `RunStore`, then hands the runId
 * to this executor. The executor is responsible for actually running the
 * agent (e.g. via a RunQueue worker, direct DzupAgent.generate(), etc.).
 *
 * The executor MUST update the Run's `status` and `output` fields via the
 * RunStore when finished, so the tracker's polling loop can detect completion.
 *
 * The `signal` is wired to the delegation's AbortController for cancellation
 * and timeout.
 */
export type DelegationExecutor = (
  runId: string,
  agentId: string,
  input: unknown,
  signal: AbortSignal
) => Promise<void>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SimpleDelegationTrackerConfig {
  /** Persistence store for run records. */
  runStore: RunStore;
  /** Event bus for delegation lifecycle events. */
  eventBus?: DzupEventBus;
  /** Callback that executes the delegated run. */
  executor: DelegationExecutor;
  /** Polling interval for checking run completion (ms, default: 100). */
  pollIntervalMs?: number;
  /** Default timeout for delegations (ms, default: 300_000). */
  defaultTimeoutMs?: number;
}
