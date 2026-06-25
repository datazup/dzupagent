/**
 * StuckDetector deep coverage — W29-A
 *
 * Covers all five detection modes:
 *   1. Repeated identical tool calls (repeated-call detection)
 *   2. High error rate in rolling time window (error-rate detection)
 *   3. Idle iterations with no tool calls
 *   4. Progress-hash (non-overlapping identical block sequences)
 *   5. Semantic plateau (fixation on one tool with varied args)
 *
 * Also covers: configuration, reset(), notifyResumed(), ring-buffer
 * bounds, reason strings, combined triggers, and edge cases.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { StuckDetector } from "../guardrails/stuck-detector.js";

// ============================================================================
// 1. Repeated-call detection
// ============================================================================

describe("StuckDetector — repeated-call detection", () => {
  it("default threshold=3: first two identical calls are not stuck", () => {
    const det = new StuckDetector();
    expect(det.recordToolCall("tool", { x: 1 }).stuck).toBe(false);
    expect(det.recordToolCall("tool", { x: 1 }).stuck).toBe(false);
  });

  it("default threshold=3: third identical call triggers stuck", () => {
    const det = new StuckDetector();
    det.recordToolCall("tool", { x: 1 });
    det.recordToolCall("tool", { x: 1 });
    const result = det.recordToolCall("tool", { x: 1 });
    expect(result.stuck).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it("threshold=2: second identical call triggers stuck", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    expect(det.recordToolCall("tool", {}).stuck).toBe(false);
    const result = det.recordToolCall("tool", {});
    expect(result.stuck).toBe(true);
  });

  it("threshold=5: four identical calls are not stuck", () => {
    const det = new StuckDetector({ maxRepeatCalls: 5 });
    for (let i = 0; i < 4; i++) {
      expect(det.recordToolCall("tool", { v: "same" }).stuck).toBe(false);
    }
  });

  it("threshold=5: fifth identical call triggers stuck", () => {
    const det = new StuckDetector({ maxRepeatCalls: 5 });
    for (let i = 0; i < 4; i++) {
      det.recordToolCall("tool", { v: "same" });
    }
    expect(det.recordToolCall("tool", { v: "same" }).stuck).toBe(true);
  });

  it("different tools interleaved: counter does NOT carry across tools", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    // a, b, a — the ring buffer is checked for ALL being identical (same name+hash)
    det.recordToolCall("tool_a", { x: 1 });
    det.recordToolCall("tool_b", { x: 1 });
    expect(det.recordToolCall("tool_a", { x: 1 }).stuck).toBe(false);
  });

  it("same tool name but different inputs: not stuck", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    expect(det.recordToolCall("read", { path: "a.ts" }).stuck).toBe(false);
    expect(det.recordToolCall("read", { path: "b.ts" }).stuck).toBe(false);
    expect(det.recordToolCall("read", { path: "c.ts" }).stuck).toBe(false);
  });

  it("different tool name with same hash: not stuck (name is checked)", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    expect(det.recordToolCall("tool_a", { x: 1 }).stuck).toBe(false);
    expect(det.recordToolCall("tool_b", { x: 1 }).stuck).toBe(false);
  });

  it("reason string includes the tool name", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    det.recordToolCall("my_tool", { q: "same" });
    const result = det.recordToolCall("my_tool", { q: "same" });
    expect(result.stuck).toBe(true);
    expect(result.reason).toContain("my_tool");
  });

  it("reason string includes the call count", () => {
    const det = new StuckDetector({ maxRepeatCalls: 3 });
    det.recordToolCall("t", {});
    det.recordToolCall("t", {});
    const result = det.recordToolCall("t", {});
    expect(result.reason).toContain("3");
  });

  it("stuck result has stuck=true", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    det.recordToolCall("t", { v: 1 });
    const result = det.recordToolCall("t", { v: 1 });
    expect(result.stuck).toBe(true);
  });

  it("not stuck result has stuck=false", () => {
    const det = new StuckDetector({ maxRepeatCalls: 3 });
    const result = det.recordToolCall("t", { v: 1 });
    expect(result.stuck).toBe(false);
  });

  it("zero calls: not stuck", () => {
    const det = new StuckDetector();
    // No calls made → the detector must never be stuck
    const status = det.recordIteration(0);
    // With maxIdleIterations=3 default, one idle = not stuck
    expect(status.stuck).toBe(false);
  });

  it("ring buffer caps at maxRepeatCalls", () => {
    // Drive 100 varied calls — ring buffer must not grow unbounded
    const det = new StuckDetector({ maxRepeatCalls: 3 });
    for (let i = 0; i < 100; i++) {
      det.recordToolCall("tool", { i });
    }
    const internal = det as unknown as { recentCalls: unknown[] };
    expect(internal.recentCalls.length).toBeLessThanOrEqual(3);
  });

  it("input as string: detected after threshold calls", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    det.recordToolCall("grep", "pattern");
    expect(det.recordToolCall("grep", "pattern").stuck).toBe(true);
  });

  it("input as null: detected after threshold calls", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    det.recordToolCall("list", null);
    expect(det.recordToolCall("list", null).stuck).toBe(true);
  });

  it("input as empty string: detected after threshold calls", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    det.recordToolCall("ping", "");
    expect(det.recordToolCall("ping", "").stuck).toBe(true);
  });

  it("deeply nested identical objects: triggers stuck", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    const input = { a: { b: { c: [1, 2, { d: true }] } } };
    det.recordToolCall("deep", input);
    expect(det.recordToolCall("deep", input).stuck).toBe(true);
  });

  it("inserting a different call between repeats prevents stuck at N-1", () => {
    const det = new StuckDetector({ maxRepeatCalls: 3 });
    det.recordToolCall("t", { x: 1 });
    det.recordToolCall("t", { x: 1 });
    // Different call resets the matching window
    det.recordToolCall("other", { x: 1 });
    // Two identical calls again — still not at threshold
    det.recordToolCall("t", { x: 1 });
    expect(det.recordToolCall("t", { x: 1 }).stuck).toBe(false);
  });
});

// ============================================================================
// 2. Error-rate detection
// ============================================================================

describe("StuckDetector — error-rate detection", () => {
  it("single error does not trigger stuck", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 5,
      errorWindowMs: 60_000,
    });
    expect(det.recordError(new Error("oops")).stuck).toBe(false);
  });

  it("errors below threshold: not stuck", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 3,
      errorWindowMs: 60_000,
    });
    det.recordError(new Error("e1"));
    expect(det.recordError(new Error("e2")).stuck).toBe(false);
  });

  it("errors at exact threshold: stuck", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 3,
      errorWindowMs: 60_000,
    });
    det.recordError(new Error("e1"));
    det.recordError(new Error("e2"));
    const result = det.recordError(new Error("e3"));
    expect(result.stuck).toBe(true);
  });

  it("errors above threshold: still stuck", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 2,
      errorWindowMs: 60_000,
    });
    det.recordError(new Error("e1"));
    det.recordError(new Error("e2"));
    expect(det.recordError(new Error("e3")).stuck).toBe(true);
  });

  it("threshold=1: first error triggers stuck", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 1,
      errorWindowMs: 60_000,
    });
    expect(det.recordError(new Error("boom")).stuck).toBe(true);
  });

  it("accepts string errors (not only Error objects)", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 2,
      errorWindowMs: 60_000,
    });
    det.recordError("string error 1");
    expect(det.recordError("string error 2").stuck).toBe(true);
  });

  it("reason includes error count", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 3,
      errorWindowMs: 5_000,
    });
    det.recordError(new Error("e1"));
    det.recordError(new Error("e2"));
    const result = det.recordError(new Error("e3"));
    expect(result.reason).toContain("3");
  });

  it("reason includes window duration", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 2,
      errorWindowMs: 30_000,
    });
    det.recordError(new Error("a"));
    const result = det.recordError(new Error("b"));
    expect(result.reason).toContain("30");
  });

  it("rolling window: old errors expire and do not count", () => {
    vi.useFakeTimers();
    try {
      const det = new StuckDetector({
        maxErrorsInWindow: 3,
        errorWindowMs: 1_000,
      });
      // Record 2 errors at t=0
      det.recordError(new Error("old1"));
      det.recordError(new Error("old2"));
      // Advance past the window
      vi.advanceTimersByTime(1_001);
      // New error: old ones expired → window has only 1 error
      expect(det.recordError(new Error("new")).stuck).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolling window: errors within window are counted", () => {
    vi.useFakeTimers();
    try {
      const det = new StuckDetector({
        maxErrorsInWindow: 3,
        errorWindowMs: 5_000,
      });
      det.recordError(new Error("e1"));
      vi.advanceTimersByTime(1_000);
      det.recordError(new Error("e2"));
      vi.advanceTimersByTime(1_000);
      // e1 is still within 5s window
      expect(det.recordError(new Error("e3")).stuck).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolling window evicts oldest when new error arrives after window", () => {
    vi.useFakeTimers();
    try {
      const det = new StuckDetector({
        maxErrorsInWindow: 2,
        errorWindowMs: 500,
      });
      det.recordError(new Error("e1"));
      vi.advanceTimersByTime(600); // e1 now outside window
      // Only 1 error in the window, not at threshold
      expect(det.recordError(new Error("e2")).stuck).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("very large window: errors accumulate until threshold", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 5,
      errorWindowMs: 3_600_000,
    });
    for (let i = 0; i < 4; i++) {
      expect(det.recordError(new Error(`e${i}`)).stuck).toBe(false);
    }
    expect(det.recordError(new Error("e4")).stuck).toBe(true);
  });

  it("error buffer does not grow unbounded (prune on each push)", () => {
    vi.useFakeTimers();
    try {
      const det = new StuckDetector({
        maxErrorsInWindow: 1000,
        errorWindowMs: 500,
      });
      // Add 200 errors then advance past window
      for (let i = 0; i < 200; i++) det.recordError(new Error(`e${i}`));
      vi.advanceTimersByTime(600);
      det.recordError(new Error("after"));
      const internal = det as unknown as { recentErrors: unknown[] };
      expect(internal.recentErrors.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================================
// 3. Idle-iteration detection
// ============================================================================

describe("StuckDetector — idle-iteration detection", () => {
  it("default threshold=3: first two idle iterations not stuck", () => {
    const det = new StuckDetector();
    expect(det.recordIteration(0).stuck).toBe(false);
    expect(det.recordIteration(0).stuck).toBe(false);
  });

  it("default threshold=3: third idle iteration triggers stuck", () => {
    const det = new StuckDetector();
    det.recordIteration(0);
    det.recordIteration(0);
    const result = det.recordIteration(0);
    expect(result.stuck).toBe(true);
  });

  it("custom threshold=2: second idle iteration triggers stuck", () => {
    const det = new StuckDetector({ maxIdleIterations: 2 });
    det.recordIteration(0);
    expect(det.recordIteration(0).stuck).toBe(true);
  });

  it("custom threshold=1: first idle iteration triggers stuck", () => {
    const det = new StuckDetector({ maxIdleIterations: 1 });
    expect(det.recordIteration(0).stuck).toBe(true);
  });

  it("non-zero tool calls resets the idle counter", () => {
    const det = new StuckDetector({ maxIdleIterations: 2 });
    det.recordIteration(0);
    det.recordIteration(5); // resets
    expect(det.recordIteration(0).stuck).toBe(false);
    expect(det.recordIteration(0).stuck).toBe(true);
  });

  it('reason includes idle count and "no tool calls" phrase', () => {
    const det = new StuckDetector({ maxIdleIterations: 2 });
    det.recordIteration(0);
    const result = det.recordIteration(0);
    expect(result.reason).toContain("no tool calls");
    expect(result.reason).toContain("2");
  });

  it("lastToolCalls reflects the most recent iteration count", () => {
    const det = new StuckDetector();
    expect(det.lastToolCalls).toBe(0);
    det.recordIteration(7);
    expect(det.lastToolCalls).toBe(7);
    det.recordIteration(0);
    expect(det.lastToolCalls).toBe(0);
  });

  it("recordToolCall resets idle count to zero", () => {
    const det = new StuckDetector({ maxIdleIterations: 2 });
    det.recordIteration(0); // idle count = 1
    det.recordToolCall("tool", {}); // resets idle
    expect(det.recordIteration(0).stuck).toBe(false); // only 1 idle again
    expect(det.recordIteration(0).stuck).toBe(true); // 2nd idle
  });

  it("iteration with toolCallsThisIteration=1 is not idle", () => {
    const det = new StuckDetector({ maxIdleIterations: 1 });
    expect(det.recordIteration(1).stuck).toBe(false);
  });

  it("large toolCallsThisIteration resets idle counter", () => {
    const det = new StuckDetector({ maxIdleIterations: 2 });
    det.recordIteration(0);
    det.recordIteration(100); // reset
    expect(det.recordIteration(0).stuck).toBe(false);
  });
});

// ============================================================================
// 4. Progress-hash detection (non-overlapping identical block sequences)
// ============================================================================

describe("StuckDetector — progress-hash detection", () => {
  /** Emit one complete 5-tool window: a, b, c, d, e */
  function oneWindow(det: StuckDetector): void {
    det.recordToolCall("tool_a", {});
    det.recordToolCall("tool_b", {});
    det.recordToolCall("tool_c", {});
    det.recordToolCall("tool_d", {});
    det.recordToolCall("tool_e", {});
  }

  it("one window of 5 calls: not stuck", () => {
    const det = new StuckDetector();
    oneWindow(det);
    // No second window yet — not enough hash history
    const result = det.recordToolCall("tool_a", {});
    expect(result.stuck).toBe(false);
  });

  it("two identical windows: not stuck yet", () => {
    const det = new StuckDetector();
    oneWindow(det);
    // Second window — first 4 calls are not stuck
    det.recordToolCall("tool_a", {});
    det.recordToolCall("tool_b", {});
    det.recordToolCall("tool_c", {});
    det.recordToolCall("tool_d", {});
    expect(det.recordToolCall("tool_e", {}).stuck).toBe(false);
  });

  it("three identical windows of 5 tools triggers stuck", () => {
    const det = new StuckDetector();
    oneWindow(det);
    oneWindow(det);
    det.recordToolCall("tool_a", {});
    det.recordToolCall("tool_b", {});
    det.recordToolCall("tool_c", {});
    det.recordToolCall("tool_d", {});
    const result = det.recordToolCall("tool_e", {});
    expect(result.stuck).toBe(true);
    expect(result.reason).toContain("tool_a");
  });

  it('reason for hash stuck mentions "repeated"', () => {
    const det = new StuckDetector();
    oneWindow(det);
    oneWindow(det);
    det.recordToolCall("tool_a", {});
    det.recordToolCall("tool_b", {});
    det.recordToolCall("tool_c", {});
    det.recordToolCall("tool_d", {});
    const result = det.recordToolCall("tool_e", {});
    expect(result.reason?.toLowerCase()).toContain("repeated");
  });

  it("changing one tool in the third window prevents hash stuck", () => {
    const det = new StuckDetector();
    oneWindow(det);
    oneWindow(det);
    det.recordToolCall("tool_a", {});
    det.recordToolCall("tool_b", {});
    det.recordToolCall("tool_X", {}); // different
    det.recordToolCall("tool_d", {});
    expect(det.recordToolCall("tool_e", {}).stuck).toBe(false);
  });

  it("completely different third sequence does not trigger hash stuck", () => {
    const det = new StuckDetector();
    oneWindow(det);
    oneWindow(det);
    det.recordToolCall("x", {});
    det.recordToolCall("y", {});
    det.recordToolCall("z", {});
    det.recordToolCall("w", {});
    expect(det.recordToolCall("v", {}).stuck).toBe(false);
  });

  it("partial third window (4/5 calls) does not trigger hash stuck", () => {
    const det = new StuckDetector();
    oneWindow(det);
    oneWindow(det);
    det.recordToolCall("tool_a", {});
    det.recordToolCall("tool_b", {});
    det.recordToolCall("tool_c", {});
    // Only 3 calls in the partial window — block not complete yet
    expect(det.recordToolCall("tool_d", {}).stuck).toBe(false);
  });
});

