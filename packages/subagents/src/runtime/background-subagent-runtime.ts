import type {
  BackgroundTask,
  SubagentResult,
  SubagentSpec,
  TaskId,
} from "../contracts/background-task.js";
import { isTerminalStatus } from "../contracts/background-task.js";
import type { Clock } from "../contracts/clock.js";
import { systemClock } from "../contracts/clock.js";
import { SubagentErrorCode } from "../contracts/error-codes.js";
import type {
  SubagentEventSink,
  SubagentRuntimeEvent,
} from "../contracts/events.js";
import type { SubagentLogger } from "../contracts/logger.js";
import { defaultSubagentLogger } from "../contracts/logger.js";
import type { TaskRunner } from "../contracts/task-runner.js";
import type { TaskStore } from "../contracts/task-store.js";
import { LifecycleController } from "../lifecycle/lifecycle-controller.js";
import type {
  ApprovedSpawnBatch,
  SpawnBatchRequest,
  SpawnContext,
  SpawnGate,
} from "../governance/spawn-gate.js";
import type { LifecyclePolicy } from "./runtime-config.js";
import { DEFAULT_LIFECYCLE_POLICY } from "./runtime-config.js";
import {
  recoverStaleRunningTasks,
  type RecoverStaleRunningTasksOptions,
} from "../store/postgres-task-store.js";

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

const noopGovernanceSink: GovernanceEventSink = { emitGovernance: () => {} };

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
  /** Deterministic id generator (no Math.random in core paths). */
  generateId: () => string;
  /** Optional policy for durable runners that should settle stale running work. */
  staleRunningRecovery?: Pick<
    RecoverStaleRunningTasksOptions,
    "runningTimeoutMs" | "action" | "enqueue"
  >;
}

/**
 * Coordinates the full background-subagent lifecycle: spawn → governance →
 * admission → run → deliver, plus cancellation and TTL/GC via the
 * {@link LifecycleController}. Owns no execution or persistence itself — both are
 * injected seams — keeping it portable and unit-testable against fakes.
 */
export class BackgroundSubagentRuntime {
  private readonly store: TaskStore;
  private readonly runner: TaskRunner;
  private readonly gate: SpawnGate;
  private readonly events: SubagentEventSink;
  private readonly governance: GovernanceEventSink;
  private readonly clock: Clock;
  private readonly policy: LifecyclePolicy;
  private readonly logger: SubagentLogger;
  private readonly generateId: () => string;
  private readonly lifecycle: LifecycleController;
  private readonly controllers = new Map<TaskId, AbortController>();
  private readonly staleRunningRecovery?: Pick<
    RecoverStaleRunningTasksOptions,
    "runningTimeoutMs" | "action" | "enqueue"
  >;

  constructor(deps: BackgroundSubagentRuntimeDeps) {
    this.store = deps.store;
    this.runner = deps.runner;
    this.gate = deps.gate;
    this.events = deps.events;
    this.governance = deps.governance ?? noopGovernanceSink;
    this.clock = deps.clock ?? systemClock;
    this.policy = { ...DEFAULT_LIFECYCLE_POLICY, ...deps.policy };
    this.logger = deps.logger ?? defaultSubagentLogger;
    this.generateId = deps.generateId;
    this.staleRunningRecovery = deps.staleRunningRecovery;
    this.lifecycle = new LifecycleController(
      this.store,
      this.policy,
      this.clock,
      this.events,
      (taskId) => this.abortController(taskId),
      this.logger,
    );
  }

  /**
   * The runtime's event sink — exposed so batch coordinators (the fan-out
   * tool) emit their `fanout:*` lifecycle events on the same sink as the
   * per-task events, keeping one observability plane.
   */
  get eventSink(): SubagentEventSink {
    return this.events;
  }

  /** The effective lifecycle policy (defaults merged with overrides). */
  get lifecyclePolicy(): Readonly<LifecyclePolicy> {
    return this.policy;
  }

  /** Start the periodic TTL/GC sweep. */
  start(): void {
    this.lifecycle.start();
  }

  stop(): void {
    this.lifecycle.stop();
  }

