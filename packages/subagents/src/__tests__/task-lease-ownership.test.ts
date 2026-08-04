import { describe, it, expect, vi } from "vitest";
import type { BackgroundTask } from "../contracts/background-task.js";
import { SubagentErrorCode } from "../contracts/error-codes.js";
import { LifecycleController } from "../lifecycle/lifecycle-controller.js";
import {
  DEFAULT_TASK_LEASE_MS,
  isLeaseLive,
  nextLeaseClaim,
  renewTaskLease,
} from "../lifecycle/task-lease.js";
import { InProcessRunner } from "../runner/in-process-runner.js";
import { BackgroundSubagentRuntime } from "../runtime/background-subagent-runtime.js";
import { DEFAULT_LIFECYCLE_POLICY } from "../runtime/runtime-config.js";
import { SpawnGate, allowAllSpawnPolicy } from "../governance/spawn-gate.js";
import { InMemoryTaskStore } from "../store/in-memory-task-store.js";
import { recoverStaleRunningTasks } from "../store/postgres-task-store.js";
import {
  ControllableExecutor,
  ManualClock,
  RecordingEventSink,
  flush,
  sequentialIds,
} from "./helpers.js";

const LEASE_MS = 10_000;

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "a",
    parentRunId: "r",
    spec: { agentId: "x", input: "hi" },
    status: "running",
    createdAt: 0,
    startedAt: 0,
    ttlMs: 1_000_000,
    depth: 0,
    ...over,
  };
}

function makeController(
  ownership: ConstructorParameters<typeof LifecycleController>[6] = {}
) {
  const store = new InMemoryTaskStore();
  const clock = new ManualClock(0);
  const events = new RecordingEventSink();
  const controller = new LifecycleController(
    store,
    DEFAULT_LIFECYCLE_POLICY,
    clock,
    events,
    vi.fn(),
    undefined,
    ownership
  );
  return { store, clock, controller };
}

describe("LifecycleController.findOrphans ownership filter (AGENT-C-08)", () => {
  it("does not reclaim another worker's task while its lease is live", async () => {
    const { store, clock, controller } = makeController({ ownerId: "self" });
    await store.put(
      task({ id: "peer", ownerId: "other-worker", leaseUntil: 5_000 })
    );
    clock.set(1_000);
    expect(await controller.findOrphans()).toEqual([]);
  });

  it("reclaims a task whose owner stopped heartbeating (lease expired)", async () => {
    const { store, clock, controller } = makeController({ ownerId: "self" });
    await store.put(
      task({ id: "dead", ownerId: "dead-worker", leaseUntil: 5_000 })
    );
    clock.set(5_001);
    const orphans = await controller.findOrphans();
    expect(orphans.map((t) => t.id)).toEqual(["dead"]);
  });

  it("reclaims its own rows from a previous boot once their lease lapsed", async () => {
    // A stable worker id across restarts must not make crash recovery a no-op.
    const { store, clock, controller } = makeController({ ownerId: "self" });
    await store.put(task({ id: "mine", ownerId: "self", leaseUntil: 100 }));
    clock.set(1_000);
    expect((await controller.findOrphans()).map((t) => t.id)).toEqual(["mine"]);
  });

  it("never reports a task running in this process, whatever the row says", async () => {
    const { store, clock, controller } = makeController({
      ownerId: "self",
      isLocallyRunning: (id) => id === "local",
    });
    await store.put(task({ id: "local", ownerId: "self", leaseUntil: 10 }));
    clock.set(1_000);
    expect(await controller.findOrphans()).toEqual([]);
  });

  it("treats unowned running rows as orphans (legacy behaviour preserved)", async () => {
    const { store, controller } = makeController();
    await store.put(task({ id: "legacy" }));
    await store.put(task({ id: "queued", status: "queued" }));
    expect((await controller.findOrphans()).map((t) => t.id)).toEqual([
      "legacy",
    ]);
  });

  it("applies orphanGraceMs to unowned running rows when configured", async () => {
    const { store, clock, controller } = makeController({
      orphanGraceMs: 1_000,
    });
    await store.put(task({ id: "fresh", startedAt: 0 }));
    clock.set(500);
    expect(await controller.findOrphans()).toEqual([]);
    clock.set(1_500);
    expect((await controller.findOrphans()).map((t) => t.id)).toEqual(["fresh"]);
  });
});

