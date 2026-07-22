import type {
  BackgroundTask,
  SubagentAuditIdentity,
  SubagentSpec,
  TaskId,
} from "../../contracts/background-task.js";
import type { Clock } from "../../contracts/clock.js";
import type { SubagentEventSink } from "../../contracts/events.js";
import type { SubagentLogger } from "../../contracts/logger.js";
import type { TaskRunner } from "../../contracts/task-runner.js";
import type { TaskStore } from "../../contracts/task-store.js";
import type {
  ApprovedSpawnBatch,
  SpawnContext,
  SpawnGate,
} from "../../governance/spawn-gate.js";
import type { LifecyclePolicy } from "../runtime-config.js";
import type { RecoverStaleRunningTasksOptions } from "../../store/postgres-task-store.js";

/** Governance event side-channel — structurally compatible with `GovernanceEvent`. */
export interface GovernanceEventSink {
  emitGovernance(event: {
    type:
      | "governance:approval_requested"
      | "governance:approval_resolved"
      | "governance:rule_violation";
    runId: string;
    approvalId?: string;
    detail?: string;
  }): void;
}

export const noopGovernanceSink: GovernanceEventSink = {
  emitGovernance: () => {},
};

/** Result of a spawn request handed back to tool/programmatic callers. */
export type SpawnOutcome =
  | { ok: true; taskId: TaskId; status: BackgroundTask["status"] }
  | { ok: false; reason: "queue_full" | "denied"; detail?: string };

/**
 * Result of a batch-level gate evaluation (Phase B hardening). A fan-out
 * coordinator calls {@link BackgroundSubagentRuntime.evaluateBatch} ONCE before
 * dispatching items; on `ok` it threads the returned {@link ApprovedSpawnBatch}
 * into each per-item `spawn(...)` via `options.batch`. A `needs_approval`
 * decision is resolved inside `evaluateBatch` (a single batch-level HITL wait
 * keyed by `batchId`), so callers only ever see allowed-or-denied.
 */
export type SpawnBatchAdmission =
  | { ok: true; batch: ApprovedSpawnBatch; approvalRequired: boolean }
  | { ok: false; reason: "denied"; detail: string };

/**
 * The outcome of a trusted pre-admission resolver: the (possibly rewritten)
 * spec to admit, plus an optional persona/inline audit identity captured for
 * the `subagent:spawned` event.
 */
export interface SubagentAdmissionResolution {
  spec: SubagentSpec;
  audit?: SubagentAuditIdentity;
}

/**
 * A trusted hook run at spawn admission that can materialize a persona snapshot
 * (`resolvedDefinition`) or attach policy data before governance evaluates the
 * spec. Runs only when the caller did not already supply a `resolvedDefinition`.
 */
export type SubagentAdmissionResolver = (
  spec: SubagentSpec,
  parentRunId: string
) => Promise<SubagentAdmissionResolution> | SubagentAdmissionResolution;

export interface SpawnOptions {
  ttlMs?: number;
  /**
   * Spawn depth (0 = spawned by the top-level run; defaults to 0). Spawns
   * performed from inside a task must pass the parent task's `depth + 1`.
   * Requests at `depth >= LifecyclePolicy.maxSpawnDepth` are rejected
   * structurally, before any policy call.
   */
  depth?: number;
  /** Fan-out batch id this spawn belongs to; persisted on the task. */
  batchId?: string;
  /** Task whose execution requested this spawn (nested spawns). */
  originTaskId?: string;
  /** Full batch context handed to context-aware policies (Spec 03 §2). */
  batch?: SpawnContext["batch"];
}

/**
 * Ownership scope for pull/cancel operations (SEC-M-04). When supplied, the
 * runtime only acts on a task whose `parentRunId` matches `scope.parentRunId`;
 * a mismatch is treated as not-found (returns `null`) so a caller cannot probe
 * for, read, or cancel another run's tasks by guessing a `taskId`. Omit the
 * scope only for trusted in-process callers (e.g. the runtime's own
 * cancel→await self-call) that have already established ownership.
 */
export interface TaskScope {
  parentRunId: string;
}

export interface BackgroundSubagentRuntimeDeps {
  store: TaskStore;
  runner: TaskRunner;
  gate: SpawnGate;
  events: SubagentEventSink;
  governance?: GovernanceEventSink;
  policy?: Partial<LifecyclePolicy>;
  clock?: Clock;
  /** Structured logger seam; defaults to a JSON-to-stderr logger when absent. */
  logger?: SubagentLogger;
  /** Optional trusted pre-admission resolver for persona snapshots/policy data. */
  resolveAdmission?: SubagentAdmissionResolver;
  /** Deterministic id generator (no Math.random in core paths). */
  generateId: () => string;
  /** Optional policy for durable runners that should settle stale running work. */
  staleRunningRecovery?: Pick<
    RecoverStaleRunningTasksOptions,
    "runningTimeoutMs" | "action" | "enqueue"
  >;
}
