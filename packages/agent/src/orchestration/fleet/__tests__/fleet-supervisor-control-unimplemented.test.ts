import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FleetSupervisor } from "../fleet-supervisor.js";
import { FanOutPolicy } from "../policies/fan-out-policy.js";
import { SupervisorPolicy } from "../policies/supervisor-policy.js";
import { FilesystemKnowledgeStore } from "@dzupagent/memory/knowledge";
import type {
  Executor,
  KnowledgeEnvelope,
  WorkerHandle,
  WorkerSpec,
  WorkerEvent,
  WorkerOutcome,
  FleetRunSpec,
} from "@dzupagent/agent-types/fleet";

async function queryAll(
  store: FilesystemKnowledgeStore,
  scope: string
): Promise<KnowledgeEnvelope[]> {
  const results: KnowledgeEnvelope[] = [];
  for await (const e of store.query({ scope })) results.push(e);
  return results;
}

/**
 * Phase 1b fleet control surface: pauseTask, cancelTask, reassign.
 *
 * These tests replace the Phase-1a "throws CAPABILITY_NOT_FOUND" contract.
 * Each method now operates on live worker handles registered during spawn.
 */

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-ctrl-"));
});

type SendRecord = { kind: string; text?: string };
type CancelRecord = { reason: string };

class ControllableExecutor implements Executor {
  readonly id = "controllable";
  sends: SendRecord[] = [];
  cancels: CancelRecord[] = [];

  private settle: (() => void) | null = null;
  private notifySpawned: (() => void) | null = null;

  /** Resolves when spawn() has been called (handle is registered). */
  readonly spawned: Promise<void>;

  constructor() {
    this.spawned = new Promise<void>((res) => {
      this.notifySpawned = res;
    });
  }

  /** Unblocks the in-flight dispatch so the run can complete. */
  complete(): void {
    this.settle?.();
  }

  async spawn(spec: WorkerSpec): Promise<WorkerHandle> {
    const sends = this.sends;
    const cancels = this.cancels;
    const executor = this;

    const settled = new Promise<void>((res) => {
      executor.settle = res;
    });

    // Notify waiters that the handle has been spawned (before returning it,
    // so the supervisor's trackingExecutorFor can register it in _taskHandles
    // immediately after this resolves).
    this.notifySpawned?.();

    return {
      workerId: spec.workerId,
      events: (async function* (): AsyncGenerator<WorkerEvent> {
        await settled;
        yield { kind: "exit", code: 0, reason: null, at: "t" };
      })(),
      async send(msg) {
        sends.push(msg);
      },
      async cancel(reason: string) {
        cancels.push({ reason });
        executor.settle?.();
      },
      async wait(): Promise<WorkerOutcome> {
        await settled;
        return {
          state: cancels.length > 0 ? "cancelled" : "completed",
          exitCode: cancels.length > 0 ? null : 0,
        };
      },
    };
  }
}

function fanOutSpec(runId = "r-ctrl"): FleetRunSpec {
  return {
    runId,
    scenario: "audit-fanout",
    repos: [{ name: "repo-a", path: "/tmp/a" }],
    tasks: [{ id: "t1", description: "task one", payload: {}, dependsOn: [] }],
  };
}

describe("FleetSupervisor Phase 1b — pauseTask", () => {
  it("writes a blocked task-state into the knowledge store", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const executor = new ControllableExecutor();
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => executor,
    });

    const runPromise = sup.run(fanOutSpec(), new FanOutPolicy());

    // Allow the executor to spawn (microtask flush)
    await executor.spawned;
    await Promise.resolve(); // let trackingExecutorFor store the handle after spawn resolves
    await sup.pauseTask("t1", "draining queue");
    executor.complete();
    await runPromise;

    const envelopes = await queryAll(store, "run:r-ctrl");
    const blocked = envelopes.filter(
      (e) =>
        e.kind === "task-state" &&
        "state" in e.payload &&
        e.payload.state === "blocked"
    );
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(blocked[0]?.payload).toMatchObject({
      taskId: "t1",
      state: "blocked",
      blockedReason: "draining queue",
    });
  });

  it("sends a pause message to the live worker handle", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const executor = new ControllableExecutor();
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => executor,
    });

    const runPromise = sup.run(fanOutSpec(), new FanOutPolicy());
    await executor.spawned;
    await Promise.resolve(); // let trackingExecutorFor store the handle after spawn resolves
    await sup.pauseTask("t1", "operator hold");
    executor.complete();
    await runPromise;

    expect(executor.sends).toContainEqual(
      expect.objectContaining({
        kind: "message",
        text: "pause: operator hold",
      })
    );
  });

  it("does not throw when no live handle exists (task already done)", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => ({
        id: "noop",
        spawn: async () => ({
          workerId: "w",
          events: (async function* () {})(),
          send: async () => {},
          cancel: async () => {},
          wait: async () => ({ state: "completed" as const, exitCode: 0 }),
        }),
      }),
    });
    await expect(
      sup.pauseTask("unknown-task", "reason")
    ).resolves.toBeUndefined();
  });
});

