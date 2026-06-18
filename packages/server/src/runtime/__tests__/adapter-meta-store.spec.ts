/**
 * Unit tests for the OQ-3 {@link AdapterMetaStore} implementations.
 *
 * `InMemoryAdapterMetaStore` is exercised against its public contract.
 * `DrizzleAdapterMetaStore` is tested against a duck-typed mock Drizzle client
 * (vi.fn() builder chains) — we assert on captured arguments rather than
 * executing real SQL, mirroring {@link DrizzleWorkerNodeStore}'s test pattern.
 */
import { describe, it, expect, vi } from "vitest";
import {
  InMemoryAdapterMetaStore,
  DrizzleAdapterMetaStore,
  type AdapterMeta,
} from "../adapter-meta-store.js";
import type { DrizzleStoreDatabase } from "../../persistence/drizzle-store-types.js";

type Args = Record<string, unknown>;

/** Build a mock insert→onConflictDoUpdate chain (no returning needed). */
function mockInsert() {
  const onConflictDoUpdate = vi.fn(async (_config: unknown) => undefined);
  const values = vi.fn((_values: Args) => ({ onConflictDoUpdate }));
  const insert = vi.fn((_table: unknown) => ({ values }));
  return { insert, values, onConflictDoUpdate };
}

/** Build a mock select→from→where chain resolving to `rows`. */
function mockSelect(rows: unknown[]) {
  const where = vi.fn(async (_cond: unknown) => rows);
  const from = vi.fn((_table: unknown) => ({ where }));
  const select = vi.fn((_sel?: unknown) => ({ from }));
  return { select, from, where };
}

describe("InMemoryAdapterMetaStore", () => {
  it("upsert + get round-trip", async () => {
    const store = new InMemoryAdapterMetaStore();
    const entry: AdapterMeta = {
      runId: "r1",
      nodeId: "n1",
      adapterId: "claude",
      sessionRef: "sess-abc",
      resumeToken: "tok-123",
      meta: { thread: "t9" },
    };
    await store.upsert(entry);

    const got = await store.get("r1", "n1", "claude");
    expect(got).toEqual(entry);

    // Missing key returns null.
    expect(await store.get("r1", "n1", "codex")).toBeNull();
  });

  it("upsert overwrites on same key", async () => {
    const store = new InMemoryAdapterMetaStore();
    await store.upsert({
      runId: "r1",
      nodeId: "n1",
      adapterId: "claude",
      sessionRef: "old",
    });
    await store.upsert({
      runId: "r1",
      nodeId: "n1",
      adapterId: "claude",
      sessionRef: "new",
      resumeToken: "tok",
    });

    const got = await store.get("r1", "n1", "claude");
    expect(got?.sessionRef).toBe("new");
    expect(got?.resumeToken).toBe("tok");
  });

  it("deleteForRun removes all entries for a run", async () => {
    const store = new InMemoryAdapterMetaStore();
    await store.upsert({ runId: "r1", nodeId: "n1", adapterId: "claude" });
    await store.upsert({ runId: "r1", nodeId: "n2", adapterId: "codex" });
    await store.upsert({ runId: "r2", nodeId: "n1", adapterId: "claude" });

    await store.deleteForRun("r1");

    expect(await store.get("r1", "n1", "claude")).toBeNull();
    expect(await store.get("r1", "n2", "codex")).toBeNull();
    // Other runs are untouched.
    expect(await store.get("r2", "n1", "claude")).not.toBeNull();
  });
});

describe("DrizzleAdapterMetaStore", () => {
  it("upsert writes via INSERT ... ON CONFLICT DO UPDATE", async () => {
    const ins = mockInsert();
    const db = { insert: ins.insert } as unknown as DrizzleStoreDatabase;
    const store = new DrizzleAdapterMetaStore(db);

    await store.upsert({
      runId: "r1",
      nodeId: "n1",
      adapterId: "claude",
      sessionRef: "sess-abc",
      resumeToken: "tok-123",
      meta: { thread: "t9" },
    });

    expect(ins.values).toHaveBeenCalledTimes(1);
    const values = ins.values.mock.calls[0]![0];
    expect(values.runId).toBe("r1");
    expect(values.nodeId).toBe("n1");
    expect(values.adapterId).toBe("claude");
    expect(values.sessionRef).toBe("sess-abc");
    expect(values.resumeToken).toBe("tok-123");
    expect(values.meta).toEqual({ thread: "t9" });
    // Upsert path taken.
    expect(ins.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it("get selects by composite key and maps the row back", async () => {
    const row = {
      runId: "r1",
      nodeId: "n1",
      adapterId: "claude",
      sessionRef: "sess-abc",
      resumeToken: null,
      meta: { thread: "t9" },
      createdAt: 1000,
      updatedAt: 2000,
    };
    const sel = mockSelect([row]);
    const db = { select: sel.select } as unknown as DrizzleStoreDatabase;
    const store = new DrizzleAdapterMetaStore(db);

    const got = await store.get("r1", "n1", "claude");

    expect(sel.where).toHaveBeenCalledTimes(1);
    expect(got).toEqual({
      runId: "r1",
      nodeId: "n1",
      adapterId: "claude",
      sessionRef: "sess-abc",
      meta: { thread: "t9" },
    });

    // No row -> null.
    const empty = mockSelect([]);
    const emptyDb = {
      select: empty.select,
    } as unknown as DrizzleStoreDatabase;
    const emptyStore = new DrizzleAdapterMetaStore(emptyDb);
    expect(await emptyStore.get("r1", "n1", "missing")).toBeNull();
  });
});
