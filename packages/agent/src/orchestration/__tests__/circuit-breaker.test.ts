import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentCircuitBreaker } from "../circuit-breaker.js";

describe("AgentCircuitBreaker", () => {
  let breaker: AgentCircuitBreaker;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    breaker = new AgentCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 1000,
      jitterFactor: 0,
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("starts available for unknown agents", () => {
    expect(breaker.isAvailable("agent-a")).toBe(true);
    expect(breaker.getState("agent-a")).toBe("closed");
  });

  it("trips after consecutive timeouts reaching threshold", () => {
    breaker.recordTimeout("agent-a");
    expect(breaker.isAvailable("agent-a")).toBe(true);

    breaker.recordTimeout("agent-a");
    expect(breaker.isAvailable("agent-a")).toBe(true);

    breaker.recordTimeout("agent-a");
    // Now at threshold (3), circuit should be open
    expect(breaker.isAvailable("agent-a")).toBe(false);
    expect(breaker.getState("agent-a")).toBe("open");
  });

  it("recordSuccess after open resets to closed", () => {
    // Trip the circuit
    breaker.recordTimeout("agent-a");
    breaker.recordTimeout("agent-a");
    breaker.recordTimeout("agent-a");
    expect(breaker.isAvailable("agent-a")).toBe(false);

    // Record success resets
    breaker.recordSuccess("agent-a");
    expect(breaker.isAvailable("agent-a")).toBe(true);
    expect(breaker.getState("agent-a")).toBe("closed");
  });

  it("filterAvailable removes tripped agents", () => {
    const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];

    // Trip agent 'b'
    breaker.recordTimeout("b");
    breaker.recordTimeout("b");
    breaker.recordTimeout("b");

    const available = breaker.filterAvailable(agents);
    expect(available.map((a) => a.id)).toEqual(["a", "c"]);
  });

  it("transitions to half-open after cooldown period", () => {
    // Trip the breaker
    breaker.recordTimeout("agent-a");
    breaker.recordTimeout("agent-a");
    breaker.recordTimeout("agent-a");
    expect(breaker.isAvailable("agent-a")).toBe(false);

    // Fast-forward past cooldown
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(1001);
      // Should transition to half-open and allow through
      expect(breaker.isAvailable("agent-a")).toBe(true);
      expect(breaker.getState("agent-a")).toBe("half-open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reset() clears all state", () => {
    breaker.recordTimeout("agent-a");
    breaker.recordTimeout("agent-a");
    breaker.recordTimeout("agent-a");
    expect(breaker.isAvailable("agent-a")).toBe(false);

    breaker.reset();
    expect(breaker.isAvailable("agent-a")).toBe(true);
    expect(breaker.getState("agent-a")).toBe("closed");
  });

  it("does not trip if successes intervene", () => {
    breaker.recordTimeout("agent-a");
    breaker.recordTimeout("agent-a");
    breaker.recordSuccess("agent-a"); // resets consecutive count
    breaker.recordTimeout("agent-a");
    breaker.recordTimeout("agent-a");
    // Only 2 consecutive timeouts, not 3
    expect(breaker.isAvailable("agent-a")).toBe(true);
    expect(breaker.getState("agent-a")).toBe("closed");
  });

  describe("state-machine edge cases", () => {
    it("getState returns closed for a key that has never been seen", () => {
      // No breaker created yet — should default to closed without creating state.
      expect(breaker.getState("never-seen")).toBe("closed");
      // isAvailable should also be true (no entry → not tripped).
      expect(breaker.isAvailable("never-seen")).toBe(true);
    });

    it("trips at exactly failureThreshold, not threshold-1", () => {
      const b = new AgentCircuitBreaker({
        failureThreshold: 2,
        cooldownMs: 5000,
        jitterFactor: 0,
      });
      b.recordFailure("x");
      // One failure: still closed.
      expect(b.getState("x")).toBe("closed");
      expect(b.isAvailable("x")).toBe(true);
      b.recordFailure("x");
      // Second failure hits threshold=2: open.
      expect(b.getState("x")).toBe("open");
      expect(b.isAvailable("x")).toBe(false);
    });

    it("filterAvailable returns all items when no breaker is tripped", () => {
      const agents = [{ id: "p" }, { id: "q" }, { id: "r" }];
      // No failures recorded — all should pass through.
      expect(breaker.filterAvailable(agents).map((a) => a.id)).toEqual([
        "p",
        "q",
        "r",
      ]);
    });

    it("filterAvailable with multiple tripped agents returns only open ones", () => {
      const agents = [
        { id: "alpha" },
        { id: "beta" },
        { id: "gamma" },
        { id: "delta" },
      ];
      // Trip beta and delta.
      for (let i = 0; i < 3; i++) {
        breaker.recordTimeout("beta");
        breaker.recordTimeout("delta");
      }
      const available = breaker.filterAvailable(agents);
      expect(available.map((a) => a.id)).toEqual(["alpha", "gamma"]);
    });

    it("recordSuccess in half-open closes circuit and re-enables agent", () => {
      vi.useFakeTimers();
      try {
        const b = new AgentCircuitBreaker({
          failureThreshold: 2,
          cooldownMs: 500,
          jitterFactor: 0,
        });
        // Trip.
        b.recordTimeout("probe");
        b.recordTimeout("probe");
        expect(b.isAvailable("probe")).toBe(false);
        // Wait past cooldown → half-open.
        vi.advanceTimersByTime(500);
        expect(b.getState("probe")).toBe("half-open");
        expect(b.isAvailable("probe")).toBe(true);
        // Successful probe closes.
        b.recordSuccess("probe");
        expect(b.getState("probe")).toBe("closed");
        expect(b.isAvailable("probe")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cooldownMs alias works identically to resetTimeoutMs through the KeyedCircuitBreaker facade", () => {
      vi.useFakeTimers();
      try {
        // cooldownMs is the orchestration alias; verify it controls the open→half-open window.
        const b = new AgentCircuitBreaker({
          failureThreshold: 1,
          cooldownMs: 800,
          jitterFactor: 0,
        });
        b.recordTimeout("k");
        expect(b.getState("k")).toBe("open");
        vi.advanceTimersByTime(799);
        expect(b.getState("k")).toBe("open"); // cooldown not yet elapsed
        vi.advanceTimersByTime(1);
        expect(b.getState("k")).toBe("half-open"); // exactly 800ms
      } finally {
        vi.useRealTimers();
      }
    });

    it("isolated keys do not affect each other", () => {
      // Tripping agent-x must leave agent-y untouched.
      for (let i = 0; i < 3; i++) breaker.recordTimeout("agent-x");
      expect(breaker.getState("agent-x")).toBe("open");
      expect(breaker.getState("agent-y")).toBe("closed");
      expect(breaker.isAvailable("agent-y")).toBe(true);
    });

    it("recordFailure and recordTimeout are identical (both delegate to recordFailure)", () => {
      const b = new AgentCircuitBreaker({
        failureThreshold: 2,
        cooldownMs: 1000,
        jitterFactor: 0,
      });
      // Mix the two aliases — should trip at threshold=2.
      b.recordFailure("mix");
      expect(b.getState("mix")).toBe("closed");
      b.recordTimeout("mix");
      expect(b.getState("mix")).toBe("open");
    });
  });
});
