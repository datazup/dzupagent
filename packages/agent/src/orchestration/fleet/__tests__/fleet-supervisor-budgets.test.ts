import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FleetSupervisor } from "../fleet-supervisor.js";
import { FanOutPolicy } from "../policies/fan-out-policy.js";
import { SupervisorPolicy } from "../policies/supervisor-policy.js";
import { FilesystemKnowledgeStore } from "@dzupagent/memory/knowledge";
import type {
  Executor,
  KnowledgeEnvelope,
  WorkerHandle,
  WorkerSpec,
  WorkerEvent,
  WorkerOutcome,
  FleetRunSpec,
} from "@dzupagent/agent-types/fleet";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "supbudget-"));
});

/**
 * Local scripted executor — emits a fixed WorkerEvent[] then exits completed.
 * Lives in-test to avoid an agent → agent-adapters dependency cycle
 * (agent-adapters depends on agent), mirroring the other fleet supervisor tests.
 */
class ScriptedExecutor implements Executor {
  readonly id = "scripted";
  spawnCount = 0;

  constructor(private readonly script: WorkerEvent[]) {}

  async spawn(spec: WorkerSpec): Promise<WorkerHandle> {
    this.spawnCount += 1;
    const script = this.script;
    return {
      workerId: spec.workerId,
      events: (async function* () {
        for (const e of script) yield e;
      })(),
      async send() {},
      async cancel() {},
      async wait(): Promise<WorkerOutcome> {
        return { state: "completed", exitCode: 0 };
      },
    };
  }
}

/** Two tool_call events per task, so budgets of 1/2/3 are all distinguishable. */
const TWO_TOOL_CALLS: WorkerEvent[] = [
  { kind: "step_start", stepId: "s1", at: "t" },
  { kind: "tool_call", toolName: "read", inputSummary: "a", at: "t" },
  { kind: "tool_call", toolName: "write", inputSummary: "b", at: "t" },
  { kind: "step_done", stepId: "s1", at: "t" },
  { kind: "exit", code: 0, reason: null, at: "t" },
];

const NO_TOOL_CALLS: WorkerEvent[] = [
  { kind: "step_start", stepId: "s1", at: "t" },
  { kind: "step_done", stepId: "s1", at: "t" },
  { kind: "exit", code: 0, reason: null, at: "t" },
];

async function queryAll(
  store: FilesystemKnowledgeStore,
  scope: string
): Promise<KnowledgeEnvelope[]> {
  const results: KnowledgeEnvelope[] = [];
  for await (const e of store.query({ scope })) results.push(e);
  return results;
}

function decisionKinds(entries: KnowledgeEnvelope[]): string[] {
  return entries
    .filter((e) => e.kind === "decision")
    .map((e) => (e.payload as { decisionKind: string }).decisionKind);
}

function threeTasks(): FleetRunSpec["tasks"] {
  return [
    { id: "t1", description: "", payload: {}, dependsOn: [] },
    { id: "t2", description: "", payload: {}, dependsOn: [] },
    { id: "t3", description: "", payload: {}, dependsOn: [] },
  ];
}

describe("FleetSupervisor budgets — inert when unset", () => {
  it("runs every task when spec.budgets is undefined", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const executor = new ScriptedExecutor(TWO_TOOL_CALLS);
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => executor,
    });
    const spec: FleetRunSpec = {
      runId: "no-budget",
      scenario: "audit-fanout",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: threeTasks(),
    };
    const r = await sup.run(spec, new FanOutPolicy());
    expect(r.status).toBe("completed");
    expect(r.taskOutcomes).toHaveLength(3);
  });

  it("runs every task when budgets is present but all fields are undefined", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => new ScriptedExecutor(TWO_TOOL_CALLS),
    });
    const spec: FleetRunSpec = {
      runId: "empty-budget",
      scenario: "audit-fanout",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: threeTasks(),
      budgets: {},
    };
    const r = await sup.run(spec, new FanOutPolicy());
    expect(r.status).toBe("completed");
    expect(r.taskOutcomes).toHaveLength(3);
  });

  it("does not enforce maxTokens (documented as unenforceable — no token source)", async () => {
    // FleetBudgets.maxTokens is deliberately NOT enforced: WorkerEvent carries no
    // token accounting, so there is nothing to measure. A maxTokens of 1 must
    // therefore be a complete no-op rather than aborting the run.
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => new ScriptedExecutor(TWO_TOOL_CALLS),
    });
    const spec: FleetRunSpec = {
      runId: "tokens-inert",
      scenario: "audit-fanout",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: threeTasks(),
      budgets: { maxTokens: 1 },
    };
    const r = await sup.run(spec, new FanOutPolicy());
    expect(r.status).toBe("completed");
    expect(r.taskOutcomes).toHaveLength(3);
  });
});

