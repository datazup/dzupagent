/**
 * Comprehensive tests for store abstractions in @dzupagent/core.
 *
 * Covers:
 * - InMemoryRunStore  (additional CRUD, retention/TTL-like, concurrency, large values)
 * - InMemoryAgentStore (additional CRUD, tenant filtering, overwrite, clear)
 * - InMemoryRunStateStore (save/load/delete/list, clone isolation, overwrite)
 * - InMemoryRunRecordStore (legacy — CRUD, filtering, events, delete)
 * - Store interface duck-typing / polymorphism
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  InMemoryRunStore,
  InMemoryAgentStore,
} from "../persistence/in-memory-store.js";
import { InMemoryRunStateStore } from "../persistence/in-memory-run-state-store.js";
import { InMemoryRunRecordStore } from "../persistence/in-memory-run-store.js";
import type {
  RunStore,
  AgentExecutionSpecStore,
} from "../persistence/store-interfaces.js";
import type { DzupRunStateStore } from "../persistence/run-state-store.js";
import type { RunRecordStore } from "../persistence/run-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunState(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    runId,
    agentId: "agent-test",
    messages: [],
    iteration: 0,
    cumulativeUsage: [],
    snapshotAt: Date.now(),
    ...overrides,
  };
}

function makeRunRecord(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    providerId: "provider-1",
    status: "completed" as const,
    prompt: "Test prompt",
    createdAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// InMemoryRunStore — additional coverage
// ---------------------------------------------------------------------------

describe("InMemoryRunStore — store abstractions", () => {
  let store: InMemoryRunStore;

  beforeEach(() => {
    store = new InMemoryRunStore();
  });

  // --- set / get ---

  it("stores and retrieves a run by id (set/get parity)", async () => {
    const run = await store.create({ agentId: "a1", input: "hello" });
    const fetched = await store.get(run.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(run.id);
    expect(fetched!.input).toBe("hello");
  });

  it("returns null for a key that was never set", async () => {
    const result = await store.get("does-not-exist-abc");
    expect(result).toBeNull();
  });

  // --- delete / has ---

  it("returns null after a run is deleted via update+eviction (TTL simulation)", async () => {
    const limited = new InMemoryRunStore({ maxRuns: 1 });
    const r1 = await limited.create({ agentId: "a1", input: "old" });
    await limited.create({ agentId: "a1", input: "new" });
    // r1 is evicted because maxRuns=1
    expect(await limited.get(r1.id)).toBeNull();
  });

  it("get returns null once the only entry is evicted (retention === delete)", async () => {
    const limited = new InMemoryRunStore({ maxRuns: 0 });
    const r1 = await limited.create({ agentId: "a1", input: "test" });
    expect(await limited.get(r1.id)).toBeNull();
  });

  // --- has / list ---

  it("list returns all created runs", async () => {
    await store.create({ agentId: "a1", input: "1" });
    await store.create({ agentId: "a1", input: "2" });
    await store.create({ agentId: "a1", input: "3" });
    const all = await store.list({ limit: 100 });
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  it("list returns empty array when store is empty", async () => {
    const all = await store.list();
    expect(all).toEqual([]);
  });

  // --- clear ---

  it("clear() removes all runs and logs", async () => {
    const run = await store.create({ agentId: "a1", input: "test" });
    await store.addLog(run.id, { level: "info", message: "msg" });
    store.clear();
    expect(await store.list()).toHaveLength(0);
    expect(await store.getLogs(run.id)).toHaveLength(0);
  });

  it("list returns empty after clear()", async () => {
    for (let i = 0; i < 5; i++)
      await store.create({ agentId: "a1", input: `t${i}` });
    store.clear();
    const all = await store.list({ limit: 100 });
    expect(all).toHaveLength(0);
  });

  // --- retention / TTL analogue ---

  it("enforces maxRuns=3: oldest run evicted when 4th run is added", async () => {
    const s = new InMemoryRunStore({ maxRuns: 3 });
    const r1 = await s.create({ agentId: "a", input: "1" });
    await s.create({ agentId: "a", input: "2" });
    await s.create({ agentId: "a", input: "3" });
    await s.create({ agentId: "a", input: "4" });
    expect(await s.get(r1.id)).toBeNull();
    expect(await s.list({ limit: 10 })).toHaveLength(3);
  });

  it("TTL not expired analogue: run is accessible before eviction limit is hit", async () => {
    const s = new InMemoryRunStore({ maxRuns: 5 });
    const r1 = await s.create({ agentId: "a", input: "first" });
    await s.create({ agentId: "a", input: "second" });
    // only 2 of 5 slots used — r1 still alive
    expect(await s.get(r1.id)).not.toBeNull();
  });

  it("TTL = Infinity (opt-out): entry never evicted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = new InMemoryRunStore({ maxRuns: Number.POSITIVE_INFINITY });
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await s.create({ agentId: "a", input: `t${i}` });
      ids.push(r.id);
    }
    // All 20 should still be present
    for (const id of ids) {
      expect(await s.get(id)).not.toBeNull();
    }
    warn.mockRestore();
  });

  // --- overwrite (update keeps latest) ---

  it("update overwrites fields: status change is reflected in get()", async () => {
    const run = await store.create({ agentId: "a", input: "x" });
    await store.update(run.id, { status: "completed", output: "done" });
    const fetched = await store.get(run.id);
    expect(fetched!.status).toBe("completed");
    expect(fetched!.output).toBe("done");
  });

  it("multiple updates accumulate correctly (last write wins per field)", async () => {
    const run = await store.create({ agentId: "a", input: "x" });
    await store.update(run.id, { status: "running" });
    await store.update(run.id, { status: "completed" });
    const fetched = await store.get(run.id);
    expect(fetched!.status).toBe("completed");
  });

  // --- count ---

  it("count returns total matching runs ignoring limit/offset", async () => {
    for (let i = 0; i < 15; i++)
      await store.create({ agentId: "a1", input: `t${i}` });
    const total = await store.count!({ agentId: "a1" });
    expect(total).toBe(15);
  });

  it("count respects filter predicates", async () => {
    await store.create({ agentId: "a1", input: "1" });
    await store.create({ agentId: "a2", input: "2" });
    expect(await store.count!({ agentId: "a1" })).toBe(1);
    expect(await store.count!({ agentId: "a2" })).toBe(1);
    expect(await store.count!({ agentId: "a3" })).toBe(0);
  });

  // --- concurrent writes ---

  it("concurrent creates do not corrupt state", async () => {
    const promises = Array.from({ length: 20 }, (_, i) =>
      store.create({ agentId: "a1", input: `concurrent-${i}` }),
    );
    const runs = await Promise.all(promises);
    const ids = new Set(runs.map((r) => r.id));
    expect(ids.size).toBe(20); // all unique IDs
  });

  it("concurrent updates to different runs are isolated", async () => {
    const r1 = await store.create({ agentId: "a", input: "r1" });
    const r2 = await store.create({ agentId: "a", input: "r2" });
    await Promise.all([
      store.update(r1.id, { status: "running" }),
      store.update(r2.id, { status: "completed" }),
    ]);
    expect((await store.get(r1.id))!.status).toBe("running");
    expect((await store.get(r2.id))!.status).toBe("completed");
  });

  // --- large value ---

  it("stores and retrieves a large input object without truncation", async () => {
    const largeInput = {
      data: "x".repeat(100_000),
      items: Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        val: `value-${i}`,
      })),
    };
    const run = await store.create({ agentId: "a", input: largeInput });
    const fetched = await store.get(run.id);
    expect(fetched!.input).toEqual(largeInput);
    expect((fetched!.input as typeof largeInput).data.length).toBe(100_000);
  });

  // --- addLogs batch ---

  it("addLogs stores multiple entries in order", async () => {
    const run = await store.create({ agentId: "a", input: "test" });
    await store.addLogs(run.id, [
      { level: "info", message: "first" },
      { level: "warn", message: "second" },
      { level: "error", message: "third" },
    ]);
    const logs = await store.getLogs(run.id);
    expect(logs).toHaveLength(3);
    expect(logs[0]!.message).toBe("first");
    expect(logs[2]!.message).toBe("third");
  });

  it("getLogs returns empty array for unknown runId", async () => {
    const logs = await store.getLogs("unknown-run-id");
    expect(logs).toEqual([]);
  });

  // --- tenant / owner scoping ---

  it("filters by tenantId", async () => {
    await store.create({ agentId: "a", input: "1", tenantId: "tenant-A" });
    await store.create({ agentId: "a", input: "2", tenantId: "tenant-B" });
    const tenantA = await store.list({ tenantId: "tenant-A", limit: 100 });
    expect(tenantA).toHaveLength(1);
    expect(tenantA[0]!.tenantId).toBe("tenant-A");
  });

  it("filters by ownerId", async () => {
    await store.create({ agentId: "a", input: "1", ownerId: "owner-1" });
    await store.create({ agentId: "a", input: "2", ownerId: "owner-2" });
    const owner1 = await store.list({ ownerId: "owner-1", limit: 100 });
    expect(owner1).toHaveLength(1);
    expect(owner1[0]!.ownerId).toBe("owner-1");
  });

  it("includeLegacyOwnerless includes ownerless runs when ownerId filter is set", async () => {
    const ownerless = await store.create({ agentId: "a", input: "no-owner" });
    const withOwner = await store.create({
      agentId: "a",
      input: "owned",
      ownerId: "owner-1",
    });
    const results = await store.list({
      ownerId: "owner-1",
      includeLegacyOwnerless: true,
      limit: 100,
    });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(ownerless.id);
    expect(ids).toContain(withOwner.id);
  });
});

// ---------------------------------------------------------------------------
// InMemoryAgentStore — additional coverage
// ---------------------------------------------------------------------------

describe("InMemoryAgentStore — store abstractions", () => {
  let store: InMemoryAgentStore;

  beforeEach(() => {
    store = new InMemoryAgentStore();
  });

  it("save and get: stores and retrieves an agent spec", async () => {
    await store.save({
      id: "a1",
      name: "Agent One",
      instructions: "Do A",
      modelTier: "chat",
    });
    const fetched = await store.get("a1");
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("Agent One");
    expect(fetched!.updatedAt).toBeInstanceOf(Date);
  });

  it("get returns null for unknown agent id", async () => {
    const result = await store.get("nonexistent-agent");
    expect(result).toBeNull();
  });

  it("delete removes the agent so get returns null", async () => {
    await store.save({
      id: "a1",
      name: "A",
      instructions: "i",
      modelTier: "chat",
    });
    await store.delete("a1");
    expect(await store.get("a1")).toBeNull();
  });

  it("delete on unknown id is a no-op (no throw)", async () => {
    await expect(store.delete("does-not-exist")).resolves.not.toThrow();
  });

  it("list returns all saved agents", async () => {
    await store.save({
      id: "a1",
      name: "A1",
      instructions: "i",
      modelTier: "chat",
    });
    await store.save({
      id: "a2",
      name: "A2",
      instructions: "i",
      modelTier: "codegen",
    });
    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  it("list returns empty when no agents are stored", async () => {
    expect(await store.list()).toHaveLength(0);
  });

  it("overwrite: saving same id updates the entry", async () => {
    await store.save({
      id: "a1",
      name: "First",
      instructions: "i",
      modelTier: "chat",
    });
    await store.save({
      id: "a1",
      name: "Updated",
      instructions: "i2",
      modelTier: "codegen",
    });
    const fetched = await store.get("a1");
    expect(fetched!.name).toBe("Updated");
    expect(fetched!.instructions).toBe("i2");
    const all = await store.list();
    expect(all).toHaveLength(1); // no duplicate
  });

  it("clear() removes all agents", async () => {
    await store.save({
      id: "a1",
      name: "A1",
      instructions: "i",
      modelTier: "chat",
    });
    store.clear();
    expect(await store.list()).toHaveLength(0);
    expect(await store.get("a1")).toBeNull();
  });

  it("filters by active=true correctly", async () => {
    await store.save({
      id: "a1",
      name: "A1",
      instructions: "i",
      modelTier: "chat",
      active: true,
    });
    await store.save({
      id: "a2",
      name: "A2",
      instructions: "i",
      modelTier: "chat",
      active: false,
    });
    await store.save({
      id: "a3",
      name: "A3",
      instructions: "i",
      modelTier: "chat",
    }); // active undefined
    const active = await store.list({ active: true });
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe("a1");
  });

  it("filters by active=false correctly", async () => {
    await store.save({
      id: "a1",
      name: "A",
      instructions: "i",
      modelTier: "chat",
      active: false,
    });
    await store.save({
      id: "a2",
      name: "B",
      instructions: "i",
      modelTier: "chat",
      active: true,
    });
    const inactive = await store.list({ active: false });
    expect(inactive).toHaveLength(1);
    expect(inactive[0]!.id).toBe("a1");
  });

  it("respects limit in list()", async () => {
    for (let i = 0; i < 10; i++) {
      await store.save({
        id: `a${i}`,
        name: `Agent ${i}`,
        instructions: "i",
        modelTier: "chat",
      });
    }
    const limited = await store.list({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it("filters by tenantId", async () => {
    await store.save({
      id: "a1",
      name: "A",
      instructions: "i",
      modelTier: "chat",
      tenantId: "T1",
    });
    await store.save({
      id: "a2",
      name: "B",
      instructions: "i",
      modelTier: "chat",
      tenantId: "T2",
    });
    const t1 = await store.list({ tenantId: "T1" });
    expect(t1).toHaveLength(1);
    expect(t1[0]!.id).toBe("a1");
  });

  it("concurrent saves do not corrupt state", async () => {
    const promises = Array.from({ length: 15 }, (_, i) =>
      store.save({
        id: `agent-${i}`,
        name: `Agent ${i}`,
        instructions: "i",
        modelTier: "chat",
      }),
    );
    await Promise.all(promises);
    const all = await store.list({ limit: 100 });
    expect(all).toHaveLength(15);
  });
});

// ---------------------------------------------------------------------------
// InMemoryRunStateStore — coverage
// ---------------------------------------------------------------------------

describe("InMemoryRunStateStore — store abstractions", () => {
  let store: InMemoryRunStateStore;

  beforeEach(() => {
    store = new InMemoryRunStateStore();
  });

  it("save and load: stores and retrieves a run state snapshot", async () => {
    const state = makeRunState("run-1", { iteration: 5 });
    await store.save(state);
    const loaded = await store.load("run-1");
    expect(loaded).not.toBeUndefined();
    expect(loaded!.runId).toBe("run-1");
    expect(loaded!.iteration).toBe(5);
  });

  it("load returns undefined for unknown runId", async () => {
    const result = await store.load("ghost-run");
    expect(result).toBeUndefined();
  });

  it("delete removes the snapshot", async () => {
    await store.save(makeRunState("run-del"));
    await store.delete("run-del");
    expect(await store.load("run-del")).toBeUndefined();
  });

  it("delete on unknown runId is a no-op (no throw)", async () => {
    await expect(store.delete("nonexistent")).resolves.not.toThrow();
  });

  it("listRunIds returns all saved run IDs", async () => {
    await store.save(makeRunState("r1"));
    await store.save(makeRunState("r2"));
    await store.save(makeRunState("r3"));
    const ids = await store.listRunIds();
    expect(ids).toContain("r1");
    expect(ids).toContain("r2");
    expect(ids).toContain("r3");
    expect(ids).toHaveLength(3);
  });

  it("listRunIds returns empty array when store is empty", async () => {
    expect(await store.listRunIds()).toEqual([]);
  });

  it("size property reflects stored count", async () => {
    expect(store.size).toBe(0);
    await store.save(makeRunState("r1"));
    await store.save(makeRunState("r2"));
    expect(store.size).toBe(2);
  });

  it("size decrements after delete", async () => {
    await store.save(makeRunState("r1"));
    await store.save(makeRunState("r2"));
    await store.delete("r1");
    expect(store.size).toBe(1);
  });

  it("clear() removes all snapshots", async () => {
    await store.save(makeRunState("r1"));
    await store.save(makeRunState("r2"));
    store.clear();
    expect(store.size).toBe(0);
    expect(await store.listRunIds()).toHaveLength(0);
  });

  it("overwrite: saving same runId replaces the snapshot", async () => {
    await store.save(makeRunState("r1", { iteration: 1 }));
    await store.save(makeRunState("r1", { iteration: 10 }));
    const loaded = await store.load("r1");
    expect(loaded!.iteration).toBe(10);
    expect(store.size).toBe(1); // no duplicate entries
  });

  it("clone isolation: mutating loaded state does not affect stored state", async () => {
    await store.save(makeRunState("r1", { messages: [] }));
    const loaded1 = await store.load("r1");
    loaded1!.messages.push({
      _getType: () => "human",
      content: "injected",
    } as never);
    const loaded2 = await store.load("r1");
    expect(loaded2!.messages).toHaveLength(0);
  });

  it("clone isolation: mutating input before save does not affect stored state", async () => {
    const state = makeRunState("r1", { messages: [] });
    await store.save(state);
    state.messages.push({
      _getType: () => "human",
      content: "post-save",
    } as never);
    const loaded = await store.load("r1");
    expect(loaded!.messages).toHaveLength(0);
  });

  it("stores and retrieves large snapshot without truncation", async () => {
    const bigState = makeRunState("r-large", {
      cumulativeUsage: Array.from({ length: 500 }, (_, i) => ({
        inputTokens: i,
        outputTokens: i * 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      })),
    });
    await store.save(bigState);
    const loaded = await store.load("r-large");
    expect(loaded!.cumulativeUsage).toHaveLength(500);
    expect(loaded!.cumulativeUsage[499]!.inputTokens).toBe(499);
  });

  it("all store operations return promises (async interface)", async () => {
    const saveResult = store.save(makeRunState("async-r"));
    expect(saveResult).toBeInstanceOf(Promise);
    await saveResult;
    const loadResult = store.load("async-r");
    expect(loadResult).toBeInstanceOf(Promise);
    await loadResult;
    const deleteResult = store.delete("async-r");
    expect(deleteResult).toBeInstanceOf(Promise);
    await deleteResult;
    const listResult = store.listRunIds();
    expect(listResult).toBeInstanceOf(Promise);
  });

  it("concurrent saves are safe (no state corruption)", async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      store.save(makeRunState(`concurrent-${i}`, { iteration: i })),
    );
    await Promise.all(promises);
    const ids = await store.listRunIds();
    expect(ids).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// InMemoryRunRecordStore (legacy) — coverage
// ---------------------------------------------------------------------------

describe("InMemoryRunRecordStore — store abstractions", () => {
  let store: InMemoryRunRecordStore;

  beforeEach(() => {
    store = new InMemoryRunRecordStore();
  });

  it("createRun uses provided id", async () => {
    const id = await store.createRun(makeRunRecord("explicit-id"));
    expect(id).toBe("explicit-id");
    const run = await store.getRun("explicit-id");
    expect(run).not.toBeUndefined();
    expect(run!.id).toBe("explicit-id");
  });

  it("createRun generates id when not provided", async () => {
    const record = { ...makeRunRecord(""), id: undefined as unknown as string };
    const id = await store.createRun(record);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("getRun returns undefined for unknown id", async () => {
    expect(await store.getRun("nope")).toBeUndefined();
  });

  it("updateRun mutates stored record", async () => {
    await store.createRun(makeRunRecord("r1", { status: "queued" }));
    await store.updateRun("r1", { status: "completed", result: "OK" });
    const run = await store.getRun("r1");
    expect(run!.status).toBe("completed");
    expect(run!.result).toBe("OK");
  });

  it("updateRun on unknown id is a no-op (no throw)", async () => {
    await expect(
      store.updateRun("ghost", { status: "completed" }),
    ).resolves.not.toThrow();
  });

  it("deleteRun removes the record and returns true", async () => {
    await store.createRun(makeRunRecord("r1"));
    const deleted = await store.deleteRun("r1");
    expect(deleted).toBe(true);
    expect(await store.getRun("r1")).toBeUndefined();
  });

  it("deleteRun returns false for unknown id", async () => {
    const result = await store.deleteRun("nonexistent");
    expect(result).toBe(false);
  });

  it("size reflects number of stored runs", async () => {
    expect(store.size).toBe(0);
    await store.createRun(makeRunRecord("r1"));
    await store.createRun(makeRunRecord("r2"));
    expect(store.size).toBe(2);
    await store.deleteRun("r1");
    expect(store.size).toBe(1);
  });

  it("clear() removes all runs and events", async () => {
    await store.createRun(makeRunRecord("r1"));
    await store.storeEvent("r1", {
      id: "e1",
      runId: "r1",
      type: "start",
      data: {},
      timestamp: Date.now(),
    });
    store.clear();
    expect(store.size).toBe(0);
    expect(await store.getRun("r1")).toBeUndefined();
    expect(await store.getEvents("r1")).toHaveLength(0);
  });

  it("listRuns returns all runs sorted by createdAt descending", async () => {
    const now = Date.now();
    await store.createRun(makeRunRecord("r1", { createdAt: now - 2000 }));
    await store.createRun(makeRunRecord("r2", { createdAt: now - 1000 }));
    await store.createRun(makeRunRecord("r3", { createdAt: now }));
    const all = await store.listRuns();
    expect(all[0]!.id).toBe("r3");
    expect(all[2]!.id).toBe("r1");
  });

  it("listRuns filters by status", async () => {
    await store.createRun(makeRunRecord("r1", { status: "completed" }));
    await store.createRun(makeRunRecord("r2", { status: "failed" }));
    const failed = await store.listRuns({ status: "failed" });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.id).toBe("r2");
  });

  it("listRuns filters by providerId", async () => {
    await store.createRun(makeRunRecord("r1", { providerId: "p1" }));
    await store.createRun(makeRunRecord("r2", { providerId: "p2" }));
    const p1runs = await store.listRuns({ providerId: "p1" });
    expect(p1runs).toHaveLength(1);
    expect(p1runs[0]!.id).toBe("r1");
  });

  it("listRuns filters by correlationId", async () => {
    await store.createRun(makeRunRecord("r1", { correlationId: "corr-A" }));
    await store.createRun(makeRunRecord("r2", { correlationId: "corr-B" }));
    const corrA = await store.listRuns({ correlationId: "corr-A" });
    expect(corrA).toHaveLength(1);
    expect(corrA[0]!.id).toBe("r1");
  });

  it("listRuns respects limit and offset", async () => {
    for (let i = 0; i < 10; i++) {
      await store.createRun(makeRunRecord(`r${i}`, { createdAt: i }));
    }
    const page = await store.listRuns({ limit: 3, offset: 2 });
    expect(page).toHaveLength(3);
  });

  it("storeEvent and getEvents round-trip", async () => {
    await store.createRun(makeRunRecord("r1"));
    await store.storeEvent("r1", {
      id: "e1",
      runId: "r1",
      type: "tool_call",
      data: { tool: "bash" },
      timestamp: 1000,
    });
    await store.storeEvent("r1", {
      id: "e2",
      runId: "r1",
      type: "tool_result",
      data: { out: "ok" },
      timestamp: 2000,
    });
    const events = await store.getEvents("r1");
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("tool_call");
    expect(events[1]!.type).toBe("tool_result");
  });

  it("getEvents returns empty array for unknown runId", async () => {
    const events = await store.getEvents("ghost");
    expect(events).toHaveLength(0);
  });

  it("getEvents respects limit and offset", async () => {
    await store.createRun(makeRunRecord("r1"));
    for (let i = 0; i < 8; i++) {
      await store.storeEvent("r1", {
        id: `e${i}`,
        runId: "r1",
        type: "tick",
        data: {},
        timestamp: i,
      });
    }
    const page = await store.getEvents("r1", { limit: 3, offset: 2 });
    expect(page).toHaveLength(3);
  });

  it("listRuns filters by tags (any match)", async () => {
    await store.createRun(makeRunRecord("r1", { tags: ["alpha", "beta"] }));
    await store.createRun(makeRunRecord("r2", { tags: ["gamma"] }));
    const result = await store.listRuns({ tags: ["alpha"] });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("r1");
  });

  it("listRuns since/until filters by time range", async () => {
    const t = 1_000_000;
    await store.createRun(makeRunRecord("r1", { createdAt: t - 100 }));
    await store.createRun(makeRunRecord("r2", { createdAt: t }));
    await store.createRun(makeRunRecord("r3", { createdAt: t + 100 }));
    const range = await store.listRuns({ since: t, until: t });
    expect(range.map((r) => r.id)).toContain("r2");
    expect(range.map((r) => r.id)).not.toContain("r1");
    expect(range.map((r) => r.id)).not.toContain("r3");
  });
});

// ---------------------------------------------------------------------------
// Store interface duck-typing / polymorphism tests
// ---------------------------------------------------------------------------

describe("Store interfaces — duck typing and polymorphism", () => {
  it("InMemoryRunStore satisfies RunStore interface (duck type)", () => {
    const store: RunStore = new InMemoryRunStore();
    expect(typeof store.create).toBe("function");
    expect(typeof store.get).toBe("function");
    expect(typeof store.update).toBe("function");
    expect(typeof store.list).toBe("function");
    expect(typeof store.addLog).toBe("function");
    expect(typeof store.addLogs).toBe("function");
    expect(typeof store.getLogs).toBe("function");
  });

  it("InMemoryAgentStore satisfies AgentExecutionSpecStore interface (duck type)", () => {
    const store: AgentExecutionSpecStore = new InMemoryAgentStore();
    expect(typeof store.save).toBe("function");
    expect(typeof store.get).toBe("function");
    expect(typeof store.list).toBe("function");
    expect(typeof store.delete).toBe("function");
  });

  it("InMemoryRunStateStore satisfies DzupRunStateStore interface (duck type)", () => {
    const store: DzupRunStateStore = new InMemoryRunStateStore();
    expect(typeof store.save).toBe("function");
    expect(typeof store.load).toBe("function");
    expect(typeof store.delete).toBe("function");
    expect(typeof store.listRunIds).toBe("function");
  });

  it("InMemoryRunRecordStore satisfies RunRecordStore interface (duck type)", () => {
    const store: RunRecordStore = new InMemoryRunRecordStore();
    expect(typeof store.createRun).toBe("function");
    expect(typeof store.getRun).toBe("function");
    expect(typeof store.updateRun).toBe("function");
    expect(typeof store.listRuns).toBe("function");
    expect(typeof store.storeEvent).toBe("function");
    expect(typeof store.getEvents).toBe("function");
    expect(typeof store.deleteRun).toBe("function");
  });

  it("RunStore and AgentExecutionSpecStore are structurally independent", async () => {
    const runStore: RunStore = new InMemoryRunStore();
    const agentStore: AgentExecutionSpecStore = new InMemoryAgentStore();
    // Creating a run does not affect agent store and vice versa
    await runStore.create({ agentId: "a1", input: "test" });
    await agentStore.save({
      id: "a1",
      name: "A1",
      instructions: "i",
      modelTier: "chat",
    });
    const runs = await runStore.list({ limit: 100 });
    const agents = await agentStore.list();
    expect(runs).toHaveLength(1);
    expect(agents).toHaveLength(1);
    // They are separate stores — no cross-contamination
    expect(runs[0]!.agentId).toBe("a1");
    expect(agents[0]!.id).toBe("a1");
  });
});
