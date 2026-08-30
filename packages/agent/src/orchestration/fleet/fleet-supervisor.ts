import { ulid } from "ulidx";
import type {
  DecisionPayload,
  EscalationOutcome,
  EscalationReason,
  FleetRunResult,
  FleetRunSpec,
  FleetTask,
  RepoAgentResult,
  RepoRef,
  Executor,
  KnowledgeStore,
  FleetPolicy,
  FleetSupervisorApi,
  RepoAgentRef,
  WorkerHandle,
  WorkerSpec,
} from "@dzupagent/agent-types/fleet";
import { RepoAgent } from "./repo-agent.js";
import { createBudgetTracker } from "./fleet-budget-tracker.js";
import {
  reassignTask,
  type ActiveRun,
} from "./fleet-task-control.js";
import {
  writeDecision,
  writeTaskControlState,
  type DecisionKind,
} from "./fleet-run-records.js";
import {
  runContractReconciliation,
  type ReconciliationRunState,
  type RepoAgentSlot,
} from "./fleet-reconciliation-runner.js";

export interface FleetSupervisorDeps {
  knowledge: KnowledgeStore;
  executorFor: (repo: RepoRef) => Executor;
  /**
   * Monotonic clock used for the `budgets.wallclockMs` deadline. Injectable so
   * tests can drive the deadline deterministically instead of sleeping.
   * Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * Delay used when a policy's escalation outcome is `{kind:"retry",delayMs}`.
   * Injectable so tests can honour multi-second policy delays for free (the
   * built-in DependencyTrackerPolicy asks for 1000ms). Defaults to a real timer.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** Real timer used for escalation retry delays when `deps.sleep` is absent. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * FleetSupervisor drives a FleetRunSpec to completion. For fan-out scenarios
 * every repo runs the task in parallel; otherwise the injected FleetPolicy
 * assigns each task to a single worker. Assignment decisions are mirrored into
 * the shared KnowledgeStore.
 *
 * Phase 1b: mid-run control (pauseTask/cancelTask/reassign) operates on live
 * worker handles registered during spawn. Pause signals the worker; cancel
 * terminates it and writes a surrendered task-state; reassign cancels and
 * re-dispatches to the next available idle worker via the active policy.
 *
 * Budgets ({@link FleetBudgets}) bound how much *new* work a run starts: the
 * `wallclockMs` deadline and the cumulative `maxToolCalls` count are checked at
 * dispatch boundaries, never mid-task, so an in-flight worker is always allowed
 * to finish. Both are inert when unset. `maxTokens` is deliberately not
 * enforced — see its doc comment in `fleet-types.ts`.
 *
 * Escalation routes a terminal condition through `FleetPolicy.onEscalation` and
 * honours the answer: `human-handoff` ends the run with status `escalated`,
 * `retry` re-dispatches the triggering task exactly once. Retries are bounded at
 * one attempt per task and never re-escalate, so a policy that always answers
 * `retry` cannot produce an unbounded loop.
 */
export class FleetSupervisor implements FleetSupervisorApi {
  /** Live worker handles keyed by taskId, populated during run(). */
  private readonly _taskHandles = new Map<string, WorkerHandle>();
  /** Active run context, set at the start of run() and cleared when done. */
  private _activeRun: ActiveRun | null = null;

  constructor(private readonly deps: FleetSupervisorDeps) {}