  /**
   * Spawn a background subagent. Returns immediately with a task id (or a typed
   * rejection). Admission, governance, and execution proceed asynchronously.
   */
  async spawn(
    spec: SubagentSpec,
    parentRunId: string,
    options: SpawnOptions = {},
  ): Promise<SpawnOutcome> {
    const depth = options.depth ?? 0;

    // Structural depth bound (Spec 03 FR7): enforced BEFORE any policy call so
    // it is not policy-overridable. No task is persisted for over-depth spawns.
    if (depth >= this.policy.maxSpawnDepth) {
      this.logger.warn({
        code: SubagentErrorCode.MAX_SPAWN_DEPTH_EXCEEDED,
        reason: "max_spawn_depth_exceeded",
        parentRunId,
        depth,
        maxSpawnDepth: this.policy.maxSpawnDepth,
      });
      this.governance.emitGovernance({
        type: "governance:rule_violation",
        runId: parentRunId,
        detail: "max_spawn_depth_exceeded",
      });
      return {
        ok: false,
        reason: "denied",
        detail: "max_spawn_depth_exceeded",
      };
    }

    // CODE-M-01: count both queued and awaiting_approval (non-terminal pending
    // work) against the cap so approval-gated tasks don't bypass the limit.
    const [queued, pendingApproval] = await Promise.all([
      this.store.list({ parentRunId, status: "queued" }),
      this.store.list({ parentRunId, status: "awaiting_approval" }),
    ]);
    if (
      queued.length + pendingApproval.length + 1 >
      this.policy.maxQueuedTasks
    ) {
      return { ok: false, reason: "queue_full" };
    }

    const id = this.generateId();
    const task: BackgroundTask = {
      id,
      parentRunId,
      spec,
      status: "queued",
      createdAt: this.clock.now(),
      ttlMs: options.ttlMs ?? this.policy.defaultTtlMs,
      depth,
      ...(options.batchId !== undefined ? { batchId: options.batchId } : {}),
    };
    await this.store.put(task);

    const approvalId = `subagent:${id}`;
    const ctx: SpawnContext = {
      parentRunId,
      depth,
      ...(options.originTaskId !== undefined
        ? { originTaskId: options.originTaskId }
        : {}),
      ...(options.batch !== undefined ? { batch: options.batch } : {}),
    };
    const decision = await this.gate.evaluate(spec, ctx, approvalId);

    if (decision.outcome === "denied") {
      await this.store.patch(id, {
        status: "failed",
        error: `policy_denied: ${decision.reason}`,
        endedAt: this.clock.now(),
      });
      this.logger.warn({
        taskId: id,
        code: SubagentErrorCode.POLICY_DENIED,
        reason: decision.reason,
        parentRunId,
      });
      this.governance.emitGovernance({
        type: "governance:rule_violation",
        runId: parentRunId,
        detail: decision.reason,
      });
      return { ok: false, reason: "denied", detail: decision.reason };
    }

    if (decision.outcome === "needs_approval") {
      await this.store.patch(id, { status: "awaiting_approval", approvalId });
      this.governance.emitGovernance({
        type: "governance:approval_requested",
        runId: parentRunId,
        approvalId,
      });
      // Resolve approval asynchronously, then admit.
      void this.resolveApprovalThenAdmit(id, parentRunId, approvalId);
      return { ok: true, taskId: id, status: "awaiting_approval" };
    }

    const admitted = await this.tryAdmit(id, parentRunId);
    return { ok: true, taskId: id, status: admitted ? "running" : "queued" };
  }

  private async resolveApprovalThenAdmit(
    id: TaskId,
    parentRunId: string,
    approvalId: string,
  ): Promise<void> {
    const outcome = await this.gate.awaitApproval(parentRunId, approvalId);
    this.governance.emitGovernance({
      type: "governance:approval_resolved",
      runId: parentRunId,
      approvalId,
      detail: outcome.decision === "granted" ? "approved" : outcome.reason,
    });
    if (outcome.decision !== "granted") {
      await this.store.patch(id, {
        status: "cancelled",
        error: `approval_rejected: ${outcome.reason}`,
        endedAt: this.clock.now(),
      });
      this.logger.warn({
        taskId: id,
        code: SubagentErrorCode.APPROVAL_REJECTED,
        reason: outcome.reason,
        parentRunId,
        approvalId,
      });
      this.events.emit({ type: "subagent:cancelled", taskId: id });
      return;
    }
    await this.tryAdmit(id, parentRunId);
  }

