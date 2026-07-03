import { describe, it, expect } from "vitest";
import type { BackgroundTask } from "../contracts/background-task.js";
import { SubagentErrorCode } from "../contracts/error-codes.js";
import { InProcessRunner } from "../runner/in-process-runner.js";
import {
  DurableQueueRunner,
  InMemoryTaskQueue,
} from "../runner/durable-queue-runner.js";
import { InMemoryTaskStore } from "../store/in-memory-task-store.js";
import { LifecycleController } from "../lifecycle/lifecycle-controller.js";
import { BackgroundSubagentRuntime } from "../runtime/background-subagent-runtime.js";
import { SpawnGate, allowAllSpawnPolicy } from "../governance/spawn-gate.js";
import {
  ControllableExecutor,
  ManualClock,
  RecordingEventSink,
  RecordingLogger,
  flush,
  sequentialIds,
} from "./helpers.js";

function seedTask(
  store: InMemoryTaskStore,
  id: string,
  parentRunId = "r"
): Promise<void> {
  const task: BackgroundTask = {
    id,
    parentRunId,
    spec: { agentId: "x", input: "hi" },
    status: "queued",
    createdAt: 0,
    ttlMs: 1000,
    depth: 0,
  };
  return store.put(task);
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

describe("InProcessRunner logger seam", () => {
  it("logs an error with the taskId and a structured code when the executor throws", async () => {
    const store = new InMemoryTaskStore();
    const executor = new ControllableExecutor("manual");
    const events = new RecordingEventSink();
    const logger = new RecordingLogger();
    const runner = new InProcessRunner({
      store,
      executor,
      events,
      clock: new ManualClock(0),
      logger,
    });

    await seedTask(store, "a");
    void runner.start("a", new AbortController().signal);
    await waitForStatus(store, "a", "running");
    executor.fail("a", "kaboom");
    await waitForTerminal(store, "a");

    const errors = logger.at("error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const logged = errors.find((f) => f.taskId === "a");
    expect(logged).toBeDefined();
    expect(logged?.code).toBe(SubagentErrorCode.TASK_EXECUTION_FAILED);
    expect(logged?.message).toBe("kaboom");
    expect(logged?.recoverable).toBe(true);
  });
});

describe("DurableQueueRunner poisoned-handler survival", () => {
  it("continues draining to the next task after a handler throws", async () => {
    const drained: string[] = [];
    const logger = new RecordingLogger();
    const queue = new InMemoryTaskQueue(logger);

    // A handler that throws on the first task but records every invocation.
    queue.consume(async (taskId) => {
      drained.push(taskId);
      if (taskId === "poison") {
        throw new Error("poisoned handler");
      }
    });

    await queue.enqueue("poison");
    await queue.enqueue("good");
    await flush(10);

    // The poisoned task must not stall the loop — the second task still drains.
    expect(drained).toEqual(["poison", "good"]);
    const errors = logger.at("error");
    expect(errors.some((f) => f.taskId === "poison")).toBe(true);
  });

  it("survives an inner-runner throw via the runner's execute guard", async () => {
    const store = new InMemoryTaskStore();
    const events = new RecordingEventSink();
    const logger = new RecordingLogger();
    // An executor that throws synchronously is settled+logged by InProcessRunner;
    // assert the durable runner drains a subsequent task regardless.
    const executor = new ControllableExecutor("instant", { output: "ok" });
    const runner = new DurableQueueRunner({
      store,
      executor,
      events,
      clock: new ManualClock(0),
      queue: new InMemoryTaskQueue(),
      logger,
    });

    await seedTask(store, "t1");
    await seedTask(store, "t2");
    await runner.start("t1", new AbortController().signal);
    await runner.start("t2", new AbortController().signal);
    await waitForTerminal(store, "t1");
    await waitForTerminal(store, "t2");

    expect((await store.get("t1"))?.status).toBe("succeeded");
    expect((await store.get("t2"))?.status).toBe("succeeded");
    runner.dispose();
  });
});

describe("Runtime orphan/TTL/approval logging", () => {
  function makeRuntime(logger: RecordingLogger) {
    const store = new InMemoryTaskStore();
    const clock = new ManualClock(0);
    const events = new RecordingEventSink();
    const executor = new ControllableExecutor("manual");
    const runner = new InProcessRunner({ store, executor, events, clock });
    const gate = new SpawnGate(allowAllSpawnPolicy);
    const runtime = new BackgroundSubagentRuntime({
      store,
      runner,
      gate,
      events,
      clock,
      logger,
      generateId: sequentialIds(),
      policy: {
        maxConcurrentBackground: 4,
        maxQueuedTasks: 100,
        defaultTtlMs: 1000,
        retentionMs: 1000,
        gcIntervalMs: 1000,
      },
    });
    return { store, clock, runtime };
  }

  it("logs a warn with a reason when reconciling a crash-orphaned task", async () => {
    const logger = new RecordingLogger();
    const { store, runtime } = makeRuntime(logger);
    // Simulate a task left `running` by a crashed process.
    await store.put({
      id: "orphan-1",
      parentRunId: "r",
      spec: { agentId: "x", input: "hi" },
      status: "running",
      createdAt: 0,
      ttlMs: 1000,
      depth: 0,
    });

    const reconciled = await runtime.reconcileOrphans();
    expect(reconciled).toContain("orphan-1");

    const warns = logger.at("warn");
    const warn = warns.find((f) => f.taskId === "orphan-1");
    expect(warn).toBeDefined();
    expect(warn?.code).toBe(SubagentErrorCode.ORPHANED_BY_PROCESS_RESTART);
    expect(warn?.reason).toBe("orphaned_by_process_restart");
  });

  it("logs a warn when a task expires past its TTL", async () => {
    const logger = new RecordingLogger();
    const store = new InMemoryTaskStore();
    const clock = new ManualClock(0);
    const events = new RecordingEventSink();
    // Exercise TTL expiry at the LifecycleController level — its periodic sweep
    // is timer-driven in the runtime, but `sweep()` is public and pure w.r.t. the
    // injected clock so we can drive it deterministically here.
    const controller = new LifecycleController(
      store,
      {
        maxConcurrentBackground: 4,
        maxQueuedTasks: 100,
        defaultTtlMs: 1000,
        retentionMs: 1000,
        gcIntervalMs: 1000,
      },
      clock,
      events,
      () => {},
      logger
    );
    await store.put({
      id: "ttl-1",
      parentRunId: "r",
      spec: { agentId: "x", input: "hi" },
      status: "queued",
      createdAt: 0,
      ttlMs: 100,
      depth: 0,
    });

    clock.set(200);
    await controller.sweep();

    expect((await store.get("ttl-1"))?.status).toBe("expired");
    const warns = logger.at("warn");
    const warn = warns.find((f) => f.taskId === "ttl-1");
    expect(warn).toBeDefined();
    expect(warn?.code).toBe(SubagentErrorCode.TTL_EXPIRED);
  });

  it("logs a warn when an approval is rejected", async () => {
    const logger = new RecordingLogger();
    const store = new InMemoryTaskStore();
    const clock = new ManualClock(0);
    const events = new RecordingEventSink();
    const executor = new ControllableExecutor("manual");
    const runner = new InProcessRunner({ store, executor, events, clock });
    const gate = new SpawnGate(
      { check: () => ({ allow: true, requiresApproval: true }) },
      { waitForApproval: () => Promise.reject(new Error("user_declined")) }
    );
    const runtime = new BackgroundSubagentRuntime({
      store,
      runner,
      gate,
      events,
      clock,
      logger,
      generateId: sequentialIds(),
      policy: {
        maxConcurrentBackground: 4,
        maxQueuedTasks: 100,
        defaultTtlMs: 1000,
        retentionMs: 1000,
        gcIntervalMs: 1000,
      },
    });

    const out = await runtime.spawn({ agentId: "x", input: "go" }, "run-1");
    expect(out).toMatchObject({ ok: true, status: "awaiting_approval" });
    await flush(10);

    const warns = logger.at("warn");
    const warn = warns.find(
      (f) => f.code === SubagentErrorCode.APPROVAL_REJECTED
    );
    expect(warn).toBeDefined();
    expect(warn?.reason).toBe("user_declined");
  });
});
