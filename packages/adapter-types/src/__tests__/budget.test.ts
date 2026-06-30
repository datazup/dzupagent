import { describe, expect, it } from "vitest";
import {
  emptyTally,
  accrueUsage,
  checkBudget,
  type BudgetLimits,
  type BudgetTally,
} from "../index.js";

describe("budget accumulator (MPCO P8a / T15)", () => {
  it("emptyTally is a zeroed tally", () => {
    expect(emptyTally()).toEqual({
      totalTokens: 0,
      totalCostCents: 0,
      calls: 0,
    });
  });

  it("accrueUsage sums tokens + cost and increments calls (pure — returns a new tally)", () => {
    const t0 = emptyTally();
    const t1 = accrueUsage(t0, {
      inputTokens: 100,
      outputTokens: 50,
      costCents: 7,
    });
    expect(t1).toEqual({ totalTokens: 150, totalCostCents: 7, calls: 1 });
    // purity: t0 untouched
    expect(t0).toEqual({ totalTokens: 0, totalCostCents: 0, calls: 0 });
    const t2 = accrueUsage(t1, {
      inputTokens: 10,
      outputTokens: 5,
      costCents: 1,
    });
    expect(t2).toEqual({ totalTokens: 165, totalCostCents: 8, calls: 2 });
  });

  it("accrueUsage counts cache tokens toward the token total but tolerates missing usage", () => {
    const t = accrueUsage(emptyTally(), {
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 5,
      cacheWriteTokens: 3,
    });
    expect(t.totalTokens).toBe(38); // 10 + 20 + 5 + 3
    expect(t.totalCostCents).toBe(0); // no costCents provided
    expect(accrueUsage(emptyTally(), undefined).calls).toBe(1); // a call with no usage still counts
  });

  it("accrueUsage tolerates partial usage payloads", () => {
    expect(
      accrueUsage(emptyTally(), { inputTokens: 10 } as any).totalTokens,
    ).toBe(10);
    expect(
      accrueUsage(emptyTally(), { outputTokens: 7 } as any).totalTokens,
    ).toBe(7);
  });

  // T15: cap breach detection
  it("T15a: checkBudget flags a token breach", () => {
    const tally: BudgetTally = {
      totalTokens: 1200,
      totalCostCents: 0,
      calls: 3,
    };
    const limits: BudgetLimits = { maxTokens: 1000 };
    const res = checkBudget(tally, limits);
    expect(res.exceeded).toBe(true);
    expect(res.breach).toEqual({
      breachedLimit: "tokens",
      limit: 1000,
      actual: 1200,
    });
  });

  it("MPCO P8a: checkBudget does not exceed at the token cap boundary", () => {
    expect(
      checkBudget(
        { totalTokens: 1000, totalCostCents: 0, calls: 1 },
        { maxTokens: 1000 },
      ),
    ).toEqual({ exceeded: false });
  });

  it("T15b: checkBudget flags a cost breach", () => {
    const res = checkBudget(
      { totalTokens: 10, totalCostCents: 250, calls: 1 },
      { maxCostCents: 200 },
    );
    expect(res.exceeded).toBe(true);
    expect(res.breach?.breachedLimit).toBe("cost");
  });

  it("T15c: checkBudget passes under both caps and with no limits set", () => {
    expect(
      checkBudget(
        { totalTokens: 10, totalCostCents: 5, calls: 1 },
        { maxTokens: 1000, maxCostCents: 200 },
      ).exceeded,
    ).toBe(false);
    expect(
      checkBudget({ totalTokens: 9_999, totalCostCents: 9_999, calls: 9 }, {})
        .exceeded,
    ).toBe(false);
  });

  it("T15d (determinism): same tally + limits → same result", () => {
    const tally: BudgetTally = {
      totalTokens: 1200,
      totalCostCents: 0,
      calls: 3,
    };
    const a = checkBudget(tally, { maxTokens: 1000 });
    const b = checkBudget(tally, { maxTokens: 1000 });
    expect(b).toEqual(a);
  });
});
