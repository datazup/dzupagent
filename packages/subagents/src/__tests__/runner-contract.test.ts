import { describe, it, expect } from "vitest";
import type { TaskRunner } from "../contracts/task-runner.js";
import type { BackgroundTask } from "../contracts/background-task.js";
import { InProcessRunner } from "../runner/in-process-runner.js";
import {
  DurableQueueRunner,
  InMemoryTaskQueue,
} from "../runner/durable-queue-runner.js";
import { InMemoryTaskStore } from "../store/in-memory-task-store.js";
import {
  ControllableExecutor,
  ManualClock,
  RecordingEventSink,
  flush,
} from "./helpers.js";

interface Harness {
  runner: TaskRunner;
  store: InMemoryTaskStore;
  executor: ControllableExecutor;
  events: RecordingEventSink;
}

async function waitForTerminal(
  store: InMemoryTaskStore,
  id: string,
  attempts = 50
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const t = await store.get(id);
    if (
      t &&
      ["succeeded", "failed", "cancelled", "expired"].includes(t.status)
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

async function waitForStatus(
  store: InMemoryTaskStore,
  id: string,
  status: string,
  attempts = 50
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if ((await store.get(id))?.status === status) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

function seedTask(store: InMemoryTaskStore, id = "a"): Promise<void> {
  const task: BackgroundTask = {
    id,
    parentRunId: "r",
    spec: { agentId: "x", input: "hi" },
    status: "queued",
    createdAt: 0,
    ttlMs: 1000,
  };
  return store.put(task);
}

/** Conformance suite both runners must satisfy. */
function runTaskRunnerContract(name: string, make: () => Harness): void {
  describe(`TaskRunner contract: ${name}`, () => {
    it("transitions a task to running then succeeded", async () => {
      const { runner, store, executor, events } = make();
      await seedTask(store);
      void runner.start("a", new AbortController().signal);
      await waitForStatus(store, "a", "running");
      executor.complete("a", { output: 7 });
      await waitForTerminal(store, "a");
      const final = await store.get("a");
      expect(final?.status).toBe("succeeded");
      expect(final?.result).toEqual({ output: 7 });
      expect(events.types()).toContain("subagent:completed");
    });

    it("marks failed when the executor throws", async () => {
      const { runner, store, executor, events } = make();
      await seedTask(store);
      void runner.start("a", new AbortController().signal);
      await waitForStatus(store, "a", "running");
      executor.fail("a", "nope");
      await waitForTerminal(store, "a");
      expect((await store.get("a"))?.status).toBe("failed");
      expect(events.types()).toContain("subagent:failed");
    });

    it("marks cancelled when aborted", async () => {
      const { runner, store, events } = make();
      await seedTask(store);
      const controller = new AbortController();
      void runner.start("a", controller.signal);
      await waitForStatus(store, "a", "running");
      controller.abort();
      // Settlement may be asynchronous (durable runner executes off-queue).
      await waitForTerminal(store, "a");
      expect((await store.get("a"))?.status).toBe("cancelled");
      expect(events.types()).toContain("subagent:cancelled");
    });

    it("reports capabilities", () => {
      const { runner } = make();
      const caps = runner.capabilities();
      expect(typeof caps.durable).toBe("boolean");
      expect(typeof caps.horizontal).toBe("boolean");
    });
  });
}

runTaskRunnerContract("InProcessRunner", () => {
  const store = new InMemoryTaskStore();
  const executor = new ControllableExecutor("manual");
  const events = new RecordingEventSink();
  const clock = new ManualClock(0);
  const runner = new InProcessRunner({ store, executor, events, clock });
  return { runner, store, executor, events };
});

runTaskRunnerContract("DurableQueueRunner (in-memory queue)", () => {
  const store = new InMemoryTaskStore();
  const executor = new ControllableExecutor("manual");
  const events = new RecordingEventSink();
  const clock = new ManualClock(0);
  const runner = new DurableQueueRunner({
    store,
    executor,
    events,
    clock,
    queue: new InMemoryTaskQueue(),
  });
  return { runner, store, executor, events };
});

describe("DurableQueueRunner capabilities", () => {
  it("reflects configured durability", () => {
    const store = new InMemoryTaskStore();
    const runner = new DurableQueueRunner({
      store,
      executor: new ControllableExecutor("instant"),
      events: new RecordingEventSink(),
      clock: new ManualClock(0),
      queue: new InMemoryTaskQueue(),
      durable: true,
      horizontal: true,
    });
    expect(runner.capabilities()).toEqual({ durable: true, horizontal: true });
  });
});