// ============================================================================
// 5. Semantic plateau detection
// ============================================================================

describe("StuckDetector — semantic plateau detection", () => {
  it("semanticPlateauWindow=0 (default): no plateau detection", () => {
    const det = new StuckDetector({ semanticPlateauWindow: 0 });
    // Even 10 calls to the same tool with different args should not trigger
    for (let i = 0; i < 10; i++) {
      const result = det.recordToolCall("search", { q: `q${i}` });
      // May or may not trigger from other detectors, but plateau itself is off
      // We use a high repeat threshold to isolate plateau
    }
    // Not testing stuck here — we just ensure it doesn't throw and respects 0
    const det2 = new StuckDetector({
      semanticPlateauWindow: 0,
      maxRepeatCalls: 100,
    });
    for (let i = 0; i < 10; i++) {
      expect(det2.recordToolCall("search", { q: `unique${i}` }).stuck).toBe(
        false
      );
    }
  });

  it("semanticPlateauWindow=3: three consecutive same-tool calls trigger stuck", () => {
    const det = new StuckDetector({
      semanticPlateauWindow: 3,
      maxRepeatCalls: 100,
    });
    det.recordToolCall("search", { q: "a" });
    det.recordToolCall("search", { q: "b" });
    const result = det.recordToolCall("search", { q: "c" });
    expect(result.stuck).toBe(true);
  });

  it("semanticPlateauWindow=3: two calls to same tool not yet stuck", () => {
    const det = new StuckDetector({
      semanticPlateauWindow: 3,
      maxRepeatCalls: 100,
    });
    det.recordToolCall("search", { q: "a" });
    expect(det.recordToolCall("search", { q: "b" }).stuck).toBe(false);
  });

  it("semanticPlateauWindow=3: interleaving another tool resets plateau", () => {
    const det = new StuckDetector({
      semanticPlateauWindow: 3,
      maxRepeatCalls: 100,
    });
    det.recordToolCall("search", { q: "a" });
    det.recordToolCall("search", { q: "b" });
    det.recordToolCall("read", { path: "x.ts" }); // different tool
    // Window slides: [search, search, read] — not all same tool
    expect(det.recordToolCall("search", { q: "c" }).stuck).toBe(false);
  });

  it("plateau reason includes the tool name", () => {
    const det = new StuckDetector({
      semanticPlateauWindow: 3,
      maxRepeatCalls: 100,
    });
    det.recordToolCall("embed", { text: "a" });
    det.recordToolCall("embed", { text: "b" });
    const result = det.recordToolCall("embed", { text: "c" });
    expect(result.reason).toContain("embed");
  });

  it("plateau reason mentions consecutive count or plateau", () => {
    const det = new StuckDetector({
      semanticPlateauWindow: 4,
      maxRepeatCalls: 100,
    });
    det.recordToolCall("llm", { p: "a" });
    det.recordToolCall("llm", { p: "b" });
    det.recordToolCall("llm", { p: "c" });
    const result = det.recordToolCall("llm", { p: "d" });
    expect(result.reason?.toLowerCase()).toMatch(/plateau|consecutive|4/);
  });

  it("semanticPlateauWindow=5: exactly 5 same-tool calls with varied args triggers stuck", () => {
    const det = new StuckDetector({
      semanticPlateauWindow: 5,
      maxRepeatCalls: 100,
    });
    for (let i = 0; i < 4; i++) {
      expect(det.recordToolCall("vectorSearch", { query: `q${i}` }).stuck).toBe(
        false
      );
    }
    expect(det.recordToolCall("vectorSearch", { query: "q4" }).stuck).toBe(
      true
    );
  });

  it("plateau window is sliding (FIFO): old entries drop off", () => {
    const det = new StuckDetector({
      semanticPlateauWindow: 3,
      maxRepeatCalls: 100,
    });
    det.recordToolCall("search", { q: "a" });
    det.recordToolCall("search", { q: "b" });
    det.recordToolCall("fetch", { url: "x" }); // breaks pattern
    det.recordToolCall("search", { q: "c" });
    // Window is now [fetch, search, search] — not all same
    expect(det.recordToolCall("search", { q: "d" }).stuck).toBe(false);
    // Next: window = [search, search, search] — now stuck!
    expect(det.recordToolCall("search", { q: "e" }).stuck).toBe(true);
  });
});