  async run(spec: FleetRunSpec, policy: FleetPolicy): Promise<FleetRunResult> {
    await this.seed(spec);

    const repoAgents = new Map<string, RepoAgentSlot>();
    for (const repo of spec.repos) {
      const ref: RepoAgentRef = {
        workerId: `w-${ulid()}`,
        repo: repo.name,
        busy: false,
      };
      const trackingExecutor = this.trackingExecutorFor(repo);
      const agent = new RepoAgent({
        runId: spec.runId,
        repo,
        executor: trackingExecutor,
        knowledge: this.deps.knowledge,
        workerId: ref.workerId,
      });
      repoAgents.set(repo.name, { agent, repo, ref });
    }

    this._activeRun = { runId: spec.runId, spec, policy, repoAgents };

    try {
      const outcomes: RepoAgentResult[] = [];
      const budget = createBudgetTracker(spec, this.deps.now ?? (() => Date.now()));
      const reconciliationState: ReconciliationRunState = {
        observedContractIds: new Set<string>(),
        observedDecisionIds: new Set<string>(),
        pausedTaskIds: new Set<string>(),
        settledTaskIds: new Set<string>(),
        knownTaskIds: new Set(spec.tasks.map((task) => task.id)),
      };
      // Set once an escalation resolved to human-handoff; makes the run's
      // terminal status `escalated` rather than the usual completed/failed.
      let escalated = false;
      // Set when dispatch stopped before every task ran (budget exhausted or
      // dependency deadlock). Such a run is never `completed` even if every task
      // that DID run succeeded — the remaining work simply never happened.
      let truncated = false;
      const isFanOut =
        spec.scenario === "audit-fanout" || policy.id === "fan-out";

      escalated = await this.reconcileContractChanges(
        spec.runId,
        policy,
        repoAgents,
        reconciliationState
      );
      if (escalated) truncated = spec.tasks.length > 0;

      if (!escalated && isFanOut) {
        for (const task of spec.tasks) {
          if (reconciliationState.pausedTaskIds.has(task.id)) {
            truncated = true;
            continue;
          }
          // Deadline is checked *before* dispatch, and only for tasks after the
          // first: a run must never be a zero-work no-op just because the
          // budget was already spent when run() was called.
          if (outcomes.length > 0 && budget.deadlinePassed()) {
            escalated = await this.escalate(
              spec.runId,
              policy,
              "budget-exhausted",
              "budget-exhausted",
              [`wallclockMs=${String(spec.budgets?.wallclockMs)}`]
            );
            truncated = true;
            break;
          }

          const runs = [...repoAgents.values()].map(async ({ agent, ref }) => {
            ref.busy = true;
            try {
              const result = await agent.dispatch(task);
              outcomes.push(result);
              return result;
            } finally {
              ref.busy = false;
              this._taskHandles.delete(task.id);
            }
          });
          const results = await Promise.all(runs);
          reconciliationState.settledTaskIds.add(task.id);

          const contractEscalated = await this.reconcileContractChanges(
            spec.runId,
            policy,
            repoAgents,
            reconciliationState
          );
          if (contractEscalated) {
            escalated = true;
            truncated = task !== spec.tasks[spec.tasks.length - 1];
            break;
          }

          if (budget.recordAndCheckToolCalls(results)) {
            escalated = await this.escalate(
              spec.runId,
              policy,
              "budget-exhausted",
              "budget-exhausted",
              [`maxToolCalls=${String(spec.budgets?.maxToolCalls)}`]
            );
            // Only truncated if there was work left to skip.
            truncated = task !== spec.tasks[spec.tasks.length - 1];
            break;
          }
        }
      } else if (!escalated) {
        // Sequential branch. `pending` is a work queue rather than a plain
        // iteration over spec.tasks: DependencyTrackerPolicy.assignTask throws
        // when a task's dependencies are unmet, and its documented contract is
        // that the supervisor re-queues rather than aborting the run. Each pass
        // drains the queue; a task that cannot be assigned is deferred to the
        // next pass. A full pass with zero progress means no deferred task can
        // ever become assignable (missing or cyclic dependency) — a deadlock,
        // which we route to escalation instead of looping forever.
        let pending: FleetTask[] = [...spec.tasks];
        let stop = false;

        while (pending.length > 0 && !stop) {
          const deferred: FleetTask[] = [];
          let progressed = false;

          for (const task of pending) {
            if (reconciliationState.pausedTaskIds.has(task.id)) {
              truncated = true;
              continue;
            }
            if (outcomes.length > 0 && budget.deadlinePassed()) {
              escalated = await this.escalate(
                spec.runId,
                policy,
                "budget-exhausted",
                "budget-exhausted",
                [`wallclockMs=${String(spec.budgets?.wallclockMs)}`]
              );
              truncated = true;
              stop = true;
              break;
            }

            const dispatched = await this.dispatchSequential(
              spec,
              policy,
              repoAgents,
              task
            );
            if (!dispatched) {
              // Assignment refused (unmet dependency / no free worker) — defer.
              deferred.push(task);
              continue;
            }
            progressed = true;

            let result = dispatched.result;
            if (result.state !== "completed") {
              const retried = await this.handleTaskFailure(
                spec.runId,
                policy,
                repoAgents,
                task,
                result
              );
              result = retried.result;
              if (retried.escalated) escalated = true;
            }
            outcomes.push(result);
            reconciliationState.settledTaskIds.add(task.id);

            const contractEscalated = await this.reconcileContractChanges(
              spec.runId,
              policy,
              repoAgents,
              reconciliationState
            );
            if (contractEscalated) {
              escalated = true;
              truncated = outcomes.length < spec.tasks.length;
              stop = true;
              break;
            }

            if (budget.recordAndCheckToolCalls([result])) {
              escalated = await this.escalate(
                spec.runId,
                policy,
                "budget-exhausted",
                "budget-exhausted",
                [`maxToolCalls=${String(spec.budgets?.maxToolCalls)}`]
              );
              truncated = outcomes.length < spec.tasks.length;
              stop = true;
              break;
            }
          }

          if (stop) break;

          if (!progressed && deferred.length > 0) {
            // Deadlock: nothing in `deferred` became assignable this pass, so a
            // further pass would produce the same result. `repeated-failure` is
            // the closest EscalationReason: the same assignment attempt failed
            // repeatedly for the same reason. (`contract-conflict` is about
            // divergent contract proposals and `no-bidder` is contract-net's
            // empty-bid case — neither describes an unsatisfiable DAG.)
            escalated = await this.escalate(
              spec.runId,
              policy,
              "repeated-failure",
              "escalation",
              ["dependency-deadlock", ...deferred.map((t) => t.id)]
            );
            truncated = true;
            break;
          }

          pending = deferred;
        }
      }

      if (!escalated) {
        escalated = await this.reconcileContractChanges(
          spec.runId,
          policy,
          repoAgents,
          reconciliationState
        );
      }

      const allOk =
        !truncated && outcomes.every((o) => o.state === "completed");
      let status: FleetRunResult["status"] = allOk ? "completed" : "failed";
      if (escalated) status = "escalated";
      return {
        runId: spec.runId,
        status,
        finishedAt: new Date().toISOString(),
        taskOutcomes: outcomes,
      };
    } finally {
      this._activeRun = null;
    }
  }

