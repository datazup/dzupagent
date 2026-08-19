import { ulid } from "ulidx";
import { isContractPayload } from "@dzupagent/agent-types/fleet";
import type {
  DecisionPayload,
  EscalationOutcome,
  EscalationReason,
  FleetRunResult,
  FleetRunSpec,
  FleetTask,
  KnowledgeEnvelope,
  RepoAgentResult,
  RepoRef,
  Executor,
  KnowledgeStore,
  ReconciliationPlan,
  FleetPolicy,
  FleetSupervisorApi,
  RepoAgentRef,
  TaskState,
  TaskStatePayload,
  WorkerHandle,
  WorkerSpec,
} from "@dzupagent/agent-types/fleet";
import { RepoAgent } from "./repo-agent.js";
import {
  FleetReconciliationError,
  actionEnvelopeMatches,
  buildContractTransitionEnvelope,
  buildReconciliationDecisionEnvelope,
  buildTaskPauseEnvelope,
  canonicalReconciliationJson,
  parseReconciliationDecision,
  reconciliationDecisionMatches,
  validateReconciliationPlan,
  type ContractProposalRecord,
  type ValidatedReconciliationPlan,
} from "./fleet-reconciliation.js";

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

type DecisionKind =
  | "assignment"
  | "reconciliation"
  | "escalation"
  | "budget-exhausted";

interface RepoAgentSlot {
  agent: RepoAgent;
  repo: RepoRef;
  ref: RepoAgentRef;
}

interface ActiveRun {
  runId: string;
  spec: FleetRunSpec;
  policy: FleetPolicy;
  repoAgents: Map<string, RepoAgentSlot>;
}

interface ReconciliationRunState {
  observedContractIds: Set<string>;
  observedDecisionIds: Set<string>;
  pausedTaskIds: Set<string>;
  settledTaskIds: Set<string>;
  knownTaskIds: Set<string>;
}

/**
 * Per-run budget state for {@link FleetBudgets}. Both predicates return `false`
 * (i.e. "keep going") when the corresponding budget field is unset, which is
 * what makes budget enforcement fully inert for specs that declare none.
 */
