import { describe, it, expect, beforeEach } from "vitest";
import {
  TokenLifecycleManager,
  createTokenBudget,
  measureTokenText,
} from "../token-lifecycle.js";
import type {
  TokenBudget,
  TokenCounter,
  TokenLifecycleConfig,
  TokenLifecycleReport,
} from "../token-lifecycle.js";

/**
 * Coverage for TokenLifecycleManager (CF-0007).
 * 40+ tests covering constructor, track(), status thresholds, report shape,
 * recommendation strings, reset(), and edge cases.
 */
describe("createTokenBudget", () => {
  it("creates a budget with total, reserved, available", () => {
    const b = createTokenBudget(200_000, 4_096);
    expect(b.total).toBe(200_000);
    expect(b.reserved).toBe(4_096);
    expect(b.available).toBe(195_904);
  });

  it("clamps negative available to 0 (reserved > total)", () => {
    const b = createTokenBudget(100, 500);
    expect(b.available).toBe(0);
  });

  it("handles zero total + zero reserved", () => {
    const b = createTokenBudget(0, 0);
    expect(b.available).toBe(0);
  });
});

describe("TokenLifecycleManager — construction", () => {
  it("constructs with default budget (200k/4k)", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(200_000, 4_096),
    });
    expect(mgr.usedTokens).toBe(0);
    expect(mgr.remainingTokens).toBe(195_904);
  });

  it('initial status is "ok"', () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(100_000, 4_000),
    });
    expect(mgr.status).toBe("ok");
  });

  it("initial phases are empty", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(100_000, 4_000),
    });
    expect(mgr.report.phases).toEqual([]);
  });

  it("accepts custom warnThresholdPct", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
      warnThresholdPct: 0.5,
    });
    mgr.track("x", 500); // exactly 50%
    expect(mgr.status).toBe("warn");
  });

  it("accepts custom criticalThresholdPct", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
      criticalThresholdPct: 0.5,
    });
    mgr.track("x", 500); // exactly 50%
    expect(mgr.status).toBe("critical");
  });
});

