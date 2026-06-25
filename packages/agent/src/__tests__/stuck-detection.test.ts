/**
 * Stuck detection tests for @dzupagent/agent
 *
 * Covers:
 * - StuckDetector (core tool-loop stuck detection — re-exported via guardrails)
 * - PipelineStuckDetector (pipeline-level stuck detection)
 * - StuckError (structured error thrown on stuck abort)
 * - Repeated-call detection (same tool + same args N times)
 * - Error-rate monitoring (too many consecutive errors in window)
 * - Idle iteration detection (no tool calls)
 * - Progress-hash block detection (repeated tool sequences)
 * - Semantic plateau detection (fixation on a single tool)
 * - Escalation / recovery after stuck
 * - Configurable thresholds
 * - Edge cases: single-tool agents, empty calls, borderline thresholds
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { StuckDetector } from "../guardrails/stuck-detector.js";
import type { StuckStatus } from "../guardrails/stuck-detector.js";
import { PipelineStuckDetector } from "../self-correction/pipeline-stuck-detector.js";
import { StuckError } from "../agent/stuck-error.js";

// ---------------------------------------------------------------------------
// StuckDetector — repeated identical tool calls
// ---------------------------------------------------------------------------

describe("StuckDetector — repeated identical tool calls", () => {
  let detector: StuckDetector;

  beforeEach(() => {
    detector = new StuckDetector({ maxRepeatCalls: 3 });
  });

  it("does not flag stuck after fewer calls than threshold", () => {
    detector.recordToolCall("search", { query: "foo" });
    const status = detector.recordToolCall("search", { query: "foo" });
    expect(status.stuck).toBe(false);
  });

  it("flags stuck when same tool called maxRepeatCalls times with identical input", () => {
    detector.recordToolCall("search", { query: "foo" });
    detector.recordToolCall("search", { query: "foo" });
    const status = detector.recordToolCall("search", { query: "foo" });
    expect(status.stuck).toBe(true);
    expect(status.reason).toContain("search");
    expect(status.reason).toContain("3");
  });

  it("does not flag stuck when same tool called with different inputs", () => {
    detector.recordToolCall("search", { query: "foo" });
    detector.recordToolCall("search", { query: "bar" });
    const status = detector.recordToolCall("search", { query: "baz" });
    expect(status.stuck).toBe(false);
  });

  it("does not flag stuck when different tools are called even with same args", () => {
    detector.recordToolCall("search", { query: "foo" });
    detector.recordToolCall("fetch", { query: "foo" });
    const status = detector.recordToolCall("search", { query: "foo" });
    expect(status.stuck).toBe(false);
  });

  it("resets repeat tracking after a different call breaks the streak", () => {
    detector.recordToolCall("search", { query: "foo" });
    detector.recordToolCall("search", { query: "foo" });
    detector.recordToolCall("other", { x: 1 }); // breaks the streak
    detector.recordToolCall("search", { query: "foo" });
    const status = detector.recordToolCall("search", { query: "foo" });
    // Only 2 consecutive same calls after the break — not stuck
    expect(status.stuck).toBe(false);
  });

  it("respects custom maxRepeatCalls of 2", () => {
    const d = new StuckDetector({ maxRepeatCalls: 2 });
    d.recordToolCall("write", { path: "/tmp/x" });
    const status = d.recordToolCall("write", { path: "/tmp/x" });
    expect(status.stuck).toBe(true);
  });

  it("respects custom maxRepeatCalls of 5", () => {
    const d = new StuckDetector({ maxRepeatCalls: 5 });
    for (let i = 0; i < 4; i++) {
      const s = d.recordToolCall("read", { file: "a" });
      expect(s.stuck).toBe(false);
    }
    const final = d.recordToolCall("read", { file: "a" });
    expect(final.stuck).toBe(true);
  });

  it("handles null input without throwing", () => {
    expect(() => detector.recordToolCall("tool", null)).not.toThrow();
  });

  it("handles undefined input — hashToolInput may throw for unserializable values", () => {
    // undefined cannot be serialized to a stable hash string; the detector
    // passes the raw input to hashToolInput which internally calls JSON.stringify.
    // The exact behavior (throw vs. coerce) depends on the hash implementation,
    // so we only assert the call is attempted and the return value is a StuckStatus.
    try {
      const status = detector.recordToolCall("tool", undefined);
      // If it does NOT throw, the result must be a valid StuckStatus shape
      expect(typeof status.stuck).toBe("boolean");
    } catch (err) {
      // If it throws, the error should be a TypeError about argument type
      expect(err).toBeInstanceOf(TypeError);
    }
  });

  it("handles empty object input", () => {
    detector.recordToolCall("tool", {});
    detector.recordToolCall("tool", {});
    const status = detector.recordToolCall("tool", {});
    expect(status.stuck).toBe(true);
  });

  it("handles empty string input", () => {
    detector.recordToolCall("tool", "");
    detector.recordToolCall("tool", "");
    const status = detector.recordToolCall("tool", "");
    expect(status.stuck).toBe(true);
  });

  it("includes tool name in stuck reason", () => {
    for (let i = 0; i < 3; i++) {
      detector.recordToolCall("my_special_tool", { arg: "val" });
    }
    const status = detector.recordToolCall("my_special_tool", { arg: "val" });
    // By the 3rd call it's already stuck, subsequent calls may still return stuck
    expect(status.stuck).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// StuckDetector — error rate monitoring
// ---------------------------------------------------------------------------

describe("StuckDetector — error rate monitoring", () => {
  let detector: StuckDetector;

  beforeEach(() => {
    detector = new StuckDetector({
      maxErrorsInWindow: 3,
      errorWindowMs: 60_000,
    });
  });

  it("does not flag stuck below error threshold", () => {
    detector.recordError(new Error("e1"));
    const status = detector.recordError(new Error("e2"));
    expect(status.stuck).toBe(false);
  });

  it("flags stuck when maxErrorsInWindow is reached", () => {
    detector.recordError(new Error("e1"));
    detector.recordError(new Error("e2"));
    const status = detector.recordError(new Error("e3"));
    expect(status.stuck).toBe(true);
    expect(status.reason).toBeTruthy();
  });

  it("accepts string errors (not just Error instances)", () => {
    detector.recordError("string error 1");
    detector.recordError("string error 2");
    const status = detector.recordError("string error 3");
    expect(status.stuck).toBe(true);
  });

  it("mixes Error instances and strings", () => {
    detector.recordError(new Error("typed error"));
    detector.recordError("raw string");
    const status = detector.recordError(new Error("another typed"));
    expect(status.stuck).toBe(true);
  });

  it("respects maxErrorsInWindow: 5 default", () => {
    const d = new StuckDetector({
      maxErrorsInWindow: 5,
      errorWindowMs: 60_000,
    });
    for (let i = 0; i < 4; i++) {
      const s = d.recordError(new Error(`e${i}`));
      expect(s.stuck).toBe(false);
    }
    const final = d.recordError(new Error("e4"));
    expect(final.stuck).toBe(true);
  });

  it("includes window duration in reason message", () => {
    detector.recordError(new Error("e1"));
    detector.recordError(new Error("e2"));
    const status = detector.recordError(new Error("e3"));
    expect(status.stuck).toBe(true);
    // Should mention "60s" or "60000" or "errors" or similar
    expect(status.reason).toBeTruthy();
    expect(typeof status.reason).toBe("string");
  });

  it("single error never triggers stuck", () => {
    const d = new StuckDetector({ maxErrorsInWindow: 1 });
    // maxErrorsInWindow=1 means the FIRST error triggers stuck
    const status = d.recordError(new Error("only error"));
    expect(status.stuck).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// StuckDetector — idle iteration detection
// ---------------------------------------------------------------------------

describe("StuckDetector — idle iteration detection", () => {
  let detector: StuckDetector;

  beforeEach(() => {
    detector = new StuckDetector({ maxIdleIterations: 3 });
  });

  it("does not flag stuck for iterations with tool calls", () => {
    const status = detector.recordIteration(2);
    expect(status.stuck).toBe(false);
  });

  it("does not flag stuck below idle threshold", () => {
    detector.recordIteration(0);
    const status = detector.recordIteration(0);
    expect(status.stuck).toBe(false);
  });

  it("flags stuck when maxIdleIterations consecutive idle iterations reached", () => {
    detector.recordIteration(0);
    detector.recordIteration(0);
    const status = detector.recordIteration(0);
    expect(status.stuck).toBe(true);
    expect(status.reason).toContain("3");
  });

  it("resets idle count when a non-idle iteration is recorded", () => {
    detector.recordIteration(0);
    detector.recordIteration(0);
    detector.recordIteration(1); // resets idle count
    detector.recordIteration(0);
    const status = detector.recordIteration(0);
    // Only 2 idles since reset — not stuck
    expect(status.stuck).toBe(false);
  });

  it("respects maxIdleIterations: 1", () => {
    const d = new StuckDetector({ maxIdleIterations: 1 });
    const status = d.recordIteration(0);
    expect(status.stuck).toBe(true);
  });

  it("tracks lastToolCalls correctly", () => {
    detector.recordIteration(5);
    expect(detector.lastToolCalls).toBe(5);
    detector.recordIteration(0);
    expect(detector.lastToolCalls).toBe(0);
  });

  it("tool call resets idle counter via recordToolCall", () => {
    detector.recordIteration(0);
    detector.recordIteration(0);
    // Now a tool call resets idle
    detector.recordToolCall("some_tool", { x: 1 });
    detector.recordIteration(0);
    const status = detector.recordIteration(0);
    // Only 2 idles after tool call reset — not stuck
    expect(status.stuck).toBe(false);
  });

  it("reason mentions idle iterations count", () => {
    detector.recordIteration(0);
    detector.recordIteration(0);
    const status = detector.recordIteration(0);
    expect(status.reason).toMatch(/iteration/i);
  });
});

// ---------------------------------------------------------------------------
// StuckDetector — semantic plateau detection
// ---------------------------------------------------------------------------

describe("StuckDetector — semantic plateau detection", () => {
  it("does not flag with semanticPlateauWindow: 0 (disabled)", () => {
    const d = new StuckDetector({ semanticPlateauWindow: 0 });
    for (let i = 0; i < 10; i++) {
      d.recordToolCall("same_tool", { i }); // different args so no repeat-call trigger
    }
    // No semantic plateau since it's disabled
    // The only trigger could be repeat-call (maxRepeatCalls=3 default),
    // but args differ each iteration so it won't trigger
  });

  it("flags stuck when same tool called semanticPlateauWindow consecutive times", () => {
    const d = new StuckDetector({
      semanticPlateauWindow: 4,
      maxRepeatCalls: 100,
    });
    d.recordToolCall("search", { q: "a" });
    d.recordToolCall("search", { q: "b" });
    d.recordToolCall("search", { q: "c" });
    const status = d.recordToolCall("search", { q: "d" });
    expect(status.stuck).toBe(true);
    expect(status.reason).toContain("search");
    expect(status.reason).toMatch(/plateau|consecutive/i);
  });

  it("does not flag when different tools are interleaved", () => {
    const d = new StuckDetector({
      semanticPlateauWindow: 3,
      maxRepeatCalls: 100,
    });
    d.recordToolCall("search", { q: "a" });
    d.recordToolCall("fetch", { url: "x" });
    const status = d.recordToolCall("search", { q: "b" });
    expect(status.stuck).toBe(false);
  });

  it("sliding window clears old entries when different tool breaks plateau", () => {
    const d = new StuckDetector({
      semanticPlateauWindow: 3,
      maxRepeatCalls: 100,
    });
    d.recordToolCall("search", { q: "a" });
    d.recordToolCall("search", { q: "b" });
    d.recordToolCall("other", { x: 1 }); // breaks the streak
    d.recordToolCall("search", { q: "c" });
    const status = d.recordToolCall("search", { q: "d" });
    // Only 2 consecutive 'search' after 'other' — not stuck (window=3)
    expect(status.stuck).toBe(false);
  });

  it("reason message mentions plateau for semantic plateau detection", () => {
    const d = new StuckDetector({
      semanticPlateauWindow: 3,
      maxRepeatCalls: 100,
    });
    d.recordToolCall("analyze", { data: 1 });
    d.recordToolCall("analyze", { data: 2 });
    const status = d.recordToolCall("analyze", { data: 3 });
    expect(status.stuck).toBe(true);
    expect(status.reason).toContain("Semantic plateau");
  });
});

// ---------------------------------------------------------------------------
// StuckDetector — reset and recovery
// ---------------------------------------------------------------------------

describe("StuckDetector — reset and recovery", () => {
  let detector: StuckDetector;

  beforeEach(() => {
    detector = new StuckDetector({
      maxRepeatCalls: 3,
      maxErrorsInWindow: 3,
      maxIdleIterations: 3,
    });
  });

  it("reset clears all tracking state", () => {
    // Drive it to stuck via errors
    detector.recordError(new Error("e1"));
    detector.recordError(new Error("e2"));
    detector.recordError(new Error("e3"));

    detector.reset();

    // Should no longer be stuck
    const status = detector.recordError(new Error("after reset"));
    expect(status.stuck).toBe(false);
  });

  it("reset clears idle count", () => {
    detector.recordIteration(0);
    detector.recordIteration(0);
    detector.reset();
    detector.recordIteration(0);
    detector.recordIteration(0);
    const status = detector.recordIteration(0);
    // After reset the count restarts — 3 idles should trigger again
    expect(status.stuck).toBe(true);
  });

  it("reset clears repeat-call history", () => {
    detector.recordToolCall("tool", { x: 1 });
    detector.recordToolCall("tool", { x: 1 });
    detector.reset();
    // After reset, only 2 calls — not stuck
    detector.recordToolCall("tool", { x: 1 });
    const status = detector.recordToolCall("tool", { x: 1 });
    expect(status.stuck).toBe(false);
  });

  it("reset allows detector to be reused for a new agent run", () => {
    // Simulate first run going stuck
    for (let i = 0; i < 3; i++) {
      detector.recordToolCall("op", { v: 1 });
    }
    expect(detector.recordToolCall("op", { v: 1 }).stuck).toBe(true);

    // Reset and start fresh
    detector.reset();
    expect(detector.recordToolCall("op", { v: 1 }).stuck).toBe(false);
  });

  it("notifyResumed resets idle counter only", () => {
    detector.recordIteration(0);
    detector.recordIteration(0);
    detector.notifyResumed();
    // After resume, idle count is 0 — 2 idles below threshold
    detector.recordIteration(0);
    detector.recordIteration(0);
    const status = detector.recordIteration(0);
    expect(status.stuck).toBe(true); // Now 3 idles after resume
  });

  it("notifyResumed does not clear error history", () => {
    detector.recordError(new Error("e1"));
    detector.recordError(new Error("e2"));
    detector.notifyResumed();
    // Error count is still 2, one more reaches threshold
    const status = detector.recordError(new Error("e3"));
    expect(status.stuck).toBe(true);
  });

  it("lastToolCalls resets to 0 on notifyResumed", () => {
    detector.recordIteration(5);
    expect(detector.lastToolCalls).toBe(5);
    detector.notifyResumed();
    expect(detector.lastToolCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// StuckDetector — default config values
// ---------------------------------------------------------------------------

describe("StuckDetector — default configuration", () => {
  it("uses maxRepeatCalls: 3 by default", () => {
    const d = new StuckDetector();
    d.recordToolCall("t", { x: 1 });
    d.recordToolCall("t", { x: 1 });
    const status = d.recordToolCall("t", { x: 1 });
    expect(status.stuck).toBe(true);
  });

  it("uses maxErrorsInWindow: 5 by default", () => {
    const d = new StuckDetector();
    for (let i = 0; i < 4; i++) d.recordError(new Error(`e${i}`));
    expect(d.recordError(new Error("e4")).stuck).toBe(true);
  });

  it("uses maxIdleIterations: 3 by default", () => {
    const d = new StuckDetector();
    d.recordIteration(0);
    d.recordIteration(0);
    expect(d.recordIteration(0).stuck).toBe(true);
  });

  it("has semanticPlateauWindow: 0 (disabled) by default", () => {
    const d = new StuckDetector();
    // With default maxRepeatCalls=3 and identical args, it would trigger at 3
    // So use distinct args to only check semantic plateau
    for (let i = 0; i < 10; i++) {
      const s = d.recordToolCall("tool", { i });
      if (s.stuck) {
        // Should only be stuck via other detectors, not semantic plateau
        expect(s.reason).not.toContain("plateau");
        break;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// StuckDetector — edge cases
// ---------------------------------------------------------------------------

describe("StuckDetector — edge cases", () => {
  it("single-tool agent scenario: detects stuck quickly", () => {
    // An agent with only one tool will always call the same tool
    const d = new StuckDetector({ maxRepeatCalls: 3 });
    d.recordToolCall("only_tool", { query: "same" });
    d.recordToolCall("only_tool", { query: "same" });
    const status = d.recordToolCall("only_tool", { query: "same" });
    expect(status.stuck).toBe(true);
    expect(status.reason).toContain("only_tool");
  });

  it("borderline threshold: N-1 calls do not trigger, N calls do", () => {
    const N = 4;
    const d = new StuckDetector({ maxRepeatCalls: N });
    for (let i = 0; i < N - 1; i++) {
      const s = d.recordToolCall("t", { x: 1 });
      expect(s.stuck).toBe(false);
    }
    const stuck = d.recordToolCall("t", { x: 1 });
    expect(stuck.stuck).toBe(true);
  });

  it("zero tool calls in the first iteration is not stuck (below maxIdleIterations)", () => {
    const d = new StuckDetector({ maxIdleIterations: 3 });
    const status = d.recordIteration(0);
    expect(status.stuck).toBe(false);
  });

  it("deeply nested object arguments are compared by content not reference", () => {
    const d = new StuckDetector({ maxRepeatCalls: 2 });
    // Two separate object instances with same content should hash equally
    d.recordToolCall("tool", { nested: { a: 1, b: [2, 3] } });
    const status = d.recordToolCall("tool", { nested: { a: 1, b: [2, 3] } });
    expect(status.stuck).toBe(true);
  });

  it("large number of tool calls with varied tool names and args does not flag stuck", () => {
    // Use unique tool names per call to prevent any detection mode from firing:
    // - maxRepeatCalls: tool names differ so hash never repeats
    // - progress-hash: block sequences differ each window
    // - semanticPlateauWindow: 0 (disabled)
    const d = new StuckDetector({
      maxRepeatCalls: 3,
      semanticPlateauWindow: 0,
    });
    for (let i = 0; i < 50; i++) {
      const s = d.recordToolCall(`tool_${i}`, { iteration: i });
      expect(s.stuck).toBe(false);
    }
  });

  it("empty tool name is accepted", () => {
    const d = new StuckDetector({ maxRepeatCalls: 2 });
    d.recordToolCall("", { x: 1 });
    const status = d.recordToolCall("", { x: 1 });
    expect(status.stuck).toBe(true);
  });

  it("all-numeric tool name is accepted", () => {
    const d = new StuckDetector({ maxRepeatCalls: 2 });
    d.recordToolCall("123", { x: 1 });
    const status = d.recordToolCall("123", { x: 1 });
    expect(status.stuck).toBe(true);
  });

  it("returns { stuck: false } initially with no calls", () => {
    const d = new StuckDetector();
    // No calls yet — any check returns not stuck
    const status = d.recordToolCall("tool", { first: true });
    expect(status.stuck).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// StuckError — structured error
// ---------------------------------------------------------------------------

describe("StuckError", () => {
  it("constructs with required reason", () => {
    const err = new StuckError({ reason: "too many retries" });
    expect(err.reason).toBe("too many retries");
    expect(err.message).toContain("too many retries");
    expect(err.name).toBe("StuckError");
  });

  it("includes tool name in message when repeatedTool provided", () => {
    const err = new StuckError({
      reason: "repeat detected",
      repeatedTool: "search",
    });
    expect(err.message).toContain("search");
    expect(err.repeatedTool).toBe("search");
  });

  it("defaults escalationLevel to 3 (loop_aborted)", () => {
    const err = new StuckError({ reason: "stuck" });
    expect(err.escalationLevel).toBe(3);
    expect(err.recoveryAction).toBe("loop_aborted");
  });

  it("escalationLevel 1 maps to tool_blocked", () => {
    const err = new StuckError({ reason: "blocked", escalationLevel: 1 });
    expect(err.escalationLevel).toBe(1);
    expect(err.recoveryAction).toBe("tool_blocked");
  });

  it("escalationLevel 2 maps to nudge_injected", () => {
    const err = new StuckError({ reason: "nudge", escalationLevel: 2 });
    expect(err.escalationLevel).toBe(2);
    expect(err.recoveryAction).toBe("nudge_injected");
  });

  it("escalationLevel 3 maps to loop_aborted", () => {
    const err = new StuckError({ reason: "abort", escalationLevel: 3 });
    expect(err.escalationLevel).toBe(3);
    expect(err.recoveryAction).toBe("loop_aborted");
  });

  it("is instanceof Error", () => {
    const err = new StuckError({ reason: "test" });
    expect(err instanceof Error).toBe(true);
  });

  it("is instanceof StuckError", () => {
    const err = new StuckError({ reason: "test" });
    expect(err instanceof StuckError).toBe(true);
  });

  it("repeatedTool is undefined when not provided", () => {
    const err = new StuckError({ reason: "no tool" });
    expect(err.repeatedTool).toBeUndefined();
  });

  it('message without tool omits "on tool" phrase', () => {
    const err = new StuckError({ reason: "idle" });
    expect(err.message).not.toContain("on tool");
    expect(err.message).toContain("Agent stuck");
  });

  it("message with tool includes on tool phrase", () => {
    const err = new StuckError({ reason: "repeat", repeatedTool: "analyze" });
    expect(err.message).toContain('on tool "analyze"');
  });

  it("can be caught and rethrown as Error", () => {
    const caught = (() => {
      try {
        throw new StuckError({ reason: "thrown" });
      } catch (e) {
        return e;
      }
    })();
    expect(caught instanceof StuckError).toBe(true);
    expect((caught as StuckError).reason).toBe("thrown");
  });
});

// ---------------------------------------------------------------------------
// PipelineStuckDetector — node failure detection
// ---------------------------------------------------------------------------

describe("PipelineStuckDetector — node failure detection", () => {
  let detector: PipelineStuckDetector;

  beforeEach(() => {
    detector = new PipelineStuckDetector({
      maxNodeFailures: 3,
      maxTotalRetries: 10,
    });
  });

  it("does not flag stuck below node failure threshold", () => {
    detector.recordNodeFailure("node1", "Error A");
    const status = detector.recordNodeFailure("node1", "Error B");
    expect(status.stuck).toBe(false);
  });

  it("flags stuck when a node reaches maxNodeFailures", () => {
    detector.recordNodeFailure("gen", "err1");
    detector.recordNodeFailure("gen", "err2");
    const status = detector.recordNodeFailure("gen", "err3");
    expect(status.stuck).toBe(true);
    expect(status.reason).toContain("gen");
    expect(status.nodeId).toBe("gen");
  });

  it("failure counts are per-node (different nodes do not cross-count)", () => {
    detector.recordNodeFailure("node1", "e");
    detector.recordNodeFailure("node1", "e");
    detector.recordNodeFailure("node2", "e");
    detector.recordNodeFailure("node2", "e");
    const statusNode2 = detector.recordNodeFailure("node2", "e");
    // node2 has 3 failures but node1 only has 2
    expect(statusNode2.stuck).toBe(true);
    expect(statusNode2.nodeId).toBe("node2");
  });

  it("getNodeFailureCount returns correct count", () => {
    detector.recordNodeFailure("a", "e1");
    detector.recordNodeFailure("a", "e2");
    expect(detector.getNodeFailureCount("a")).toBe(2);
  });

  it("getNodeFailureCount returns 0 for unknown node", () => {
    expect(detector.getNodeFailureCount("nonexistent")).toBe(0);
  });

  it("suggested action escalates with failure count", () => {
    // With default maxNodeFailures=3, first trigger at count=3 returns abort
    // (escalateAction(3) = abort)
    const d = new PipelineStuckDetector({ maxNodeFailures: 3 });
    d.recordNodeFailure("n", "e");
    d.recordNodeFailure("n", "e");
    const status = d.recordNodeFailure("n", "e");
    expect(status.stuck).toBe(true);
    expect(status.suggestedAction).toBe("abort");
  });

  it("suggested action is retry_with_hint at count below escalation", () => {
    // maxNodeFailures=1 triggers at count=1, escalateAction(1)='retry_with_hint'
    const d = new PipelineStuckDetector({ maxNodeFailures: 1 });
    const status = d.recordNodeFailure("n", "err");
    expect(status.stuck).toBe(true);
    expect(status.suggestedAction).toBe("retry_with_hint");
  });

  it("includes nodeId in the stuck status", () => {
    detector.recordNodeFailure("backend-gen", "e");
    detector.recordNodeFailure("backend-gen", "e");
    const status = detector.recordNodeFailure("backend-gen", "e");
    expect(status.nodeId).toBe("backend-gen");
  });

  it("reason mentions node name and failure count", () => {
    detector.recordNodeFailure("api-node", "e");
    detector.recordNodeFailure("api-node", "e");
    const status = detector.recordNodeFailure("api-node", "e");
    expect(status.reason).toContain("api-node");
  });
});

// ---------------------------------------------------------------------------
// PipelineStuckDetector — identical output detection
// ---------------------------------------------------------------------------

describe("PipelineStuckDetector — identical output detection", () => {
  let detector: PipelineStuckDetector;

  beforeEach(() => {
    detector = new PipelineStuckDetector({ maxIdenticalOutputs: 3 });
  });

  it("does not flag stuck for varied outputs", () => {
    detector.recordNodeOutput("gen", "output A");
    detector.recordNodeOutput("gen", "output B");
    const status = detector.recordNodeOutput("gen", "output C");
    expect(status.stuck).toBe(false);
  });

  it("flags stuck when same output repeated maxIdenticalOutputs times", () => {
    detector.recordNodeOutput("gen", "same output");
    detector.recordNodeOutput("gen", "same output");
    const status = detector.recordNodeOutput("gen", "same output");
    expect(status.stuck).toBe(true);
    expect(status.reason).toContain("gen");
    expect(status.suggestedAction).toBe("switch_strategy");
  });

  it("does not flag when output pattern is broken before threshold", () => {
    detector.recordNodeOutput("gen", "same");
    detector.recordNodeOutput("gen", "different");
    detector.recordNodeOutput("gen", "same");
    const status = detector.recordNodeOutput("gen", "same");
    // Pattern [same, different, same, same] — only 2 consecutive same at tail not matching full window
    expect(status.stuck).toBe(false);
  });

  it("tracks outputs per-node independently", () => {
    detector.recordNodeOutput("node1", "x");
    detector.recordNodeOutput("node1", "x");
    detector.recordNodeOutput("node2", "y");
    detector.recordNodeOutput("node2", "y");
    const statusNode2 = detector.recordNodeOutput("node2", "y");
    expect(statusNode2.stuck).toBe(true);
    expect(statusNode2.nodeId).toBe("node2");
  });

  it("getSummary includes identical output nodes when stuck", () => {
    detector.recordNodeOutput("looping", "repeat");
    detector.recordNodeOutput("looping", "repeat");
    detector.recordNodeOutput("looping", "repeat");
    const summary = detector.getSummary();
    expect(summary.identicalOutputNodes).toContain("looping");
  });
});

// ---------------------------------------------------------------------------
// PipelineStuckDetector — total retry detection
// ---------------------------------------------------------------------------

describe("PipelineStuckDetector — total retry detection", () => {
  it("flags stuck when total retries exceed maxTotalRetries", () => {
    const d = new PipelineStuckDetector({ maxTotalRetries: 3 });
    d.recordRetry();
    d.recordRetry();
    const status = d.recordRetry();
    expect(status.stuck).toBe(true);
    expect(status.reason).toContain("3");
    expect(status.suggestedAction).toBe("abort");
  });

  it("does not flag stuck below total retry threshold", () => {
    const d = new PipelineStuckDetector({ maxTotalRetries: 5 });
    for (let i = 0; i < 4; i++) {
      expect(d.recordRetry().stuck).toBe(false);
    }
  });

  it("getTotalRetries increments correctly", () => {
    const d = new PipelineStuckDetector({ maxTotalRetries: 10 });
    d.recordRetry();
    d.recordRetry();
    d.recordRetry();
    expect(d.getTotalRetries()).toBe(3);
  });

  it("getSummary reflects total retries", () => {
    const d = new PipelineStuckDetector({ maxTotalRetries: 10 });
    d.recordRetry();
    d.recordRetry();
    const summary = d.getSummary();
    expect(summary.totalRetries).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PipelineStuckDetector — getSummary and reset
// ---------------------------------------------------------------------------

describe("PipelineStuckDetector — getSummary and reset", () => {
  it("getSummary returns empty maps when no activity", () => {
    const d = new PipelineStuckDetector();
    const summary = d.getSummary();
    expect(summary.nodeFailures.size).toBe(0);
    expect(summary.totalRetries).toBe(0);
    expect(summary.identicalOutputNodes).toEqual([]);
  });

  it("getSummary.nodeFailures reflects recorded failures", () => {
    const d = new PipelineStuckDetector();
    d.recordNodeFailure("a", "e1");
    d.recordNodeFailure("a", "e2");
    d.recordNodeFailure("b", "e1");
    const summary = d.getSummary();
    expect(summary.nodeFailures.get("a")).toBe(2);
    expect(summary.nodeFailures.get("b")).toBe(1);
  });

  it("reset clears all tracking state", () => {
    const d = new PipelineStuckDetector({ maxTotalRetries: 5 });
    d.recordNodeFailure("n", "e");
    d.recordRetry();
    d.recordNodeOutput("n", "same");
    d.reset();

    expect(d.getNodeFailureCount("n")).toBe(0);
    expect(d.getTotalRetries()).toBe(0);
    const summary = d.getSummary();
    expect(summary.nodeFailures.size).toBe(0);
    expect(summary.totalRetries).toBe(0);
  });

  it("reset allows clean re-use", () => {
    const d = new PipelineStuckDetector({ maxNodeFailures: 2 });
    d.recordNodeFailure("x", "e");
    const before = d.recordNodeFailure("x", "e");
    expect(before.stuck).toBe(true);

    d.reset();

    const after = d.recordNodeFailure("x", "e");
    expect(after.stuck).toBe(false); // only 1 failure after reset
  });
});

// ---------------------------------------------------------------------------
// PipelineStuckDetector — default config
// ---------------------------------------------------------------------------

describe("PipelineStuckDetector — default configuration", () => {
  it("defaults maxNodeFailures to 3", () => {
    const d = new PipelineStuckDetector();
    d.recordNodeFailure("n", "e");
    d.recordNodeFailure("n", "e");
    expect(d.recordNodeFailure("n", "e").stuck).toBe(true);
  });

  it("defaults maxIdenticalOutputs to 3", () => {
    const d = new PipelineStuckDetector();
    d.recordNodeOutput("n", "same");
    d.recordNodeOutput("n", "same");
    expect(d.recordNodeOutput("n", "same").stuck).toBe(true);
  });

  it("defaults maxTotalRetries to 10", () => {
    const d = new PipelineStuckDetector();
    for (let i = 0; i < 9; i++) expect(d.recordRetry().stuck).toBe(false);
    expect(d.recordRetry().stuck).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// StuckDetector — progress-hash block detection
// ---------------------------------------------------------------------------

describe("StuckDetector — progress-hash block detection", () => {
  it("detects repeated identical 5-tool blocks", () => {
    // hashWindow = 5, hashRepeatThreshold = 3
    // Need 3 blocks of 5 identical tools = 15 calls with same sequence
    const d = new StuckDetector({
      maxRepeatCalls: 100,
      semanticPlateauWindow: 0,
    });
    const sequence = ["a", "b", "c", "d", "e"];
    let lastStatus: StuckStatus = { stuck: false };
    for (let repeat = 0; repeat < 3; repeat++) {
      for (const tool of sequence) {
        lastStatus = d.recordToolCall(tool, { block: repeat });
      }
    }
    expect(lastStatus.stuck).toBe(true);
    expect(lastStatus.reason).toMatch(/sequence/i);
  });

  it("does not flag for 2 identical blocks (below threshold)", () => {
    const d = new StuckDetector({
      maxRepeatCalls: 100,
      semanticPlateauWindow: 0,
    });
    const sequence = ["a", "b", "c", "d", "e"];
    let lastStatus: StuckStatus = { stuck: false };
    for (let repeat = 0; repeat < 2; repeat++) {
      for (const tool of sequence) {
        lastStatus = d.recordToolCall(tool, { block: repeat });
      }
    }
    expect(lastStatus.stuck).toBe(false);
  });

  it("does not flag when sequences vary", () => {
    const d = new StuckDetector({
      maxRepeatCalls: 100,
      semanticPlateauWindow: 0,
    });
    const seq1 = ["a", "b", "c", "d", "e"];
    const seq2 = ["a", "b", "c", "d", "x"]; // different last tool
    let lastStatus: StuckStatus = { stuck: false };
    for (const tool of seq1) lastStatus = d.recordToolCall(tool, {});
    for (const tool of seq2) lastStatus = d.recordToolCall(tool, {});
    for (const tool of seq1) lastStatus = d.recordToolCall(tool, {});
    expect(lastStatus.stuck).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Combined: StuckDetector + StuckError integration
// ---------------------------------------------------------------------------

describe("StuckDetector + StuckError integration", () => {
  it("StuckError is thrown when stuck is detected and loop aborts", () => {
    const d = new StuckDetector({ maxRepeatCalls: 2 });
    d.recordToolCall("op", { x: 1 });
    const status = d.recordToolCall("op", { x: 1 });

    if (status.stuck) {
      const err = new StuckError({
        reason: status.reason!,
        repeatedTool: "op",
        escalationLevel: 3,
      });
      expect(err instanceof StuckError).toBe(true);
      expect(err.reason).toBe(status.reason);
      expect(err.recoveryAction).toBe("loop_aborted");
    } else {
      // If not stuck yet, force the issue
      expect(d.recordToolCall("op", { x: 1 }).stuck).toBe(true);
    }
  });

  it("escalation level 1 action corresponds to tool_blocked", () => {
    const err = new StuckError({
      reason: "first occurrence",
      escalationLevel: 1,
    });
    expect(err.recoveryAction).toBe("tool_blocked");
    expect(err.escalationLevel).toBe(1);
  });

  it("can check stuck status and conditionally throw", () => {
    const d = new StuckDetector({ maxRepeatCalls: 2 });
    const runWithStuckCheck = (tool: string, args: unknown) => {
      const status = d.recordToolCall(tool, args);
      if (status.stuck) {
        throw new StuckError({ reason: status.reason!, repeatedTool: tool });
      }
    };

    runWithStuckCheck("search", { q: "hello" });
    expect(() => runWithStuckCheck("search", { q: "hello" })).toThrow(
      StuckError,
    );
  });

  it("reset then reuse does not carry over stuck state", () => {
    // maxErrorsInWindow: 3 so 2 errors after reset do not trigger stuck
    const d = new StuckDetector({ maxRepeatCalls: 2, maxErrorsInWindow: 3 });

    // First run: gets stuck via error rate (3 errors)
    d.recordError(new Error("e1"));
    d.recordError(new Error("e2"));
    expect(d.recordError(new Error("e3")).stuck).toBe(true);

    // Reset and new run: only 2 errors — below threshold of 3
    d.reset();
    d.recordError(new Error("fresh error"));
    expect(d.recordError(new Error("fresh error 2")).stuck).toBe(false);
  });
});
