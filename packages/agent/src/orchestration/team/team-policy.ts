/**
 * Team policy types — orthogonal knobs that control how a `TeamDefinition`
 * executes at runtime.
 *
 * Each policy is optional; the runtime applies sensible defaults when a
 * policy (or any field within it) is omitted. Policies are deliberately
 * decoupled from the definition so that the same team can be promoted from
 * ephemeral/sandboxed to persistent/live by swapping policy objects.
 */

/** Controls how participants are scheduled and retried. */
export interface ExecutionPolicy {
  /** Max number of participants running concurrently (default: 5). */
  maxParallelParticipants?: number
  /** Hard timeout for the entire team run. */
  timeoutMs?: number
  /** Whether to retry failed participants. */
  retryOnFailure?: boolean
  /** Maximum retry attempts per participant (when retryOnFailure is true). */
  maxRetries?: number
}

/**
 * Controls quality gates applied by a judge model (typically Opus).
 * Used most heavily by the `council` pattern but available to any pattern.
 */
export interface GovernancePolicy {
  /** Model to use for judging. Recommended: `claude-opus-4-7`. */
  judgeModel: string
  /** Minimum acceptable judge score in [0, 1]; below this rejects the run. */
  minScore?: number
  /** If true, council requires unanimous judgment to pass. */
  requireUnanimous?: boolean
}

/** Controls how team memory is scoped and persisted. */
export interface MemoryPolicy {
  /** Storage tier for team memory. */
  tier: 'ephemeral' | 'session' | 'persistent'
  /** Whether all participants share the same memory store. */
  shareAcrossParticipants: boolean
  /** Whether to consolidate/summarize memory when the run completes. */
  consolidateOnComplete?: boolean
}

/** Controls sandboxing and workspace sharing. */
export interface IsolationPolicy {
  /** Whether participants run in a sandboxed environment. */
  sandboxed: boolean
  /** Whether participants share a filesystem/workspace. */
  sharedWorkspace: boolean
}

/** Controls inter-participant mailbox (message passing). */
export interface MailboxPolicy {
  /** Max queued messages per participant (default: unbounded). */
  maxQueueDepth?: number
  /** How messages are delivered to participants. */
  deliveryMode: 'broadcast' | 'targeted' | 'round_robin'
}

/**
 * Controls automated scoring of the team's final output.
 * Typically uses an Opus-class scorer model for high-stakes evaluation.
 */
export interface EvaluationPolicy {
  /** Model to use for scoring. Recommended: `claude-opus-4-7`. */
  scorerModel: string
  /** Human-readable criteria the scorer should apply. */
  scoringCriteria?: string[]
  /** Minimum passing score in [0, 1]. */
  minPassScore?: number
}

/** Aggregate of all optional team policies. */
export interface TeamPolicies {
  execution?: ExecutionPolicy
  governance?: GovernancePolicy
  memory?: MemoryPolicy
  isolation?: IsolationPolicy
  mailbox?: MailboxPolicy
  evaluation?: EvaluationPolicy
}
