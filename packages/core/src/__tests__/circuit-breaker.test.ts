import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker } from "../llm/circuit-breaker.js";
import type { CircuitTransitionEvent } from "../llm/circuit-breaker.js";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Transitions emit a structured console.warn; silence it for clean output.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 1000,
      halfOpenMaxAttempts: 1,
      jitterFactor: 0, // deterministic for tests
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("starts in closed state", () => {
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canExecute()).toBe(true);
  });

  it("stays closed when failures < threshold", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canExecute()).toBe(true);
  });

  it("opens after reaching failure threshold", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    expect(breaker.canExecute()).toBe(false);
  });

  it("resets failure count on success", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.getState()).toBe("closed");
    // Now needs 3 more failures to open
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("closed");
  });

  it("transitions to half-open after reset timeout", () => {
    vi.useFakeTimers();
    try {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe("open");

      vi.advanceTimersByTime(1000);
      expect(breaker.getState()).toBe("half-open");
      expect(breaker.canExecute()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes on success in half-open state", () => {
    vi.useFakeTimers();
    try {
      // Trip the breaker
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      // Wait for half-open
      vi.advanceTimersByTime(1000);
      expect(breaker.getState()).toBe("half-open");

      // Success closes it
      breaker.recordSuccess();
      expect(breaker.getState()).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-opens on failure in half-open state", () => {
    vi.useFakeTimers();
    try {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      vi.advanceTimersByTime(1000);
      expect(breaker.getState()).toBe("half-open");

      breaker.recordFailure();
      expect(breaker.getState()).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reset() returns to initial state", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");

    breaker.reset();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canExecute()).toBe(true);
  });

  it("uses default config when none provided", () => {
    const defaultBreaker = new CircuitBreaker();
    // Default threshold is 3
    defaultBreaker.recordFailure();
    defaultBreaker.recordFailure();
    expect(defaultBreaker.getState()).toBe("closed");
    defaultBreaker.recordFailure();
    expect(defaultBreaker.getState()).toBe("open");
  });

  describe("transition events and logging (ERR-M-05)", () => {
    it("invokes onTransition and logs on open / half_open / close", () => {
      vi.useFakeTimers();
      try {
        const events: CircuitTransitionEvent[] = [];
        const b = new CircuitBreaker({
          failureThreshold: 2,
          resetTimeoutMs: 1000,
          halfOpenMaxAttempts: 1,
          jitterFactor: 0,
          onTransition: (e) => events.push(e),
        });

        b.recordFailure();
        b.recordFailure(); // → open
        expect(events.map((e) => e.kind)).toEqual(["circuit:open"]);

        vi.advanceTimersByTime(1000);
        expect(b.getState()).toBe("half-open"); // → half_open
        expect(events.map((e) => e.kind)).toEqual([
          "circuit:open",
          "circuit:half_open",
        ]);

        b.recordSuccess(); // → close
        expect(events.map((e) => e.kind)).toEqual([
          "circuit:open",
          "circuit:half_open",
          "circuit:close",
        ]);

        // Every transition emitted a structured log line.
        expect(warnSpy).toHaveBeenCalledTimes(3);
        const firstLog = JSON.parse(warnSpy.mock.calls[0]?.[0] as string);
        expect(firstLog.component).toBe("circuit-breaker");
        expect(firstLog.event).toBe("circuit:open");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not emit a transition when state is unchanged", () => {
      const events: CircuitTransitionEvent[] = [];
      const b = new CircuitBreaker({
        failureThreshold: 3,
        resetTimeoutMs: 1000,
        jitterFactor: 0,
        onTransition: (e) => events.push(e),
      });
      // Starts closed; recording a single failure keeps it closed → no event.
      b.recordFailure();
      expect(events).toHaveLength(0);
      // recordSuccess while already closed → no spurious close event.
      b.recordSuccess();
      expect(events).toHaveLength(0);
    });
  });

  describe("cooldown jitter (AGENT-L-05)", () => {
    it("jitterFactor 0 yields exactly resetTimeoutMs cooldown", () => {
      vi.useFakeTimers();
      try {
        const b = new CircuitBreaker({
          failureThreshold: 1,
          resetTimeoutMs: 1000,
          jitterFactor: 0,
        });
        b.recordFailure(); // open
        vi.advanceTimersByTime(999);
        expect(b.getState()).toBe("open"); // not yet
        vi.advanceTimersByTime(1);
        expect(b.getState()).toBe("half-open"); // exactly at 1000
      } finally {
        vi.useRealTimers();
      }
    });

    it("jitter only shortens the cooldown, never extends past resetTimeoutMs", () => {
      vi.useFakeTimers();
      // Force Math.random() to its max so reduction is maximal.
      const randSpy = vi.spyOn(Math, "random").mockReturnValue(0.999999);
      try {
        const b = new CircuitBreaker({
          failureThreshold: 1,
          resetTimeoutMs: 1000,
          jitterFactor: 0.5, // up to 50% reduction
        });
        b.recordFailure(); // open — cooldown ≈ 1000 * (1 - 0.5*~1) ≈ 500ms
        // Well before resetTimeoutMs, the shortened cooldown has elapsed.
        vi.advanceTimersByTime(501);
        expect(b.getState()).toBe("half-open");
      } finally {
        randSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it("clamps jitterFactor above 1 and never waits longer than resetTimeoutMs", () => {
      vi.useFakeTimers();
      const randSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        const b = new CircuitBreaker({
          failureThreshold: 1,
          resetTimeoutMs: 1000,
          jitterFactor: 5, // clamped to 1
        });
        b.recordFailure(); // open
        // random=0 → no reduction → cooldown stays at resetTimeoutMs.
        vi.advanceTimersByTime(1000);
        expect(b.getState()).toBe("half-open");
      } finally {
        randSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });
});
