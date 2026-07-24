/**
 * Team policy types — orthogonal knobs that control how a `TeamDefinition`
 * executes at runtime.
 *
 * Each policy is optional; the runtime applies sensible defaults for supported
 * omissions and rejects reserved policy groups or fields until it can enforce
 * them. Policies are deliberately decoupled from the definition so that the
 * same team can be promoted from ephemeral/sandboxed to persistent/live by
 * swapping policy objects once those controls are implemented.
 */

/** Controls the supported participant scheduling subset for TeamRuntime. */
export interface ExecutionPolicy {
  /** Max number of peer participants running concurrently (default: 5). */
  maxParallelParticipants?: number;
  /**
   * Hard timeout (ms, positive integer) around an entire team run.
   *
   * On expiry the run rejects through the normal failure path (team_failed
   * event, span error). The abandoned pattern promise is NOT cancelled —
   * in-flight member calls run to completion but their results are discarded.
   */
  timeoutMs?: number;
  /**
   * Retry a failed participant attempt (peer_to_peer pattern only; other
   * patterns reject this field). Retries are immediate, up to `maxRetries`
   * extra attempts (default 1).
   */
  retryOnFailure?: boolean;
  /**
   * Extra attempts per participant after the first failure (positive
   * integer, default 1). Requires `retryOnFailure: true`; peer_to_peer only.
   */
  maxRetries?: number;
}

/**
 * Controls quality gates applied by a judge model (typically Opus).
 * Used most heavily by the `council` pattern but available to any pattern.
 */
export interface GovernancePolicy {
  /** Model to use for judging. Recommended: `claude-opus-4-7`. */
  judgeModel: string;
  /** Minimum acceptable judge score in [0, 1]; below this rejects the run. */
  minScore?: number;
  /** If true, council requires unanimous judgment to pass. */
  requireUnanimous?: boolean;
}

/** Controls how team memory is scoped and persisted. */
export interface MemoryPolicy {
  /** Storage tier for team memory. */
  tier: "ephemeral" | "session" | "persistent";
  /** Whether all participants share the same memory store. */
  shareAcrossParticipants: boolean;
  /**
   * Whether to consolidate/summarize memory when the run completes.
   *
   * TeamRuntime rejects this field when it is enabled until a real
   * consolidation implementation exists.
   */
  consolidateOnComplete?: boolean;
  /**
   * Serialized-size budget for blackboard shared context passed to
   * participants. Applies only to the `blackboard` coordinator pattern.
   */
  blackboardContext?: BlackboardContextPolicy;
}

/** Overflow behavior for bounded blackboard context. */
export type BlackboardContextOverflowBehavior = "compact" | "reject";

/** Controls bounded shared-context prompts for the blackboard pattern. */
export interface BlackboardContextPolicy {
  /** Maximum serialized characters for the formatted shared context. */
  maxSerializedChars?: number;
  /** Maximum characters accepted for a single participant contribution. */
  maxEntryChars?: number;
  /** How to handle oversized participant contributions (default: `compact`). */
  overflowBehavior?: BlackboardContextOverflowBehavior;
}

/** Controls sandboxing and workspace sharing. */
export interface IsolationPolicy {
  /** Whether participants run in a sandboxed environment. */
  sandboxed: boolean;
  /** Whether participants share a filesystem/workspace. */
  sharedWorkspace: boolean;
}

/** Controls inter-participant mailbox (message passing). */
export interface MailboxPolicy {
  /** Max queued messages per participant (default: unbounded). */
  maxQueueDepth?: number;
  /** How messages are delivered to participants. */
  deliveryMode: "broadcast" | "targeted" | "round_robin";
}

/**
 * Controls automated scoring of the team's final output.
 * Typically uses an Opus-class scorer model for high-stakes evaluation.
 */
export interface EvaluationPolicy {
  /** Model to use for scoring. Recommended: `claude-opus-4-7`. */
  scorerModel: string;
  /** Human-readable criteria the scorer should apply. */
  scoringCriteria?: string[];
  /** Minimum passing score in [0, 1]. */
  minPassScore?: number;
}

/** Aggregate of all optional team policies. */
export interface TeamPolicies {
  execution?: ExecutionPolicy;
  governance?: GovernancePolicy;
  memory?: MemoryPolicy;
  isolation?: IsolationPolicy;
  mailbox?: MailboxPolicy;
  evaluation?: EvaluationPolicy;
}
