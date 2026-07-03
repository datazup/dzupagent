/**
 * Structured failure codes for background subagent tasks.
 *
 * Stored verbatim in `BackgroundTask.error` (alongside a human-readable message
 * where useful) and surfaced in structured logs so callers and operators can
 * branch on a stable machine code rather than parsing free-form strings.
 */

export const SubagentErrorCode = {
  /** The executor (or queue handler) threw while running the task. */
  TASK_EXECUTION_FAILED: "TASK_EXECUTION_FAILED",
  /** Spawn rejected by the host spawn policy. */
  POLICY_DENIED: "POLICY_DENIED",
  /** Spawn rejected structurally: at/over `LifecyclePolicy.maxSpawnDepth`. */
  MAX_SPAWN_DEPTH_EXCEEDED: "MAX_SPAWN_DEPTH_EXCEEDED",
  /** HITL approval gate rejected (or no gate was configured). */
  APPROVAL_REJECTED: "APPROVAL_REJECTED",
  /** A `running` task was left behind by a process restart and reconciled. */
  ORPHANED_BY_PROCESS_RESTART: "ORPHANED_BY_PROCESS_RESTART",
  /** Task exceeded its TTL before reaching a terminal state. */
  TTL_EXPIRED: "TTL_EXPIRED",
} as const;

export type SubagentErrorCode =
  (typeof SubagentErrorCode)[keyof typeof SubagentErrorCode];

/**
 * Best-effort classification of an executor failure as retryable. Conservative:
 * unknown/unstructured errors are treated as recoverable so a durable host may
 * choose to retry, while explicit non-retryable signals are honoured.
 */
export function isRecoverableError(error: unknown): boolean {
  if (error instanceof Error) {
    const flagged = (error as { recoverable?: unknown }).recoverable;
    if (typeof flagged === "boolean") {
      return flagged;
    }
  }
  return true;
}