describe("TokenLifecycleManager — track() basic", () => {
  let mgr: TokenLifecycleManager;
  const budget: TokenBudget = createTokenBudget(10_000, 0);

  beforeEach(() => {
    mgr = new TokenLifecycleManager({ budget });
  });

  it("track() accumulates usedTokens", () => {
    mgr.track("system", 1000);
    expect(mgr.usedTokens).toBe(1000);
  });

  it("multiple track() calls sum correctly", () => {
    mgr.track("system", 1000);
    mgr.track("user", 500);
    mgr.track("assistant", 250);
    expect(mgr.usedTokens).toBe(1750);
  });

  it("same phase tracked twice: both entries recorded", () => {
    mgr.track("history", 100);
    mgr.track("history", 200);
    expect(mgr.report.phases).toHaveLength(2);
    expect(mgr.report.phases[0]?.tokens).toBe(100);
    expect(mgr.report.phases[1]?.tokens).toBe(200);
  });

  it("remainingTokens = available - usedTokens", () => {
    mgr.track("system", 3000);
    expect(mgr.remainingTokens).toBe(10_000 - 3000);
  });

  it("tracking zero tokens is a no-op semantically", () => {
    mgr.track("empty", 0);
    expect(mgr.usedTokens).toBe(0);
    expect(mgr.report.phases).toHaveLength(1);
  });

  it("phase name preserved in report.phases[].phase", () => {
    mgr.track("custom-phase", 123);
    expect(mgr.report.phases[0]?.phase).toBe("custom-phase");
  });

  it("each phase entry has numeric timestamp", () => {
    const before = Date.now();
    mgr.track("x", 1);
    const after = Date.now();
    const ts = mgr.report.phases[0]?.timestamp;
    expect(typeof ts).toBe("number");
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("phase entry has tokens field", () => {
    mgr.track("x", 99);
    expect(mgr.report.phases[0]?.tokens).toBe(99);
  });
});

describe("TokenLifecycleManager — status thresholds (default 0.8 / 0.95)", () => {
  const budget: TokenBudget = createTokenBudget(1000, 0); // 1000 available

  it('status "ok" when pct < 0.8', () => {
    const mgr = new TokenLifecycleManager({ budget });
    mgr.track("x", 799); // 79.9%
    expect(mgr.status).toBe("ok");
  });

  it('status "warn" when pct == 0.8 (exact threshold)', () => {
    const mgr = new TokenLifecycleManager({ budget });
    mgr.track("x", 800); // 80%
    expect(mgr.status).toBe("warn");
  });

  it('status "warn" when 0.8 <= pct < 0.95', () => {
    const mgr = new TokenLifecycleManager({ budget });
    mgr.track("x", 900); // 90%
    expect(mgr.status).toBe("warn");
  });

  it('status "critical" when pct == 0.95 (exact threshold)', () => {
    const mgr = new TokenLifecycleManager({ budget });
    mgr.track("x", 950); // 95%
    expect(mgr.status).toBe("critical");
  });

  it('status "critical" when 0.95 <= pct < 1.0', () => {
    const mgr = new TokenLifecycleManager({ budget });
    mgr.track("x", 999); // 99.9%
    expect(mgr.status).toBe("critical");
  });

  it('status "exhausted" when pct == 1.0', () => {
    const mgr = new TokenLifecycleManager({ budget });
    mgr.track("x", 1000); // 100%
    expect(mgr.status).toBe("exhausted");
  });

  it('status "exhausted" when pct > 1.0 (over budget)', () => {
    const mgr = new TokenLifecycleManager({ budget });
    mgr.track("x", 2000); // 200%
    expect(mgr.status).toBe("exhausted");
  });
});

describe("TokenLifecycleManager — custom thresholds", () => {
  it("custom warn=0.5 fires earlier", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
      warnThresholdPct: 0.5,
    });
    mgr.track("x", 500);
    expect(mgr.status).toBe("warn");
  });

  it("custom critical=0.9 fires earlier", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
      criticalThresholdPct: 0.9,
    });
    mgr.track("x", 900);
    expect(mgr.status).toBe("critical");
  });

  it("custom warn=0.5, critical=0.7 with 400 tokens → ok", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
      warnThresholdPct: 0.5,
      criticalThresholdPct: 0.7,
    });
    mgr.track("x", 400);
    expect(mgr.status).toBe("ok");
  });

  it("custom warn=0.5, critical=0.7 with 600 tokens → warn", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
      warnThresholdPct: 0.5,
      criticalThresholdPct: 0.7,
    });
    mgr.track("x", 600);
    expect(mgr.status).toBe("warn");
  });

  it("custom warn=0.5, critical=0.7 with 800 tokens → critical", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
      warnThresholdPct: 0.5,
      criticalThresholdPct: 0.7,
    });
    mgr.track("x", 800);
    expect(mgr.status).toBe("critical");
  });
});

describe("TokenLifecycleManager — report shape", () => {
  it("report.used equals usedTokens", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    mgr.track("a", 250);
    expect(mgr.report.used).toBe(mgr.usedTokens);
  });

  it("report.available equals budget.available", () => {
    const b = createTokenBudget(2000, 100);
    const mgr = new TokenLifecycleManager({ budget: b });
    expect(mgr.report.available).toBe(b.available);
  });

  it("report.pct is 0 initially", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    expect(mgr.report.pct).toBe(0);
  });

  it("report.pct equals used / available", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    mgr.track("x", 300);
    expect(mgr.report.pct).toBeCloseTo(0.3, 5);
  });

  it("report.pct clamped to 1.0 when over budget", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    mgr.track("x", 5000);
    expect(mgr.report.pct).toBe(1);
  });

  it("report.phases length matches number of track() calls", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(10_000, 0),
    });
    mgr.track("a", 1);
    mgr.track("b", 2);
    mgr.track("c", 3);
    expect(mgr.report.phases).toHaveLength(3);
  });

  it("report.phases is a copy (not a live reference)", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(10_000, 0),
    });
    mgr.track("a", 1);
    const snapshot = mgr.report.phases;
    mgr.track("b", 2);
    // snapshot should not gain the new entry
    expect(snapshot).toHaveLength(1);
  });

  it("report.status matches manager.status", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    mgr.track("x", 900);
    expect(mgr.report.status).toBe(mgr.status);
  });
});

