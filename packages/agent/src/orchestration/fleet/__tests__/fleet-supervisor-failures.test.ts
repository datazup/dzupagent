import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FleetSupervisor } from "../fleet-supervisor.js";
import { FanOutPolicy } from "../policies/fan-out-policy.js";
import { FilesystemKnowledgeStore } from "@dzupagent/memory/knowledge";
import type {
  Executor,
  WorkerHandle,
  WorkerSpec,
  WorkerEvent,
  WorkerOutcome,
  FleetRunSpec,
} from "@dzupagent/agent-types/fleet";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "supfail-"));
});

/**
 * Local scripted executor — emits a fixed WorkerEvent[] then resolves wait()
 * with the supplied outcome. Lives in-test to avoid an agent → agent-adapters
 * dependency cycle (agent-adapters depends on agent), mirroring
 * repo-agent.test.ts and fleet-supervisor-happy-path.test.ts.
 *
 * IMPORTANT: RepoAgent derives the task's terminal TaskState from
 * `handle.wait()`'s `outcome.state`, NOT from the exit-event code. So a failure
 * must be expressed via the outcome here (state: "failed"), not just an exit
 * event with code !== 0.
 */
class ScriptedExecutor implements Executor {
  readonly id = "scripted";
  constructor(
    private readonly script: WorkerEvent[],
    private readonly outcome: WorkerOutcome,
  ) {}

  async spawn(spec: WorkerSpec): Promise<WorkerHandle> {
    const script = this.script;
    const outcome = this.outcome;
    return {
      workerId: spec.workerId,
      events: (async function* () {
        for (const e of script) yield e;
      })(),
      async send() {},
      async cancel() {},
      async wait(): Promise<WorkerOutcome> {
        return outcome;
      },
    };
  }
}

function scriptFor(code: number): WorkerEvent[] {
  return [
    { kind: "step_start", stepId: "s1", at: "t" },
    { kind: "step_done", stepId: "s1", at: "t" },
    { kind: "exit", code, reason: null, at: "t" },
  ];
}

async function collectKnowledge(
  store: FilesystemKnowledgeStore,
  runId: string,
): Promise<KnowledgeEnvelope[]> {
  const results: KnowledgeEnvelope[] = [];
  for await (const entry of store.query({ scope: `run:${runId}` })) {
    results.push(entry);
  }
  return results;
}

import type { KnowledgeEnvelope } from "@dzupagent/agent-types/fleet";

