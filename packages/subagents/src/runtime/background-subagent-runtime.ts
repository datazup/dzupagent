import type {
  BackgroundTask,
  SubagentSpec,
  TaskId,
} from "../contracts/background-task.js";
import { isTerminalStatus } from "../contracts/background-task.js";
import type { Clock } from "../contracts/clock.js";
import { systemClock } from "../contracts/clock.js";
import { SubagentErrorCode } from "../contracts/error-codes.js";
import type { SubagentEventSink } from "../contracts/events.js";
import type { SubagentLogger } from "../contracts/logger.js";
import { defaultSubagentLogger } from "../contracts/logger.js";
import type { TaskRunner } from "../contracts/task-runner.js";
import type { TaskStore } from "../contracts/task-store.js";
import { LifecycleController } from "../lifecycle/lifecycle-controller.js";
import type {
  SpawnBatchRequest,
  SpawnContext,
  SpawnGate,
} from "../governance/spawn-gate.js";
import type { LifecyclePolicy } from "./runtime-config.js";
import { DEFAULT_LIFECYCLE_POLICY } from "./runtime-config.js";
import type { RecoverStaleRunningTasksOptions } from "../store/postgres-task-store.js";
import type {
  BackgroundSubagentRuntimeDeps,
  GovernanceEventSink,
  SpawnBatchAdmission,
  SpawnOptions,
  SpawnOutcome,
  SubagentAdmissionResolution,
  SubagentAdmissionResolver,
  TaskScope,
} from "./background-subagent-runtime/contracts.js";
import { noopGovernanceSink } from "./background-subagent-runtime/contracts.js";
import { defaultAuditForSpec } from "./background-subagent-runtime/admission-audit.js";
import { sleep } from "./background-subagent-runtime/sleep.js";
import { reconcileOrphans } from "./background-subagent-runtime/orphan-reconciler.js";
import { AdmissionPipeline } from "./background-subagent-runtime/admission-pipeline.js";

