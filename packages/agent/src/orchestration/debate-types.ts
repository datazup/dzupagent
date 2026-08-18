/** Roles that can perform a real model invocation during a debate run. */
export type DebateParticipantRole = "proposer" | "judge";

/** Start evidence for one real debate model invocation. */
export interface DebateInvocationStart {
  /** Stable ID of the agent whose model is being invoked. */
  readonly agentId: string;
  /** Whether this invocation belongs to a proposer or the final judge. */
  readonly role: DebateParticipantRole;
  /** Zero-based order in which this debate started model invocations. */
  readonly invocationIndex: number;
  /** Zero-based proposer round. Omitted for the judge. */
  readonly round?: number;
}

/** Terminal evidence for one real debate model invocation. */
export interface DebateInvocationOutcome extends DebateInvocationStart {
  /** Whether the invocation returned successfully. */
  readonly success: boolean;
  /** Finite, non-negative elapsed wall-clock duration. */
  readonly durationMs: number;
  /** Exact generated content. Present only for a successful invocation. */
  readonly content?: string;
  /** Normalized failure text. Present only for a failed invocation. */
  readonly error?: string;
}

/**
 * Best-effort observer for real debate invocations.
 *
 * Callback failures are isolated from debate execution. Prompts, messages,
 * provider metadata, and other invocation inputs are deliberately excluded.
 */
export interface DebateInvocationObserver {
  onStart?(start: DebateInvocationStart): unknown;
  onComplete?(outcome: DebateInvocationOutcome): unknown;
}

/** Options shared by detailed and legacy debate execution. */
export interface DebateOptions {
  rounds?: number;
  signal?: AbortSignal;
  maxConcurrency?: number;
  invocationObserver?: DebateInvocationObserver;
}

/** Successful detailed debate result. */
export interface DebateResult {
  /** Exact generated content returned by the judge. */
  readonly content: string;
  /** Completed invocations ordered by their actual start index. */
  readonly invocations: readonly DebateInvocationOutcome[];
  /** Number of proposer rounds that completed successfully. */
  readonly roundsExecuted: number;
  /** Finite, non-negative elapsed wall-clock duration for the whole debate. */
  readonly durationMs: number;
}
