import { describe, it, expect } from "vitest";
import { InProcessExecutor, scriptExecutor } from "../in-process-executor.js";
import type { WorkerSpec } from "@dzupagent/agent-types/fleet";

describe("InProcessExecutor", () => {
  it("emits scripted events and exits", async () => {
    const exec = scriptExecutor([
      { kind: "step_start", stepId: "s1", at: "t" },
      { kind: "step_done", stepId: "s1", at: "t" },
      { kind: "exit", code: 0, reason: null, at: "t" },
    ]);
    const spec: WorkerSpec = {
      workerId: "w1",
      repo: { name: "r", path: "/tmp" },
      repoPath: "/tmp",
      taskBundle: { id: "t1", description: "", payload: {}, dependsOn: [] },
      knowledgeHandle: { store: {} as never, scope: "run:x", repo: "r" },
      mailboxAddress: "m",
      config: {},
    };
    const handle = await exec.spawn(spec);
    const events: string[] = [];
    for await (const e of handle.events) events.push(e.kind);
    const outcome = await handle.wait();
    expect(events).toEqual(["step_start", "step_done", "exit"]);
    expect(outcome.state).toBe("completed");
  });

  it("respects cancel", async () => {
    const exec = scriptExecutor(
      [{ kind: "step_start", stepId: "s1", at: "t" }],
      { hangAfterScript: true }
    );
    const handle = await exec.spawn(stubSpec());
    setTimeout(() => {
      void handle.cancel("test");
    }, 10);
    const outcome = await handle.wait();
    expect(outcome.state).toBe("cancelled");
  });
});

function stubSpec(): WorkerSpec {
  return {
    workerId: "w",
    repo: { name: "r", path: "/tmp" },
    repoPath: "/tmp",
    taskBundle: { id: "t", description: "", payload: {}, dependsOn: [] },
    knowledgeHandle: { store: {} as never, scope: "run:x", repo: "r" },
    mailboxAddress: "m",
    config: {},
  };
}

// Reference InProcessExecutor type in the import to satisfy the linter
// since the named export is consumed via scriptExecutor in the tests.
void InProcessExecutor;
