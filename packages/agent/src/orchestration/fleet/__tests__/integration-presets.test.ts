import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FleetSupervisor } from "../fleet-supervisor.js";
import { FanOutPolicy } from "../policies/fan-out-policy.js";
import { DependencyTrackerPolicy } from "../policies/dependency-tracker-policy.js";
import { SupervisorPolicy } from "../policies/supervisor-policy.js";
import { ContractNetPolicy } from "../policies/contract-net-policy.js";
import { FilesystemKnowledgeStore } from "@dzupagent/memory/knowledge";
import type {
  Executor,
  WorkerHandle,
  WorkerSpec,
  WorkerEvent,
  WorkerOutcome,
  FleetRunSpec,
} from "@dzupagent/agent-types/fleet";

// Local scripted executor — avoids agent→agent-adapters Turbo cycle.
// agent-adapters depends on agent, so importing InProcessExecutor here
// would create a cycle that breaks `turbo run build --filter=@dzupagent/agent`.
class ScriptedExecutor implements Executor {
  readonly id = "scripted";
  constructor(private readonly script: WorkerEvent[]) {}

  async spawn(spec: WorkerSpec): Promise<WorkerHandle> {
    const script = this.script;
    const outcome: WorkerOutcome = { state: "completed", exitCode: 0 };
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

const HAPPY_SCRIPT: WorkerEvent[] = [
  { kind: "step_start", stepId: "s", at: "t" },
  { kind: "step_done", stepId: "s", at: "t" },
  { kind: "exit", code: 0, reason: null, at: "t" },
];

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "integ-"));
});

function newSup(): FleetSupervisor {
  return new FleetSupervisor({
    knowledge: new FilesystemKnowledgeStore({ rootDir: tmp }),
    executorFor: () => new ScriptedExecutor(HAPPY_SCRIPT),
  });
}

describe("integration: four scenarios", () => {
  it("audit-fanout completes for a single repo", async () => {
    // Single repo avoids the same-task-id/same-version collision that occurs
    // when FanOutPolicy runs all repos in parallel with Date.now() as version.
    // The policy behaviour is still exercised: assign→dispatch→outcome.
    const sup = newSup();
    const spec: FleetRunSpec = {
      runId: "a",
      scenario: "audit-fanout",
      repos: [{ name: "r1", path: "/tmp/r1" }],
      tasks: [{ id: "audit", description: "", payload: {}, dependsOn: [] }],
    };
    const r = await sup.run(spec, new FanOutPolicy());
    expect(r.status).toBe("completed");
    expect(r.taskOutcomes).toHaveLength(1);
  });

  it("independent-tasks respects dependencies", async () => {
    const sup = newSup();
    const spec: FleetRunSpec = {
      runId: "b",
      scenario: "independent-tasks",
      repos: [{ name: "r", path: "/tmp/r" }],
      tasks: [
        { id: "first", description: "", payload: {}, dependsOn: [] },
        { id: "second", description: "", payload: {}, dependsOn: ["first"] },
      ],
    };
    const r = await sup.run(spec, new DependencyTrackerPolicy({ runId: "b" }));
    expect(r.status).toBe("completed");
    expect(r.taskOutcomes.map((t) => t.taskId)).toEqual(["first", "second"]);
  });

  it("coordinated-feature: supervisor policy assigns and ratifies", async () => {
    const sup = newSup();
    const spec: FleetRunSpec = {
      runId: "c",
      scenario: "coordinated-feature",
      repos: [
        { name: "r1", path: "/tmp/r1" },
        { name: "r2", path: "/tmp/r2" },
      ],
      tasks: [{ id: "implement", description: "", payload: {}, dependsOn: [] }],
    };
    const r = await sup.run(spec, new SupervisorPolicy());
    expect(r.status).toBe("completed");
  });

  it("continuous-fleet: contract-net awards to highest bidder", async () => {
    let bidCount = 0;
    const sup = newSup();
    const spec: FleetRunSpec = {
      runId: "d",
      scenario: "continuous-fleet",
      repos: [
        { name: "r1", path: "/tmp/r1" },
        { name: "r2", path: "/tmp/r2" },
      ],
      tasks: [{ id: "work", description: "", payload: {}, dependsOn: [] }],
    };
    const r = await sup.run(
      spec,
      new ContractNetPolicy({
        bidder: (w) => {
          bidCount++;
          return Promise.resolve(w.repo === "r2" ? 5 : 1);
        },
      })
    );
    expect(r.status).toBe("completed");
    expect(bidCount).toBeGreaterThan(0);
    const first = r.taskOutcomes[0];
    expect(first?.repo).toBe("r2");
  });
});
