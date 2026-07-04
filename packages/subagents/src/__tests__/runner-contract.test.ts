import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import type { TaskRunner } from "../contracts/task-runner.js";
import type { BackgroundTask } from "../contracts/background-task.js";
import { InProcessRunner } from "../runner/in-process-runner.js";
import {
  DurableQueueRunner,
  InMemoryTaskQueue,
} from "../runner/durable-queue-runner.js";
import type { TaskQueue } from "../runner/durable-queue-runner.js";
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

class FileBackedTaskQueue implements TaskQueue {
  private handler: ((taskId: string) => Promise<void>) | undefined;
  private draining = false;

  constructor(private readonly filePath: string) {}

  async enqueue(taskId: string): Promise<void> {
    const pending = await this.readPending();
    pending.push(taskId);
    await this.writePending(pending);
    void this.drain();
  }

  consume(handler: (taskId: string) => Promise<void>): () => void {
    this.handler = handler;
    void this.drain();
    return () => {
      this.handler = undefined;
    };
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.handler) return;
    this.draining = true;
    try {
      for (;;) {
        const pending = await this.readPending();
        const next = pending.shift();
        if (next === undefined || !this.handler) {
          await this.writePending(pending);
          return;
        }
        await this.writePending(pending);
        await this.handler(next);
      }
    } finally {
      this.draining = false;
    }
  }

  private async readPending(): Promise<string[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writePending(pending: string[]): Promise<void> {
    await writeFile(this.filePath, JSON.stringify(pending), "utf8");
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
    depth: 0,
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

describe("DurableQueueRunner durable snapshot preservation", () => {
  it("executes a queued resolved persona snapshot with audit identity after runner reattachment", async () => {
    const store = new InMemoryTaskStore();
    const executor = new ControllableExecutor("instant", { output: "restored" });
    const events = new RecordingEventSink();
    const clock = new ManualClock(0);
    const queue = new InMemoryTaskQueue();

    const firstRunner = new DurableQueueRunner({
      store,
      executor,
      events,
      clock,
      queue,
      durable: true,
    });
    firstRunner.dispose();

    await store.put({
      id: "durable-task",
      parentRunId: "parent-run",
      spec: {
        agentId: "inline",
        resolvedPersonaName: "reviewer",
        resolvedDefinition: {
          name: "reviewer",
          personaPrompt: "Review carefully.",
          constraints: { maxBudgetUsd: 0.25, toolPolicy: "strict" },
        },
        input: "check this",
      },
      audit: {
        personaName: "reviewer",
        inlineDefinitionHash: "hash-reviewer",
      },
      status: "queued",
      createdAt: 0,
      ttlMs: 1000,
      depth: 0,
    });

    const secondRunner = new DurableQueueRunner({
      store,
      executor,
      events,
      clock,
      queue,
      durable: true,
    });
    await secondRunner.start("durable-task", new AbortController().signal);
    await waitForTerminal(store, "durable-task");

    expect(executor.runCalls[0]).toMatchObject({
      resolvedPersonaName: "reviewer",
      resolvedDefinition: {
        name: "reviewer",
        personaPrompt: "Review carefully.",
        constraints: { maxBudgetUsd: 0.25, toolPolicy: "strict" },
      },
    });
    expect(await store.get("durable-task")).toMatchObject({
      status: "succeeded",
      audit: {
        personaName: "reviewer",
        inlineDefinitionHash: "hash-reviewer",
      },
      result: { output: "restored" },
    });
    secondRunner.dispose();
  });

  it("drains a file-backed queued task with resolved persona snapshot after runner reattachment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dzupagent-queue-"));
    try {
      const queuePath = join(dir, "queue.json");
      const store = new InMemoryTaskStore();
      const executor = new ControllableExecutor("instant", { output: "file-restored" });
      const events = new RecordingEventSink();
      const clock = new ManualClock(0);

      await store.put({
        id: "file-durable-task",
        parentRunId: "parent-run",
        spec: {
          agentId: "inline",
          resolvedPersonaName: "reviewer",
          resolvedDefinition: {
            name: "reviewer",
            personaPrompt: "Review from durable queue.",
            constraints: { maxBudgetUsd: 0.25, toolPolicy: "strict" },
          },
          input: "check this",
        },
        audit: {
          personaName: "reviewer",
          inlineDefinitionHash: "hash-reviewer",
        },
        status: "queued",
        createdAt: 0,
        ttlMs: 1000,
        depth: 0,
      });

      await new FileBackedTaskQueue(queuePath).enqueue("file-durable-task");

      const reattachedRunner = new DurableQueueRunner({
        store,
        executor,
        events,
        clock,
        queue: new FileBackedTaskQueue(queuePath),
        durable: true,
      });
      await waitForTerminal(store, "file-durable-task");

      expect(executor.runCalls[0]).toMatchObject({
        resolvedPersonaName: "reviewer",
        resolvedDefinition: {
          name: "reviewer",
          personaPrompt: "Review from durable queue.",
          constraints: { maxBudgetUsd: 0.25, toolPolicy: "strict" },
        },
      });
      expect(await store.get("file-durable-task")).toMatchObject({
        status: "succeeded",
        audit: {
          personaName: "reviewer",
          inlineDefinitionHash: "hash-reviewer",
        },
        result: { output: "file-restored" },
      });
      reattachedRunner.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
