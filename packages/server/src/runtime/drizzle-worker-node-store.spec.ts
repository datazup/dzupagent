/**
 * Unit tests for {@link DrizzleWorkerNodeStore}.
 *
 * The Drizzle client is mocked with `vi.fn()` chains — each builder method
 * returns the next link and the terminal (`returning`, `where`, the awaited
 * builder) resolves to a caller-supplied row set. We assert on the captured
 * arguments rather than executing real SQL, so the suite is DB-free.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { DrizzleWorkerNodeStore } from "./drizzle-worker-node-store.js";
import type { DrizzleWorkerNodeDatabase } from "../persistence/drizzle-store-types.js";
import { createScaleTargetRoute } from "../routes/scale-target.js";
import type { ProviderCapacity } from "../routes/scale-target.js";
import type { WorkerNode, WorkerNodeStore } from "./worker-registry.js";
import type { QueueStats, RunQueue } from "../queue/run-queue.js";

type Args = Record<string, unknown>;

/** Build a mock insert→onConflictDoUpdate→returning chain. */
function mockInsert(returnRows: unknown[]) {
  const returning = vi.fn(async () => returnRows);
  const onConflictDoUpdate = vi.fn((_config: unknown) => ({ returning }));
  const values = vi.fn((_values: Args) => ({ onConflictDoUpdate, returning }));
  const insert = vi.fn((_table: unknown) => ({ values }));
  return { insert, values, onConflictDoUpdate, returning };
}

/** Build a mock update→set→where chain (optionally returning rows). */
function mockUpdate(returnRows: unknown[] = []) {
  const returning = vi.fn(async () => returnRows);
  // `where` is awaitable AND chains to `.returning()`.
  const where = vi.fn((_cond: unknown) => {
    const p = Promise.resolve(undefined) as Promise<undefined> & {
      returning: typeof returning;
    };
    p.returning = returning;
    return p;
  });
  const set = vi.fn((_patch: Args) => ({ where }));
  const update = vi.fn((_table: unknown) => ({ set }));
  return { update, set, where, returning };
}

/** Build a mock delete→where chain. */
function mockDelete() {
  const where = vi.fn(async (_cond: unknown) => undefined);
  const del = vi.fn((_table: unknown) => ({ where }));
  return { delete: del, where };
}