describe("FleetSupervisor failure paths", () => {
  it("reports failed status when any worker exits non-zero", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: (repo) => {
        const failed = repo.name === "bad";
        return new ScriptedExecutor(
          scriptFor(failed ? 2 : 0),
          failed
            ? { state: "failed", exitCode: 2 }
            : { state: "completed", exitCode: 0 },
        );
      },
    });
    const spec: FleetRunSpec = {
      runId: "rf",
      scenario: "audit-fanout",
      repos: [
        { name: "good", path: "/tmp/good" },
        { name: "bad", path: "/tmp/bad" },
      ],
      tasks: [{ id: "t1", description: "", payload: {}, dependsOn: [] }],
    };
    const result = await sup.run(spec, new FanOutPolicy());
    expect(result.status).toBe("failed");
    expect(result.taskOutcomes.find((t) => t.repo === "bad")?.state).toBe(
      "failed",
    );
    expect(result.taskOutcomes.find((t) => t.repo === "good")?.state).toBe(
      "completed",
    );
  });

  it("maps crashed outcome to failed task state", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () =>
        new ScriptedExecutor(scriptFor(1), { state: "crashed", exitCode: 1 }),
    });
    const spec: FleetRunSpec = {
      runId: "crashed-run",
      scenario: "audit-fanout",
      repos: [{ name: "repo-a", path: "/tmp/repo-a" }],
      tasks: [{ id: "t1", description: "", payload: {}, dependsOn: [] }],
    };
    const result = await sup.run(spec, new FanOutPolicy());
    expect(result.status).toBe("failed");
    expect(result.taskOutcomes[0]?.state).toBe("failed");
  });

  it("maps cancelled outcome to surrendered task state", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () =>
        new ScriptedExecutor(scriptFor(0), {
          state: "cancelled",
          exitCode: null,
        }),
    });
    const spec: FleetRunSpec = {
      runId: "cancelled-run",
      scenario: "audit-fanout",
      repos: [{ name: "repo-a", path: "/tmp/repo-a" }],
      tasks: [{ id: "t1", description: "", payload: {}, dependsOn: [] }],
    };
    const result = await sup.run(spec, new FanOutPolicy());
    expect(result.status).toBe("failed");
    expect(result.taskOutcomes[0]?.state).toBe("surrendered");
  });

  it("propagates spawn error out of run()", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => ({
        id: "failing-spawn",
        async spawn(): Promise<WorkerHandle> {
          throw new Error("executor unavailable");
        },
      }),
    });
    const spec: FleetRunSpec = {
      runId: "spawn-err",
      scenario: "audit-fanout",
      repos: [{ name: "repo-a", path: "/tmp/repo-a" }],
      tasks: [{ id: "t1", description: "", payload: {}, dependsOn: [] }],
    };
    await expect(sup.run(spec, new FanOutPolicy())).rejects.toThrow(
      "executor unavailable",
    );
  });

  it("writes task-state transitions to the knowledge store for a failed run", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () =>
        new ScriptedExecutor(scriptFor(1), { state: "failed", exitCode: 1 }),
    });
    const spec: FleetRunSpec = {
      runId: "state-trace",
      scenario: "audit-fanout",
      repos: [{ name: "repo-a", path: "/tmp/repo-a" }],
      tasks: [{ id: "task-x", description: "", payload: {}, dependsOn: [] }],
    };
    await sup.run(spec, new FanOutPolicy());

    const entries = await collectKnowledge(store, "state-trace");
    const taskStates = entries
      .filter((e) => e.kind === "task-state")
      .map((e) => (e.payload as { state: string }).state);

    expect(taskStates).toContain("claimed");
    expect(taskStates).toContain("in-progress");
    expect(taskStates).toContain("failed");
  });

  it("result includes a valid ISO finishedAt timestamp on failure", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () =>
        new ScriptedExecutor(scriptFor(1), { state: "failed", exitCode: 1 }),
    });
    const spec: FleetRunSpec = {
      runId: "ts-check",
      scenario: "audit-fanout",
      repos: [{ name: "repo-a", path: "/tmp/repo-a" }],
      tasks: [{ id: "t1", description: "", payload: {}, dependsOn: [] }],
    };
    const result = await sup.run(spec, new FanOutPolicy());
    expect(result.finishedAt).toBeDefined();
    expect(Number.isNaN(Date.parse(result.finishedAt))).toBe(false);
  });

  it("seedKnowledge entries are written to the store before the run", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () =>
        new ScriptedExecutor(scriptFor(0), { state: "completed", exitCode: 0 }),
    });
    const seedEntry: KnowledgeEnvelope = {
      id: "seed-1",
      runId: "seed-run",
      repo: null,
      kind: "context",
      key: "seed-key",
      version: 1,
      authorWorkerId: null,
      parentId: null,
      createdAt: new Date().toISOString(),
      supersededAt: null,
      payload: { data: "seed value" },
      tags: ["seed"],
    };
    const spec: FleetRunSpec = {
      runId: "seed-run",
      scenario: "audit-fanout",
      repos: [{ name: "repo-a", path: "/tmp/repo-a" }],
      tasks: [{ id: "t1", description: "", payload: {}, dependsOn: [] }],
      seedKnowledge: [seedEntry],
    };
    await sup.run(spec, new FanOutPolicy());

    const entries = await collectKnowledge(store, "seed-run");
    const seed = entries.find((e) => e.id === "seed-1");
    expect(seed).toBeDefined();
    expect(seed?.key).toBe("seed-key");
  });

  it("outcome state drives task result, not exit event code in the stream", async () => {
    // The exit event in the stream has code: 0, but the outcome reports failed.
    // RepoAgent must use outcome.state to determine the terminal TaskState.
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () =>
        new ScriptedExecutor(
          scriptFor(0), // exit code 0 in the stream
          { state: "failed", exitCode: 1 }, // but outcome says failed
        ),
    });
    const spec: FleetRunSpec = {
      runId: "outcome-vs-event",
      scenario: "audit-fanout",
      repos: [{ name: "repo-a", path: "/tmp/repo-a" }],
      tasks: [{ id: "t1", description: "", payload: {}, dependsOn: [] }],
    };
    const result = await sup.run(spec, new FanOutPolicy());
    expect(result.status).toBe("failed");
    expect(result.taskOutcomes[0]?.state).toBe("failed");
  });

  it("all-repos-failed fan-out produces failed result with all task outcomes failed", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () =>
        new ScriptedExecutor(scriptFor(1), { state: "failed", exitCode: 1 }),
    });
    const spec: FleetRunSpec = {
      runId: "all-fail",
      scenario: "audit-fanout",
      repos: [
        { name: "repo-a", path: "/tmp/repo-a" },
        { name: "repo-b", path: "/tmp/repo-b" },
        { name: "repo-c", path: "/tmp/repo-c" },
      ],
      tasks: [{ id: "t1", description: "", payload: {}, dependsOn: [] }],
    };
    const result = await sup.run(spec, new FanOutPolicy());
    expect(result.status).toBe("failed");
    expect(result.taskOutcomes).toHaveLength(3);
    expect(result.taskOutcomes.every((o) => o.state === "failed")).toBe(true);
  });
});