  /**
   * Signals a live worker to pause. Writes a `blocked` task-state into the
   * knowledge store and sends a pause message to the worker handle. The worker
   * itself decides whether to honour the pause — the supervisor does not
   * forcibly halt execution.
   */
  async pauseTask(taskId: string, reason: string): Promise<void> {
    const handle = this._taskHandles.get(taskId);
    const runId = this._activeRun?.runId ?? "unknown";
    await writeTaskControlState(
      this.deps.knowledge,
      runId,
      taskId,
      "blocked",
      reason
    );
    if (handle) {
      await handle.send({ kind: "message", text: `pause: ${reason}` });
    }
  }

  /**
   * Cancels a live worker and marks the task surrendered. Calls
   * `WorkerHandle.cancel(reason)` if a live handle exists, then writes a
   * `surrendered` task-state. The task will not be retried automatically.
   */
  async cancelTask(taskId: string, reason: string): Promise<void> {
    const handle = this._taskHandles.get(taskId);
    if (handle) {
      await handle.cancel(reason);
      this._taskHandles.delete(taskId);
    }
    const runId = this._activeRun?.runId ?? "unknown";
    await writeTaskControlState(
      this.deps.knowledge,
      runId,
      taskId,
      "surrendered",
      reason
    );
  }

  /**
   * Cancels the current worker for a task (if live) and re-dispatches it to the
   * next available idle worker chosen by the active policy.
   */
  async reassign(taskId: string): Promise<void> {
    await reassignTask(
      {
        api: this,
        knowledge: this.deps.knowledge,
        taskHandles: this._taskHandles,
        activeRun: this._activeRun,
      },
      taskId
    );
  }

  /**
   * Runs the escalation path: asks the policy what to do about `reason`, records
   * the question and the answer as a decision envelope, and reports whether the
   * run must terminate as `escalated`.
   *
   * `decisionKind` is the caller's choice of `"budget-exhausted"` (a budget
   * tripped) or `"escalation"` (anything else) — both are reserved in
   * {@link DecisionPayload}. A `retry` answer is NOT acted on here; callers that
   * can retry (see {@link handleTaskFailure}) interpret the outcome themselves,
   * and callers that cannot simply treat it as "policy declined to hand off",
   * which leaves the terminal status at completed/failed.
   */
  private async escalate(
    runId: string,
    policy: FleetPolicy,
    reason: EscalationReason,
    decisionKind: Extract<DecisionKind, "escalation" | "budget-exhausted">,
    extraInputs: unknown[] = []
  ): Promise<boolean> {
    const outcome = await policy.onEscalation(reason, this);
    await writeDecision(
      this.deps.knowledge,
      runId,
      decisionKind,
      policy.id,
      [reason, ...extraInputs],
      outcome
    );
    return outcome.kind === "human-handoff";
  }