  private async tryAdmit(id: TaskId, parentRunId: string): Promise<boolean> {
    const queued = await this.store.list({ parentRunId, status: "queued" });
    const decision = this.lifecycle.admit(queued.length);
    if (!decision.admitted) {
      // Stays queued; a later settle or sweep retry will admit it.
      return false;
    }

    const task = await this.store.get(id);
    if (!task) {
      this.lifecycle.release();
      return false;
    }

    await this.store.patch(id, { admittedAt: this.clock.now() });
    const controller = new AbortController();
    this.controllers.set(id, controller);

    this.events.emit({
      type: "subagent:admitted",
      taskId: id,
    } satisfies SubagentRuntimeEvent);
    this.events.emit({
      type: "subagent:spawned",
      taskId: id,
      parentRunId,
      agentId: task.spec.agentId,
      depth: task.depth,
      ...(task.batchId !== undefined ? { batchId: task.batchId } : {}),
    });

    // Fire-and-forget execution; runner persists terminal state + events.
    // The runtime (not the runner) owns concurrency accounting: release the
    // admitted slot here once the run settles, then admit the next queued task.
    void this.runner.start(id, controller.signal).finally(() => {
      this.controllers.delete(id);
      this.lifecycle.release();
      void this.drainQueue(parentRunId);
    });
    return true;
  }

  /** After a slot frees, admit the next queued task for this parent run. */
  private async drainQueue(parentRunId: string): Promise<void> {
    const queued = await this.store.list({ parentRunId, status: "queued" });
    const next = queued[0];
    if (next) {
      await this.tryAdmit(next.id, parentRunId);
    }
  }

  /**
   * Resolve a task by id, enforcing ownership when a {@link TaskScope} is given.
   * Returns `null` for a missing task OR a `parentRunId` mismatch — the two are
   * deliberately indistinguishable to callers (SEC-M-04: no existence oracle).
   */
  private async resolveOwned(
    taskId: TaskId,
    scope?: TaskScope,
  ): Promise<BackgroundTask | null> {
    const task = await this.store.get(taskId);
    if (!task) return null;
    if (scope !== undefined && task.parentRunId !== scope.parentRunId) {
      return null;
    }
    return task;
  }

  /** Pull: current task state (ownership-scoped when `scope` is supplied). */
  async check(
    taskId: TaskId,
    scope?: TaskScope,
  ): Promise<BackgroundTask | null> {
    return this.resolveOwned(taskId, scope);
  }

  /**
   * Pull + block: resolve when the task reaches a terminal state or `timeoutMs`
   * elapses. Polls the store via the injected clock; intervalMs is small and
   * unref'd so it never holds the process open.
   */
  async await(
    taskId: TaskId,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
    scope?: TaskScope,
  ): Promise<BackgroundTask | null> {
    const pollIntervalMs = options.pollIntervalMs ?? 25;
    const deadline =
      options.timeoutMs !== undefined
        ? this.clock.now() + options.timeoutMs
        : undefined;

    for (;;) {
      const task = await this.resolveOwned(taskId, scope);
      if (!task) {
        return null;
      }
      if (isTerminalStatus(task.status)) {
        return task;
      }
      if (deadline !== undefined && this.clock.now() >= deadline) {
        return task;
      }
      await sleep(pollIntervalMs);
    }
  }

  /** Cancel a task: abort its run (if running) or mark cancelled (if pending). */
  async cancel(
    taskId: TaskId,
    scope?: TaskScope,
  ): Promise<BackgroundTask | null> {
    const task = await this.resolveOwned(taskId, scope);
    if (!task || isTerminalStatus(task.status)) {
      return task;
    }
    const controller = this.controllers.get(taskId);
    if (controller) {
      controller.abort();
      // The runner observes the signal and persists the terminal state + emits
      // asynchronously; wait for it to settle so callers see the final status.
      // Ownership is already verified above, so the self-await is unscoped.
      return this.await(taskId, { timeoutMs: 5000 });
    }
    await this.store.patch(taskId, {
      status: "cancelled",
      endedAt: this.clock.now(),
    });
    this.events.emit({ type: "subagent:cancelled", taskId });
    return this.store.get(taskId);
  }