describe("DrizzleWorkerNodeStore", () => {
  it("register upserts the node and returns the stored row", async () => {
    const stored = {
      id: "w1",
      tenantScope: "shared",
      status: "active",
      capacity: 5,
      inFlight: 0,
      startedAt: 1000,
      lastHeartbeatAt: 1000,
      meta: { region: "eu" },
    };
    const ins = mockInsert([stored]);
    const db = { insert: ins.insert } as unknown as DrizzleWorkerNodeDatabase;
    const store = new DrizzleWorkerNodeStore(db);

    const node = await store.register(
      {
        id: "w1",
        tenantScope: "shared",
        capacity: 5,
        inFlight: 0,
        startedAt: 1000,
        meta: { region: "eu" },
      },
      1000
    );

    expect(ins.values).toHaveBeenCalledTimes(1);
    // Inserted row is registered as active with the heartbeat stamped to `now`.
    const values = ins.values.mock.calls[0]![0];
    expect(values.status).toBe("active");
    expect(values.lastHeartbeatAt).toBe(1000);
    // Upsert path used so a restart resumes onto the same id.
    expect(ins.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(node).toEqual({
      id: "w1",
      tenantScope: "shared",
      status: "active",
      capacity: 5,
      inFlight: 0,
      startedAt: 1000,
      lastHeartbeatAt: 1000,
      meta: { region: "eu" },
    });
  });

  it("heartbeat updates in-flight + timestamp", async () => {
    const upd = mockUpdate();
    const db = { update: upd.update } as unknown as DrizzleWorkerNodeDatabase;
    const store = new DrizzleWorkerNodeStore(db);

    await store.heartbeat("w1", 3, 2000);

    expect(upd.set).toHaveBeenCalledTimes(1);
    const patch = upd.set.mock.calls[0]![0];
    expect(patch.inFlight).toBe(3);
    expect(patch.lastHeartbeatAt).toBe(2000);
    // A `status` CASE expression is set so a dead node resurrects to active.
    expect(patch.status).toBeDefined();
    expect(upd.where).toHaveBeenCalledTimes(1);
  });

  it("setStatus updates only the status column", async () => {
    const upd = mockUpdate();
    const db = { update: upd.update } as unknown as DrizzleWorkerNodeDatabase;
    const store = new DrizzleWorkerNodeStore(db);

    await store.setStatus("w1", "draining");

    expect(upd.set).toHaveBeenCalledWith({ status: "draining" });
    expect(upd.where).toHaveBeenCalledTimes(1);
  });

  it("reapExpired marks stale nodes dead and returns their ids", async () => {
    const upd = mockUpdate([{ id: "w2" }, { id: "w3" }]);
    const db = { update: upd.update } as unknown as DrizzleWorkerNodeDatabase;
    const store = new DrizzleWorkerNodeStore(db);

    const reaped = await store.reapExpired(10_000, 30_000);

    expect(upd.set).toHaveBeenCalledWith({ status: "dead" });
    expect(upd.returning).toHaveBeenCalledTimes(1);
    expect(reaped).toEqual(["w2", "w3"]);
  });

  it("deregister deletes the node by id", async () => {
    const del = mockDelete();
    const db = { delete: del.delete } as unknown as DrizzleWorkerNodeDatabase;
    const store = new DrizzleWorkerNodeStore(db);

    await store.deregister("w1");

    expect(del.delete).toHaveBeenCalledTimes(1);
    expect(del.where).toHaveBeenCalledTimes(1);
  });

  // S4-H: provider-awareness.
  it("register stores the providers field in the INSERT", async () => {
    const ins = mockInsert([]);
    const db = { insert: ins.insert } as unknown as DrizzleWorkerNodeDatabase;
    const store = new DrizzleWorkerNodeStore(db);

    await store.register(
      {
        id: "w1",
        tenantScope: "shared",
        capacity: 5,
        inFlight: 0,
        startedAt: 1000,
        providers: ["claude"],
      },
      1000
    );

    const values = ins.values.mock.calls[0]![0];
    expect(values.providers).toEqual(["claude"]);
  });

  it("list maps providers from the row back to the WorkerNode", async () => {
    const stored = {
      id: "w1",
      tenantScope: "shared",
      status: "active",
      capacity: 5,
      inFlight: 0,
      startedAt: 1000,
      lastHeartbeatAt: 1000,
      meta: null,
      providers: ["claude", "openai"],
    };
    const rows = [stored];
    const db = {
      select: vi.fn(() => ({ from: vi.fn(async () => rows) })),
    } as unknown as DrizzleWorkerNodeDatabase;
    const store = new DrizzleWorkerNodeStore(db);

    const nodes = await store.list();

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.providers).toEqual(["claude", "openai"]);
  });
});

describe("scale-target byProvider breakdown (S4-H)", () => {
  const emptyStats: QueueStats = {
    pending: 0,
    active: 0,
    completed: 0,
    failed: 0,
    deadLetter: 0,
  };
  const queue: RunQueue = { stats: () => emptyStats } as unknown as RunQueue;

  function workerStoreOf(nodes: WorkerNode[]): WorkerNodeStore {
    return { list: async () => nodes } as unknown as WorkerNodeStore;
  }

  async function callScaleTarget(nodes: WorkerNode[]): Promise<{
    byProvider?: ProviderCapacity[];
  }> {
    const app = new Hono();
    app.route(
      "/",
      createScaleTargetRoute({ queue, workerStore: workerStoreOf(nodes) })
    );
    const res = await app.request("/");
    return (await res.json()) as { byProvider?: ProviderCapacity[] };
  }

  it("includes a byProvider breakdown grouped by declared provider", async () => {
    const base = {
      tenantScope: "shared",
      status: "active" as const,
      capacity: 5,
      startedAt: 1000,
      lastHeartbeatAt: 1000,
    };
    const nodes: WorkerNode[] = [
      { ...base, id: "w1", inFlight: 0, providers: ["claude", "openai"] },
      { ...base, id: "w2", inFlight: 2, providers: ["claude"] },
      { ...base, id: "w3", inFlight: 0 }, // no providers -> wildcard
    ];

    const body = await callScaleTarget(nodes);
    const byProvider = body.byProvider ?? [];
    const lookup = new Map(byProvider.map((p) => [p.provider, p]));

    // claude: w1 (idle) + w2 (busy) => 2 active, 1 idle.
    expect(lookup.get("claude")).toEqual({
      provider: "claude",
      activeWorkers: 2,
      idleWorkers: 1,
    });
    // openai: w1 only => 1 active, 1 idle.
    expect(lookup.get("openai")).toEqual({
      provider: "openai",
      activeWorkers: 1,
      idleWorkers: 1,
    });
    // wildcard: w3 only => 1 active, 1 idle.
    expect(lookup.get("*")).toEqual({
      provider: "*",
      activeWorkers: 1,
      idleWorkers: 1,
    });
  });
});
