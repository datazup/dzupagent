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
      exactOnce: true,
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
