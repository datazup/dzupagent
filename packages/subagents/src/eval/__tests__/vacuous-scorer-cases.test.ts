import { describe, expect, it } from "vitest";
import { createFanoutReportAccuracyScorer } from "../fanout-report-accuracy-scorer.js";
import { createAgentIdentityResolutionScorer } from "../agent-identity-resolution-scorer.js";
import { runFanoutEvalSuite } from "../harness.js";
import type { FanoutEvalCase, FanoutScorer } from "../types.js";
import type { FanoutReport } from "../../tools/fanout-tool.js";

/**
 * A scorer that scores nothing must say so.
 *
 * Every scorer under ./ compares a produced artifact against per-item ground
 * truth from the case. When a case declares no items, no comparison runs and
 * the scorer CANNOT fail — so a bare `score: 1, pass: true` would report an
 * absence of evidence as evidence of correctness, and a regression baseline
 * built from such rows would be green while checking nothing.
 *
 * These tests pin the `measured: false` discriminator on exactly the
 * zero-evidence branches, and pin that a genuinely-checked zero-spawn outcome
 * (a denied batch) stays measured.
 */

const EMPTY_SETTLED = {
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  expired: 0,
  denied: 0,
  aborted_budget: 0,
} as const;

function report(overrides: Partial<FanoutReport> = {}): FanoutReport {
  return {
    batchId: "b-1",
    mode: "template",
    declared: 0,
    dispatched: 0,
    settled: { ...EMPTY_SETTLED },
    uncovered: [],
    inFlight: [],
    items: [],
    extraDispatches: [],
    budget: { wallClockMs: 0, aborted: false },
    logs: [],
    ...overrides,
  };
}

describe("vacuous scorer cases are reported as unmeasured", () => {
  it("report-accuracy: an empty report with no declared outcomes is not evidence of accuracy", async () => {
    const result = await createFanoutReportAccuracyScorer().score({
      report: report(),
      actualOutcomes: [],
    });

    expect(result.measured).toBe(false);
    expect(result.reasoning).toMatch(/vacuous|nothing was checked/i);
  });

  it("report-accuracy: a real comparison stays measured", async () => {
    const result = await createFanoutReportAccuracyScorer().score({
      report: report({
        declared: 1,
        dispatched: 1,
        items: [{ key: "a", status: "succeeded" }],
        settled: { ...EMPTY_SETTLED, succeeded: 1 },
      }),
      actualOutcomes: [{ key: "a", status: "succeeded" }],
    });

    expect(result.pass).toBe(true);
    expect(result.measured).not.toBe(false);
  });

  it("identity-resolution: no items means no resolution was checked", async () => {
    const result = await createAgentIdentityResolutionScorer().score({
      template: { agentId: "worker", instructions: "do {{key}}" },
      items: [],
      expected: {},
    });

    expect(result.measured).toBe(false);
  });
});

describe("suite aggregation excludes unmeasured cases", () => {
  /** A stub scorer so aggregation is tested independently of any real scorer. */
  function stubScorer(
    results: ReadonlyArray<{ score: number; pass: boolean; measured?: boolean }>
  ): FanoutScorer<number> {
    return {
      config: { id: "stub", name: "Stub", type: "deterministic" },
      score(index: number) {
        const r = results[index];
        if (r === undefined) throw new Error(`no stub result for ${index}`);
        return {
          score: r.score,
          pass: r.pass,
          reasoning: "stub",
          ...(r.measured === undefined ? {} : { measured: r.measured }),
        };
      },
    };
  }

  function cases(n: number): Array<FanoutEvalCase<number>> {
    return Array.from({ length: n }, (_, i) => ({
      id: `case-${i}`,
      description: `case ${i}`,
      input: i,
    }));
  }

  it("a suite of nothing but vacuous cases is not a green suite", async () => {
    const report = await runFanoutEvalSuite(
      "all-vacuous",
      cases(2),
      stubScorer([
        { score: 1, pass: true, measured: false },
        { score: 1, pass: true, measured: false },
      ])
    );

    expect(report.totalCount).toBe(2);
    expect(report.passCount).toBe(2);
    expect(report.measuredCount).toBe(0);
    // Every case "passed", but nothing was checked.
    expect(report.allPassed).toBe(false);
    expect(report.aggregateScore).toBe(0);
  });

  it("a vacuous 1.0 does not inflate the aggregate of a real failure", async () => {
    const report = await runFanoutEvalSuite(
      "mixed",
      cases(2),
      stubScorer([
        { score: 0, pass: false },
        { score: 1, pass: true, measured: false },
      ])
    );

    expect(report.measuredCount).toBe(1);
    // Averaging the vacuous 1.0 in would report 0.5 for a suite whose only
    // real measurement scored 0.
    expect(report.aggregateScore).toBe(0);
    expect(report.allPassed).toBe(false);
  });

  it("fully measured suites are unaffected", async () => {
    const report = await runFanoutEvalSuite(
      "measured",
      cases(2),
      stubScorer([
        { score: 1, pass: true },
        { score: 1, pass: true },
      ])
    );

    expect(report.measuredCount).toBe(2);
    expect(report.aggregateScore).toBe(1);
    expect(report.allPassed).toBe(true);
  });
});
