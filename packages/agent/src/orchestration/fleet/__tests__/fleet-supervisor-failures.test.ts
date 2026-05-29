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
    private readonly outcome: WorkerOutcome
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
            : { state: "completed", exitCode: 0 }
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
      "failed"
    );
    expect(result.taskOutcomes.find((t) => t.repo === "good")?.state).toBe(
      "completed"
    );
  });
});