describe("FleetSupervisor budgets — maxToolCalls (fan-out)", () => {
  it("stops dispatching once the cumulative tool_call count exceeds the budget", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const executor = new ScriptedExecutor(TWO_TOOL_CALLS);
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => executor,
    });
    // Budget 3: after t1 the count is 2 (<=3, keep going); after t2 it is 4 (>3,
    // stop). t3 must never be dispatched.
    const spec: FleetRunSpec = {
      runId: "toolcap",
      scenario: "audit-fanout",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: threeTasks(),
      budgets: { maxToolCalls: 3 },
    };
    const r = await sup.run(spec, new FanOutPolicy());
    expect(r.taskOutcomes.map((o) => o.taskId)).toEqual(["t1", "t2"]);
    expect(executor.spawnCount).toBe(2);
  });

  it("escalates with budget-exhausted and terminates escalated under a human-handoff policy", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => new ScriptedExecutor(TWO_TOOL_CALLS),
    });
    const spec: FleetRunSpec = {
      runId: "toolcap-esc",
      scenario: "audit-fanout",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: threeTasks(),
      budgets: { maxToolCalls: 1 },
    };
    const r = await sup.run(spec, new FanOutPolicy());
    // FanOutPolicy.onEscalation returns human-handoff → run terminates escalated.
    expect(r.status).toBe("escalated");
    const kinds = decisionKinds(await queryAll(store, "run:toolcap-esc"));
    expect(kinds).toContain("budget-exhausted");
  });

  it("records the escalation reason and policy outcome in the decision envelope", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => new ScriptedExecutor(TWO_TOOL_CALLS),
    });
    const spec: FleetRunSpec = {
      runId: "toolcap-payload",
      scenario: "audit-fanout",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: threeTasks(),
      budgets: { maxToolCalls: 1 },
    };
    await sup.run(spec, new FanOutPolicy());
    const entries = await queryAll(store, "run:toolcap-payload");
    const escalation = entries.find(
      (e) =>
        e.kind === "decision" &&
        (e.payload as { decisionKind: string }).decisionKind ===
          "budget-exhausted"
    );
    expect(escalation).toBeDefined();
    const payload = escalation?.payload as {
      inputs: unknown[];
      outcome: unknown;
      policyId: string;
    };
    expect(payload.policyId).toBe("fan-out");
    expect(payload.inputs).toContain("budget-exhausted");
    expect(payload.outcome).toMatchObject({ kind: "human-handoff" });
  });

  it("does not stop when the tool_call count stays at or below the budget", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => new ScriptedExecutor(TWO_TOOL_CALLS),
    });
    const spec: FleetRunSpec = {
      runId: "toolcap-headroom",
      scenario: "audit-fanout",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: threeTasks(),
      budgets: { maxToolCalls: 6 },
    };
    const r = await sup.run(spec, new FanOutPolicy());
    expect(r.status).toBe("completed");
    expect(r.taskOutcomes).toHaveLength(3);
  });

  it("counts tool_calls across all repos in a fan-out task", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => new ScriptedExecutor(TWO_TOOL_CALLS),
    });
    // 2 repos × 2 tool calls = 4 after the first task alone, exceeding 3.
    const spec: FleetRunSpec = {
      runId: "toolcap-fanwide",
      scenario: "audit-fanout",
      repos: [
        { name: "a", path: "/tmp/a" },
        { name: "b", path: "/tmp/b" },
      ],
      tasks: threeTasks(),
      budgets: { maxToolCalls: 3 },
    };
    const r = await sup.run(spec, new FanOutPolicy());
    expect(r.taskOutcomes.map((o) => o.taskId)).toEqual(["t1", "t1"]);
  });

  it("ignores non-tool_call events when counting", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => new ScriptedExecutor(NO_TOOL_CALLS),
    });
    const spec: FleetRunSpec = {
      runId: "toolcap-none",
      scenario: "audit-fanout",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: threeTasks(),
      budgets: { maxToolCalls: 1 },
    };
    const r = await sup.run(spec, new FanOutPolicy());
    expect(r.status).toBe("completed");
    expect(r.taskOutcomes).toHaveLength(3);
  });
});

