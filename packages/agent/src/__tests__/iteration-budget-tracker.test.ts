import { describe, expect, it } from "vitest";
import {
  applyCost,
  createBudgetTrackerState,
} from "../pipeline/pipeline-runtime/iteration-budget-tracker.js";

describe("iteration-budget-tracker", () => {
  it("starts with zero cost and no warnings emitted", () => {
    const state = createBudgetTrackerState();
    expect(state.cumulativeCostCents).toBe(0);
    expect(state.warnings.warn70).toBe(false);
    expect(state.warnings.warn90).toBe(false);
  });

  it("ignores zero or negative cost contributions without advancing the budget", () => {
    const state = createBudgetTrackerState();
    expect(applyCost(state, 0, 100)).toEqual({
      cumulativeCostCents: 0,
      warning: undefined,
      exceeded: false,
    });
    expect(applyCost(state, -25, 100)).toEqual({
      cumulativeCostCents: 0,
      warning: undefined,
      exceeded: false,
    });
    expect(state.warnings).toEqual({ warn70: false, warn90: false });
  });

  it("emits warn_70 the first time cumulative cost reaches >=70%", () => {
    const state = createBudgetTrackerState();

    // 60% — below 70 threshold
    expect(applyCost(state, 60, 100).warning).toBeUndefined();

    // jumps to 75% — fires warn_70 once
    const decision = applyCost(state, 15, 100);
    expect(decision.warning).toBe("warn_70");
    expect(decision.cumulativeCostCents).toBe(75);
    expect(state.warnings.warn70).toBe(true);
  });

  it("emits warn_70 only once even on subsequent sub-threshold steps", () => {
    const state = createBudgetTrackerState();
    expect(applyCost(state, 70, 100).warning).toBe("warn_70");
    // Adding more cost in the 70-89% band must not re-fire warn_70.
    expect(applyCost(state, 5, 100).warning).toBeUndefined();
    expect(applyCost(state, 5, 100).warning).toBeUndefined();
  });

  it("emits warn_90 separately after warn_70 has fired", () => {
    const state = createBudgetTrackerState();
    expect(applyCost(state, 75, 100).warning).toBe("warn_70");
    const decision = applyCost(state, 20, 100);
    expect(decision.warning).toBe("warn_90");
    expect(decision.cumulativeCostCents).toBe(95);
    expect(state.warnings.warn90).toBe(true);
  });

  it("emits warn_90 ahead of warn_70 when a single step jumps straight past 90%", () => {
    // Mirrors the runtime's original `if/else if` semantics: in a single
    // call, 90% wins over 70%. The 70% flag stays unset, so a later
    // sub-90% step would still fire warn_70 — that's the existing
    // runtime behaviour we are preserving.
    const state = createBudgetTrackerState();
    const decision = applyCost(state, 95, 100);
    expect(decision.warning).toBe("warn_90");
    expect(state.warnings.warn90).toBe(true);
    expect(state.warnings.warn70).toBe(false);
  });

  it("does not re-fire warn_90 once it has already fired", () => {
    const state = createBudgetTrackerState();
    expect(applyCost(state, 75, 100).warning).toBe("warn_70");
    expect(applyCost(state, 20, 100).warning).toBe("warn_90");
    // Subsequent sub-budget contributions while warn_90 is set must not
    // re-fire it (95 -> 99 cents, still under the 100-cent budget).
    expect(applyCost(state, 4, 100).warning).toBeUndefined();
    // ...but crossing 100% reports the breach rather than staying silent.
    expect(applyCost(state, 100, 100).warning).toBe("exceeded");
  });

  it("reports exceeded on every call once the budget is blown", () => {
    const state = createBudgetTrackerState();
    // A single contribution jumping straight past 100% reports `exceeded`,
    // NOT `warn_90` — the breach outranks the advisory threshold.
    const first = applyCost(state, 150, 100);
    expect(first.warning).toBe("exceeded");
    expect(first.exceeded).toBe(true);

    // Not one-shot: a caller that checks late still sees the breach.
    const second = applyCost(state, 1, 100);
    expect(second.warning).toBe("exceeded");
    expect(second.exceeded).toBe(true);
  });

  it("treats exactly 100% of the budget as exceeded", () => {
    const state = createBudgetTrackerState();
    const decision = applyCost(state, 100, 100);
    expect(decision.warning).toBe("exceeded");
    expect(decision.exceeded).toBe(true);
  });

  it("never reports exceeded when the budget is non-positive", () => {
    const state = createBudgetTrackerState();
    // A non-positive budget means "unset", not "instantly exhausted" —
    // otherwise every pipeline without a budget would abort immediately.
    expect(applyCost(state, 5_000, 0).exceeded).toBe(false);
    expect(applyCost(state, 5_000, -1).exceeded).toBe(false);
  });

  it("never emits a warning when budget is non-positive", () => {
    const state = createBudgetTrackerState();
    const decision = applyCost(state, 50, 0);
    expect(decision.warning).toBeUndefined();
    // Non-positive budget still accumulates cost but gates warnings off.
    expect(state.cumulativeCostCents).toBe(50);
    expect(state.warnings).toEqual({ warn70: false, warn90: false });
  });

  it("returns the running cumulative cost on every call", () => {
    const state = createBudgetTrackerState();
    expect(applyCost(state, 10, 100).cumulativeCostCents).toBe(10);
    expect(applyCost(state, 25, 100).cumulativeCostCents).toBe(35);
    expect(applyCost(state, 40, 100).cumulativeCostCents).toBe(75);
  });

  it("fires each warning at most once across many small contributions", () => {
    const state = createBudgetTrackerState();
    const warnings: string[] = [];
    for (let i = 0; i < 20; i++) {
      const d = applyCost(state, 5, 100); // 5, 10, ..., 100
      if (d.warning) warnings.push(d.warning);
    }
    // The advisory warnings still fire at most once each; the final step
    // lands exactly on 100% and reports the breach.
    expect(warnings).toEqual(["warn_70", "warn_90", "exceeded"]);
  });
});
