import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FleetSupervisor } from "../fleet-supervisor.js";
import { DependencyTrackerPolicy } from "../policies/dependency-tracker-policy.js";
import { FanOutPolicy } from "../policies/fan-out-policy.js";
import { FilesystemKnowledgeStore } from "@dzupagent/memory/knowledge";
import type {
  Assignment,
  ContractChange,
  EscalationOutcome,
  EscalationReason,
  Executor,
  FleetPolicy,
  FleetRunSpec,
  FleetSupervisorApi,
  FleetTask,
  KnowledgeEnvelope,
  KnowledgeStore,
  ReconciliationPlan,
  RepoAgentRef,
  RepoAgentResult,
  WorkerEvent,
  WorkerHandle,
  WorkerOutcome,
  WorkerSpec,
} from "@dzupagent/agent-types/fleet";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "supesc-"));
});

/**
 * Local scripted executor. Per-task outcomes are resolved through a callback so
 * a test can make the first dispatch of a task fail and a later retry succeed.
 * Lives in-test to avoid an agent → agent-adapters dependency cycle.
 */
class ScriptedExecutor implements Executor {
  readonly id = "scripted";
  readonly dispatches: string[] = [];

  constructor(
    private readonly outcomeFor: (
      taskId: string,
      attempt: number
    ) => WorkerOutcome
  ) {}

  attemptsFor(taskId: string): number {
    return this.dispatches.filter((d) => d === taskId).length;
  }

  async spawn(spec: WorkerSpec): Promise<WorkerHandle> {
    const taskId = spec.taskBundle.id;
    this.dispatches.push(taskId);
    const attempt = this.attemptsFor(taskId);
    const outcome = this.outcomeFor(taskId, attempt);
    return {
      workerId: spec.workerId,
      events: (async function* (): AsyncGenerator<WorkerEvent> {
        yield { kind: "exit", code: 0, reason: null, at: "t" };
      })(),
      async send() {},
      async cancel() {},
      async wait(): Promise<WorkerOutcome> {
        return outcome;
      },
    };
  }
}

const ALWAYS_OK = (): WorkerOutcome => ({ state: "completed", exitCode: 0 });

/**
 * Records every onEscalation call and answers with a caller-supplied outcome,
 * so tests can drive both branches of EscalationOutcome (human-handoff, retry)
 * through the supervisor without depending on a concrete built-in policy.
 */
class RecordingPolicy implements FleetPolicy {
  readonly id = "recording";
  readonly escalations: EscalationReason[] = [];

  constructor(private readonly outcome: EscalationOutcome) {}

  async assignTask(
    task: FleetTask,
    fleet: RepoAgentRef[],
    _knowledge: KnowledgeStore
  ): Promise<Assignment> {
    const free = fleet.find((f) => !f.busy);
    if (!free) throw new Error(`No available worker for task ${task.id}`);
    return { taskId: task.id, workerId: free.workerId, rationale: "recording" };
  }

  async onContractChange(
    _change: ContractChange,
    _fleet: RepoAgentRef[]
  ): Promise<ReconciliationPlan> {
    return { ratified: null, rejectIds: [], pauseTasks: [], escalate: false };
  }

  async onWorkerComplete(
    _result: RepoAgentResult,
    _supervisor: FleetSupervisorApi
  ): Promise<void> {}

  async onEscalation(
    reason: EscalationReason,
    _supervisor: FleetSupervisorApi
  ): Promise<EscalationOutcome> {
    this.escalations.push(reason);
    return this.outcome;
  }
}

async function queryAll(
  store: FilesystemKnowledgeStore,
  scope: string
): Promise<KnowledgeEnvelope[]> {
  const results: KnowledgeEnvelope[] = [];
  for await (const e of store.query({ scope })) results.push(e);
  return results;
}

function decisions(entries: KnowledgeEnvelope[]): {
  decisionKind: string;
  inputs: unknown[];
  outcome: unknown;
  policyId: string;
}[] {
  return entries
    .filter((e) => e.kind === "decision")
    .map(
      (e) =>
        e.payload as {
          decisionKind: string;
          inputs: unknown[];
          outcome: unknown;
          policyId: string;
        }
    );
}