describe("TokenLifecycleManager — recommendation strings", () => {
  it("recommendation is undefined when status=ok", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    mgr.track("x", 100);
    expect(mgr.report.recommendation).toBeUndefined();
  });

  it("recommendation is a string when status=warn", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    mgr.track("x", 850);
    const rec = mgr.report.recommendation;
    expect(typeof rec).toBe("string");
    expect(rec!.length).toBeGreaterThan(0);
  });

  it("recommendation mentions compression when status=warn", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    mgr.track("x", 850);
    expect(mgr.report.recommendation).toMatch(/compress/i);
  });

  it("recommendation is a string when status=critical", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    mgr.track("x", 970);
    expect(typeof mgr.report.recommendation).toBe("string");
  });

  it("recommendation signals urgency when status=critical", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    mgr.track("x", 970);
    expect(mgr.report.recommendation).toMatch(/immediately|truncate|critical/i);
  });

  it("recommendation is a string when status=exhausted", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    mgr.track("x", 1500);
    expect(typeof mgr.report.recommendation).toBe("string");
  });

  it("recommendation signals exhaustion when status=exhausted", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    mgr.track("x", 1500);
    expect(mgr.report.recommendation).toMatch(/exhausted|must/i);
  });
});

describe("TokenLifecycleManager — reset()", () => {
  it("reset() clears usedTokens to 0", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    mgr.track("x", 500);
    mgr.reset();
    expect(mgr.usedTokens).toBe(0);
  });

  it("reset() clears phases", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    mgr.track("a", 1);
    mgr.track("b", 2);
    mgr.reset();
    expect(mgr.report.phases).toEqual([]);
  });

  it("reset() returns status to ok", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    mgr.track("x", 999);
    expect(mgr.status).toBe("critical");
    mgr.reset();
    expect(mgr.status).toBe("ok");
  });

  it("track() works normally after reset()", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    mgr.track("x", 500);
    mgr.reset();
    mgr.track("y", 100);
    expect(mgr.usedTokens).toBe(100);
    expect(mgr.report.phases).toHaveLength(1);
  });

  it("reset() on a fresh manager is a no-op", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    expect(() => mgr.reset()).not.toThrow();
    expect(mgr.usedTokens).toBe(0);
  });
});

describe("TokenLifecycleManager — edge cases", () => {
  it("zero-budget manager starts exhausted", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(0, 0),
    });
    expect(mgr.status).toBe("exhausted");
  });

  it("zero-budget report.pct is 1", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(0, 0),
    });
    expect(mgr.report.pct).toBe(1);
  });

  it("reserved >= total → status exhausted", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(100, 200),
    });
    expect(mgr.status).toBe("exhausted");
  });

  it("very large input does not overflow", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1_000_000, 0),
    });
    mgr.track("huge", 999_999);
    expect(mgr.usedTokens).toBe(999_999);
    expect(mgr.status).toBe("critical");
  });

  it("remaining is 0 at exactly budget", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(500, 0),
    });
    mgr.track("x", 500);
    expect(mgr.remainingTokens).toBe(0);
  });

  it("remaining is 0 when exceeding budget (not negative)", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(500, 0),
    });
    mgr.track("x", 9999);
    expect(mgr.remainingTokens).toBe(0);
  });

  it("reserved tokens reduce available accordingly", () => {
    const b = createTokenBudget(1000, 100);
    expect(b.available).toBe(900);
    const mgr = new TokenLifecycleManager({ budget: b });
    mgr.track("x", 900);
    expect(mgr.status).toBe("exhausted");
  });

  it("config accepts 0 threshold edge", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
      warnThresholdPct: 0,
    });
    mgr.track("x", 1);
    // pct=0.001 >= warn=0 → warn
    expect(mgr.status).toBe("warn");
  });

  it("config accepts 1.0 threshold edge", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
      warnThresholdPct: 1.0,
      criticalThresholdPct: 1.0,
    });
    mgr.track("x", 999);
    // pct=0.999 < 1.0 → ok
    expect(mgr.status).toBe("ok");
  });
});