// ============================================================================
// 6. reset() behaviour
// ============================================================================

describe("StuckDetector — reset()", () => {
  it("clears repeated-call history", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    det.recordToolCall("t", { x: 1 });
    det.reset();
    expect(det.recordToolCall("t", { x: 1 }).stuck).toBe(false);
    expect(det.recordToolCall("t", { x: 1 }).stuck).toBe(true);
  });

  it("clears error history", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 2,
      errorWindowMs: 60_000,
    });
    det.recordError(new Error("e1"));
    det.reset();
    expect(det.recordError(new Error("e2")).stuck).toBe(false);
    expect(det.recordError(new Error("e3")).stuck).toBe(true);
  });

  it("clears idle counter", () => {
    const det = new StuckDetector({ maxIdleIterations: 2 });
    det.recordIteration(0);
    det.reset();
    expect(det.recordIteration(0).stuck).toBe(false);
  });

  it("clears lastToolCalls", () => {
    const det = new StuckDetector();
    det.recordIteration(9);
    expect(det.lastToolCalls).toBe(9);
    det.reset();
    expect(det.lastToolCalls).toBe(0);
  });

  it("clears progress-hash history", () => {
    const det = new StuckDetector();
    // Build two complete windows
    for (let win = 0; win < 2; win++) {
      for (const t of ["a", "b", "c", "d", "e"]) {
        det.recordToolCall(t, {});
      }
    }
    det.reset();
    // After reset, even 2 more windows should not trigger (only 2, need 3)
    for (let win = 0; win < 2; win++) {
      for (const t of ["a", "b", "c", "d", "e"]) {
        expect(det.recordToolCall(t, {}).stuck).toBe(false);
      }
    }
  });

  it("clears semantic plateau window", () => {
    const det = new StuckDetector({
      semanticPlateauWindow: 3,
      maxRepeatCalls: 100,
    });
    det.recordToolCall("s", { a: 1 });
    det.recordToolCall("s", { a: 2 });
    det.reset();
    det.recordToolCall("s", { a: 3 });
    expect(det.recordToolCall("s", { a: 4 }).stuck).toBe(false);
  });

  it("allows fresh run after reset: repeat detection works normally", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    det.recordToolCall("t", { v: 1 });
    det.recordToolCall("t", { v: 1 }); // triggers stuck
    det.reset();
    // Completely fresh state
    expect(det.recordToolCall("t", { v: 1 }).stuck).toBe(false);
    expect(det.recordToolCall("t", { v: 1 }).stuck).toBe(true);
  });

  it("multiple resets are idempotent", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2, maxIdleIterations: 2 });
    det.recordToolCall("t", { v: 1 });
    det.recordIteration(0);
    det.reset();
    det.reset();
    det.reset();
    expect(det.lastToolCalls).toBe(0);
    expect(det.recordIteration(0).stuck).toBe(false);
  });
});