describe("FleetSupervisor escalation — human-handoff", () => {
  it("terminates the run as escalated when the policy hands off", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const policy = new RecordingPolicy({
      kind: "human-handoff",
      note: "operator please look",
    });
    const sup = new FleetSupervisor({
      knowledge: store,
      // The single task fails, which is the repeated-failure trigger in the
      // sequential branch.
      executorFor: () =>
        new ScriptedExecutor(() => ({ state: "failed", exitCode: 1 })),
    });
    const spec: FleetRunSpec = {
      runId: "esc-handoff",
      scenario: "independent-tasks",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: [{ id: "t1", description: "", payload: {}, dependsOn: [] }],
    };
    const r = await sup.run(spec, policy);
    expect(policy.escalations).toEqual(["repeated-failure"]);
    expect(r.status).toBe("escalated");
  });

  it("writes an escalation decision envelope naming the policy and reason", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const policy = new RecordingPolicy({ kind: "human-handoff", note: "stop" });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () =>
        new ScriptedExecutor(() => ({ state: "failed", exitCode: 1 })),
    });
    const spec: FleetRunSpec = {
      runId: "esc-envelope",
      scenario: "independent-tasks",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: [{ id: "t1", description: "", payload: {}, dependsOn: [] }],
    };
    await sup.run(spec, policy);
    const escalation = decisions(
      await queryAll(store, "run:esc-envelope")
    ).find((d) => d.decisionKind === "escalation");
    expect(escalation).toBeDefined();
    expect(escalation?.policyId).toBe("recording");
    expect(escalation?.inputs).toContain("repeated-failure");
    expect(escalation?.outcome).toMatchObject({ kind: "human-handoff" });
  });
});

describe("FleetSupervisor escalation — retry", () => {
  it("retries the triggering task once and completes when the retry succeeds", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const policy = new RecordingPolicy({ kind: "retry", delayMs: 5000 });
    const executor = new ScriptedExecutor((_taskId, attempt) =>
      attempt === 1
        ? { state: "failed", exitCode: 1 }
        : { state: "completed", exitCode: 0 }
    );
    const sleeps: number[] = [];
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => executor,
      // Injected sleep keeps the suite fast: a 5s policy delay costs nothing
      // here, and the test can assert the delay was honoured.
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const spec: FleetRunSpec = {
      runId: "esc-retry-ok",
      scenario: "independent-tasks",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: [{ id: "t1", description: "", payload: {}, dependsOn: [] }],
    };
    const r = await sup.run(spec, policy);
    expect(executor.attemptsFor("t1")).toBe(2);
    expect(sleeps).toEqual([5000]);
    expect(r.status).toBe("completed");
    // The retry result replaces the failed one — the run reports one outcome.
    expect(r.taskOutcomes).toHaveLength(1);
    expect(r.taskOutcomes[0]?.state).toBe("completed");
  });

  it("bounds retries to one attempt and falls through to failed", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const policy = new RecordingPolicy({ kind: "retry", delayMs: 1 });
    const executor = new ScriptedExecutor(() => ({
      state: "failed",
      exitCode: 1,
    }));
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => executor,
      sleep: async () => {},
    });
    const spec: FleetRunSpec = {
      runId: "esc-retry-exhausted",
      scenario: "independent-tasks",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: [{ id: "t1", description: "", payload: {}, dependsOn: [] }],
    };
    const r = await sup.run(spec, policy);
    // Exactly two dispatches: the original plus one bounded retry.
    expect(executor.attemptsFor("t1")).toBe(2);
    // And the policy is only consulted once — the retry does not re-escalate,
    // which is what would produce an unbounded retry loop.
    expect(policy.escalations).toEqual(["repeated-failure"]);
    expect(r.status).toBe("failed");
  });
});

describe("FleetSupervisor escalation — existing failure semantics preserved", () => {
  it("fan-out task failures still report failed, not escalated", async () => {
    // Fan-out deliberately does NOT route task failures to onEscalation: every
    // repo runs the same task, so one repo failing is a normal partial result,
    // not a repeated failure of a single unit of work.
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () =>
        new ScriptedExecutor(() => ({ state: "failed", exitCode: 1 })),
    });
    const spec: FleetRunSpec = {
      runId: "fanout-failed",
      scenario: "audit-fanout",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: [{ id: "t1", description: "", payload: {}, dependsOn: [] }],
    };
    const r = await sup.run(spec, new FanOutPolicy());
    expect(r.status).toBe("failed");
  });

  it("does not escalate at all when every task completes", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const policy = new RecordingPolicy({ kind: "human-handoff", note: "n/a" });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => new ScriptedExecutor(ALWAYS_OK),
    });
    const spec: FleetRunSpec = {
      runId: "no-escalation",
      scenario: "independent-tasks",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: [
        { id: "t1", description: "", payload: {}, dependsOn: [] },
        { id: "t2", description: "", payload: {}, dependsOn: [] },
      ],
    };
    const r = await sup.run(spec, policy);
    expect(policy.escalations).toEqual([]);
    expect(r.status).toBe("completed");
    const kinds = decisions(await queryAll(store, "run:no-escalation")).map(
      (d) => d.decisionKind
    );
    expect(kinds).not.toContain("escalation");
  });
});