describe("TokenLifecycleManager — type contracts", () => {
  it("TokenLifecycleReport matches interface shape", () => {
    const mgr = new TokenLifecycleManager({
      budget: createTokenBudget(1000, 0),
    });
    const report: TokenLifecycleReport = mgr.report;
    expect(report).toHaveProperty("used");
    expect(report).toHaveProperty("available");
    expect(report).toHaveProperty("pct");
    expect(report).toHaveProperty("status");
    expect(report).toHaveProperty("phases");
  });

  it("TokenLifecycleConfig accepts full config", () => {
    const cfg: TokenLifecycleConfig = {
      budget: createTokenBudget(1000, 0),
      warnThresholdPct: 0.8,
      criticalThresholdPct: 0.95,
    };
    const mgr = new TokenLifecycleManager(cfg);
    expect(mgr.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// measureTokenText — every module that needs a hard-budget-safe measurement
// funnels through this function, but it was previously only exercised
// indirectly (via exact/heuristic fixture shapes in other test files),
// leaving its own defensive branches — a countDetailed() that throws, a
// count-only counter with no countDetailed at all, and an out-of-range
// tokens value from countDetailed — uncovered. Each of these branches
// exists specifically so a misbehaving TokenCounter degrades to a heuristic
// measurement instead of the hard-budget code silently trusting bad data.
// ---------------------------------------------------------------------------
describe("measureTokenText", () => {
  it("uses the tokenizer-backed result when countDetailed succeeds with a valid integer", () => {
    const counter: TokenCounter = {
      count: (text) => text.length,
      countDetailed: (text) => ({
        tokens: text.length,
        method: "exact",
        model: "test",
      }),
    };
    const result = measureTokenText("hello", counter, "test", 4);
    expect(result).toEqual({ tokens: 5, method: "exact", model: "test" });
  });

  it('falls back to count() and reports "detailed token measurement failed" when countDetailed throws', () => {
    const counter: TokenCounter = {
      count: (text) => text.length,
      countDetailed: () => {
        throw new Error("tokenizer crashed");
      },
    };
    const result = measureTokenText("hello", counter, undefined, 4);
    expect(result).toEqual({
      tokens: 5,
      method: "heuristic",
      reason: "detailed token measurement failed",
    });
  });

  it('falls back to count() and reports "detailed token measurement failed" when countDetailed returns a non-integer', () => {
    const counter: TokenCounter = {
      count: () => 7,
      countDetailed: () => ({ tokens: 2.5, method: "exact" }),
    };
    const result = measureTokenText("hello", counter);
    expect(result).toEqual({
      tokens: 7,
      method: "heuristic",
      reason: "detailed token measurement failed",
    });
  });

  it("falls back to count() when countDetailed returns a negative token count", () => {
    const counter: TokenCounter = {
      count: () => 4,
      countDetailed: () => ({ tokens: -1, method: "exact" }),
    };
    const result = measureTokenText("hello", counter);
    expect(result.tokens).toBe(4);
    expect(result.method).toBe("heuristic");
  });

  it("falls back to count() when countDetailed returns a non-finite token count", () => {
    const counter: TokenCounter = {
      count: () => 4,
      countDetailed: () => ({
        tokens: Number.POSITIVE_INFINITY,
        method: "exact",
      }),
    };
    const result = measureTokenText("hello", counter);
    expect(result.tokens).toBe(4);
    expect(result.method).toBe("heuristic");
  });

  it("includes the model field on the countDetailed-failure fallback when a model is given", () => {
    const counter: TokenCounter = {
      count: () => 4,
      countDetailed: () => {
        throw new Error("boom");
      },
    };
    const result = measureTokenText("hello", counter, "gpt-4o");
    expect(result.model).toBe("gpt-4o");
  });

  it('uses count() directly and reports "does not expose measurement provenance" for a count-only counter', () => {
    const countOnlyCounter: TokenCounter = {
      count: (text) => Math.ceil(text.length / 2),
    };
    const result = measureTokenText(
      "hello world",
      countOnlyCounter,
      undefined,
      4
    );
    expect(result).toEqual({
      tokens: 6,
      method: "heuristic",
      reason: "token counter does not expose measurement provenance",
    });
  });

  it("includes the model field for a count-only counter when a model is given", () => {
    const countOnlyCounter: TokenCounter = {
      count: (text) => text.length,
    };
    const result = measureTokenText("hi", countOnlyCounter, "claude-haiku");
    expect(result.model).toBe("claude-haiku");
  });

  it("falls back to the chars-per-token estimate when no counter is supplied", () => {
    const result = measureTokenText("12345678", undefined, undefined, 4);
    expect(result).toEqual({
      tokens: 2,
      method: "heuristic",
      reason: "chars-per-token estimate (4)",
    });
  });

  it("uses the given charsPerToken in both the token count and the reason string", () => {
    const result = measureTokenText("123456", undefined, undefined, 2);
    expect(result.tokens).toBe(3);
    expect(result.reason).toBe("chars-per-token estimate (2)");
  });

  it("includes the model field on the no-counter fallback when a model is given", () => {
    const result = measureTokenText("hi", undefined, "gpt-4o", 4);
    expect(result.model).toBe("gpt-4o");
  });
});