// ============================================================================
// 7. notifyResumed() (pause/resume)
// ============================================================================

describe("StuckDetector — notifyResumed()", () => {
  it("clears idle counter so resumed agent is not falsely stuck", () => {
    const det = new StuckDetector({ maxIdleIterations: 2 });
    det.recordIteration(0); // idle count = 1
    det.notifyResumed(); // idle count = 0
    expect(det.recordIteration(0).stuck).toBe(false); // fresh idle count = 1
    expect(det.recordIteration(0).stuck).toBe(true); // idle count = 2
  });

  it("preserves repeated-call history across resume", () => {
    const det = new StuckDetector({ maxRepeatCalls: 3 });
    det.recordToolCall("tool", { x: 1 });
    det.recordToolCall("tool", { x: 1 });
    det.notifyResumed(); // must NOT clear repeat history
    expect(det.recordToolCall("tool", { x: 1 }).stuck).toBe(true);
  });

  it("preserves error history across resume", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 3,
      errorWindowMs: 60_000,
    });
    det.recordError(new Error("e1"));
    det.recordError(new Error("e2"));
    det.notifyResumed();
    expect(det.recordError(new Error("e3")).stuck).toBe(true);
  });

  it("resets lastToolCalls to 0 on resume", () => {
    const det = new StuckDetector();
    det.recordIteration(7);
    expect(det.lastToolCalls).toBe(7);
    det.notifyResumed();
    expect(det.lastToolCalls).toBe(0);
  });

  it("multiple consecutive resumes do not corrupt state", () => {
    const det = new StuckDetector({ maxIdleIterations: 2, maxRepeatCalls: 2 });
    det.recordToolCall("t", { v: 1 });
    det.notifyResumed();
    det.notifyResumed();
    // Repeat detection still works after double resume
    expect(det.recordToolCall("t", { v: 1 }).stuck).toBe(true);
  });
});

