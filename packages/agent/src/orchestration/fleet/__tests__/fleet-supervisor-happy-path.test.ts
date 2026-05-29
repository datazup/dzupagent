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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-"));
});

/**
 * Local scripted executor — emits a fixed WorkerEvent[] then exits with the
 * given outcome. Lives in-test to avoid an agent → agent-adapters dependency
 * cycle (agent-adapters depends on agent), mirroring repo-agent.test.ts.
 */
class ScriptedExecutor implements Executor {
  readonly id = "scripted";
  constructor(
    private readonly script: WorkerEvent[],
    private readonly outcome: WorkerOutcome = {
      state: "completed",
      exitCode: 0,
    }
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

const happyScript: WorkerEvent[] = [
  { kind: "step_start", stepId: "s1", at: "t" },
  { kind: "step_done", stepId: "s1", at: "t" },
  { kind: "exit", code: 0, reason: null, at: "t" },
];

describe("FleetSupervisor happy path", () => {
  it("fan-out: every repo runs the task and completes", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => new ScriptedExecutor(happyScript),
    });
    const spec: FleetRunSpec = {
      runId: "r1",
      scenario: "audit-fanout",
      repos: [
        { name: "a", path: "/tmp/a" },
        { name: "b", path: "/tmp/b" },
      ],
      tasks: [
        { id: "audit", description: "audit repo", payload: {}, dependsOn: [] },
      ],
    };
    const result = await sup.run(spec, new FanOutPolicy());
    expect(result.status).toBe("completed");
    expect(result.taskOutcomes).toHaveLength(2);
    expect(result.taskOutcomes.every((t) => t.state === "completed")).toBe(
      true
    );
  });
});