  /** List tasks for a parent run (or all). */
  async list(parentRunId?: string): Promise<BackgroundTask[]> {
    return this.store.list(parentRunId !== undefined ? { parentRunId } : {});
  }

  /**
   * Batch-level gate (Phase B hardening). Evaluates a whole fan-out batch ONCE
   * before any item is dispatched, delegating to {@link SpawnGate.evaluateBatch}.
   * On `needs_approval` it blocks on a single batch-level HITL wait keyed by
   * `batchId`, emitting the corresponding governance events (so a batch is one
   * approval, not one-per-item). Denials (policy or rejected approval) surface a
   * `governance:rule_violation`. On success it returns an
   * {@link ApprovedSpawnBatch} the coordinator threads into each per-item spawn.
   */
  async evaluateBatch(
    request: SpawnBatchRequest,
  ): Promise<SpawnBatchAdmission> {
    const decision = await this.gate.evaluateBatch(request);
    if (decision.outcome === "denied") {
      this.governance.emitGovernance({
        type: "governance:rule_violation",
        runId: request.parentRunId,
        detail: decision.reason,
      });
      return { ok: false, reason: "denied", detail: decision.reason };
    }

    if (decision.outcome === "needs_approval") {
      this.governance.emitGovernance({
        type: "governance:approval_requested",
        runId: request.parentRunId,
        approvalId: request.batchId,
      });
      const outcome = await this.gate.awaitApproval(
        request.parentRunId,
        request.batchId,
      );
      this.governance.emitGovernance({
        type: "governance:approval_resolved",
        runId: request.parentRunId,
        approvalId: request.batchId,
        detail: outcome.decision === "granted" ? "approved" : outcome.reason,
      });
      if (outcome.decision !== "granted") {
        const rejectionReason = outcome.reason ?? "approval_rejected";
        this.governance.emitGovernance({
          type: "governance:rule_violation",
          runId: request.parentRunId,
          detail: rejectionReason,
        });
        return { ok: false, reason: "denied", detail: rejectionReason };
      }
    }

    return {
      ok: true,
      approvalRequired: decision.outcome === "needs_approval",
      batch: {
        batchId: request.batchId,
        mode: request.mode,
        template: request.template,
        itemKeys: [...request.itemKeys],
      },
    };
  }

  /**
   * Reconcile orphaned `running` tasks left by a crashed process. In-process
   * (non-durable) runs are marked `failed` with their `checkpointRef` preserved
   * for later resumption; durable runners may instead resume.
   */
  async reconcileOrphans(): Promise<TaskId[]> {
    const orphans = await this.lifecycle.findOrphans();
    const reconciled: TaskId[] = [];
    const durable = this.runner.capabilities().durable;
    if (durable && this.staleRunningRecovery !== undefined) {
      return recoverStaleRunningTasks({
        store: this.store,
        now: this.clock.now(),
        ...this.staleRunningRecovery,
      });
    }
    for (const task of orphans) {
      if (durable) {
        // Durable runner is expected to resume; leave state for it to pick up.
        continue;
      }
      await this.store.patch(task.id, {
        status: "failed",
        error: "orphaned_by_process_restart",
        endedAt: this.clock.now(),
      });
      this.logger.warn({
        taskId: task.id,
        code: SubagentErrorCode.ORPHANED_BY_PROCESS_RESTART,
        reason: "orphaned_by_process_restart",
        parentRunId: task.parentRunId,
      });
      this.events.emit({
        type: "subagent:failed",
        taskId: task.id,
        error: "orphaned_by_process_restart",
        durationMs: 0,
      });
      reconciled.push(task.id);
    }
    return reconciled;
  }

  private abortController(taskId: TaskId): void {
    this.controllers.get(taskId)?.abort();
    this.controllers.delete(taskId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