// Re-export the public contract surface from the composition root so the
// `./runtime/background-subagent-runtime.js` import path is unchanged for every
// consumer (index.ts, create-runtime.ts, orchestrator-background-api.ts, the
// fanout tool, and the test helpers).
export type {
  BackgroundSubagentRuntimeDeps,
  GovernanceEventSink,
  SpawnBatchAdmission,
  SpawnOptions,
  SpawnOutcome,
  SubagentAdmissionResolution,
  SubagentAdmissionResolver,
  TaskScope,
} from "./background-subagent-runtime/contracts.js";

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
  private readonly resolveAdmission?: SubagentAdmissionResolver;
  private readonly generateId: () => string;
  private readonly lifecycle: LifecycleController;
  private readonly pipeline: AdmissionPipeline;
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
    this.resolveAdmission = deps.resolveAdmission;
    this.generateId = deps.generateId;
    this.staleRunningRecovery = deps.staleRunningRecovery;
    this.lifecycle = new LifecycleController(
      this.store,
      this.policy,
      this.clock,
      this.events,
      // The pipeline owns the AbortController registry; the closure resolves it
      // lazily so the sweep-triggered abort reaches the live controller map.
      (taskId) => this.pipeline.abort(taskId),
      this.logger
    );
    this.pipeline = new AdmissionPipeline({
      store: this.store,
      runner: this.runner,
      gate: this.gate,
      events: this.events,
      clock: this.clock,
      logger: this.logger,
      lifecycle: this.lifecycle,
      emitGovernance: (event) => this.governance.emitGovernance(event),
    });
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
    options: SpawnOptions = {}
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

    // Trusted pre-admission: materialize a persona snapshot / attach policy
    // data before governance sees the spec, and capture an audit identity.
    const admission = await this.resolveAdmissionSpec(spec, parentRunId);
    const admittedSpec = admission.spec;

    const id = this.generateId();
    const task: BackgroundTask = {
      id,
      parentRunId,
      spec: admittedSpec,
      status: "queued",
      createdAt: this.clock.now(),
      ttlMs: options.ttlMs ?? this.policy.defaultTtlMs,
      depth,
      ...(options.batchId !== undefined ? { batchId: options.batchId } : {}),
      ...(admission.audit !== undefined ? { audit: admission.audit } : {}),
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
    const decision = await this.gate.evaluate(admittedSpec, ctx, approvalId);

    if (decision.outcome === "denied") {
      await this.store.patch(id, {
        status: "failed",
        // ERR-M-06: persist the structured code so hosts branch on `errorCode`
        // rather than string-prefix-matching the human-readable `error`.
        errorCode: SubagentErrorCode.POLICY_DENIED,
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
      void this.pipeline.resolveApprovalThenAdmit(id, parentRunId, approvalId);
      return { ok: true, taskId: id, status: "awaiting_approval" };
    }

    const admitted = await this.pipeline.tryAdmit(id, parentRunId);
    return { ok: true, taskId: id, status: admitted ? "running" : "queued" };
  }

  /**
   * Resolve a task by id, enforcing ownership when a {@link TaskScope} is given.
   * Returns `null` for a missing task OR a `parentRunId` mismatch — the two are
   * deliberately indistinguishable to callers (SEC-M-04: no existence oracle).
   */
  private async resolveOwned(
    taskId: TaskId,
    scope?: TaskScope
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
    scope?: TaskScope
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
    scope?: TaskScope
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
    scope?: TaskScope
  ): Promise<BackgroundTask | null> {
    const task = await this.resolveOwned(taskId, scope);
    if (!task || isTerminalStatus(task.status)) {
      return task;
    }
    if (this.pipeline.hasController(taskId)) {
      this.pipeline.abort(taskId);
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
    request: SpawnBatchRequest
  ): Promise<SpawnBatchAdmission> {
    // Resolve the batch template once so persona snapshots/policy data are
    // applied uniformly to every per-item spawn derived from it.
    const admission = await this.resolveAdmissionSpec(
      request.template,
      request.parentRunId
    );
    const resolvedRequest: SpawnBatchRequest = {
      ...request,
      template: admission.spec,
    };
    const decision = await this.gate.evaluateBatch(resolvedRequest);
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
        request.batchId
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
        template: admission.spec,
        itemKeys: [...request.itemKeys],
      },
    };
  }

  /**
   * Reconcile orphaned `running` tasks left by a crashed process. In-process
   * (non-durable) runs are marked `failed` with their `checkpointRef` preserved
   * for later resumption; durable runners may instead resume. Delegates the
   * recovery routine to the {@link reconcileOrphans} leaf (crash-recovery
   * concern kept separable from the spawn/admit lifecycle loop).
   */
  async reconcileOrphans(): Promise<TaskId[]> {
    const orphans = await this.lifecycle.findOrphans();
    return reconcileOrphans(
      {
        store: this.store,
        runner: this.runner,
        events: this.events,
        clock: this.clock,
        logger: this.logger,
        ...(this.staleRunningRecovery !== undefined
          ? { staleRunningRecovery: this.staleRunningRecovery }
          : {}),
      },
      orphans
    );
  }

  /**
   * Run the trusted pre-admission resolver (when configured) and derive the
   * persona/inline audit identity. A caller-supplied `resolvedDefinition` is a
   * trusted snapshot already, so it short-circuits the resolver.
   */
  private async resolveAdmissionSpec(
    spec: SubagentSpec,
    parentRunId: string
  ): Promise<SubagentAdmissionResolution> {
    if (
      spec.resolvedDefinition !== undefined ||
      this.resolveAdmission === undefined
    ) {
      const audit = defaultAuditForSpec(spec);
      return audit !== undefined ? { spec, audit } : { spec };
    }
    const admission = await this.resolveAdmission(spec, parentRunId);
    const audit = admission.audit ?? defaultAuditForSpec(admission.spec);
    return audit !== undefined
      ? { spec: admission.spec, audit }
      : { spec: admission.spec };
  }
}