  /**
   * Reconcile proposed contract envelopes for this run, binding the extracted
   * runner to this supervisor's knowledge store and escalation path.
   */
  private reconcileContractChanges(
    runId: string,
    policy: FleetPolicy,
    repoAgents: Map<string, RepoAgentSlot>,
    state: ReconciliationRunState
  ): Promise<boolean> {
    return runContractReconciliation(
      {
        knowledge: this.deps.knowledge,
        escalateContractConflict: (id, activePolicy, extraInputs) =>
          this.escalate(
            id,
            activePolicy,
            "contract-conflict",
            "escalation",
            extraInputs
          ),
      },
      runId,
      policy,
      repoAgents,
      state
    );
  }

  /**
   * Assigns and dispatches one task in the sequential branch.
   *
   * Returns `null` when the policy *refused* the assignment — `assignTask`
   * throwing is DependencyTrackerPolicy's documented "not assignable yet"
   * signal, so the caller re-queues the task instead of failing the run. An
   * assignment naming a worker that does not exist is a different thing: that is
   * a programming error in the policy, not a deferrable condition, so it still
   * throws out of `run()`.
   */
  private async dispatchSequential(
    spec: FleetRunSpec,
    policy: FleetPolicy,
    repoAgents: Map<string, RepoAgentSlot>,
    task: FleetTask
  ): Promise<{ result: RepoAgentResult } | null> {
    const fleet: RepoAgentRef[] = [...repoAgents.values()].map((v) => v.ref);

    let assignment;
    try {
      assignment = await policy.assignTask(task, fleet, this.deps.knowledge);
    } catch {
      return null;
    }

    const target = [...repoAgents.values()].find(
      (v) => v.ref.workerId === assignment.workerId
    );
    if (!target) {
      throw new Error(`Policy assigned unknown worker ${assignment.workerId}`);
    }

    await writeDecision(
      this.deps.knowledge,
      spec.runId,
      "assignment",
      policy.id,
      [task.id, assignment.workerId],
      assignment.rationale
    );

    target.ref.busy = true;
    try {
      const result = await target.agent.dispatch(task);
      await policy.onWorkerComplete(result, this);
      return { result };
    } finally {
      target.ref.busy = false;
      this._taskHandles.delete(task.id);
    }
  }

  /**
   * Handles a sequential task that came back in a non-completed state — the
   * `repeated-failure` escalation trigger.
   *
   * Consults the policy exactly once. `human-handoff` makes the run `escalated`
   * and keeps the failed result. `retry` waits `delayMs` and re-dispatches the
   * task exactly once; the retry result replaces the failed one. The retry never
   * re-enters this method, which is what bounds the retry at one attempt — a
   * policy that unconditionally answers `retry` cannot spin.
   *
   * Note this is sequential-branch-only. Fan-out deliberately does not escalate
   * on task failure: every repo runs the *same* task there, so one repo failing
   * is a normal partial result rather than the repeated failure of one unit of
   * work.
   */
  private async handleTaskFailure(
    runId: string,
    policy: FleetPolicy,
    repoAgents: Map<string, RepoAgentSlot>,
    task: FleetTask,
    failed: RepoAgentResult
  ): Promise<{ result: RepoAgentResult; escalated: boolean }> {
    const outcome: EscalationOutcome = await policy.onEscalation(
      "repeated-failure",
      this
    );
    await writeDecision(
      this.deps.knowledge,
      runId,
      "escalation",
      policy.id,
      ["repeated-failure", task.id, failed.state],
      outcome
    );

    if (outcome.kind === "human-handoff") {
      return { result: failed, escalated: true };
    }

    const sleep = this.deps.sleep ?? defaultSleep;
    await sleep(outcome.delayMs);

    const spec = this._activeRun?.spec;
    if (!spec) return { result: failed, escalated: false };

    const retried = await this.dispatchSequential(
      spec,
      policy,
      repoAgents,
      task
    );
    // A retry whose assignment is refused leaves the original failure standing.
    return { result: retried?.result ?? failed, escalated: false };
  }

  /**
   * Returns a handle-tracking wrapper around the real executor for a given
   * repo. When the underlying executor spawns a worker, the handle is
   * registered under the task's id so control methods can reach it.
   */
  private trackingExecutorFor(repo: RepoRef): Executor {
    const supervisor = this;
    const inner = this.deps.executorFor(repo);
    return {
      id: inner.id,
      async spawn(workerSpec: WorkerSpec): Promise<WorkerHandle> {
        const handle = await inner.spawn(workerSpec);
        supervisor._taskHandles.set(workerSpec.taskBundle.id, handle);
        return handle;
      },
    };
  }

  private async seed(spec: FleetRunSpec): Promise<void> {
    for (const entry of spec.seedKnowledge ?? []) {
      await this.deps.knowledge.append(`run:${spec.runId}`, entry);
    }
  }

}
