/**
 * P2 — startNodeHeartbeat: lease renewal + lease-loss abort.
 *
 * Deterministic via fake timers. Verifies the composite signal aborts on
 * lease loss (heartbeat → false) and on parent-signal cancellation, that a
 * throwing heartbeat is transient (no abort), and that stop() clears the loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startNodeHeartbeat,
  type HeartbeatHandle,
} from "../node-ledger-integration.js";
import type { NodeLedgerLike } from "../../pipeline-runtime-types.js";

function ledgerWith(heartbeat: NodeLedgerLike["heartbeat"]): NodeLedgerLike {
  return {
    acquire: async () => null,
    heartbeat,
    complete: async () => {},
    fail: async () => {},
    getByIdempotencyKey: async () => undefined,
  };
}

describe("startNodeHeartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renews on the interval while the lease holds (signal not aborted)", async () => {
    const heartbeat = vi.fn().mockResolvedValue(true);
    const hb: HeartbeatHandle = startNodeHeartbeat(
      ledgerWith(heartbeat),
      "run1",
      "n1",
      "w1",
      1,
      undefined,
      30_000,
      10_000,
    );
    await vi.advanceTimersByTimeAsync(25_000); // 2 beats
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(hb.signal.aborted).toBe(false);
    expect(hb.lost()).toBe(false);
    hb.stop();
  });

  it("aborts the signal and marks lost when a beat returns false (fenced out)", async () => {
    const heartbeat = vi.fn().mockResolvedValue(false);
    const hb = startNodeHeartbeat(
      ledgerWith(heartbeat),
      "run1",
      "n1",
      "w1",
      1,
      undefined,
      30_000,
      10_000,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hb.signal.aborted).toBe(true);
    expect(hb.lost()).toBe(true);
    hb.stop();
  });

  it("does NOT abort on a transient throwing heartbeat", async () => {
    const heartbeat = vi.fn().mockRejectedValue(new Error("redis blip"));
    const hb = startNodeHeartbeat(
      ledgerWith(heartbeat),
      "run1",
      "n1",
      "w1",
      1,
      undefined,
      30_000,
      10_000,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hb.signal.aborted).toBe(false);
    expect(hb.lost()).toBe(false);
    hb.stop();
  });

  it("propagates parent-signal cancellation into the composite signal", async () => {
    const parent = new AbortController();
    const hb = startNodeHeartbeat(
      ledgerWith(vi.fn().mockResolvedValue(true)),
      "run1",
      "n1",
      "w1",
      1,
      parent.signal,
      30_000,
      10_000,
    );
    expect(hb.signal.aborted).toBe(false);
    parent.abort();
    expect(hb.signal.aborted).toBe(true);
    hb.stop();
  });

  it("stop() halts further heartbeats", async () => {
    const heartbeat = vi.fn().mockResolvedValue(true);
    const hb = startNodeHeartbeat(
      ledgerWith(heartbeat),
      "run1",
      "n1",
      "w1",
      1,
      undefined,
      30_000,
      10_000,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const callsBeforeStop = heartbeat.mock.calls.length;
    hb.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeat.mock.calls.length).toBe(callsBeforeStop);
  });
});
