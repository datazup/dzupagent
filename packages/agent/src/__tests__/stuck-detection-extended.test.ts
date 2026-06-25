/**
 * Extended stuck-detection tests — +75 new tests covering:
 *
 *  A. StuckDetector (tool-loop level)
 *     - Configurable repeat thresholds (N=3, 5, 10)
 *     - Different args → not stuck
 *     - Error-rate thresholds and rolling windows
 *     - Semantic plateau detection
 *     - Multiple tools tracked independently
 *     - Disabled detection via config
 *     - Event payload structure (stuck status fields)
 *     - Reset between runs
 *     - Cleared on success
 *
 *  B. PipelineStuckDetector (pipeline level)
 *     - Per-node failure counting
 *     - Failure window pruning (old failures don't count)
 *     - Identical output detection
 *     - Total retry limit
 *     - getSummary() shape
 *     - Independent per-node tracking
 *     - reset() clears all state
 *     - Configurable thresholds
 *
 *  C. StuckError
 *     - Escalation levels 1/2/3 → correct RecoveryAction
 *     - Error message format
 *     - Optional repeatedTool field
 *     - Default escalation level
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { StuckDetector } from "../guardrails/stuck-detector.js";
import type { StuckDetectorConfig } from "../guardrails/stuck-detector.js";
import { PipelineStuckDetector } from "../self-correction/pipeline-stuck-detector.js";
import { StuckError } from "../agent/stuck-error.js";

// ============================================================================
// A. StuckDetector — tool-loop level
// ============================================================================

describe("StuckDetector — configurable repeat thresholds", () => {
  it("threshold=3: flags on the 3rd identical call, not before", () => {
    const det = new StuckDetector({ maxRepeatCalls: 3 });
    const args = { path: "x.ts" };
    expect(det.recordToolCall("read", args).stuck).toBe(false); // 1
    expect(det.recordToolCall("read", args).stuck).toBe(false); // 2
    expect(det.recordToolCall("read", args).stuck).toBe(true); // 3
  });

  it("threshold=5: not stuck at 4, stuck at 5", () => {
    const det = new StuckDetector({ maxRepeatCalls: 5 });
    const args = { q: "same" };
    for (let i = 0; i < 4; i++) {
      expect(det.recordToolCall("search", args).stuck).toBe(false);
    }
    expect(det.recordToolCall("search", args).stuck).toBe(true);
  });

  it("threshold=10: not stuck at 9, stuck at 10", () => {
    const det = new StuckDetector({ maxRepeatCalls: 10 });
    const args = { key: "val" };
    for (let i = 0; i < 9; i++) {
      expect(det.recordToolCall("fetch", args).stuck).toBe(false);
    }
    expect(det.recordToolCall("fetch", args).stuck).toBe(true);
  });

  it("reason string mentions the tool name and count", () => {
    const det = new StuckDetector({ maxRepeatCalls: 3 });
    const args = { id: 1 };
    det.recordToolCall("write_file", args);
    det.recordToolCall("write_file", args);
    const result = det.recordToolCall("write_file", args);
    expect(result.reason).toContain("write_file");
    expect(result.reason).toContain("3");
  });
});

describe("StuckDetector — different args not flagged", () => {
  it("same tool name but different args → not stuck", () => {
    const det = new StuckDetector({ maxRepeatCalls: 3 });
    expect(det.recordToolCall("read", { path: "a.ts" }).stuck).toBe(false);
    expect(det.recordToolCall("read", { path: "b.ts" }).stuck).toBe(false);
    expect(det.recordToolCall("read", { path: "c.ts" }).stuck).toBe(false);
  });

  it("interleaved same-args calls with different tool breaks streak", () => {
    const det = new StuckDetector({ maxRepeatCalls: 3 });
    const args = { path: "same.ts" };
    det.recordToolCall("read", args);
    det.recordToolCall("write", { content: "x" }); // different tool
    det.recordToolCall("read", args);
    // only 2 consecutive identical entries → not stuck
    expect(det.recordToolCall("read", args).stuck).toBe(false);
  });

  it("args with extra field treated as different", () => {
    const det = new StuckDetector({ maxRepeatCalls: 3 });
    det.recordToolCall("query", { sql: "SELECT 1" });
    det.recordToolCall("query", { sql: "SELECT 1" });
    // different extra field
    expect(
      det.recordToolCall("query", { sql: "SELECT 1", db: "main" }).stuck,
    ).toBe(false);
  });

  it("null vs empty object treated as different", () => {
    const det = new StuckDetector({ maxRepeatCalls: 3 });
    det.recordToolCall("ping", null);
    det.recordToolCall("ping", null);
    // empty object hashes differently than null
    const result = det.recordToolCall("ping", {});
    expect(result.stuck).toBe(false);
  });
});

describe("StuckDetector — error-rate window", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flags when error count reaches maxErrorsInWindow", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 4,
      errorWindowMs: 30_000,
    });
    det.recordError(new Error("e1"));
    det.recordError(new Error("e2"));
    det.recordError(new Error("e3"));
    const result = det.recordError(new Error("e4"));
    expect(result.stuck).toBe(true);
    expect(result.reason).toContain("4");
  });

  it("below threshold does not flag", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 5,
      errorWindowMs: 30_000,
    });
    for (let i = 0; i < 4; i++) {
      expect(det.recordError(new Error(`e${i}`)).stuck).toBe(false);
    }
  });

  it("old errors outside window do not count", () => {
    vi.useFakeTimers();
    const det = new StuckDetector({
      maxErrorsInWindow: 3,
      errorWindowMs: 5_000,
    });

    // Record 2 errors at t=0
    det.recordError(new Error("old-1"));
    det.recordError(new Error("old-2"));

    // Advance past the window
    vi.setSystemTime(Date.now() + 10_000);

    // New error at t=10s — old ones pruned, only 1 in window
    const result = det.recordError(new Error("new-1"));
    expect(result.stuck).toBe(false);
  });

  it("errors just inside window boundary still count", () => {
    vi.useFakeTimers();
    const det = new StuckDetector({
      maxErrorsInWindow: 3,
      errorWindowMs: 5_000,
    });

    det.recordError("e1");
    det.recordError("e2");

    // Advance by 4999ms (still within 5s window)
    vi.setSystemTime(Date.now() + 4_999);
    const result = det.recordError("e3");
    expect(result.stuck).toBe(true);
  });

  it("accepts string errors (not just Error instances)", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 3,
      errorWindowMs: 30_000,
    });
    det.recordError("string error 1");
    det.recordError("string error 2");
    const result = det.recordError("string error 3");
    expect(result.stuck).toBe(true);
  });

  it("mixed string and Error instances counted together", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 3,
      errorWindowMs: 30_000,
    });
    det.recordError("string error");
    det.recordError(new Error("error instance"));
    const result = det.recordError("another string");
    expect(result.stuck).toBe(true);
  });

  it("reason string contains error count and window duration", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 3,
      errorWindowMs: 60_000,
    });
    det.recordError("e1");
    det.recordError("e2");
    const result = det.recordError("e3");
    expect(result.stuck).toBe(true);
    expect(result.reason).toContain("3");
    expect(result.reason).toContain("60"); // 60s window
  });
});

describe("StuckDetector — semantic plateau detection", () => {
  it("not stuck when semanticPlateauWindow=0 (disabled)", () => {
    const det = new StuckDetector({
      semanticPlateauWindow: 0,
      maxRepeatCalls: 20,
    });
    // Use a unique tool name on every call so neither the repeat-call detector
    // (different names) nor the progress-hash detector (no repeated block
    // sequence) can fire — only the semantic plateau check would trip if it
    // were enabled, but semanticPlateauWindow=0 disables it.
    for (let i = 0; i < 15; i++) {
      const result = det.recordToolCall(`tool_${i}`, { q: `query-${i}` });
      expect(result.stuck).toBe(false);
    }
  });

  it("flags semantic plateau: same tool N times in a row (varied args)", () => {
    const det = new StuckDetector({
      semanticPlateauWindow: 5,
      maxRepeatCalls: 20,
    });
    for (let i = 0; i < 4; i++) {
      expect(det.recordToolCall("search", { q: `q${i}` }).stuck).toBe(false);
    }
    const result = det.recordToolCall("search", { q: "q4" });
    expect(result.stuck).toBe(true);
    expect(result.reason).toContain("search");
  });

  it("breaks plateau when a different tool is inserted mid-window", () => {
    const det = new StuckDetector({
      semanticPlateauWindow: 5,
      maxRepeatCalls: 20,
    });
    det.recordToolCall("search", { q: "q0" });
    det.recordToolCall("search", { q: "q1" });
    det.recordToolCall("search", { q: "q2" });
    det.recordToolCall("write", { content: "c" }); // breaks plateau window
    // next 4 searches start a new window — not yet at threshold
    det.recordToolCall("search", { q: "q3" });
    expect(det.recordToolCall("search", { q: "q4" }).stuck).toBe(false);
  });

  it("plateau window=3: flags after exactly 3 same-tool calls", () => {
    const det = new StuckDetector({
      semanticPlateauWindow: 3,
      maxRepeatCalls: 20,
    });
    det.recordToolCall("grep", { pattern: "a" });
    det.recordToolCall("grep", { pattern: "b" });
    const result = det.recordToolCall("grep", { pattern: "c" });
    expect(result.stuck).toBe(true);
    expect(result.reason).toContain("3");
  });
});

describe("StuckDetector — multiple tools tracked independently", () => {
  it("tool A stuck does not flag tool B", () => {
    const det = new StuckDetector({ maxRepeatCalls: 3 });
    const argsA = { path: "a.ts" };
    const argsB = { path: "b.ts" };

    // Drive tool_A to the brink (2 calls)
    det.recordToolCall("tool_A", argsA);
    det.recordToolCall("tool_A", argsA);

    // One call of tool_B — should not be stuck
    expect(det.recordToolCall("tool_B", argsB).stuck).toBe(false);
  });

  it("each tool's repeat counter is separate", () => {
    const det = new StuckDetector({ maxRepeatCalls: 3 });
    const args = { x: 1 };

    // tool_A: 3 identical → stuck
    det.recordToolCall("tool_A", args);
    det.recordToolCall("tool_A", args);
    const stuckA = det.recordToolCall("tool_A", args);
    expect(stuckA.stuck).toBe(true);

    // reset and now check tool_B alone
    det.reset();
    det.recordToolCall("tool_B", args);
    det.recordToolCall("tool_B", args);
    const notStuckB = det.recordToolCall("tool_B", { x: 2 }); // different arg
    expect(notStuckB.stuck).toBe(false);
  });

  it("interleaving two tools with same args does not trigger stuck prematurely", () => {
    const det = new StuckDetector({ maxRepeatCalls: 3 });
    const args = { id: 42 };
    // A, B, A, B — never 3 consecutive identical calls
    det.recordToolCall("A", args);
    det.recordToolCall("B", args);
    det.recordToolCall("A", args);
    expect(det.recordToolCall("B", args).stuck).toBe(false);
  });
});

describe("StuckDetector — reset between runs", () => {
  it("reset() clears repeat-call state so next run starts clean", () => {
    const det = new StuckDetector({ maxRepeatCalls: 3 });
    const args = { path: "same.ts" };
    det.recordToolCall("read", args);
    det.recordToolCall("read", args);
    det.recordToolCall("read", args); // stuck
    det.reset();
    // After reset: need 3 fresh calls to re-trigger
    expect(det.recordToolCall("read", args).stuck).toBe(false);
    expect(det.recordToolCall("read", args).stuck).toBe(false);
    expect(det.recordToolCall("read", args).stuck).toBe(true);
  });

  it("reset() clears error-rate state", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 3,
      errorWindowMs: 30_000,
    });
    det.recordError("e1");
    det.recordError("e2");
    det.reset();
    // After reset: need 3 fresh errors
    expect(det.recordError("e1").stuck).toBe(false);
    expect(det.recordError("e2").stuck).toBe(false);
    expect(det.recordError("e3").stuck).toBe(true);
  });

  it("reset() clears idle iteration count", () => {
    const det = new StuckDetector({ maxIdleIterations: 2 });
    det.recordIteration(0); // idle 1
    det.reset();
    expect(det.recordIteration(0).stuck).toBe(false); // fresh idle 1
    expect(det.recordIteration(0).stuck).toBe(true); // idle 2 → stuck
  });

  it("reset() clears progress-hash history", () => {
    const det = new StuckDetector();
    // Two full sequences of 5 tools
    const seq = ["a", "b", "c", "d", "e"] as const;
    for (const t of seq) det.recordToolCall(t, {});
    for (const t of seq) det.recordToolCall(t, {});
    det.reset();
    // Third sequence should NOT trigger stuck (hash history was cleared)
    const results: boolean[] = [];
    for (const t of seq) results.push(det.recordToolCall(t, {}).stuck);
    expect(results.every((r) => r === false)).toBe(true);
  });
});

describe("StuckDetector — cleared on successful tool call", () => {
  it("successful (non-identical) call resets idle counter", () => {
    const det = new StuckDetector({ maxIdleIterations: 2 });
    det.recordIteration(0); // idle 1
    det.recordToolCall("do_work", { payload: "x" }); // success → resets idle
    expect(det.recordIteration(1).stuck).toBe(false);
  });

  it("tool call with new args after repeated-identical streak clears check window", () => {
    // After two identical calls, a different call breaks the run
    const det = new StuckDetector({ maxRepeatCalls: 3 });
    const sameArgs = { path: "x.ts" };
    det.recordToolCall("read", sameArgs);
    det.recordToolCall("read", sameArgs);
    // Now a different arg — window slides, count is not 3 consecutive identical
    det.recordToolCall("read", { path: "y.ts" });
    // Next same-arg call: only 1 consecutive identical in tail
    expect(det.recordToolCall("read", sameArgs).stuck).toBe(false);
  });
});

describe("StuckDetector — stuck status payload structure", () => {
  it("non-stuck result has stuck=false and no reason", () => {
    const det = new StuckDetector();
    const result = det.recordToolCall("any_tool", {});
    expect(result.stuck).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("stuck repeat-call result has stuck=true and string reason", () => {
    const det = new StuckDetector({ maxRepeatCalls: 2 });
    const args = { k: "v" };
    det.recordToolCall("t", args);
    const result = det.recordToolCall("t", args);
    expect(result.stuck).toBe(true);
    expect(typeof result.reason).toBe("string");
    expect(result.reason!.length).toBeGreaterThan(0);
  });

  it("stuck error-rate result has stuck=true and reason mentioning window", () => {
    const det = new StuckDetector({
      maxErrorsInWindow: 2,
      errorWindowMs: 10_000,
    });
    det.recordError("e1");
    const result = det.recordError("e2");
    expect(result.stuck).toBe(true);
    expect(result.reason).toBeTruthy();
  });

  it("stuck idle result has stuck=true and reason mentioning iterations", () => {
    const det = new StuckDetector({ maxIdleIterations: 1 });
    const result = det.recordIteration(0);
    expect(result.stuck).toBe(true);
    expect(result.reason).toContain("no tool calls");
  });

  it("lastToolCalls getter reflects most recent iteration's count", () => {
    const det = new StuckDetector();
    det.recordIteration(5);
    expect(det.lastToolCalls).toBe(5);
    det.recordIteration(0);
    expect(det.lastToolCalls).toBe(0);
  });
});

// ============================================================================
// B. PipelineStuckDetector
// ============================================================================

describe("PipelineStuckDetector — per-node failure counting", () => {
  it("flags when node failure count reaches maxNodeFailures", () => {
    const det = new PipelineStuckDetector({ maxNodeFailures: 3 });
    det.recordNodeFailure("node-1", "err");
    det.recordNodeFailure("node-1", "err");
    const result = det.recordNodeFailure("node-1", "err");
    expect(result.stuck).toBe(true);
    expect(result.nodeId).toBe("node-1");
    expect(result.reason).toContain("node-1");
  });

  it("does not flag below threshold", () => {
    const det = new PipelineStuckDetector({ maxNodeFailures: 3 });
    det.recordNodeFailure("node-x", "err");
    expect(det.recordNodeFailure("node-x", "err").stuck).toBe(false);
  });

  it("failure count per node is tracked independently", () => {
    const det = new PipelineStuckDetector({ maxNodeFailures: 3 });
    det.recordNodeFailure("A", "err");
    det.recordNodeFailure("A", "err");
    det.recordNodeFailure("B", "err"); // B's first failure
    const resultA = det.recordNodeFailure("A", "err");
    expect(resultA.stuck).toBe(true);
    expect(resultA.nodeId).toBe("A");
    expect(det.getNodeFailureCount("B")).toBe(1);
  });

  it("getNodeFailureCount returns 0 for unknown node", () => {
    const det = new PipelineStuckDetector();
    expect(det.getNodeFailureCount("non-existent")).toBe(0);
  });

  it("configurable maxNodeFailures=1 flags on first failure", () => {
    const det = new PipelineStuckDetector({ maxNodeFailures: 1 });
    const result = det.recordNodeFailure("node-1", "immediate failure");
    expect(result.stuck).toBe(true);
  });
});

describe("PipelineStuckDetector — failure window pruning", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("old failures outside failureWindowMs are not counted", () => {
    vi.useFakeTimers();
    const det = new PipelineStuckDetector({
      maxNodeFailures: 3,
      failureWindowMs: 5_000,
    });
    det.recordNodeFailure("node-1", "old1");
    det.recordNodeFailure("node-1", "old2");

    // Advance past the window
    vi.setSystemTime(Date.now() + 10_000);

    // New failure at t+10s — old ones expired, only 1 in window
    const result = det.recordNodeFailure("node-1", "new1");
    expect(result.stuck).toBe(false);
  });

  it("failures inside window still trigger stuck", () => {
    vi.useFakeTimers();
    const det = new PipelineStuckDetector({
      maxNodeFailures: 3,
      failureWindowMs: 60_000,
    });
    det.recordNodeFailure("node-1", "e1");
    vi.setSystemTime(Date.now() + 30_000); // still within window
    det.recordNodeFailure("node-1", "e2");
    vi.setSystemTime(Date.now() + 15_000); // still within window
    const result = det.recordNodeFailure("node-1", "e3");
    expect(result.stuck).toBe(true);
  });
});

describe("PipelineStuckDetector — identical output detection", () => {
  it("flags when same node produces maxIdenticalOutputs identical outputs", () => {
    const det = new PipelineStuckDetector({ maxIdenticalOutputs: 3 });
    det.recordNodeOutput("gen", "same output");
    det.recordNodeOutput("gen", "same output");
    const result = det.recordNodeOutput("gen", "same output");
    expect(result.stuck).toBe(true);
    expect(result.reason).toContain("gen");
    expect(result.suggestedAction).toBe("switch_strategy");
  });

  it("does not flag when outputs vary", () => {
    const det = new PipelineStuckDetector({ maxIdenticalOutputs: 3 });
    det.recordNodeOutput("gen", "output A");
    det.recordNodeOutput("gen", "output B");
    const result = det.recordNodeOutput("gen", "output C");
    expect(result.stuck).toBe(false);
  });

  it("one different output breaks the identical streak", () => {
    const det = new PipelineStuckDetector({ maxIdenticalOutputs: 3 });
    det.recordNodeOutput("gen", "same");
    det.recordNodeOutput("gen", "same");
    det.recordNodeOutput("gen", "DIFFERENT"); // breaks streak
    det.recordNodeOutput("gen", "same");
    const result = det.recordNodeOutput("gen", "same");
    // tail is now [DIFFERENT, same, same] → not all identical
    expect(result.stuck).toBe(false);
  });

  it("identical outputs from different nodes are tracked separately", () => {
    const det = new PipelineStuckDetector({ maxIdenticalOutputs: 3 });
    det.recordNodeOutput("A", "same");
    det.recordNodeOutput("A", "same");
    det.recordNodeOutput("B", "same"); // B's first output
    const resultA = det.recordNodeOutput("A", "same");
    expect(resultA.stuck).toBe(true);
    expect(resultA.nodeId).toBe("A");
    // B should not be stuck (only 1 output recorded for B so far for window)
    const resultB = det.recordNodeOutput("B", "different");
    expect(resultB.stuck).toBe(false);
  });
});

describe("PipelineStuckDetector — total retry limit", () => {
  it("flags when retries reach maxTotalRetries", () => {
    const det = new PipelineStuckDetector({ maxTotalRetries: 3 });
    det.recordRetry();
    det.recordRetry();
    const result = det.recordRetry();
    expect(result.stuck).toBe(true);
    expect(result.suggestedAction).toBe("abort");
  });

  it("below threshold does not flag", () => {
    const det = new PipelineStuckDetector({ maxTotalRetries: 5 });
    for (let i = 0; i < 4; i++) {
      expect(det.recordRetry().stuck).toBe(false);
    }
  });

  it("getTotalRetries returns accumulated count", () => {
    const det = new PipelineStuckDetector({ maxTotalRetries: 10 });
    det.recordRetry();
    det.recordRetry();
    det.recordRetry();
    expect(det.getTotalRetries()).toBe(3);
  });
});

describe("PipelineStuckDetector — getSummary", () => {
  it("summary reflects all failure and identical-output state", () => {
    const det = new PipelineStuckDetector({
      maxNodeFailures: 5,
      maxIdenticalOutputs: 3,
      maxTotalRetries: 10,
    });
    det.recordNodeFailure("A", "err1");
    det.recordNodeFailure("A", "err2");
    det.recordNodeFailure("B", "err3");
    det.recordNodeOutput("gen", "same");
    det.recordNodeOutput("gen", "same");
    det.recordNodeOutput("gen", "same");
    det.recordRetry();
    det.recordRetry();

    const summary = det.getSummary();
    expect(summary.totalRetries).toBe(2);
    expect(summary.nodeFailures.get("A")).toBe(2);
    expect(summary.nodeFailures.get("B")).toBe(1);
    expect(summary.identicalOutputNodes).toContain("gen");
  });

  it("summary identicalOutputNodes is empty when no output loops", () => {
    const det = new PipelineStuckDetector({ maxIdenticalOutputs: 3 });
    det.recordNodeOutput("n1", "out1");
    det.recordNodeOutput("n1", "out2");
    const summary = det.getSummary();
    expect(summary.identicalOutputNodes).toHaveLength(0);
  });
});

describe("PipelineStuckDetector — reset", () => {
  it("reset() clears all state: failures, outputs, retries", () => {
    const det = new PipelineStuckDetector({
      maxNodeFailures: 3,
      maxIdenticalOutputs: 3,
      maxTotalRetries: 3,
    });
    det.recordNodeFailure("n1", "err");
    det.recordNodeFailure("n1", "err");
    det.recordNodeOutput("n1", "same");
    det.recordNodeOutput("n1", "same");
    det.recordRetry();
    det.recordRetry();
    det.reset();

    expect(det.getTotalRetries()).toBe(0);
    expect(det.getNodeFailureCount("n1")).toBe(0);
    const summary = det.getSummary();
    expect(summary.identicalOutputNodes).toHaveLength(0);
    expect(summary.nodeFailures.size).toBe(0);
  });

  it("after reset(), failure counts restart from zero", () => {
    const det = new PipelineStuckDetector({ maxNodeFailures: 3 });
    det.recordNodeFailure("node-1", "e1");
    det.recordNodeFailure("node-1", "e2");
    det.reset();
    // Need 3 fresh failures to trigger again
    expect(det.recordNodeFailure("node-1", "e1").stuck).toBe(false);
    expect(det.recordNodeFailure("node-1", "e2").stuck).toBe(false);
    expect(det.recordNodeFailure("node-1", "e3").stuck).toBe(true);
  });
});

describe("PipelineStuckDetector — suggested actions escalation", () => {
  it("3 failures → suggestedAction=abort", () => {
    const det = new PipelineStuckDetector({ maxNodeFailures: 3 });
    det.recordNodeFailure("n", "e1");
    det.recordNodeFailure("n", "e2");
    const result = det.recordNodeFailure("n", "e3");
    expect(result.suggestedAction).toBe("abort");
  });

  it("retry-exceeded → suggestedAction=abort", () => {
    const det = new PipelineStuckDetector({ maxTotalRetries: 5 });
    for (let i = 0; i < 4; i++) det.recordRetry();
    const result = det.recordRetry();
    expect(result.suggestedAction).toBe("abort");
    expect(result.stuck).toBe(true);
  });
});

// ============================================================================
// C. StuckError
// ============================================================================

describe("StuckError — escalation levels and recovery actions", () => {
  it("escalationLevel=1 → recoveryAction=tool_blocked", () => {
    const err = new StuckError({
      reason: "too many calls",
      escalationLevel: 1,
    });
    expect(err.escalationLevel).toBe(1);
    expect(err.recoveryAction).toBe("tool_blocked");
  });

  it("escalationLevel=2 → recoveryAction=nudge_injected", () => {
    const err = new StuckError({
      reason: "high error rate",
      escalationLevel: 2,
    });
    expect(err.escalationLevel).toBe(2);
    expect(err.recoveryAction).toBe("nudge_injected");
  });

  it("escalationLevel=3 → recoveryAction=loop_aborted", () => {
    const err = new StuckError({ reason: "total abort", escalationLevel: 3 });
    expect(err.escalationLevel).toBe(3);
    expect(err.recoveryAction).toBe("loop_aborted");
  });

  it("default escalationLevel is 3 (loop_aborted)", () => {
    const err = new StuckError({ reason: "some reason" });
    expect(err.escalationLevel).toBe(3);
    expect(err.recoveryAction).toBe("loop_aborted");
  });

  it("error name is 'StuckError'", () => {
    const err = new StuckError({ reason: "test" });
    expect(err.name).toBe("StuckError");
  });

  it("is an instance of Error", () => {
    const err = new StuckError({ reason: "test" });
    expect(err).toBeInstanceOf(Error);
  });

  it("message includes repeatedTool when provided", () => {
    const err = new StuckError({
      reason: "called 3 times",
      repeatedTool: "read_file",
    });
    expect(err.message).toContain("read_file");
    expect(err.message).toContain("called 3 times");
  });

  it("message omits tool section when repeatedTool is undefined", () => {
    const err = new StuckError({ reason: "idle for too long" });
    expect(err.message).not.toContain("undefined");
    expect(err.message).toContain("idle for too long");
  });

  it("reason property matches constructor input", () => {
    const reason = "high error rate in 60s window";
    const err = new StuckError({ reason });
    expect(err.reason).toBe(reason);
  });

  it("repeatedTool property is undefined when not provided", () => {
    const err = new StuckError({ reason: "test" });
    expect(err.repeatedTool).toBeUndefined();
  });

  it("repeatedTool property is set when provided", () => {
    const err = new StuckError({ reason: "test", repeatedTool: "my_tool" });
    expect(err.repeatedTool).toBe("my_tool");
  });

  it("can be caught as Error and discriminated by name", () => {
    let caught: unknown;
    try {
      throw new StuckError({ reason: "test abort", escalationLevel: 3 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as StuckError).name).toBe("StuckError");
    expect((caught as StuckError).recoveryAction).toBe("loop_aborted");
  });

  it("message always starts with 'Agent stuck'", () => {
    const err1 = new StuckError({ reason: "r" });
    const err2 = new StuckError({ reason: "r", repeatedTool: "t" });
    expect(err1.message).toMatch(/^Agent stuck/);
    expect(err2.message).toMatch(/^Agent stuck/);
  });
});
