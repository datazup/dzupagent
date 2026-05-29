import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  Executor,
  WorkerEvent,
  WorkerHandle,
  WorkerOutcome,
  WorkerSpec,
} from "@dzupagent/agent-types/fleet";
import { RepoAgent } from "../repo-agent.js";
import { FilesystemKnowledgeStore } from "@dzupagent/memory/knowledge";

// Local scripted executor test double. We deliberately do NOT import
// @dzupagent/agent-adapters' InProcessExecutor here: agent-adapters depends on
// @dzupagent/agent, so importing it (even as a devDependency) introduces a
// Turbo package-graph cycle. The Executor contract lives in agent-types/fleet,
// which agent already depends on, so a local fake costs only legal imports.
class ScriptedExecutor implements Executor {
  readonly id = "scripted";
  constructor(private readonly script: WorkerEvent[]) {}

  async spawn(spec: WorkerSpec): Promise<WorkerHandle> {
    const script = this.script;
    const last = script[script.length - 1];
    const exitCode = last?.kind === "exit" ? last.code : 0;
    return {
      workerId: spec.workerId,
      events: (async function* () {
        for (const e of script) yield e;
      })(),
      async send() {},
      async cancel() {},
      async wait(): Promise<WorkerOutcome> {
        return { state: "completed", exitCode };
      },
    };
  }
}

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "repoagent-"));
});

describe("RepoAgent.dispatch", () => {
  it("runs a worker to completion and writes task-state transitions", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const exec = new ScriptedExecutor([
      { kind: "step_start", stepId: "s1", at: "t" },
      { kind: "step_done", stepId: "s1", at: "t" },
      { kind: "exit", code: 0, reason: null, at: "t" },
    ]);
    const agent = new RepoAgent({
      runId: "r1",
      repo: { name: "demo", path: tmp },
      executor: exec,
      knowledge: store,
    });
    const result = await agent.dispatch({
      id: "t1",
      description: "",
      payload: {},
      dependsOn: [],
    });
    expect(result.state).toBe("completed");
    const states: string[] = [];
    for await (const env of store.query({
      scope: "run:r1",
      kind: "task-state",
    })) {
      const p = env.payload as { state: string };
      states.push(p.state);
    }
    expect(states).toEqual(["claimed", "in-progress", "completed"]);
  });
});