interface BudgetTracker {
  /** True once `wallclockMs` has elapsed since the run started. */
  deadlinePassed(): boolean;
  /**
   * Accumulates the `tool_call` events in `results` into the run total and
   * returns true when that total now exceeds `maxToolCalls`.
   */
  recordAndCheckToolCalls(results: RepoAgentResult[]): boolean;
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
      const budget = this.newBudgetTracker(spec);
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
    await this.writeTaskControlState(runId, taskId, "blocked", reason);
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
    await this.writeTaskControlState(runId, taskId, "surrendered", reason);
  }

  /**
   * Cancels the current worker for a task (if live) and re-dispatches it to
   * the next available idle worker chosen by the active policy. If no run is
   * active or no idle worker is available the task is cancelled and written as
   * surrendered — the run's outcome will reflect the failure.
   */
  async reassign(taskId: string): Promise<void> {
    // Capture run context and task BEFORE cancelling — cancelling the live handle
    // triggers the dispatch microtask chain which clears _activeRun by the time
    // the await resumes.
    const ctx = this._activeRun;
    const task = ctx?.spec.tasks.find((t) => t.id === taskId);

    const handle = this._taskHandles.get(taskId);
    if (handle) {
      await handle.cancel("reassignment requested");
      this._taskHandles.delete(taskId);
      // Yield the microtask queue so the run loop's dispatch chain (generator
      // drain → wait() → finally { busy=false }) can complete before we
      // inspect the idle fleet for reassignment.
      await Promise.resolve();
    }

    if (!ctx) {
      return;
    }

    if (!task) {
      return;
    }

    const fleet: RepoAgentRef[] = [...ctx.repoAgents.values()].map(
      (v) => v.ref
    );
    const idle = fleet.filter((f) => !f.busy);
    if (idle.length === 0) {
      await this.writeTaskControlState(
        ctx.runId,
        taskId,
        "surrendered",
        "no idle worker available for reassignment"
      );
      return;
    }

    const assignment = await ctx.policy.assignTask(
      task,
      idle,
      this.deps.knowledge
    );
    await this.writeDecision(
      ctx.runId,
      "assignment",
      ctx.policy.id,
      [taskId, assignment.workerId, "reassignment"],
      assignment.rationale
    );

    const target = [...ctx.repoAgents.values()].find(
      (v) => v.ref.workerId === assignment.workerId
    );
    if (!target) {
      await this.writeTaskControlState(
        ctx.runId,
        taskId,
        "surrendered",
        `reassignment target worker ${assignment.workerId} not found`
      );
      return;
    }

    target.ref.busy = true;
    target.agent
      .dispatch(task)
      .then(async (result) => {
        await ctx.policy.onWorkerComplete(result, this);
      })
      .catch(() => {
        // Dispatch errors after reassignment are surfaced through task-state
        // written by RepoAgent; not re-thrown here since this is async.
      })
      .finally(() => {
        target.ref.busy = false;
        this._taskHandles.delete(taskId);
      });
  }

  /**
   * Builds the per-run budget tracker for `spec.budgets`.
   *
   * Every check is inert when the corresponding field is undefined, so a spec
   * without budgets (or with `budgets: {}`) behaves exactly as it did before
   * budgets were enforced. `maxTokens` has no tracker at all — see its doc
   * comment in `fleet-types.ts` for why it is deliberately unenforceable here.
   */
  private newBudgetTracker(spec: FleetRunSpec): BudgetTracker {
    const now = this.deps.now ?? (() => Date.now());
    const wallclockMs = spec.budgets?.wallclockMs;
    const maxToolCalls = spec.budgets?.maxToolCalls;
    // Snapshot the start instant once so every later check compares against the
    // same origin (an injected clock may advance on every read).
    const startedAt = now();
    let toolCalls = 0;

    return {
      deadlinePassed(): boolean {
        if (wallclockMs === undefined) return false;
        return now() - startedAt > wallclockMs;
      },
      recordAndCheckToolCalls(results: RepoAgentResult[]): boolean {
        // Always accumulate, even when no cap is set: the count is cheap and
        // keeping it unconditional avoids a second code path.
        for (const result of results) {
          for (const event of result.events) {
            if (event.kind === "tool_call") toolCalls += 1;
          }
        }
        if (maxToolCalls === undefined) return false;
        return toolCalls > maxToolCalls;
      },
    };
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
    await this.writeDecision(
      runId,
      decisionKind,
      policy.id,
      [reason, ...extraInputs],
      outcome
    );
    return outcome.kind === "human-handoff";
  }

  /**
   * Reconciles proposed contract envelopes that have appeared since the last
   * safe run boundary. Query order determines both surface and proposal order.
   * Deterministic decision and action envelopes make completed work replay-safe
   * and resume a partially applied plan before any new policy callback.
   */
  private async reconcileContractChanges(
    runId: string,
    policy: FleetPolicy,
    repoAgents: Map<string, RepoAgentSlot>,
    state: ReconciliationRunState
  ): Promise<boolean> {
    const scope = `run:${runId}`;
    const entries: KnowledgeEnvelope[] = [];
    for await (const entry of this.deps.knowledge.query({ scope })) {
      entries.push(entry);
    }
    const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
    const resolvedProposalIds = new Set<string>();
    for (const entry of entries) {
      if (
        entry.kind === "contract"
        && isContractPayload(entry.payload)
        && entry.payload.status !== "proposed"
        && entry.parentId !== null
      ) {
        resolvedProposalIds.add(entry.parentId);
      }
    }

    // Resume already-recorded decisions before looking for new proposal
    // groups. This closes the decision-written/action-partial crash window.
    for (const entry of entries) {
      const replay = parseReconciliationDecision(entry);
      if (!replay) continue;
      if (entry.runId !== runId) {
        throw new FleetReconciliationError(
          `decision ${entry.id} belongs to run ${entry.runId}, not ${runId}`
        );
      }
      for (const proposalId of replay.proposalIds) {
        resolvedProposalIds.add(proposalId);
      }
      if (state.observedDecisionIds.has(entry.id)) continue;

      const decisionPayload = entry.payload as DecisionPayload;
      if (decisionPayload.policyId !== policy.id) {
        throw new FleetReconciliationError(
          `decision ${entry.id} belongs to policy ${decisionPayload.policyId}, not ${policy.id}`
        );
      }
      const expectedDecision = buildReconciliationDecisionEnvelope({
        runId,
        surface: replay.surface,
        proposalIds: replay.proposalIds,
        policyId: policy.id,
        plan: replay.plan,
        createdAt: entry.createdAt,
      });
      if (!reconciliationDecisionMatches(entry, expectedDecision)) {
        throw new FleetReconciliationError(
          `decision ${entry.id} does not match its deterministic identity`
        );
      }
      const proposals = replay.proposalIds.map((proposalId) => {
        const proposal = entriesById.get(proposalId);
        if (
          !proposal
          || proposal.kind !== "contract"
          || proposal.runId !== runId
          || !isContractPayload(proposal.payload)
          || proposal.payload.status !== "proposed"
          || proposal.payload.surface !== replay.surface
        ) {
          throw new FleetReconciliationError(
            `decision ${entry.id} references invalid proposal ${proposalId}`
          );
        }
        return { envelope: proposal, payload: proposal.payload };
      });
      const validated = validateReconciliationPlan({
        surface: replay.surface,
        proposals,
        plan: replay.plan,
        knownTaskIds: state.knownTaskIds,
        settledTaskIds: state.settledTaskIds,
      });
      await this.applyReconciliationPlan(
        scope,
        entry,
        replay.plan,
        validated,
        state.pausedTaskIds
      );
      state.observedDecisionIds.add(entry.id);

      if (replay.plan.escalate) {
        const escalationInputs = [
          "contract-conflict",
          "reconciliation",
          replay.surface,
          ...replay.proposalIds,
        ];
        const priorEscalation = entries.find((candidate) => {
          if (candidate.kind !== "decision") return false;
          const payload = candidate.payload as DecisionPayload;
          return (
            payload.decisionKind === "escalation"
            && canonicalReconciliationJson(payload.inputs)
              === canonicalReconciliationJson(escalationInputs)
          );
        });
        if (priorEscalation) {
          const outcome = (priorEscalation.payload as DecisionPayload).outcome;
          if (
            outcome !== null
            && typeof outcome === "object"
            && (outcome as { kind?: unknown }).kind === "human-handoff"
          ) {
            return true;
          }
        } else {
          const handedOff = await this.escalate(
            runId,
            policy,
            "contract-conflict",
            "escalation",
            ["reconciliation", replay.surface, ...replay.proposalIds]
          );
          if (handedOff) return true;
        }
      }
    }

    const groups = new Map<
      string,
      { records: ContractProposalRecord[]; envelopeIds: string[] }
    >();

    for (const entry of entries) {
      if (state.observedContractIds.has(entry.id)) continue;
      state.observedContractIds.add(entry.id);
      if (
        entry.kind !== "contract" ||
        entry.runId !== runId ||
        !isContractPayload(entry.payload) ||
        entry.payload.status !== "proposed" ||
        resolvedProposalIds.has(entry.id)
      ) {
        continue;
      }

      const group = groups.get(entry.payload.surface);
      if (group) {
        group.records.push({ envelope: entry, payload: entry.payload });
        group.envelopeIds.push(entry.id);
      } else {
        groups.set(entry.payload.surface, {
          records: [{ envelope: entry, payload: entry.payload }],
          envelopeIds: [entry.id],
        });
      }
    }

    for (const [surface, group] of groups) {
      const fleet = [...repoAgents.values()].map((slot) => slot.ref);
      const plan = await policy.onContractChange(
        {
          surface,
          proposalIds: [...group.envelopeIds],
          proposals: group.records.map((record) => record.payload),
        },
        fleet
      );
      const validated = validateReconciliationPlan({
        surface,
        proposals: group.records,
        plan,
        knownTaskIds: state.knownTaskIds,
        settledTaskIds: state.settledTaskIds,
      });
      const decision = await this.writeReconciliationDecision(
        runId,
        policy.id,
        surface,
        group.envelopeIds,
        plan,
      );
      state.observedDecisionIds.add(decision.id);
      await this.applyReconciliationPlan(
        scope,
        decision,
        plan,
        validated,
        state.pausedTaskIds
      );

      if (plan.escalate) {
        const handedOff = await this.escalate(
          runId,
          policy,
          "contract-conflict",
          "escalation",
          ["reconciliation", surface, ...group.envelopeIds]
        );
        if (handedOff) return true;
      }
    }

    return false;
  }

  private async writeReconciliationDecision(
    runId: string,
    policyId: string,
    surface: string,
    proposalIds: string[],
    plan: ReconciliationPlan
  ): Promise<KnowledgeEnvelope> {
    const scope = `run:${runId}`;
    const expected = buildReconciliationDecisionEnvelope({
      runId,
      surface,
      proposalIds: [...proposalIds],
      policyId,
      plan,
      createdAt: new Date().toISOString(),
    });
    const existing = await this.deps.knowledge.read(
      scope,
      "decision",
      expected.key
    );
    if (existing) {
      if (!reconciliationDecisionMatches(existing, expected)) {
        throw new FleetReconciliationError(
          `decision identity ${expected.id} already contains different bytes`
        );
      }
      return existing;
    }
    await this.deps.knowledge.append(scope, expected);
    return expected;
  }

  private async applyReconciliationPlan(
    scope: string,
    decision: KnowledgeEnvelope,
    plan: ReconciliationPlan,
    validated: ValidatedReconciliationPlan,
    pausedTaskIds: Set<string>
  ): Promise<void> {
    if (validated.ratifiedSource) {
      const expected = buildContractTransitionEnvelope({
        parent: validated.ratifiedSource,
        status: "ratified",
        payload: plan.ratified!,
        decision,
      });
      await this.appendReconciliationAction(scope, expected, validated.ratifiedSource.envelope);
    }

    for (const rejected of validated.rejectedSources) {
      const expected = buildContractTransitionEnvelope({
        parent: rejected,
        status: "rejected",
        payload: { ...rejected.payload, status: "rejected" },
        decision,
      });
      await this.appendReconciliationAction(scope, expected, rejected.envelope);
    }

    for (const taskId of validated.pauseTaskIds) {
      const current = await this.deps.knowledge.read(
        scope,
        "task-state",
        taskId
      );
      const identityProbe = buildTaskPauseEnvelope({
        taskId,
        current: null,
        decision,
      });
      if (
        current
        && current.id === identityProbe.id
        && canonicalReconciliationJson(current.payload)
          === canonicalReconciliationJson(identityProbe.payload)
      ) {
        pausedTaskIds.add(taskId);
        continue;
      }
      if (current) {
        const payload = current.payload as TaskStatePayload;
        if (payload.state !== "queued") {
          throw new FleetReconciliationError(
            `queued-only pause cannot replace task ${taskId} state ${payload.state}`
          );
        }
      }
      const expected = buildTaskPauseEnvelope({ taskId, current, decision });
      await this.deps.knowledge.append(scope, expected);
      pausedTaskIds.add(taskId);
    }
  }

  private async appendReconciliationAction(
    scope: string,
    expected: KnowledgeEnvelope,
    parent: KnowledgeEnvelope
  ): Promise<void> {
    const current = await this.deps.knowledge.read(
      scope,
      expected.kind,
      expected.key
    );
    if (current && actionEnvelopeMatches(current, expected)) return;
    if (current && current.id !== parent.id) {
      throw new FleetReconciliationError(
        `action ${expected.id} conflicts with current ${expected.kind}/${expected.key}@${current.version}`
      );
    }
    await this.deps.knowledge.append(scope, expected);
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

    await this.writeDecision(
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
    await this.writeDecision(
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

  private async writeTaskControlState(
    runId: string,
    taskId: string,
    state: TaskState,
    blockedReason: string
  ): Promise<void> {
    const payload: TaskStatePayload = { taskId, state, blockedReason };
    const env: KnowledgeEnvelope = {
      id: ulid(),
      runId,
      repo: null,
      kind: "task-state",
      key: taskId,
      version:
        Date.now() * 1000 +
        (Math.abs(taskId.charCodeAt(taskId.length - 1)) % 1000),
      authorWorkerId: null,
      parentId: null,
      createdAt: new Date().toISOString(),
      supersededAt: null,
      payload,
      tags: ["control"],
    };
    await this.deps.knowledge.append(`run:${runId}`, env);
  }

  private async writeDecision(
    runId: string,
    decisionKind: DecisionKind,
    policyId: string,
    inputs: unknown[],
    outcome: unknown
  ): Promise<void> {
    const env: KnowledgeEnvelope = {
      id: ulid(),
      runId,
      repo: null,
      kind: "decision",
      key: `${decisionKind}-${ulid()}`,
      version: 1,
      authorWorkerId: null,
      parentId: null,
      createdAt: new Date().toISOString(),
      supersededAt: null,
      payload: { decisionKind, inputs, outcome, policyId },
      tags: [],
    };
    await this.deps.knowledge.append(`run:${runId}`, env);
  }
}
