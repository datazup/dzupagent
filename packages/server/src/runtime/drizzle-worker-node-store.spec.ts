/**
 * Unit tests for {@link DrizzleWorkerNodeStore}.
 *
 * The Drizzle client is mocked with `vi.fn()` chains — each builder method
 * returns the next link and the terminal (`returning`, `where`, the awaited
 * builder) resolves to a caller-supplied row set. We assert on the captured
 * arguments rather than executing real SQL, so the suite is DB-free.
 */
import { describe, it, expect, vi } from "vitest";
import { DrizzleWorkerNodeStore } from "./drizzle-worker-node-store.js";
import type { DrizzleWorkerNodeDatabase } from "../persistence/drizzle-store-types.js";

/** Build a mock insert→onConflictDoUpdate→returning chain. */
function mockInsert(returnRows: unknown[]) {
  const returning = vi.fn(async () => returnRows);
  const onConflictDoUpdate = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoUpdate, returning }));
  const insert = vi.fn(() => ({ values }));
  return { insert, values, onConflictDoUpdate, returning };
}

/** Build a mock update→set→where chain (optionally returning rows). */
function mockUpdate(returnRows: unknown[] = []) {
  const returning = vi.fn(async () => returnRows);
  // `where` is awaitable AND chains to `.returning()`.
  const where = vi.fn(() => {
    const p = Promise.resolve(undefined) as Promise<undefined> & {
      returning: typeof returning;
    };
    p.returning = returning;
    return p;
  });
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { update, set, where, returning };
}

/** Build a mock select→from→where chain. */
function mockSelect(returnRows: unknown[]) {
  const where = vi.fn(async () => returnRows);
  const from = vi.fn(() => {
    const p = Promise.resolve(returnRows) as Promise<unknown[]> & {
      where: typeof where;
    };
    p.where = where;
    return p;
  });
  const select = vi.fn(() => ({ from }));
  return { select, from, where };
}

/** Build a mock delete→where chain. */
function mockDelete() {
  const where = vi.fn(async () => undefined);
  const del = vi.fn(() => ({ where }));
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
    const values = ins.values.mock.calls[0]![0] as Record<string, unknown>;
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
    const patch = upd.set.mock.calls[0]![0] as Record<string, unknown>;
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
});
