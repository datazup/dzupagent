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
  /** Max time to wait for specialist completion (ms, default: 300_000) */
  timeoutMs?: number;
  /** Priority (lower = higher, default: 5) */
  priority?: number;
}

/** Contextual information passed from supervisor to specialist. */
export interface DelegationContext {
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
