import type { TaskId } from "../../contracts/background-task.js";
import type { Clock } from "../../contracts/clock.js";
import { SubagentErrorCode } from "../../contracts/error-codes.js";
import type {
  SubagentEventSink,
  SubagentRuntimeEvent,
} from "../../contracts/events.js";
import type { SubagentLogger } from "../../contracts/logger.js";
import type { TaskRunner } from "../../contracts/task-runner.js";
import type { TaskStore } from "../../contracts/task-store.js";
import type { SpawnGate } from "../../governance/spawn-gate.js";
import type { LifecycleController } from "../../lifecycle/lifecycle-controller.js";

/** Injected seams the admission pipeline reads (shared with the runtime). */
export interface AdmissionPipelineDeps {
  store: TaskStore;
  runner: TaskRunner;
  gate: SpawnGate;
  events: SubagentEventSink;
  clock: Clock;
  logger: SubagentLogger;
  lifecycle: LifecycleController;
  emitGovernance: (event: {
    type:
      | "governance:approval_requested"
      | "governance:approval_resolved"
      | "governance:rule_violation";
    runId: string;
    approvalId?: string;
    detail?: string;
  }) => void;
}

/**
 * Owns the admit → run → drain half of the background-subagent lifecycle plus
 * the per-task {@link AbortController} registry. Extracted from
 * `BackgroundSubagentRuntime` (mirroring the sibling `LifecycleController`
 * convention) so the concurrency-accounting / execution-dispatch concern is
 * separable from the public spawn/check/await/cancel API surface. Behavior is
 * preserved exactly; the runtime constructs one instance and delegates to it.
 */
export class AdmissionPipeline {
  private readonly controllers = new Map<TaskId, AbortController>();

  constructor(private readonly deps: AdmissionPipelineDeps) {}

  /** Abort a task's in-flight run (if any) and forget its controller. */
  abort(taskId: TaskId): void {
    this.controllers.get(taskId)?.abort();
    this.controllers.delete(taskId);
  }

  /** Whether a task currently has a live run controller registered. */
  hasController(taskId: TaskId): boolean {
    return this.controllers.has(taskId);
  }

  /**
   * Await a batch-level or per-item approval decision, then admit on grant or
   * mark the task cancelled on rejection (ERR-M-06: structured error code).
   */
  async resolveApprovalThenAdmit(
    id: TaskId,
    parentRunId: string,
    approvalId: string
  ): Promise<void> {
    const { gate, store, events, logger, clock, emitGovernance } = this.deps;
    const outcome = await gate.awaitApproval(parentRunId, approvalId);
    emitGovernance({
      type: "governance:approval_resolved",
      runId: parentRunId,
      approvalId,
      detail: outcome.decision === "granted" ? "approved" : outcome.reason,
    });
    if (outcome.decision !== "granted") {
      await store.patch(id, {
        status: "cancelled",
        // ERR-M-06: structured code alongside the human-readable message.
        errorCode: SubagentErrorCode.APPROVAL_REJECTED,
        error: `approval_rejected: ${outcome.reason}`,
        endedAt: clock.now(),
      });
      logger.warn({
        taskId: id,
        code: SubagentErrorCode.APPROVAL_REJECTED,
        reason: outcome.reason,
        parentRunId,
        approvalId,
      });
      events.emit({ type: "subagent:cancelled", taskId: id });
      return;
    }
    await this.tryAdmit(id, parentRunId);
  }

  /**
   * Admit a queued task into a concurrency slot, dispatch it to the runner
   * fire-and-forget, and release the slot + drain the next queued task once the
   * run settles. Returns `false` when no slot is free (task stays queued).
   */
  async tryAdmit(id: TaskId, parentRunId: string): Promise<boolean> {
    const { store, lifecycle, clock, events, runner } = this.deps;
    const queued = await store.list({ parentRunId, status: "queued" });
    const decision = lifecycle.admit(queued.length);
    if (!decision.admitted) {
      // Stays queued; a later settle or sweep retry will admit it.
      return false;
    }

    const task = await store.get(id);
    if (!task) {
      lifecycle.release();
      return false;
    }

    await store.patch(id, { admittedAt: clock.now() });
    const controller = new AbortController();
    this.controllers.set(id, controller);

    events.emit({
      type: "subagent:admitted",
      taskId: id,
    } satisfies SubagentRuntimeEvent);
    events.emit({
      type: "subagent:spawned",
      taskId: id,
      parentRunId,
      agentId: task.spec.agentId,
      depth: task.depth,
      ...(task.audit?.personaName !== undefined
        ? { personaName: task.audit.personaName }
        : {}),
      ...(task.audit?.inlineDefinitionHash !== undefined
        ? { inlineDefinitionHash: task.audit.inlineDefinitionHash }
        : {}),
      ...(task.batchId !== undefined ? { batchId: task.batchId } : {}),
    });

    // Fire-and-forget execution; runner persists terminal state + events.
    // The runtime (not the runner) owns concurrency accounting: release the
    // admitted slot here once the run settles, then admit the next queued task.
    void runner.start(id, controller.signal).finally(() => {
      this.controllers.delete(id);
      lifecycle.release();
      void this.drainQueue(parentRunId);
    });
    return true;
  }

  /** After a slot frees, admit the next queued task for this parent run. */
  async drainQueue(parentRunId: string): Promise<void> {
    const queued = await this.deps.store.list({
      parentRunId,
      status: "queued",
    });
    const next = queued[0];
    if (next) {
      await this.tryAdmit(next.id, parentRunId);
    }
  }
}
