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
 * An inline agent persona supplied at spawn time instead of by registry key.
 * Used when `SubagentSpec.agentId === "inline"` (with the executor's
 * `allowInline` enabled) or as an admission-time persona snapshot
 * (`resolvedDefinition`) produced by trusted runtime wiring.
 */
export interface InlineAgentDefinition {
  /** Display/audit label, not a provider registry key. */
  name: string;
  /** Persona/system prompt materialized by the injected executor. */
  personaPrompt: string;
  /** Optional adapter id hint; executor/router decides fallback behavior. */
  preferredProvider?: string;
  /** Optional skill names for executors that can compile local skill bundles. */
  skillNames?: string[];
  /** Governance and adapter-policy hints carried with the definition. */
  constraints?: {
    maxBudgetUsd?: number;
    estimatedCostUsd?: number;
    approvalMode?: "auto" | "required" | "conditional";
    networkPolicy?: "off" | "restricted" | "on";
    toolPolicy?: "strict" | "balanced" | "open";
  };
}

/**
 * Specification of the subagent to dispatch. Intentionally minimal and
 * governance-aware: the spawn gate inspects `agentId`, `outboundScope`, and
 * `memoryScope` to make a policy decision.
 */
export interface SubagentSpec {
  /** Logical agent identity to dispatch; resolved by the injected executor port. */
  agentId: string;
  /** Inline definition, required only when agentId is "inline". */
  definition?: InlineAgentDefinition;
  /** Admission-time persona snapshot produced by trusted runtime wiring. */
  resolvedDefinition?: InlineAgentDefinition;
  /** Display/audit name for an admission-time resolved persona snapshot. */
  resolvedPersonaName?: string;
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
  /** Provider adapter id that actually executed this task, when known. */
  provider?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
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
  /**
   * Spawn depth (0 = spawned by the top-level run). Set at spawn admission,
   * immutable, persisted — durable-queue workers and orphan reconciliation see
   * it. Spawns at `depth >= LifecyclePolicy.maxSpawnDepth` are rejected
   * structurally, before any policy check.
   */
  depth: number;
  /**
   * Fan-out batch this task belongs to, when spawned by a fan-out tool. Set at
   * spawn admission, immutable, persisted — individual tasks of an interrupted
   * batch remain queryable by `batchId` via the store.
   */
  batchId?: string;
  /** Persona identity captured at admission for audit events. */
  audit?: SubagentAuditIdentity;
}

/**
 * Persona/inline identity captured at spawn admission and surfaced on the
 * `subagent:spawned` lifecycle event for audit — without exposing the full
 * persona prompt on the bus.
 */
export interface SubagentAuditIdentity {
  personaName?: string;
  inlineDefinitionHash?: string;
}