// ============================================================================
// 8. Combined detection modes
// ============================================================================

describe("StuckDetector — combined detection", () => {
  it("idle trigger fires independently of repeat-call trigger", () => {
    const det = new StuckDetector({ maxIdleIterations: 2, maxRepeatCalls: 10 });
    det.recordIteration(0);
    expect(det.recordIteration(0).stuck).toBe(true); // idle fires first
  });

  it("repeat-call trigger fires independently of idle trigger", () => {
    const det = new StuckDetector({ maxIdleIterations: 10, maxRepeatCalls: 2 });
    det.recordToolCall("t", { x: 1 });
    expect(det.recordToolCall("t", { x: 1 }).stuck).toBe(true); // repeat fires
  });

  it("error trigger fires independently of repeat trigger", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 2,
      errorWindowMs: 60_000,
      maxRepeatCalls: 100,
    });
    det.recordError(new Error("a"));
    expect(det.recordError(new Error("b")).stuck).toBe(true);
  });

  it("semantic plateau fires independently of repeat trigger", () => {
    const det = new StuckDetector({
      semanticPlateauWindow: 3,
      maxRepeatCalls: 100,
      maxIdleIterations: 100,
    });
    det.recordToolCall("embed", { t: "a" });
    det.recordToolCall("embed", { t: "b" });
    expect(det.recordToolCall("embed", { t: "c" }).stuck).toBe(true);
  });

  it("both error and repeat triggered in sequence: each fires", () => {
    const det = new StuckDetector({
      maxRepeatCalls: 2,
      maxErrorsInWindow: 2,
      errorWindowMs: 60_000,
    });
    // Trip error path first
    det.recordError(new Error("e1"));
    expect(det.recordError(new Error("e2")).stuck).toBe(true);
    // Separately, trip repeat path
    det.recordToolCall("t", { v: 1 });
    expect(det.recordToolCall("t", { v: 1 }).stuck).toBe(true);
  });

  it("all three triggers configurable independently without interference", () => {
    const det = new StuckDetector({
      maxRepeatCalls: 3,
      maxErrorsInWindow: 5,
      maxIdleIterations: 4,
    });
    // 2 repeat calls — not stuck
    det.recordToolCall("r", { v: 1 });
    expect(det.recordToolCall("r", { v: 1 }).stuck).toBe(false);
    // 3 idle — not stuck yet (threshold is 4)
    det.recordIteration(0);
    det.recordIteration(0);
    expect(det.recordIteration(0).stuck).toBe(false);
    // 4 errors — not stuck (threshold is 5)
    det.recordError(new Error("a"));
    det.recordError(new Error("b"));
    det.recordError(new Error("c"));
    expect(det.recordError(new Error("d")).stuck).toBe(false);
  });

  it("progress-hash and repeat triggers are independent", () => {
    // 3 hash windows of 5 tools should trigger hash stuck
    // even when repeat threshold is very high
    const det = new StuckDetector({ maxRepeatCalls: 100 });
    for (let win = 0; win < 2; win++) {
      for (const t of ["ha", "hb", "hc", "hd", "he"]) det.recordToolCall(t, {});
    }
    det.recordToolCall("ha", {});
    det.recordToolCall("hb", {});
    det.recordToolCall("hc", {});
    det.recordToolCall("hd", {});
    expect(det.recordToolCall("he", {}).stuck).toBe(true);
  });
});