describe("task lease primitives", () => {
  it("claims monotonically increasing fencing tokens", () => {
    const first = nextLeaseClaim({}, "w1", 0, LEASE_MS);
    expect(first).toEqual({ ownerId: "w1", leaseUntil: LEASE_MS, leaseEpoch: 1 });
    const second = nextLeaseClaim({ leaseEpoch: 1 }, "w2", 100, LEASE_MS);
    expect(second.leaseEpoch).toBe(2);
  });

  it("treats a never-leased task as not live", () => {
    expect(isLeaseLive({}, 0)).toBe(false);
    expect(isLeaseLive({ leaseUntil: 1 }, 0)).toBe(true);
    expect(isLeaseLive({ leaseUntil: 1 }, 1)).toBe(false);
  });

  it("renews only for the current owner and fencing epoch", async () => {
    const store = new InMemoryTaskStore();
    await store.put(
      task({ id: "a", ownerId: "w1", leaseUntil: 100, leaseEpoch: 1 })
    );

    expect(
      await renewTaskLease({
        store,
        taskId: "a",
        ownerId: "w1",
        leaseEpoch: 1,
        now: 50,
        leaseMs: LEASE_MS,
      })
    ).toBe(true);
    expect((await store.get("a"))?.leaseUntil).toBe(50 + LEASE_MS);

    // Lease lost to another worker: the old owner must not renew it back.
    await store.patch("a", { ownerId: "w2", leaseEpoch: 2 });
    expect(
      await renewTaskLease({
        store,
        taskId: "a",
        ownerId: "w1",
        leaseEpoch: 1,
        now: 60,
        leaseMs: LEASE_MS,
      })
    ).toBe(false);

    // Terminal tasks are never renewed.
    await store.patch("a", { ownerId: "w2", status: "succeeded" });
    expect(
      await renewTaskLease({
        store,
        taskId: "a",
        ownerId: "w2",
        leaseEpoch: 2,
        now: 70,
      })
    ).toBe(false);
  });

  it("defaults the lease window", () => {
    expect(nextLeaseClaim({}, "w", 0).leaseUntil).toBe(DEFAULT_TASK_LEASE_MS);
  });
});

describe("recoverStaleRunningTasks lease awareness", () => {
  it("leaves a long-running task alone while its lease is heartbeated", async () => {
    const store = new InMemoryTaskStore();
    await store.put(
      task({ id: "long", startedAt: 0, ownerId: "w1", leaseUntil: 60_000 })
    );
    const recovered = await recoverStaleRunningTasks({
      store,
      now: 50_000,
      runningTimeoutMs: 10_000,
    });
    expect(recovered).toEqual([]);
    expect((await store.get("long"))?.status).toBe("running");
  });

  it("still recovers a task whose lease lapsed", async () => {
    const store = new InMemoryTaskStore();
    await store.put(
      task({ id: "dead", startedAt: 0, ownerId: "w1", leaseUntil: 20_000 })
    );
    const recovered = await recoverStaleRunningTasks({
      store,
      now: 50_000,
      runningTimeoutMs: 10_000,
    });
    expect(recovered).toEqual(["dead"]);
    expect((await store.get("dead"))?.status).toBe("failed");
  });
});

/** One worker process: runtime + its own runner identity over a shared store. */
function makeWorker(
  ownerId: string,
  store: InMemoryTaskStore,
  clock: ManualClock,
  executor: ControllableExecutor
) {
  const events = new RecordingEventSink();
  const runner = new InProcessRunner({
    store,
    executor,
    events,
    clock,
    ownerId,
    leaseMs: LEASE_MS,
  });
  const runtime = new BackgroundSubagentRuntime({
    store,
    runner,
    gate: new SpawnGate(allowAllSpawnPolicy),
    events,
    clock,
    ownerId,
    generateId: sequentialIds(`${ownerId}-`),
    policy: { defaultTtlMs: 1_000_000 },
  });
  return { runtime, events };
}

describe("two workers on a shared task store (AGENT-C-08)", () => {
  it("a second worker booting does not reap the first worker's live task", async () => {
    const store = new InMemoryTaskStore();
    const clock = new ManualClock(0);
    const executor = new ControllableExecutor("manual");
    const workerA = makeWorker("worker-a", store, clock, executor);

    const spawned = await workerA.runtime.spawn({ agentId: "x", input: "go" }, "r");
    if (!spawned.ok) throw new Error("spawn failed");
    await flush(10);

    const claimed = await store.get(spawned.taskId);
    expect(claimed?.status).toBe("running");
    expect(claimed?.ownerId).toBe("worker-a");
    expect(claimed?.leaseUntil).toBe(LEASE_MS);
    expect(claimed?.leaseEpoch).toBe(1);

    // Worker B boots against the same store and reconciles orphans on startup.
    const workerB = makeWorker("worker-b", store, clock, executor);
    expect(await workerB.runtime.reconcileOrphans()).toEqual([]);
    expect((await store.get(spawned.taskId))?.status).toBe("running");

    // The task outlives one lease window but keeps heartbeating (worker A is
    // alive): it is still not reclaimable.
    clock.set(8_000);
    expect(
      await renewTaskLease({
        store,
        taskId: spawned.taskId,
        ownerId: "worker-a",
        leaseEpoch: 1,
        now: clock.now(),
        leaseMs: LEASE_MS,
      })
    ).toBe(true);
    clock.set(12_000);
    expect(await workerB.runtime.reconcileOrphans()).toEqual([]);
    expect((await store.get(spawned.taskId))?.status).toBe("running");

    // Worker A dies: heartbeats stop and the lease lapses. Legitimate orphan
    // recovery must still fire.
    clock.set(30_000);
    expect(await workerB.runtime.reconcileOrphans()).toEqual([spawned.taskId]);
    const reaped = await store.get(spawned.taskId);
    expect(reaped?.status).toBe("failed");
    expect(reaped?.errorCode).toBe(
      SubagentErrorCode.ORPHANED_BY_PROCESS_RESTART
    );

    executor.fail(spawned.taskId, "worker-a-crashed");
    await flush(10);
  });
});
