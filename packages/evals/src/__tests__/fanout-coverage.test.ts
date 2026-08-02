import { describe, expect, it } from "vitest";
import {
  runDeterministicFanoutCoverageEval,
  scoreFanoutCoverageReport,
} from "../fanout-coverage/index.js";

describe("fanout coverage eval", () => {
  it("scores perfect coverage when every declared item is dispatched exactly once", async () => {
    const report = await runDeterministicFanoutCoverageEval({
      declaredKeys: ["a", "b", "c"],
      dispatch: async (key) => ({ key, status: "succeeded" }),
    });

    expect(scoreFanoutCoverageReport(report)).toEqual({
      declared: 3,
      dispatched: 3,
      uniqueDispatched: 3,
      duplicateDispatches: 0,
      uncovered: [],
      coverage: 1,
      effectiveCoverage: 1,
      unperformed: [],
      exactOnce: true,
      exactOnceEffective: true,
    });
  });

  it("detects duplicates and uncovered declared keys", async () => {
    const report = await runDeterministicFanoutCoverageEval({
      declaredKeys: ["a", "b", "c"],
      dispatch: async (key) =>
        key === "b"
          ? [
              { key: "b", status: "succeeded" },
              { key: "b", status: "succeeded" },
            ]
          : key === "c"
          ? []
          : { key, status: "succeeded" },
    });

    expect(scoreFanoutCoverageReport(report)).toMatchObject({
      declared: 3,
      dispatched: 3,
      uniqueDispatched: 2,
      duplicateDispatches: 1,
      uncovered: ["c"],
      coverage: 2 / 3,
      exactOnce: false,
    });
  });

  it("accounts for budget-aborted items without marking them as silently uncovered", async () => {
    const report = await runDeterministicFanoutCoverageEval({
      declaredKeys: ["a", "b", "c"],
      dispatch: async (key) =>
        key === "c"
          ? { key, status: "aborted_budget" }
          : { key, status: "succeeded" },
    });

    const score = scoreFanoutCoverageReport(report);
    expect(score.uncovered).toEqual([]);
    expect(score.coverage).toBe(1);
    expect(score.exactOnce).toBe(true);

    // ...but the budget-aborted item did not do its work, and the effective
    // dimensions must say so rather than reading as a perfect fan-out.
    expect(score.unperformed).toEqual(["c"]);
    expect(score.effectiveCoverage).toBe(2 / 3);
    expect(score.exactOnceEffective).toBe(false);
  });

  it("does not report a wholly denied fan-out as perfect coverage", async () => {
    const report = await runDeterministicFanoutCoverageEval({
      declaredKeys: ["a", "b", "c"],
      dispatch: async (key) => ({ key, status: "denied" }),
    });

    const score = scoreFanoutCoverageReport(report);
    // Dispatch reached every item, so the reach-oriented dimensions are 1.
    expect(score.coverage).toBe(1);
    expect(score.exactOnce).toBe(true);
    // Nothing was actually performed — this is the regression that made a
    // fully-denied fan-out indistinguishable from a fully-successful one.
    expect(score.effectiveCoverage).toBe(0);
    expect(score.unperformed).toEqual(["a", "b", "c"]);
    expect(score.exactOnceEffective).toBe(false);
  });

  it("treats cancelled, expired and failed as reached-but-unperformed", async () => {
    const report = await runDeterministicFanoutCoverageEval({
      declaredKeys: ["a", "b", "c", "d"],
      dispatch: async (key) => {
        const status =
          key === "a"
            ? "succeeded"
            : key === "b"
            ? "cancelled"
            : key === "c"
            ? "expired"
            : "failed";
        return { key, status };
      },
    });

    const score = scoreFanoutCoverageReport(report);
    expect(score.effectiveCoverage).toBe(1 / 4);
    expect(score.unperformed).toEqual(["b", "c", "d"]);
    expect(score.exactOnceEffective).toBe(false);
  });

  it("counts a key as performed when any dispatch of it succeeded", async () => {
    const report = await runDeterministicFanoutCoverageEval({
      declaredKeys: ["a"],
      dispatch: async () => [
        { key: "a", status: "failed" },
        { key: "a", status: "succeeded" },
      ],
    });

    const score = scoreFanoutCoverageReport(report);
    // A retry that eventually succeeded did perform its work...
    expect(score.effectiveCoverage).toBe(1);
    expect(score.unperformed).toEqual([]);
    // ...but it took two dispatches, so exact-once is still violated.
    expect(score.duplicateDispatches).toBe(1);
    expect(score.exactOnce).toBe(false);
    expect(score.exactOnceEffective).toBe(false);
  });

  it("does not count undeclared or never-dispatched records as dispatched coverage", async () => {
    const report = await runDeterministicFanoutCoverageEval({
      declaredKeys: ["a"],
      dispatch: async () => [
        { key: "a", status: "never_dispatched" },
        { key: "extra", status: "succeeded" },
      ],
    });

    expect(scoreFanoutCoverageReport(report)).toMatchObject({
      declared: 1,
      dispatched: 0,
      uniqueDispatched: 0,
      duplicateDispatches: 0,
      uncovered: ["a"],
      coverage: 0,
      exactOnce: false,
    });
  });
});
