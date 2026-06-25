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

class ThrowingExecutor implements Executor {
  readonly id = "throwing";
  constructor(private readonly message: string) {}
  async spawn(): Promise<WorkerHandle> {
    throw new Error(this.message);
  }
}

const baseScript: WorkerEvent[] = [
  { kind: "step_start", stepId: "s1", at: "t" },
  { kind: "step_done", stepId: "s1", at: "t" },
  { kind: "exit", code: 0, reason: null, at: "t" },
];

async function collectStates(
  store: FilesystemKnowledgeStore,
  runId: string
): Promise<string[]> {
  const states: string[] = [];
  for await (const env of store.query({
    scope: `run:${runId}`,
    kind: "task-state",
  })) {
    states.push((env.payload as { state: string }).state);
  }
  return states;
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

  it("maps failed outcome to failed state and writes claimed→in-progress→failed", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const agent = new RepoAgent({
      runId: "r-fail",
      repo: { name: "demo", path: tmp },
      executor: new ScriptedExecutor(baseScript, {
        state: "failed",
        exitCode: 1,
      }),
      knowledge: store,
    });
    const result = await agent.dispatch({
      id: "t1",
      description: "",
      payload: {},
      dependsOn: [],
    });
    expect(result.state).toBe("failed");
    expect(await collectStates(store, "r-fail")).toEqual([
      "claimed",
      "in-progress",
      "failed",
    ]);
  });

  it("maps crashed outcome to failed state", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const agent = new RepoAgent({
      runId: "r-crash",
      repo: { name: "demo", path: tmp },
      executor: new ScriptedExecutor(baseScript, {
        state: "crashed",
        exitCode: 1,
      }),
      knowledge: store,
    });
    const result = await agent.dispatch({
      id: "t1",
      description: "",
      payload: {},
      dependsOn: [],
    });
    expect(result.state).toBe("failed");
    expect(await collectStates(store, "r-crash")).toContain("failed");
  });

  it("maps cancelled outcome to surrendered state", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const agent = new RepoAgent({
      runId: "r-cancel",
      repo: { name: "demo", path: tmp },
      executor: new ScriptedExecutor(baseScript, {
        state: "cancelled",
        exitCode: null,
      }),
      knowledge: store,
    });
    const result = await agent.dispatch({
      id: "t1",
      description: "",
      payload: {},
      dependsOn: [],
    });
    expect(result.state).toBe("surrendered");
    expect(await collectStates(store, "r-cancel")).toContain("surrendered");
  });

  it("propagates spawn error without writing in-progress or terminal state", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const agent = new RepoAgent({
      runId: "r-spawn-err",
      repo: { name: "demo", path: tmp },
      executor: new ThrowingExecutor("spawn failed"),
      knowledge: store,
    });
    await expect(
      agent.dispatch({ id: "t1", description: "", payload: {}, dependsOn: [] })
    ).rejects.toThrow("spawn failed");
    // claimed was written before spawn; in-progress and terminal were not
    const states = await collectStates(store, "r-spawn-err");
    expect(states).toContain("claimed");
    expect(states).not.toContain("in-progress");
    expect(states).not.toContain("failed");
  });

  it("includes blockedReason in terminal task-state when outcome carries a reason", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const agent = new RepoAgent({
      runId: "r-reason",
      repo: { name: "demo", path: tmp },
      executor: new ScriptedExecutor(baseScript, {
        state: "failed",
        exitCode: 1,
        reason: "OOM killed",
      }),
      knowledge: store,
    });
    await agent.dispatch({
      id: "t1",
      description: "",
      payload: {},
      dependsOn: [],
    });
    const entries: Array<{ state: string; blockedReason?: string }> = [];
    for await (const env of store.query({
      scope: "run:r-reason",
      kind: "task-state",
    })) {
      entries.push(env.payload as { state: string; blockedReason?: string });
    }
    const terminal = entries.find((e) => e.state === "failed");
    expect(terminal?.blockedReason).toBe("OOM killed");
  });

  it("result carries the repo name, taskId, workerId, and collected events", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const agent = new RepoAgent({
      runId: "r-shape",
      repo: { name: "my-repo", path: tmp },
      executor: new ScriptedExecutor(baseScript),
      knowledge: store,
      workerId: "w-fixed",
    });
    const result = await agent.dispatch({
      id: "task-shape",
      description: "",
      payload: {},
      dependsOn: [],
    });
    expect(result.repo).toBe("my-repo");
    expect(result.taskId).toBe("task-shape");
    expect(result.workerId).toBe("w-fixed");
    expect(result.events).toHaveLength(baseScript.length);
  });

  it("task-state envelopes carry the correct runId and repo fields", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const agent = new RepoAgent({
      runId: "r-meta",
      repo: { name: "meta-repo", path: tmp },
      executor: new ScriptedExecutor(baseScript),
      knowledge: store,
    });
    await agent.dispatch({
      id: "t-meta",
      description: "",
      payload: {},
      dependsOn: [],
    });
    for await (const env of store.query({
      scope: "run:r-meta",
      kind: "task-state",
    })) {
      expect(env.runId).toBe("r-meta");
      expect(env.repo).toBe("meta-repo");
    }
  });
});
