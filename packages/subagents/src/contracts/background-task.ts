/**
 * Core domain types for background subagent tasks.
 *
 * These types are the persistent shape of a background task as it moves through
 * the runtime lifecycle: spawn → governance → admission → run → deliver → GC.
 */

export type TaskId = string;

/**
 * Lifecycle states for a background task.
 *
 * - `queued`            — created, not yet admitted (awaiting governance and/or a concurrency slot)
 * - `awaiting_approval` — blocked on a human-in-the-loop approval decision
 * - `running`           — admitted and executing on a {@link TaskRunner}
 * - `succeeded`         — completed with a result
 * - `failed`            — terminated with an error (may be resumable if `checkpointRef` is set)
 * - `cancelled`         — explicitly cancelled or rejected at the approval gate
 * - `expired`           — exceeded its TTL before reaching a terminal state
 */
export type TaskStatus =
  | "queued"
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

/** Terminal states — a task in one of these will not transition further. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "expired",
];

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Specification of the subagent to dispatch. Intentionally minimal and
 * governance-aware: the spawn gate inspects `agentId`, `outboundScope`, and
 * `memoryScope` to make a policy decision.
 */
export interface SubagentSpec {
  /** Logical agent identity to dispatch; resolved by the injected executor port. */
  agentId: string;
  /** Optional per-spawn instruction override. */
  instructions?: string;
  /** The task input handed to the subagent. */
  input: string | Record<string, unknown>;
  /** Network/tool scopes the subagent may use — inspected by the policy engine. */
  outboundScope?: string[];
  /** Memory scope the subagent runs under. */
  memoryScope?: "global" | "workspace" | "project" | "agent";
}

/** The result produced by a successful subagent run. */
export interface SubagentResult {
  output: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

/**
 * The persistent record of a background task. This is what a {@link TaskStore}
 * stores and what `check_subagent` / `await_subagent` surface to callers.
 */
export interface BackgroundTask {
  id: TaskId;
  /** Run ID of the parent agent/orchestration that spawned this task. */
  parentRunId: string;
  spec: SubagentSpec;
  status: TaskStatus;
  result?: SubagentResult;
  error?: string;
  /** Epoch-ms timestamps — supplied by an injected clock, never `Date.now()` in core paths. */
  createdAt: number;
  admittedAt?: number;
  startedAt?: number;
  endedAt?: number;
  /** Time-to-live in ms; the lifecycle sweep expires non-terminal tasks past this. */
  ttlMs: number;
  /** Opaque handle into the checkpointer for resumability. */
  checkpointRef?: string;
  /** Approval correlation id when the task passed (or is passing) an HITL gate. */
  approvalId?: string;
}
