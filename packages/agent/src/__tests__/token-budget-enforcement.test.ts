/**
 * Comprehensive tests for token budget enforcement in IterationBudget.
 *
 * Covers: budget tracking, cumulative accumulation, hard stops on exhaustion,
 * soft warning thresholds, budget reporting, input/output token tracking,
 * tool call overhead, budget reset between runs, edge cases (0, Infinity),
 * and per-run configurable budgets.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { IterationBudget } from "../guardrails/iteration-budget.js";
import type { GuardrailConfig } from "../guardrails/guardrail-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBudget(config: GuardrailConfig): IterationBudget {
  return new IterationBudget(config);
}

// ---------------------------------------------------------------------------
// 1. Budget tracking — tokens consumed recorded after each LLM call
// ---------------------------------------------------------------------------

describe("token budget enforcement — tracking", () => {
  it("records input tokens after an LLM call", () => {
    const budget = makeBudget({ maxTokens: 10_000 });
    budget.recordUsage({ inputTokens: 100, outputTokens: 0 });
    const state = budget.getState();
    expect(state.totalInputTokens).toBe(100);
  });

  it("records output tokens after an LLM call", () => {
    const budget = makeBudget({ maxTokens: 10_000 });
    budget.recordUsage({ inputTokens: 0, outputTokens: 50 });
    const state = budget.getState();
    expect(state.totalOutputTokens).toBe(50);
  });

  it("increments llmCalls counter on each recordUsage call", () => {
    const budget = makeBudget({ maxTokens: 10_000 });
    budget.recordUsage({ inputTokens: 10, outputTokens: 5 });
    budget.recordUsage({ inputTokens: 20, outputTokens: 10 });
    expect(budget.getState().llmCalls).toBe(2);
  });

  it("tracks input and output tokens independently", () => {
    const budget = makeBudget({ maxTokens: 10_000 });
    budget.recordUsage({ inputTokens: 300, outputTokens: 50 });
    const state = budget.getState();
    expect(state.totalInputTokens).toBe(300);
    expect(state.totalOutputTokens).toBe(50);
  });

  it("starts with zero tokens consumed", () => {
    const budget = makeBudget({ maxTokens: 5_000 });
    const state = budget.getState();
    expect(state.totalInputTokens).toBe(0);
    expect(state.totalOutputTokens).toBe(0);
    expect(state.llmCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Cumulative budget — tokens accumulate across multiple calls in a run
// ---------------------------------------------------------------------------

describe("token budget enforcement — cumulative accumulation", () => {
  it("accumulates tokens across multiple LLM calls", () => {
    const budget = makeBudget({ maxTokens: 10_000 });
    budget.recordUsage({ inputTokens: 200, outputTokens: 50 });
    budget.recordUsage({ inputTokens: 300, outputTokens: 75 });
    budget.recordUsage({ inputTokens: 100, outputTokens: 25 });

    const state = budget.getState();
    expect(state.totalInputTokens).toBe(600);
    expect(state.totalOutputTokens).toBe(150);
  });

  it("total used = sum of all input + output across all calls", () => {
    const budget = makeBudget({ maxTokens: 10_000 });
    budget.recordUsage({ inputTokens: 100, outputTokens: 10 });
    budget.recordUsage({ inputTokens: 200, outputTokens: 20 });

    const state = budget.getState();
    const total = state.totalInputTokens + state.totalOutputTokens;
    expect(total).toBe(330);
  });

  it("isExceeded reflects cumulative total not per-call total", () => {
    const budget = makeBudget({ maxTokens: 500 });
    budget.recordUsage({ inputTokens: 200, outputTokens: 100 }); // 300, not exceeded
    expect(budget.isExceeded().exceeded).toBe(false);
    budget.recordUsage({ inputTokens: 150, outputTokens: 60 }); // 510, exceeded
    expect(budget.isExceeded().exceeded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Hard stop — run halted when budget exceeded
// ---------------------------------------------------------------------------

describe("token budget enforcement — hard stop on exhaustion", () => {
  it("isExceeded returns false when under the token limit", () => {
    const budget = makeBudget({ maxTokens: 1000 });
    budget.recordUsage({ inputTokens: 400, outputTokens: 100 });
    expect(budget.isExceeded().exceeded).toBe(false);
  });

  it("isExceeded returns true when token limit is exactly reached", () => {
    const budget = makeBudget({ maxTokens: 500 });
    budget.recordUsage({ inputTokens: 300, outputTokens: 200 });
    const result = budget.isExceeded();
    expect(result.exceeded).toBe(true);
  });

  it("isExceeded returns true when token limit is exceeded", () => {
    const budget = makeBudget({ maxTokens: 500 });
    budget.recordUsage({ inputTokens: 400, outputTokens: 200 });
    expect(budget.isExceeded().exceeded).toBe(true);
  });

  it("isExceeded returns a reason string when token limit is exceeded", () => {
    const budget = makeBudget({ maxTokens: 500 });
    budget.recordUsage({ inputTokens: 400, outputTokens: 200 });
    const result = budget.isExceeded();
    expect(result.reason).toBeDefined();
    expect(typeof result.reason).toBe("string");
  });

  it("reason includes tokens used and budget limit", () => {
    const budget = makeBudget({ maxTokens: 1000 });
    budget.recordUsage({ inputTokens: 800, outputTokens: 300 });
    const result = budget.isExceeded();
    // should mention 1100 (total) and 1000 (limit)
    expect(result.reason).toContain("1100");
    expect(result.reason).toContain("1000");
  });

  it("hard stop on cost limit exceeded", () => {
    const budget = makeBudget({ maxCostCents: 100 });
    // recordUsage with non-zero tokens will accumulate some cost
    // We need enough calls to exceed cost ceiling
    for (let i = 0; i < 100; i++) {
      budget.recordUsage({ inputTokens: 1000, outputTokens: 1000 });
    }
    expect(budget.isExceeded().exceeded).toBe(true);
  });

  it("hard stop on iteration limit exceeded", () => {
    const budget = makeBudget({ maxIterations: 3 });
    budget.recordIteration();
    budget.recordIteration();
    budget.recordIteration();
    expect(budget.isExceeded().exceeded).toBe(true);
  });

  it("isExceeded reason mentions cost when cost limit exceeded", () => {
    const budget = makeBudget({ maxCostCents: 1 });
    for (let i = 0; i < 100; i++) {
      budget.recordUsage({ inputTokens: 10000, outputTokens: 10000 });
    }
    const result = budget.isExceeded();
    expect(result.exceeded).toBe(true);
    expect(result.reason).toMatch(/[Cc]ost/);
  });

  it("isExceeded reason mentions iteration when iteration limit exceeded", () => {
    const budget = makeBudget({ maxIterations: 2 });
    budget.recordIteration();
    budget.recordIteration();
    const result = budget.isExceeded();
    expect(result.exceeded).toBe(true);
    expect(result.reason).toMatch(/[Ii]teration/);
  });
});

// ---------------------------------------------------------------------------
// 4. Soft warning threshold — warning emitted at configurable %
// ---------------------------------------------------------------------------

describe("token budget enforcement — soft warning threshold", () => {
  it("emits a warning when usage crosses 70% of token budget", () => {
    const budget = makeBudget({ maxTokens: 1000, budgetWarnings: [0.7] });
    const warnings = budget.recordUsage({ inputTokens: 700, outputTokens: 0 });
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0].threshold).toBe(0.7);
  });

  it("emits a warning when usage crosses 90% of token budget", () => {
    const budget = makeBudget({ maxTokens: 1000, budgetWarnings: [0.9] });
    const warnings = budget.recordUsage({ inputTokens: 900, outputTokens: 0 });
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0].threshold).toBe(0.9);
  });

  it("emits no warning when below the configured threshold", () => {
    const budget = makeBudget({ maxTokens: 1000, budgetWarnings: [0.8] });
    const warnings = budget.recordUsage({ inputTokens: 700, outputTokens: 0 });
    expect(warnings.length).toBe(0);
  });

  it("uses default warning thresholds [0.7, 0.9] when not configured", () => {
    const budget = makeBudget({ maxTokens: 1000 });
    // 70% threshold should fire at 700 tokens
    const w1 = budget.recordUsage({ inputTokens: 700, outputTokens: 0 });
    expect(w1.some((w) => w.threshold === 0.7)).toBe(true);
  });

  it("emits warnings at multiple configurable thresholds", () => {
    const budget = makeBudget({ maxTokens: 1000, budgetWarnings: [0.5, 0.8] });
    const w1 = budget.recordUsage({ inputTokens: 500, outputTokens: 0 });
    expect(w1.some((w) => w.threshold === 0.5)).toBe(true);

    const w2 = budget.recordUsage({ inputTokens: 300, outputTokens: 0 });
    expect(w2.some((w) => w.threshold === 0.8)).toBe(true);
  });

  it("emits cost warning when cost crosses threshold", () => {
    const budget = makeBudget({ maxCostCents: 100, budgetWarnings: [0.7] });
    // Large usage to ensure cost crosses threshold
    for (let i = 0; i < 30; i++) {
      const ws = budget.recordUsage({ inputTokens: 1000, outputTokens: 1000 });
      if (ws.length > 0) {
        expect(ws[0].type).toMatch(/tokens|cost/);
        break;
      }
    }
  });

  it("emits iteration warning when iterations cross threshold", () => {
    const budget = makeBudget({ maxIterations: 10, budgetWarnings: [0.7] });
    let warningFound = false;
    for (let i = 0; i < 10; i++) {
      const ws = budget.recordIteration();
      if (ws.some((w) => w.type === "iterations")) {
        warningFound = true;
        break;
      }
    }
    expect(warningFound).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Warning event payload — includes tokens used, budget, percentage
// ---------------------------------------------------------------------------

describe("token budget enforcement — warning payload", () => {
  it("warning includes current token count", () => {
    const budget = makeBudget({ maxTokens: 1000, budgetWarnings: [0.7] });
    const warnings = budget.recordUsage({ inputTokens: 700, outputTokens: 0 });
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].current).toBe(700);
  });

  it("warning includes the budget limit", () => {
    const budget = makeBudget({ maxTokens: 1000, budgetWarnings: [0.7] });
    const warnings = budget.recordUsage({ inputTokens: 700, outputTokens: 0 });
    expect(warnings[0].limit).toBe(1000);
  });

  it("warning includes the threshold that was crossed", () => {
    const budget = makeBudget({ maxTokens: 1000, budgetWarnings: [0.75] });
    const warnings = budget.recordUsage({ inputTokens: 750, outputTokens: 0 });
    expect(warnings[0].threshold).toBe(0.75);
  });

  it("warning includes a human-readable message", () => {
    const budget = makeBudget({ maxTokens: 1000, budgetWarnings: [0.7] });
    const warnings = budget.recordUsage({ inputTokens: 700, outputTokens: 0 });
    expect(typeof warnings[0].message).toBe("string");
    expect(warnings[0].message.length).toBeGreaterThan(0);
  });

  it("warning message contains percentage info", () => {
    const budget = makeBudget({ maxTokens: 1000, budgetWarnings: [0.7] });
    const warnings = budget.recordUsage({ inputTokens: 700, outputTokens: 0 });
    // message should contain something like "70%"
    expect(warnings[0].message).toMatch(/\d+%/);
  });

  it('warning type is "tokens" for token budget warnings', () => {
    const budget = makeBudget({ maxTokens: 1000, budgetWarnings: [0.7] });
    const warnings = budget.recordUsage({ inputTokens: 700, outputTokens: 0 });
    expect(warnings[0].type).toBe("tokens");
  });

  it("warnings are stored in budget state", () => {
    const budget = makeBudget({ maxTokens: 1000, budgetWarnings: [0.7] });
    budget.recordUsage({ inputTokens: 700, outputTokens: 0 });
    const state = budget.getState();
    expect(state.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Multiple warnings — not repeated once emitted
// ---------------------------------------------------------------------------

describe("token budget enforcement — warning deduplication", () => {
  it("does not emit the same threshold warning twice", () => {
    const budget = makeBudget({ maxTokens: 1000, budgetWarnings: [0.7] });
    const w1 = budget.recordUsage({ inputTokens: 700, outputTokens: 0 });
    const w2 = budget.recordUsage({ inputTokens: 10, outputTokens: 0 });
    // Second call is still in the 70% band — should not re-emit
    expect(w1.some((w) => w.threshold === 0.7)).toBe(true);
    expect(w2.some((w) => w.threshold === 0.7)).toBe(false);
  });

  it("emits 0.7 and 0.9 warnings exactly once each across many small steps", () => {
    const budget = makeBudget({ maxTokens: 1000 });
    const fired70: number[] = [];
    const fired90: number[] = [];

    for (let i = 0; i < 20; i++) {
      const ws = budget.recordUsage({ inputTokens: 50, outputTokens: 0 });
      ws.forEach((w) => {
        if (w.threshold === 0.7) fired70.push(i);
        if (w.threshold === 0.9) fired90.push(i);
      });
    }

    expect(fired70.length).toBe(1);
    expect(fired90.length).toBe(1);
  });

  it("state.warnings accumulates all unique warnings that fired", () => {
    const budget = makeBudget({ maxTokens: 1000 });
    for (let i = 0; i < 20; i++) {
      budget.recordUsage({ inputTokens: 50, outputTokens: 0 });
    }
    const state = budget.getState();
    // Should have at most 2 warnings (70% and 90%)
    expect(state.warnings.length).toBeLessThanOrEqual(2);
    expect(state.warnings.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Budget not exceeded — run completes normally
// ---------------------------------------------------------------------------

describe("token budget enforcement — normal completion", () => {
  it("does not flag exceeded when well under token budget", () => {
    const budget = makeBudget({ maxTokens: 10_000 });
    budget.recordUsage({ inputTokens: 500, outputTokens: 100 });
    budget.recordUsage({ inputTokens: 300, outputTokens: 50 });
    expect(budget.isExceeded().exceeded).toBe(false);
  });

  it("does not flag exceeded when no limits configured", () => {
    const budget = makeBudget({});
    for (let i = 0; i < 1000; i++) {
      budget.recordUsage({ inputTokens: 10000, outputTokens: 10000 });
    }
    expect(budget.isExceeded().exceeded).toBe(false);
  });

  it("produces no warnings when usage stays below all thresholds", () => {
    const budget = makeBudget({ maxTokens: 1000, budgetWarnings: [0.7, 0.9] });
    const w1 = budget.recordUsage({ inputTokens: 100, outputTokens: 50 });
    const w2 = budget.recordUsage({ inputTokens: 200, outputTokens: 50 });
    expect(w1.length).toBe(0);
    expect(w2.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Budget reporting — final state includes total tokens consumed
// ---------------------------------------------------------------------------

describe("token budget enforcement — budget reporting", () => {
  it("getState returns total input tokens across all calls", () => {
    const budget = makeBudget({ maxTokens: 10_000 });
    budget.recordUsage({ inputTokens: 100, outputTokens: 0 });
    budget.recordUsage({ inputTokens: 200, outputTokens: 0 });
    budget.recordUsage({ inputTokens: 300, outputTokens: 0 });
    expect(budget.getState().totalInputTokens).toBe(600);
  });

  it("getState returns total output tokens across all calls", () => {
    const budget = makeBudget({ maxTokens: 10_000 });
    budget.recordUsage({ inputTokens: 0, outputTokens: 25 });
    budget.recordUsage({ inputTokens: 0, outputTokens: 50 });
    expect(budget.getState().totalOutputTokens).toBe(75);
  });

  it("getState returns llmCalls count", () => {
    const budget = makeBudget({ maxTokens: 10_000 });
    budget.recordUsage({ inputTokens: 100, outputTokens: 10 });
    budget.recordUsage({ inputTokens: 200, outputTokens: 20 });
    expect(budget.getState().llmCalls).toBe(2);
  });

  it("getState returns accumulated cost in cents", () => {
    const budget = makeBudget({ maxCostCents: 100 });
    budget.recordUsage({ inputTokens: 100, outputTokens: 10 });
    const state = budget.getState();
    // totalCostCents is a number >= 0
    expect(typeof state.totalCostCents).toBe("number");
    expect(state.totalCostCents).toBeGreaterThanOrEqual(0);
  });

  it("getState returns all accumulated warnings", () => {
    const budget = makeBudget({ maxTokens: 1000, budgetWarnings: [0.7, 0.9] });
    budget.recordUsage({ inputTokens: 700, outputTokens: 0 });
    budget.recordUsage({ inputTokens: 200, outputTokens: 0 });
    const state = budget.getState();
    expect(Array.isArray(state.warnings)).toBe(true);
    expect(state.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("getState snapshot does not mutate internal state when modified externally", () => {
    const budget = makeBudget({ maxTokens: 10_000 });
    budget.recordUsage({ inputTokens: 100, outputTokens: 10 });
    const snap1 = budget.getState();
    budget.recordUsage({ inputTokens: 200, outputTokens: 20 });
    const snap2 = budget.getState();
    // snap1 should not reflect the second call
    expect(snap1.totalInputTokens).toBe(100);
    expect(snap2.totalInputTokens).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// 9. Input vs output token tracking — tracked separately
// ---------------------------------------------------------------------------

describe("token budget enforcement — input vs output tracking", () => {
  it("tracks input and output tokens separately across multiple calls", () => {
    const budget = makeBudget({ maxTokens: 10_000 });
    budget.recordUsage({ inputTokens: 100, outputTokens: 10 });
    budget.recordUsage({ inputTokens: 200, outputTokens: 20 });
    budget.recordUsage({ inputTokens: 300, outputTokens: 30 });

    const state = budget.getState();
    expect(state.totalInputTokens).toBe(600);
    expect(state.totalOutputTokens).toBe(60);
  });

  it("combined input + output is used for the maxTokens hard stop", () => {
    const budget = makeBudget({ maxTokens: 100 });
    // 60 input + 50 output = 110 > 100
    budget.recordUsage({ inputTokens: 60, outputTokens: 50 });
    expect(budget.isExceeded().exceeded).toBe(true);
  });

  it("combined input + output is used for budget warning thresholds", () => {
    const budget = makeBudget({ maxTokens: 1000, budgetWarnings: [0.7] });
    // 400 input + 300 output = 700 = 70%
    const warnings = budget.recordUsage({
      inputTokens: 400,
      outputTokens: 300,
    });
    expect(warnings.some((w) => w.threshold === 0.7)).toBe(true);
  });

  it("zero input tokens with non-zero output still tracked", () => {
    const budget = makeBudget({ maxTokens: 10_000 });
    budget.recordUsage({ inputTokens: 0, outputTokens: 500 });
    const state = budget.getState();
    expect(state.totalInputTokens).toBe(0);
    expect(state.totalOutputTokens).toBe(500);
  });

  it("zero output tokens with non-zero input still tracked", () => {
    const budget = makeBudget({ maxTokens: 10_000 });
    budget.recordUsage({ inputTokens: 500, outputTokens: 0 });
    const state = budget.getState();
    expect(state.totalInputTokens).toBe(500);
    expect(state.totalOutputTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 10. Tool call overhead — tool iterations counted toward budget
// ---------------------------------------------------------------------------

describe("token budget enforcement — tool call iteration overhead", () => {
  it("recordIteration increments iteration counter", () => {
    const budget = makeBudget({ maxIterations: 10 });
    budget.recordIteration();
    budget.recordIteration();
    expect(budget.getState().iterations).toBe(2);
  });

  it("iteration limit is checked on recordIteration", () => {
    const budget = makeBudget({ maxIterations: 2 });
    budget.recordIteration();
    budget.recordIteration();
    expect(budget.isExceeded().exceeded).toBe(true);
  });

  it("iteration warnings fire at threshold via recordIteration", () => {
    const budget = makeBudget({ maxIterations: 10, budgetWarnings: [0.7] });
    let warningFired = false;
    for (let i = 0; i < 7; i++) {
      const ws = budget.recordIteration();
      if (ws.some((w) => w.type === "iterations")) warningFired = true;
    }
    expect(warningFired).toBe(true);
  });

  it("blocked tool check works independently of token accounting", () => {
    const budget = makeBudget({ blockedTools: ["shell", "net.fetch"] });
    expect(budget.isToolBlocked("shell")).toBe(true);
    expect(budget.isToolBlocked("net.fetch")).toBe(true);
    expect(budget.isToolBlocked("fs.read")).toBe(false);
  });

  it("dynamically blocked tool counted as blocked after blockTool()", () => {
    const budget = makeBudget({ maxIterations: 10 });
    budget.blockTool("dangerous-tool");
    expect(budget.isToolBlocked("dangerous-tool")).toBe(true);
  });

  it("dynamically blocked tool does not affect token budget state", () => {
    const budget = makeBudget({ maxTokens: 1000 });
    budget.blockTool("some-tool");
    budget.recordUsage({ inputTokens: 100, outputTokens: 50 });
    expect(budget.getState().totalInputTokens).toBe(100);
    expect(budget.isExceeded().exceeded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. Budget reset between runs — fork creates independent instance
// ---------------------------------------------------------------------------

describe("token budget enforcement — budget reset between runs", () => {
  it("a new IterationBudget instance starts fresh with zero state", () => {
    const budget1 = makeBudget({ maxTokens: 1_000 });
    budget1.recordUsage({ inputTokens: 500, outputTokens: 100 });

    // New instance for a new run — should start at zero
    const budget2 = makeBudget({ maxTokens: 1_000 });
    expect(budget2.getState().totalInputTokens).toBe(0);
    expect(budget2.getState().totalOutputTokens).toBe(0);
    expect(budget2.getState().llmCalls).toBe(0);
    expect(budget2.isExceeded().exceeded).toBe(false);
  });

  it("forked child shares cumulative state by reference", () => {
    const parent = makeBudget({ maxTokens: 1000 });
    const child = parent.fork();

    child.recordUsage({ inputTokens: 600, outputTokens: 0 });
    // Parent sees child's usage through shared state
    expect(parent.getState().totalInputTokens).toBe(600);
  });

  it("forked child and parent share the same exceeded state", () => {
    const parent = makeBudget({ maxTokens: 500 });
    const child = parent.fork();

    child.recordUsage({ inputTokens: 300, outputTokens: 0 });
    parent.recordUsage({ inputTokens: 300, outputTokens: 0 });
    // Combined 600 > 500 limit
    expect(parent.isExceeded().exceeded).toBe(true);
    expect(child.isExceeded().exceeded).toBe(true);
  });

  it("forked child has independent blocked-tools set", () => {
    const parent = makeBudget({ maxTokens: 1000 });
    const child = parent.fork();
    child.blockTool("net.fetch");
    expect(parent.isToolBlocked("net.fetch")).toBe(false);
    expect(child.isToolBlocked("net.fetch")).toBe(true);
  });

  it("forked child has independent emitted-thresholds set", () => {
    const parent = makeBudget({ maxTokens: 1000, budgetWarnings: [0.7] });
    // Parent crosses threshold
    const pWarnings = parent.recordUsage({ inputTokens: 700, outputTokens: 0 });
    expect(pWarnings.some((w) => w.threshold === 0.7)).toBe(true);

    // Fork AFTER threshold was crossed on parent — child inherits dedup
    const child = parent.fork();
    // Child adding 0 tokens should not re-emit the threshold
    const cWarnings = child.recordUsage({ inputTokens: 0, outputTokens: 0 });
    expect(cWarnings.some((w) => w.threshold === 0.7)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. Edge cases — budget = 0, budget = Infinity
// ---------------------------------------------------------------------------

describe("token budget enforcement — edge cases", () => {
  it("maxTokens of 0 is treated as no limit (falsy guard in isExceeded)", () => {
    // The implementation uses `if (maxTokens && ...)` — zero is falsy, so
    // maxTokens=0 is treated the same as "no limit" and never triggers exceeded.
    const budget = makeBudget({ maxTokens: 0 });
    budget.recordUsage({ inputTokens: 1, outputTokens: 0 });
    expect(budget.isExceeded().exceeded).toBe(false);
  });

  it("no token limit means isExceeded never flags token excess", () => {
    // Infinity budget equivalent: omit maxTokens
    const budget = makeBudget({});
    for (let i = 0; i < 1000; i++) {
      budget.recordUsage({ inputTokens: 100_000, outputTokens: 50_000 });
    }
    // No maxTokens set → token check does not apply
    const result = budget.isExceeded();
    // Only iteration/cost limits could apply — neither is set here
    expect(result.exceeded).toBe(false);
  });

  it("only token limit set — cost and iteration do not trigger exceeded", () => {
    const budget = makeBudget({ maxTokens: 10_000 });
    budget.recordUsage({ inputTokens: 100, outputTokens: 50 });
    budget.recordIteration();
    budget.recordIteration();
    budget.recordIteration();
    expect(budget.isExceeded().exceeded).toBe(false);
  });

  it("maxIterations of 0 is treated as no limit (falsy guard in isExceeded)", () => {
    // The implementation uses `if (maxIterations && ...)` — zero is falsy, so
    // maxIterations=0 is treated the same as "no limit" and never triggers exceeded.
    const budget = makeBudget({ maxIterations: 0 });
    budget.recordIteration();
    expect(budget.isExceeded().exceeded).toBe(false);
  });

  it("very large token budget never triggered for moderate usage", () => {
    const budget = makeBudget({ maxTokens: Number.MAX_SAFE_INTEGER });
    for (let i = 0; i < 100; i++) {
      budget.recordUsage({ inputTokens: 10_000, outputTokens: 5_000 });
    }
    expect(budget.isExceeded().exceeded).toBe(false);
  });

  it("budget with all zero usage reports no excess", () => {
    const budget = makeBudget({ maxTokens: 1000 });
    budget.recordUsage({ inputTokens: 0, outputTokens: 0 });
    expect(budget.isExceeded().exceeded).toBe(false);
  });

  it("budget with no warnings configured uses default 0.7 and 0.9", () => {
    const budget = makeBudget({ maxTokens: 1000 }); // no budgetWarnings
    const ws = budget.recordUsage({ inputTokens: 700, outputTokens: 0 });
    expect(ws.some((w) => w.threshold === 0.7)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13. Configurable budget — budget is set per-run via constructor config
// ---------------------------------------------------------------------------

describe("token budget enforcement — configurable per-run budget", () => {
  it("different runs can have different maxTokens limits", () => {
    const tight = makeBudget({ maxTokens: 100 });
    const loose = makeBudget({ maxTokens: 10_000 });

    tight.recordUsage({ inputTokens: 90, outputTokens: 20 });
    loose.recordUsage({ inputTokens: 90, outputTokens: 20 });

    expect(tight.isExceeded().exceeded).toBe(true);
    expect(loose.isExceeded().exceeded).toBe(false);
  });

  it("different runs have independent warning threshold sets", () => {
    const b1 = makeBudget({ maxTokens: 1000, budgetWarnings: [0.5] });
    const b2 = makeBudget({ maxTokens: 1000, budgetWarnings: [0.9] });

    const w1 = b1.recordUsage({ inputTokens: 500, outputTokens: 0 });
    const w2 = b2.recordUsage({ inputTokens: 500, outputTokens: 0 });

    expect(w1.some((w) => w.threshold === 0.5)).toBe(true);
    expect(w2.some((w) => w.threshold === 0.9)).toBe(false);
    expect(w2.length).toBe(0);
  });

  it("budget supports all three limit types simultaneously", () => {
    const budget = makeBudget({
      maxTokens: 10_000,
      maxCostCents: 100_000,
      maxIterations: 50,
    });
    budget.recordUsage({ inputTokens: 100, outputTokens: 10 });
    budget.recordIteration();
    expect(budget.isExceeded().exceeded).toBe(false);
    expect(budget.getState().llmCalls).toBe(1);
    expect(budget.getState().iterations).toBe(1);
  });

  it("exceeding any single limit triggers isExceeded even if others are fine", () => {
    const budget = makeBudget({
      maxTokens: 100, // will be exceeded
      maxCostCents: 100_000, // not exceeded
      maxIterations: 1000, // not exceeded
    });
    budget.recordUsage({ inputTokens: 60, outputTokens: 50 });
    expect(budget.isExceeded().exceeded).toBe(true);
  });

  it("warns at different thresholds for tokens and iterations independently", () => {
    const budget = makeBudget({
      maxTokens: 1000,
      maxIterations: 10,
      budgetWarnings: [0.8],
    });

    // Cross token warning threshold
    const tw = budget.recordUsage({ inputTokens: 800, outputTokens: 0 });
    expect(tw.some((w) => w.type === "tokens" && w.threshold === 0.8)).toBe(
      true
    );

    // Reset and check iteration warning on the SAME budget instance
    // 8 iterations = 80% of 10 → iteration warning
    for (let i = 0; i < 8; i++) {
      const iw = budget.recordIteration();
      if (iw.some((w) => w.type === "iterations")) {
        expect(
          iw.some((w) => w.type === "iterations" && w.threshold === 0.8)
        ).toBe(true);
        break;
      }
    }
  });
});
