import { describe, it, expect, vi } from "vitest";
import { LifecycleController } from "../lifecycle/lifecycle-controller.js";
import { InMemoryTaskStore } from "../store/in-memory-task-store.js";
import { DEFAULT_LIFECYCLE_POLICY } from "../runtime/runtime-config.js";
import { ManualClock, RecordingEventSink } from "./helpers.js";
import type { BackgroundTask } from "../contracts/background-task.js";

function makeController(over: Partial<typeof DEFAULT_LIFECYCLE_POLICY> = {}) {
  const store = new InMemoryTaskStore();
  const clock = new ManualClock(0);
  const events = new RecordingEventSink();
  const onExpire = vi.fn();
  const controller = new LifecycleController(
    store,
    { ...DEFAULT_LIFECYCLE_POLICY, ...over },
    clock,
    events,
    onExpire
  );
  return { store, clock, events, onExpire, controller };
}

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "a",
    parentRunId: "r",
    spec: { agentId: "x", input: "hi" },
    status: "queued",
    createdAt: 0,
    ttlMs: 1000,
    depth: 0,
    ...over,
  };
}

describe("LifecycleController admission", () => {
  it("admits up to maxConcurrentBackground then refuses", () => {
    const { controller } = makeController({ maxConcurrentBackground: 2 });
    expect(controller.admit(1).admitted).toBe(true);
    expect(controller.admit(1).admitted).toBe(true);
    const third = controller.admit(1);
    expect(third).toEqual({ admitted: false, reason: "concurrency_full" });
    expect(controller.inFlight).toBe(2);
  });

  it("refuses when queue is over capacity", () => {
    const { controller } = makeController({ maxQueuedTasks: 3 });
    expect(controller.admit(4)).toEqual({
      admitted: false,
      reason: "queue_full",
    });
  });

  it("release frees a slot and never goes negative", () => {
    const { controller } = makeController({ maxConcurrentBackground: 1 });
    controller.admit(1);
    controller.release();
    controller.release();
    expect(controller.inFlight).toBe(0);
    expect(controller.admit(1).admitted).toBe(true);
  });
});

describe("LifecycleController sweep", () => {
  it("expires non-terminal tasks past TTL and emits + aborts", async () => {
    const { store, clock, events, onExpire, controller } = makeController();
    await store.put(
      task({ id: "a", status: "running", ttlMs: 100, createdAt: 0 })
    );
    clock.set(150);
    await controller.sweep();
    expect((await store.get("a"))?.status).toBe("expired");
    expect(onExpire).toHaveBeenCalledWith("a");
    expect(events.types()).toContain("subagent:expired");
  });

  it("does not expire tasks within TTL", async () => {
    const { store, clock, controller } = makeController();
    await store.put(task({ id: "a", status: "running", ttlMs: 100 }));
    clock.set(50);
    await controller.sweep();
    expect((await store.get("a"))?.status).toBe("running");
  });

  it("GCs terminal tasks past the retention window", async () => {
    const { store, clock, controller } = makeController({ retentionMs: 100 });
    await store.put(
      task({ id: "done", status: "succeeded", endedAt: 0, createdAt: 0 })
    );
    clock.set(1_000_000); // past TTL too, but already terminal
    await controller.sweep();
    expect(await store.get("done")).toBeNull();
  });

  it("does not release a slot on expiry (runtime .finally owns release)", async () => {
    const { store, clock, controller } = makeController({
      maxConcurrentBackground: 1,
    });
    controller.admit(1); // simulate one running
    await store.put(task({ id: "a", status: "running", ttlMs: 10 }));
    clock.set(100);
    await controller.sweep();
    // inFlight stays 1 — the runtime releases when the aborted run settles.
    expect(controller.inFlight).toBe(1);
  });
});

describe("LifecycleController.findOrphans", () => {
  it("returns running tasks", async () => {
    const { store, controller } = makeController();
    await store.put(task({ id: "a", status: "running" }));
    await store.put(task({ id: "b", status: "queued" }));
    const orphans = await controller.findOrphans();
    expect(orphans.map((t) => t.id)).toEqual(["a"]);
  });
});
