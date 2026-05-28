import { describe, it, expect } from "vitest";
import type { Executor, WorkerHandle, WorkerSpec } from "../executor.js";

describe("Executor interface", () => {
  it("shape is callable through a mock implementation", async () => {
    const handle: WorkerHandle = {
      workerId: "w1",
      events: (async function* () {
        yield {
          kind: "exit",
          code: 0,
          reason: null,
          at: new Date().toISOString(),
        } as const;
      })(),
      async send() {},
      async cancel() {},
      async wait() {
        return { state: "completed", exitCode: 0 };
      },
    };
    const executor: Executor = {
      id: "mock",
      async spawn(_spec: WorkerSpec) {
        return handle;
      },
    };
    const h = await executor.spawn({
      repoPath: "/tmp/x",
      taskBundle: {} as never,
      knowledgeHandle: {} as never,
      mailboxAddress: "m",
      config: {},
    } as WorkerSpec);
    const outcome = await h.wait();
    expect(outcome.state).toBe("completed");
  });
});
