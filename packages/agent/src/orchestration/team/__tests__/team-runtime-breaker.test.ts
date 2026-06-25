import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TeamBreakerTracker } from "../team-runtime-breaker.js";
import type { SupervisionPolicy } from "../supervision-policy.js";

const makePolicy = (
  overrides: Partial<SupervisionPolicy> = {}
): SupervisionPolicy => ({
  maxFailuresBeforeCircuitBreak: 2,
  resetAfterMs: 1000,
  ...overrides,
});

describe("TeamBreakerTracker", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  describe("availability checks", () => {
    it("reports available for a participant that has never been seen", () => {
      const tracker = new TeamBreakerTracker(makePolicy());
      expect(tracker.isAvailable("p-unknown")).toBe(true);
    });

    it("remains available while failures are below threshold", () => {
      const tracker = new TeamBreakerTracker(
        makePolicy({ maxFailuresBeforeCircuitBreak: 3 })
      );
      tracker.record("p1", false);
      tracker.record("p1", false);
      // 2 failures < threshold of 3
      expect(tracker.isAvailable("p1")).toBe(true);
    });

    it("becomes unavailable exactly at the threshold", () => {
      const tracker = new TeamBreakerTracker(
        makePolicy({ maxFailuresBeforeCircuitBreak: 2 })
      );
      tracker.record("p1", false);
      expect(tracker.isAvailable("p1")).toBe(true); // 1 failure, not yet
      tracker.record("p1", false);
      expect(tracker.isAvailable("p1")).toBe(false); // 2 == threshold → open
    });

    it("restores availability after resetAfterMs elapses", () => {
      vi.useFakeTimers();
      const tracker = new TeamBreakerTracker(
        makePolicy({ maxFailuresBeforeCircuitBreak: 1, resetAfterMs: 500 })
      );
      tracker.record("p1", false);
      expect(tracker.isAvailable("p1")).toBe(false);
      vi.advanceTimersByTime(500);
      expect(tracker.isAvailable("p1")).toBe(true); // half-open → passable
    });
  });

  describe("record() return value", () => {
    it("returns 'recorded' for a success", () => {
      const tracker = new TeamBreakerTracker(makePolicy());
      expect(tracker.record("p1", true)).toBe("recorded");
    });

    it("returns 'recorded' for a failure that does not trip the breaker", () => {
      const tracker = new TeamBreakerTracker(
        makePolicy({ maxFailuresBeforeCircuitBreak: 3 })
      );
      expect(tracker.record("p1", false)).toBe("recorded"); // 1/3 failures
      expect(tracker.record("p1", false)).toBe("recorded"); // 2/3 failures
    });

    it("returns 'tripped' on the exact failure that opens the circuit", () => {
      const tracker = new TeamBreakerTracker(
        makePolicy({ maxFailuresBeforeCircuitBreak: 2 })
      );
      expect(tracker.record("p1", false)).toBe("recorded"); // 1st
      expect(tracker.record("p1", false)).toBe("tripped"); // 2nd → trips
    });

    it("returns 'recorded' for subsequent failures while already open (not 'tripped' again)", () => {
      const tracker = new TeamBreakerTracker(
        makePolicy({ maxFailuresBeforeCircuitBreak: 1 })
      );
      expect(tracker.record("p1", false)).toBe("tripped"); // first trip
      // Additional failures while open must not re-fire the callback.
      expect(tracker.record("p1", false)).toBe("recorded");
      expect(tracker.record("p1", false)).toBe("recorded");
    });
  });

  describe("onCircuitOpen callback", () => {
    it("fires exactly once when the circuit first opens", () => {
      const onOpen = vi.fn();
      const tracker = new TeamBreakerTracker(
        makePolicy({ maxFailuresBeforeCircuitBreak: 2 }),
        { onCircuitOpen: onOpen }
      );
      tracker.record("p1", false);
      expect(onOpen).not.toHaveBeenCalled();
      tracker.record("p1", false); // trips
      expect(onOpen).toHaveBeenCalledOnce();
      expect(onOpen).toHaveBeenCalledWith("p1");
    });

    it("does not fire again on subsequent failures while open", () => {
      const onOpen = vi.fn();
      const tracker = new TeamBreakerTracker(
        makePolicy({ maxFailuresBeforeCircuitBreak: 1 }),
        { onCircuitOpen: onOpen }
      );
      tracker.record("p1", false); // trips
      tracker.record("p1", false); // already open → no second fire
      tracker.record("p1", false);
      expect(onOpen).toHaveBeenCalledOnce();
    });

    it("fires again after recover-then-retrp cycle", () => {
      vi.useFakeTimers();
      const onOpen = vi.fn();
      const tracker = new TeamBreakerTracker(
        makePolicy({ maxFailuresBeforeCircuitBreak: 1, resetAfterMs: 200 }),
        { onCircuitOpen: onOpen }
      );
      // First trip.
      tracker.record("p1", false);
      expect(onOpen).toHaveBeenCalledTimes(1);
      // Wait past cooldown, record success → clears trippedOnce set.
      vi.advanceTimersByTime(200);
      tracker.record("p1", true); // success → closed, trippedOnce cleared
      // Second trip should fire callback again.
      tracker.record("p1", false);
      expect(onOpen).toHaveBeenCalledTimes(2);
    });

    it("falls back to policy.onCircuitOpen when no callbacks object is provided", () => {
      const policyCallback = vi.fn();
      const policy = makePolicy({
        maxFailuresBeforeCircuitBreak: 1,
        onCircuitOpen: policyCallback,
      });
      const tracker = new TeamBreakerTracker(policy); // no callbacks arg
      tracker.record("p1", false);
      expect(policyCallback).toHaveBeenCalledOnce();
      expect(policyCallback).toHaveBeenCalledWith("p1");
    });

    it("swallows errors thrown by onCircuitOpen (supervision is best-effort)", () => {
      const tracker = new TeamBreakerTracker(
        makePolicy({ maxFailuresBeforeCircuitBreak: 1 }),
        {
          onCircuitOpen: () => {
            throw new Error("callback boom");
          },
        }
      );
      // Must not propagate.
      expect(() => tracker.record("p1", false)).not.toThrow();
    });
  });

  describe("key isolation", () => {
    it("tripping one participant does not affect another", () => {
      const tracker = new TeamBreakerTracker(
        makePolicy({ maxFailuresBeforeCircuitBreak: 1 })
      );
      tracker.record("pA", false); // trips pA
      expect(tracker.isAvailable("pA")).toBe(false);
      expect(tracker.isAvailable("pB")).toBe(true); // pB untouched
    });

    it("onCircuitOpen receives the correct participant id per key", () => {
      const calls: string[] = [];
      const tracker = new TeamBreakerTracker(
        makePolicy({ maxFailuresBeforeCircuitBreak: 1 }),
        { onCircuitOpen: (id) => calls.push(id) }
      );
      tracker.record("alice", false);
      tracker.record("bob", false);
      expect(calls).toEqual(["alice", "bob"]);
    });
  });

  describe("registry accessor", () => {
    it("exposes the underlying KeyedCircuitBreaker via .registry", () => {
      const tracker = new TeamBreakerTracker(
        makePolicy({ maxFailuresBeforeCircuitBreak: 1 })
      );
      // Use .registry to check state directly.
      tracker.record("p1", false);
      expect(tracker.registry.getState("p1")).toBe("open");
      expect(tracker.registry.isAvailable("p1")).toBe(false);
    });

    it("registry.filterAvailable can be used by callers to bulk-filter participants", () => {
      const tracker = new TeamBreakerTracker(
        makePolicy({ maxFailuresBeforeCircuitBreak: 1 })
      );
      const participants = [{ id: "x" }, { id: "y" }, { id: "z" }];
      tracker.record("y", false); // trip y
      const available = tracker.registry.filterAvailable(participants);
      expect(available.map((p) => p.id)).toEqual(["x", "z"]);
    });
  });
});