describe("FleetSupervisor dependency deferral", () => {
  it("defers an out-of-order dependent task instead of aborting the run", async () => {
    // Tasks are declared B-before-A, so DependencyTrackerPolicy.assignTask
    // throws on the first pass. The supervisor must re-queue B, run A, then
    // retry B — rather than propagating the throw out of run().
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => new ScriptedExecutor(ALWAYS_OK),
    });
    const spec: FleetRunSpec = {
      runId: "dep-order",
      scenario: "coordinated-feature",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: [
        { id: "B", description: "", payload: {}, dependsOn: ["A"] },
        { id: "A", description: "", payload: {}, dependsOn: [] },
      ],
    };
    const r = await sup.run(
      spec,
      new DependencyTrackerPolicy({ runId: "dep-order" })
    );
    expect(r.status).toBe("completed");
    // Execution order follows dependency satisfaction, not declaration order.
    expect(r.taskOutcomes.map((o) => o.taskId)).toEqual(["A", "B"]);
  });

  it("handles a chain deferred more than one pass", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => new ScriptedExecutor(ALWAYS_OK),
    });
    const spec: FleetRunSpec = {
      runId: "dep-chain",
      scenario: "coordinated-feature",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: [
        { id: "C", description: "", payload: {}, dependsOn: ["B"] },
        { id: "B", description: "", payload: {}, dependsOn: ["A"] },
        { id: "A", description: "", payload: {}, dependsOn: [] },
      ],
    };
    const r = await sup.run(
      spec,
      new DependencyTrackerPolicy({ runId: "dep-chain" })
    );
    expect(r.status).toBe("completed");
    expect(r.taskOutcomes.map((o) => o.taskId)).toEqual(["A", "B", "C"]);
  });

  it("routes an unsatisfiable dependency to escalation instead of hanging", async () => {
    // "ghost" is never a task in the spec, so B can never become assignable.
    // A full pass with no progress is a deadlock → repeated-failure escalation.
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => new ScriptedExecutor(ALWAYS_OK),
    });
    const spec: FleetRunSpec = {
      runId: "dep-deadlock",
      scenario: "coordinated-feature",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: [{ id: "B", description: "", payload: {}, dependsOn: ["ghost"] }],
    };
    const r = await sup.run(
      spec,
      new DependencyTrackerPolicy({ runId: "dep-deadlock" })
    );
    // DependencyTrackerPolicy.onEscalation answers `retry`, which cannot fix a
    // structurally unsatisfiable dependency, so the run ends non-completed
    // rather than looping forever.
    expect(r.status).not.toBe("completed");
    const escalations = decisions(await queryAll(store, "run:dep-deadlock"))
      .filter((d) => d.decisionKind === "escalation")
      .map((d) => d.inputs);
    expect(escalations.length).toBeGreaterThanOrEqual(1);
    expect(escalations.some((i) => i.includes("repeated-failure"))).toBe(true);
  });

  it("escalates a mutual dependency cycle", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const policy = new RecordingPolicy({
      kind: "human-handoff",
      note: "cycle",
    });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => new ScriptedExecutor(ALWAYS_OK),
    });
    // RecordingPolicy assigns anything, so use the dependency-aware policy for
    // the deferral and a handoff answer for the terminal status.
    const depPolicy = new DependencyTrackerPolicy({ runId: "dep-cycle" });
    const cyclePolicy: FleetPolicy = {
      id: "dep-cycle-hybrid",
      assignTask: (t, f, k) => depPolicy.assignTask(t, f, k),
      onContractChange: (c, f) => depPolicy.onContractChange(c, f),
      onWorkerComplete: (r, s) => depPolicy.onWorkerComplete(r, s),
      onEscalation: (reason, s) => policy.onEscalation(reason, s),
    };
    const spec: FleetRunSpec = {
      runId: "dep-cycle",
      scenario: "coordinated-feature",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: [
        { id: "X", description: "", payload: {}, dependsOn: ["Y"] },
        { id: "Y", description: "", payload: {}, dependsOn: ["X"] },
      ],
    };
    const r = await sup.run(spec, cyclePolicy);
    expect(r.status).toBe("escalated");
    expect(policy.escalations).toContain("repeated-failure");
  });

  it("still throws on an unknown worker id (programming error, not deferrable)", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const rogue: FleetPolicy = {
      id: "rogue",
      async assignTask(task): Promise<Assignment> {
        return { taskId: task.id, workerId: "no-such-worker", rationale: "?" };
      },
      async onContractChange(): Promise<ReconciliationPlan> {
        return {
          ratified: null,
          rejectIds: [],
          pauseTasks: [],
          escalate: false,
        };
      },
      async onWorkerComplete(): Promise<void> {},
      async onEscalation(): Promise<EscalationOutcome> {
        return { kind: "human-handoff", note: "n/a" };
      },
    };
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => new ScriptedExecutor(ALWAYS_OK),
    });
    const spec: FleetRunSpec = {
      runId: "rogue-worker",
      scenario: "independent-tasks",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: [{ id: "t1", description: "", payload: {}, dependsOn: [] }],
    };
    await expect(sup.run(spec, rogue)).rejects.toThrow(
      /assigned unknown worker/
    );
  });
});