// ============================================================================
// 9. Edge cases
// ============================================================================

describe("StuckDetector — edge cases", () => {
  it("new instance with no calls: not stuck", () => {
    const det = new StuckDetector();
    // Just creating it should not produce any stuck state
    expect(det.lastToolCalls).toBe(0);
  });

  it("constructor with empty config applies all defaults", () => {
    const det = new StuckDetector({});
    // Default maxRepeatCalls = 3
    det.recordToolCall("t", { x: 1 });
    det.recordToolCall("t", { x: 1 });
    expect(det.recordToolCall("t", { x: 1 }).stuck).toBe(true);
  });

  it("constructor with no args applies all defaults", () => {
    const det = new StuckDetector();
    det.recordToolCall("t", { x: 1 });
    det.recordToolCall("t", { x: 1 });
    expect(det.recordToolCall("t", { x: 1 }).stuck).toBe(true);
  });

  it('tool names are case-sensitive: "Tool" and "tool" are different', () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    det.recordToolCall("Tool", { v: 1 });
    expect(det.recordToolCall("tool", { v: 1 }).stuck).toBe(false);
  });

  it("empty string tool name works without crash", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    det.recordToolCall("", { x: 1 });
    expect(det.recordToolCall("", { x: 1 }).stuck).toBe(true);
  });

  it("array input is hashed consistently", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    det.recordToolCall("tool", [1, 2, 3]);
    expect(det.recordToolCall("tool", [1, 2, 3]).stuck).toBe(true);
  });

  it("boolean input works", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    det.recordToolCall("tool", true);
    expect(det.recordToolCall("tool", true).stuck).toBe(true);
  });

  it("number input works", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    det.recordToolCall("tool", 42);
    expect(det.recordToolCall("tool", 42).stuck).toBe(true);
  });

  it("not-stuck result has undefined reason", () => {
    const det = new StuckDetector();
    const result = det.recordToolCall("t", { v: 1 });
    expect(result.stuck).toBe(false);
    // reason may be undefined or absent
    expect(result.reason ?? undefined).toBeUndefined();
  });

  it("stuck result always has a non-empty reason string", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    det.recordToolCall("t", { v: 1 });
    const result = det.recordToolCall("t", { v: 1 });
    expect(result.stuck).toBe(true);
    expect(typeof result.reason).toBe("string");
    expect(result.reason!.length).toBeGreaterThan(0);
  });

  it("maxRepeatCalls=1: every identical call triggers stuck after first call", () => {
    const det = new StuckDetector({ maxRepeatCalls: 1 });
    expect(det.recordToolCall("t", { v: 1 }).stuck).toBe(true);
  });

  it("large number of iterations with tool calls never idle-stucks", () => {
    const det = new StuckDetector({ maxIdleIterations: 3 });
    for (let i = 0; i < 100; i++) {
      expect(det.recordIteration(1).stuck).toBe(false);
    }
  });
});

