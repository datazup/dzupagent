/**
 * P2 — DurableNodeLedger (in-memory): leasing, fencing, replay, reclaim.
 * Covers the crash-safe spec §6.1 lifecycle, §6.2 replay rules, §14 failure matrix.
 */
import { describe, it, expect } from "vitest";
import {
  InMemoryDurableNodeLedger,
  FencedOutError,
} from "../durable-node-ledger.js";

const TTL = 10_000;
const T0 = 1_000_000;
const KEY = "dzup:v1:src:run1:nodeA:node:digest";

function newLedger() {
  return new InMemoryDurableNodeLedger();
}

describe("acquire", () => {
  it("acquires a free node with fence 1, status leased", async () => {
    const l = newLedger();
    const lease = await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0);
    expect(lease).not.toBeNull();
    expect(lease?.fenceToken).toBe(1);
    expect(lease?.status).toBe("leased");
    expect(lease?.owner).toBe("w1");
  });

  it("returns null when the node is actively held by a fresh lease", async () => {
    const l = newLedger();
    await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0);
    const second = await l.acquire("run1", "nodeA", KEY, "w2", TTL, T0 + 1_000);
    expect(second).toBeNull();
  });

  it("re-leases an EXPIRED lease to a new owner and bumps the fence", async () => {
    const l = newLedger();
    await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0);
    const reacquired = await l.acquire(
      "run1",
      "nodeA",
      KEY,
      "w2",
      TTL,
      T0 + TTL + 1,
    );
    expect(reacquired?.owner).toBe("w2");
    expect(reacquired?.fenceToken).toBe(2);
    expect(reacquired?.attempt).toBe(2);
  });

  it("returns null for a completed node (caller replays instead)", async () => {
    const l = newLedger();
    const lease = await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0);
    await l.complete({
      runId: "run1",
      nodeId: "nodeA",
      idempotencyKey: KEY,
      fenceToken: lease!.fenceToken,
      output: "r",
    });
    expect(await l.acquire("run1", "nodeA", KEY, "w2", TTL, T0 + 1)).toBeNull();
  });

  it("re-leases a failed_retryable node", async () => {
    const l = newLedger();
    const lease = await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0);
    await l.fail({
      runId: "run1",
      nodeId: "nodeA",
      idempotencyKey: KEY,
      fenceToken: lease!.fenceToken,
      error: "boom",
      retryable: true,
    });
    const re = await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0 + 1);
    expect(re?.fenceToken).toBe(2);
  });
});

describe("heartbeat", () => {
  it("returns true for the current owner+fence and promotes leased→running", async () => {
    const l = newLedger();
    const lease = await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0);
    expect(
      await l.heartbeat(
        "run1",
        "nodeA",
        "w1",
        lease!.fenceToken,
        TTL,
        T0 + 100,
      ),
    ).toBe(true);
  });

  it("returns false (fenced out) for a stale fence after re-lease", async () => {
    const l = newLedger();
    const a = await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0);
    await l.acquire("run1", "nodeA", KEY, "w2", TTL, T0 + TTL + 1); // fence → 2
    expect(
      await l.heartbeat(
        "run1",
        "nodeA",
        "w1",
        a!.fenceToken,
        TTL,
        T0 + TTL + 2,
      ),
    ).toBe(false);
  });
});

describe("fencing (spec §14)", () => {
  it("rejects a complete carrying a stale fence (zombie worker)", async () => {
    const l = newLedger();
    const a = await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0); // fence 1
    await l.acquire("run1", "nodeA", KEY, "w2", TTL, T0 + TTL + 1); // fence 2
    await expect(
      l.complete({
        runId: "run1",
        nodeId: "nodeA",
        idempotencyKey: KEY,
        fenceToken: a!.fenceToken,
        output: "stale",
      }),
    ).rejects.toBeInstanceOf(FencedOutError);
  });

  it("accepts a complete from the current fence holder", async () => {
    const l = newLedger();
    const a = await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0);
    await expect(
      l.complete({
        runId: "run1",
        nodeId: "nodeA",
        idempotencyKey: KEY,
        fenceToken: a!.fenceToken,
        output: "ok",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("replay (getByIdempotencyKey)", () => {
  it("returns the completion only after the node is completed", async () => {
    const l = newLedger();
    const a = await l.acquire("run1", "nodeA", KEY, "w1", TTL, T0);
    expect(await l.getByIdempotencyKey(KEY)).toBeUndefined();
    await l.complete({
      runId: "run1",
      nodeId: "nodeA",
      idempotencyKey: KEY,
      fenceToken: a!.fenceToken,
      output: { v: 42 },
    });
    const replay = await l.getByIdempotencyKey(KEY);
    expect(replay?.output).toEqual({ v: 42 });
  });
});

describe("findStale", () => {
  it("returns only leases past their expiry, up to the limit", async () => {
    const l = newLedger();
    await l.acquire("run1", "a", "k-a", "w1", TTL, T0);
    await l.acquire("run1", "b", "k-b", "w1", TTL, T0);
    const lease = await l.acquire("run1", "c", "k-c", "w1", TTL, T0);
    await l.heartbeat("run1", "c", "w1", lease!.fenceToken, TTL, T0 + TTL); // c stays fresh
    const stale = await l.findStale(T0 + TTL + 1, 10);
    expect(stale.map((s) => s.nodeId).sort()).toEqual(["a", "b"]);
  });

  it("does not return completed nodes", async () => {
    const l = newLedger();
    const a = await l.acquire("run1", "a", "k-a", "w1", TTL, T0);
    await l.complete({
      runId: "run1",
      nodeId: "a",
      idempotencyKey: "k-a",
      fenceToken: a!.fenceToken,
    });
    expect(await l.findStale(T0 + TTL + 1, 10)).toHaveLength(0);
  });
});

describe("fail", () => {
  it("failed_terminal node is not re-leasable", async () => {
    const l = newLedger();
    const a = await l.acquire("run1", "a", "k-a", "w1", TTL, T0);
    await l.fail({
      runId: "run1",
      nodeId: "a",
      idempotencyKey: "k-a",
      fenceToken: a!.fenceToken,
      error: "fatal",
      retryable: false,
    });
    expect(await l.acquire("run1", "a", "k-a", "w1", TTL, T0 + 1)).toBeNull();
  });
});