describe("FleetSupervisor budgets — maxToolCalls (sequential)", () => {
  it("stops dispatching in the sequential policy branch too", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const executor = new ScriptedExecutor(TWO_TOOL_CALLS);
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => executor,
    });
    const spec: FleetRunSpec = {
      runId: "seq-toolcap",
      scenario: "independent-tasks",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: threeTasks(),
      budgets: { maxToolCalls: 3 },
    };
    const r = await sup.run(spec, new SupervisorPolicy());
    expect(r.taskOutcomes.map((o) => o.taskId)).toEqual(["t1", "t2"]);
    expect(executor.spawnCount).toBe(2);
    const kinds = decisionKinds(await queryAll(store, "run:seq-toolcap"));
    expect(kinds).toContain("budget-exhausted");
  });
});

describe("FleetSupervisor budgets — wallclockMs", () => {
  it("stops dispatching once the run deadline has passed (fan-out)", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const executor = new ScriptedExecutor(NO_TOOL_CALLS);
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => executor,
      // Injected clock: reads 0, 10, 20, … With a 15ms budget the pre-dispatch
      // check before t2 sees 10ms elapsed (under budget, so t2 runs) and the
      // check before t3 sees 20ms (over budget, so t3 is skipped). No real
      // sleeping, so the suite stays fast.
      now: stepClock(10),
    });
    const spec: FleetRunSpec = {
      runId: "wallclock",
      scenario: "audit-fanout",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: threeTasks(),
      budgets: { wallclockMs: 15 },
    };
    const r = await sup.run(spec, new FanOutPolicy());
    expect(r.status).toBe("escalated");
    expect(r.taskOutcomes.map((o) => o.taskId)).toEqual(["t1", "t2"]);
    expect(executor.spawnCount).toBe(2);
    const kinds = decisionKinds(await queryAll(store, "run:wallclock"));
    expect(kinds).toContain("budget-exhausted");
  });

  it("stops dispatching once the run deadline has passed (sequential)", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => new ScriptedExecutor(NO_TOOL_CALLS),
      now: stepClock(10),
    });
    const spec: FleetRunSpec = {
      runId: "wallclock-seq",
      scenario: "independent-tasks",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: threeTasks(),
      budgets: { wallclockMs: 15 },
    };
    const r = await sup.run(spec, new SupervisorPolicy());
    expect(r.taskOutcomes.length).toBeLessThan(3);
    const kinds = decisionKinds(await queryAll(store, "run:wallclock-seq"));
    expect(kinds).toContain("budget-exhausted");
  });

  it("dispatches the first task even with a zero wallclock budget", async () => {
    // The deadline is only checked BEFORE dispatch of tasks 2..n; the first
    // task always runs so a run can never be a silent zero-work no-op.
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const executor = new ScriptedExecutor(NO_TOOL_CALLS);
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => executor,
      now: stepClock(100),
    });
    const spec: FleetRunSpec = {
      runId: "wallclock-zero",
      scenario: "audit-fanout",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: threeTasks(),
      budgets: { wallclockMs: 0 },
    };
    const r = await sup.run(spec, new FanOutPolicy());
    expect(executor.spawnCount).toBe(1);
    expect(r.taskOutcomes).toHaveLength(1);
  });

  it("is inert when the deadline is never reached", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => new ScriptedExecutor(NO_TOOL_CALLS),
      now: stepClock(1),
    });
    const spec: FleetRunSpec = {
      runId: "wallclock-roomy",
      scenario: "audit-fanout",
      repos: [{ name: "a", path: "/tmp/a" }],
      tasks: threeTasks(),
      budgets: { wallclockMs: 10_000 },
    };
    const r = await sup.run(spec, new FanOutPolicy());
    expect(r.status).toBe("completed");
    expect(r.taskOutcomes).toHaveLength(3);
  });
});

/** Deterministic monotonic clock: starts at 0, advances `stepMs` per call. */
function stepClock(stepMs: number): () => number {
  let t = 0;
  return () => {
    const value = t;
    t += stepMs;
    return value;
  };
}
