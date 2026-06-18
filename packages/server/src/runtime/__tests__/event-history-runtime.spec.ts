/**
 * Stage 5 — unit tests for the event-history replay runtime, its event store,
 * and the replay cursor.
 *
 * Covers the replay/live branching contract (return recorded output without
 * re-executing vs. execute-and-record), failure recording, multi-node replay,
 * cursor miss semantics, and the Drizzle store's per-run sequence increment
 * (against a duck-typed mock Drizzle client).
 */
import { describe, it, expect, vi } from "vitest";
import {
  InMemoryEventStore,
  DrizzleEventStore,
  type FlowEvent,
} from "../event-store.js";
import { EventCursor } from "../event-cursor.js";
import { EventHistoryRuntime } from "../event-history-runtime.js";
import type { DrizzleConflictInsertDatabase } from "../../persistence/drizzle-store-types.js";

type Args = Record<string, unknown>;

/** Build a mock insert→values→onConflictDoNothing chain. */
function mockInsert() {
  const onConflictDoNothing = vi.fn(async () => undefined);
  const values = vi.fn((_values: Args) => ({ onConflictDoNothing }));
  const insert = vi.fn((_table: unknown) => ({ values }));
  return { insert, values, onConflictDoNothing };
}

/** Build a mock select→from→where→orderBy chain resolving to `rows`. */
function mockSelect(rows: unknown[]) {
  const orderBy = vi.fn(async (..._e: unknown[]) => rows);
  const where = vi.fn((_cond: unknown) => ({ orderBy }));
  const from = vi.fn((_table: unknown) => ({ where }));
  const select = vi.fn((_sel?: unknown) => ({ from }));
  return { select, from, where, orderBy };
}

describe("EventHistoryRuntime", () => {
  it("first execution appends node_started + node_completed and is not replayed", async () => {
    const store = new InMemoryEventStore();
    const runtime = new EventHistoryRuntime(store);
    const executor = vi.fn(async () => ({ value: 42 }));

    const result = await runtime.executeNode("run-1", "node-a", executor);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ output: { value: 42 }, replayed: false });

    const events = await store.loadForRun("run-1");
    expect(events.map((e) => e.eventType)).toEqual([
      "run_started",
      "node_started",
      "node_completed",
    ]);
    const completed = events.find((e) => e.eventType === "node_completed");
    expect(completed?.nodeId).toBe("node-a");
    expect(completed?.payload?.output).toEqual({ value: 42 });
  });

  it("re-entry after crash replays the recorded output without executing", async () => {
    const store = new InMemoryEventStore();

    // First runtime executes the node live.
    const first = new EventHistoryRuntime(store);
    await first.executeNode("run-1", "node-a", async () => ({ value: 42 }));

    // A fresh runtime (simulating a new worker process) re-enters the node.
    const second = new EventHistoryRuntime(store);
    const executor = vi.fn(async () => ({ value: 999 }));
    const result = await second.executeNode("run-1", "node-a", executor);

    expect(executor).not.toHaveBeenCalled();
    expect(result).toEqual({ output: { value: 42 }, replayed: true });

    // No duplicate started/completed events were appended on replay.
    const events = await store.loadForRun("run-1");
    expect(events.filter((e) => e.eventType === "node_completed").length).toBe(
      1
    );
    expect(events.filter((e) => e.eventType === "run_started").length).toBe(1);
  });

  it("records node_failed and propagates the error when the executor throws", async () => {
    const store = new InMemoryEventStore();
    const runtime = new EventHistoryRuntime(store);

    await expect(
      runtime.executeNode("run-1", "node-a", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const events = await store.loadForRun("run-1");
    expect(events.map((e) => e.eventType)).toEqual([
      "run_started",
      "node_started",
      "node_failed",
    ]);
    const failed = events.find((e) => e.eventType === "node_failed");
    expect(failed?.payload?.error).toBe("boom");
  });

  it("replays the first node and executes the second on re-entry", async () => {
    const store = new InMemoryEventStore();

    // Original run: both nodes execute live.
    const original = new EventHistoryRuntime(store);
    await original.executeNode("run-1", "node-a", async () => "a-out");
    await original.executeNode("run-1", "node-b", async () => "b-out");

    // Simulate a crash that lost node-b's completion: delete + replay only a.
    const store2 = new InMemoryEventStore();
    const r1 = new EventHistoryRuntime(store2);
    await r1.executeNode("run-2", "node-a", async () => "a-out");

    // New process re-runs the orchestrator: node-a replays, node-b is live.
    const r2 = new EventHistoryRuntime(store2);
    const aExec = vi.fn(async () => "a-again");
    const bExec = vi.fn(async () => "b-out");

    const aResult = await r2.executeNode("run-2", "node-a", aExec);
    const bResult = await r2.executeNode("run-2", "node-b", bExec);

    expect(aExec).not.toHaveBeenCalled();
    expect(aResult).toEqual({ output: "a-out", replayed: true });

    expect(bExec).toHaveBeenCalledTimes(1);
    expect(bResult).toEqual({ output: "b-out", replayed: false });
  });
});

describe("EventCursor", () => {
  it("nextCompletedFor returns null for an unknown nodeId", () => {
    const events: FlowEvent[] = [
      {
        eventId: "e1",
        runId: "r1",
        sequence: 1,
        eventType: "node_completed",
        nodeId: "node-a",
        payload: { output: 1 },
        tenantId: "default",
        createdAt: 1,
      },
    ];
    const cursor = new EventCursor(events);
    expect(cursor.nextCompletedFor("does-not-exist")).toBeNull();
    // The matching node still resolves.
    expect(cursor.nextCompletedFor("node-a")?.nodeId).toBe("node-a");
    expect(cursor.isDrained()).toBe(true);
  });
});

describe("DrizzleEventStore", () => {
  it("append assigns the next per-run sequence and inserts with ON CONFLICT DO NOTHING", async () => {
    // Existing rows for the run end at sequence 2 → next append is 3.
    const existing = [{ sequence: 1 }, { sequence: 2 }];
    const sel = mockSelect(existing);
    const ins = mockInsert();
    const db = {
      select: sel.select,
      insert: ins.insert,
    } as unknown as DrizzleConflictInsertDatabase;
    const store = new DrizzleEventStore({ db });

    const event = await store.append({
      runId: "run-1",
      eventType: "node_completed",
      nodeId: "node-a",
      payload: { output: "x" },
      tenantId: "default",
    });

    expect(event.sequence).toBe(3);
    expect(ins.values).toHaveBeenCalledTimes(1);
    const values = ins.values.mock.calls[0]![0];
    expect(values.sequence).toBe(3);
    expect(values.runId).toBe("run-1");
    expect(values.eventType).toBe("node_completed");
    expect(ins.onConflictDoNothing).toHaveBeenCalledTimes(1);

    // First append on an empty run starts at sequence 1.
    const emptySel = mockSelect([]);
    const emptyIns = mockInsert();
    const emptyDb = {
      select: emptySel.select,
      insert: emptyIns.insert,
    } as unknown as DrizzleConflictInsertDatabase;
    const emptyStore = new DrizzleEventStore({ db: emptyDb });
    const firstEvent = await emptyStore.append({
      runId: "run-2",
      eventType: "run_started",
      tenantId: "default",
    });
    expect(firstEvent.sequence).toBe(1);
  });
});
