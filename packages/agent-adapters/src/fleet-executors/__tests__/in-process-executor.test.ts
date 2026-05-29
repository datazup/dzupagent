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

  it("does not push events into the buffer after cancel closes the iterator", async () => {
    // The producer IIFE runs its first iteration synchronously on spawn, so
    // step_start lands in the buffer before cancel() is ever called.
    // After cancel() calls close(), any events the producer pushes during
    // subsequent delay cycles must be dropped (push must guard `if (closed)`).
    //
    // Observable: consume exactly the first event, then cancel and wait for
    // the producer to finish all its delay cycles. The buffer must stay at 0
    // after that — step_done and exit must not accumulate.
    const exec = new InProcessExecutor({
      script: [
        { kind: "step_start", stepId: "s1", at: "t" },
        { kind: "step_done", stepId: "s1", at: "t" },
        { kind: "exit", code: 0, reason: null, at: "t" },
      ],
      delayMsBetweenEvents: 20,
    });
    const handle = await exec.spawn(stubSpec());
    // Consume step_start, then cancel immediately
    for await (const e of handle.events) {
      expect(e.kind).toBe("step_start");
      void handle.cancel("after-first");
      break;
    }
    await handle.wait();
    // After the producer has finished all delay cycles, the iterator must be
    // closed and yield nothing — step_done and exit were dropped by push()
    const leaked: string[] = [];
    for await (const e of handle.events) leaked.push(e.kind);
    expect(leaked).toHaveLength(0);
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