describe("FleetSupervisor Phase 1b — cancelTask", () => {
  it("calls handle.cancel and writes surrendered task-state", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const executor = new ControllableExecutor();
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => executor,
    });

    const runPromise = sup.run(fanOutSpec(), new FanOutPolicy());
    await executor.spawned;
    await Promise.resolve(); // let trackingExecutorFor store the handle after spawn resolves
    await sup.cancelTask("t1", "abort run");
    await runPromise;

    expect(executor.cancels).toContainEqual({ reason: "abort run" });

    const envelopes = await queryAll(store, "run:r-ctrl");
    // cancelTask writes its own surrendered envelope with blockedReason;
    // RepoAgent also writes one without blockedReason — find the control one.
    const controlSurrendered = envelopes.find(
      (e) =>
        e.kind === "task-state" &&
        "state" in e.payload &&
        e.payload.state === "surrendered" &&
        "blockedReason" in e.payload
    );
    expect(controlSurrendered).toBeDefined();
    expect(controlSurrendered?.payload).toMatchObject({
      taskId: "t1",
      state: "surrendered",
      blockedReason: "abort run",
    });
  });

  it("resolves cleanly when no live handle exists", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => ({
        id: "noop",
        spawn: async () => ({
          workerId: "w",
          events: (async function* () {})(),
          send: async () => {},
          cancel: async () => {},
          wait: async () => ({ state: "completed" as const, exitCode: 0 }),
        }),
      }),
    });
    await expect(
      sup.cancelTask("no-such-task", "drain")
    ).resolves.toBeUndefined();
  });
});

describe("FleetSupervisor Phase 1b — reassign", () => {
  it("cancels the current handle and writes a reassignment decision", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const cancelledReasons: string[] = [];
    const spawnCount = { value: 0 };

    let firstSpawnResolve!: () => void;
    const firstSpawnReady = new Promise<void>((res) => {
      firstSpawnResolve = res;
    });

    const trackingExecutor: Executor = {
      id: "tracking",
      async spawn(spec: WorkerSpec): Promise<WorkerHandle> {
        spawnCount.value += 1;
        const current = spawnCount.value;
        let settle: (() => void) | null = null;
        const settled = new Promise<void>((res) => {
          settle = res;
        });
        if (current === 1) firstSpawnResolve();
        return {
          workerId: spec.workerId,
          events: (async function* (): AsyncGenerator<WorkerEvent> {
            await settled;
            yield { kind: "exit", code: 0, reason: null, at: "t" };
          })(),
          async send() {},
          async cancel(reason: string) {
            cancelledReasons.push(reason);
            settle?.();
          },
          async wait(): Promise<WorkerOutcome> {
            await settled;
            return {
              state: current === 1 ? "cancelled" : "completed",
              exitCode: current === 1 ? null : 0,
            };
          },
        };
      },
    };

    const spec: FleetRunSpec = {
      runId: "r-reassign",
      scenario: "independent-tasks",
      repos: [
        { name: "repo-x", path: "/tmp/x" },
        { name: "repo-y", path: "/tmp/y" },
      ],
      tasks: [
        {
          id: "task-a",
          description: "reassignable",
          payload: {},
          dependsOn: [],
        },
      ],
    };

    const policy = new SupervisorPolicy();
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => trackingExecutor,
    });

    const runPromise = sup.run(spec, policy);
    // Wait for the tracking wrapper to register the first handle.
    await firstSpawnReady;
    await Promise.resolve();
    await sup.reassign("task-a");

    // run() completes after the original dispatch returns (cancelled).
    await runPromise;

    expect(cancelledReasons).toContain("reassignment requested");
    // A reassignment decision envelope must be recorded in the knowledge store.
    const envelopes = await queryAll(store, "run:r-reassign");
    const reassignDecisions = envelopes.filter(
      (e) =>
        e.kind === "decision" &&
        "decisionKind" in e.payload &&
        e.payload.decisionKind === "assignment" &&
        Array.isArray(e.payload.inputs) &&
        (e.payload.inputs as unknown[]).includes("reassignment")
    );
    expect(reassignDecisions.length).toBeGreaterThanOrEqual(1);
  });

  it("writes surrendered state when no idle worker is available", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const executor = new ControllableExecutor();

    // Single-repo spec — the one worker will be busy, leaving no idle slot.
    const spec: FleetRunSpec = {
      runId: "r-no-idle",
      scenario: "independent-tasks",
      repos: [{ name: "only", path: "/tmp/only" }],
      tasks: [{ id: "busy-task", description: "", payload: {}, dependsOn: [] }],
    };

    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => executor,
    });

    const runPromise = sup.run(spec, new SupervisorPolicy());
    await executor.spawned;
    await Promise.resolve(); // let trackingExecutorFor store the handle after spawn resolves
    await sup.reassign("busy-task");
    // Original handle was cancelled — complete it so run() can finish.
    executor.complete();
    await runPromise;

    const envelopes = await queryAll(store, "run:r-no-idle");
    const surrendered = envelopes.filter(
      (e) =>
        e.kind === "task-state" &&
        "state" in e.payload &&
        e.payload.state === "surrendered"
    );
    expect(surrendered.length).toBeGreaterThanOrEqual(1);
  });

  it("resolves cleanly when called with no active run", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const sup = new FleetSupervisor({
      knowledge: store,
      executorFor: () => ({
        id: "noop",
        spawn: async () => ({
          workerId: "w",
          events: (async function* () {})(),
          send: async () => {},
          cancel: async () => {},
          wait: async () => ({ state: "completed" as const, exitCode: 0 }),
        }),
      }),
    });
    await expect(sup.reassign("t-orphan")).resolves.toBeUndefined();
  });
});