// ============================================================================
// 10. Per-run isolation (independent instances)
// ============================================================================

describe("StuckDetector — per-run isolation", () => {
  it("two detector instances do not share state", () => {
    const det1 = new StuckDetector({ maxRepeatCalls: 2 });
    const det2 = new StuckDetector({ maxRepeatCalls: 2 });
    det1.recordToolCall("t", { x: 1 });
    det1.recordToolCall("t", { x: 1 }); // det1 is stuck
    // det2 should be completely unaffected
    expect(det2.recordToolCall("t", { x: 1 }).stuck).toBe(false);
  });

  it("resetting one instance does not affect another", () => {
    const det1 = new StuckDetector({ maxRepeatCalls: 2 });
    const det2 = new StuckDetector({ maxRepeatCalls: 2 });
    det1.recordToolCall("t", { x: 1 });
    det2.recordToolCall("t", { x: 1 });
    det1.reset();
    // det2 still has its history
    expect(det2.recordToolCall("t", { x: 1 }).stuck).toBe(true);
    // det1 is fresh
    expect(det1.recordToolCall("t", { x: 1 }).stuck).toBe(false);
  });

  it("each new instance starts with lastToolCalls=0", () => {
    const det = new StuckDetector();
    expect(det.lastToolCalls).toBe(0);
  });

  it("fresh instance after reset behaves identically to a newly constructed one", () => {
    const fresh = new StuckDetector({
      maxRepeatCalls: 2,
      maxIdleIterations: 2,
    });
    const reused = new StuckDetector({
      maxRepeatCalls: 2,
      maxIdleIterations: 2,
    });
    reused.recordToolCall("t", { v: 9 });
    reused.recordIteration(5);
    reused.recordError(new Error("x"));
    reused.reset();
    // Both should behave the same now
    expect(fresh.recordToolCall("t", { v: 1 }).stuck).toBe(
      reused.recordToolCall("t", { v: 1 }).stuck
    );
  });
});
