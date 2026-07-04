import { describe, it, expect } from "vitest";
import { runFanoutEvalSuite, runFanoutEvalSuites } from "../harness.js";
import { createSpawnDecisionScorer } from "../spawn-decision-scorer.js";
import { createFanoutReportAccuracyScorer } from "../fanout-report-accuracy-scorer.js";
import { SPAWN_DECISION_SCENARIOS } from "../scenarios/spawn-decision-scenarios.js";
import { FANOUT_REPORT_ACCURACY_SCENARIOS } from "../scenarios/fanout-report-accuracy-scenarios.js";

describe("runFanoutEvalSuite", () => {
  it("produces an aggregate report with per-case scores in order", async () => {
    const scorer = createSpawnDecisionScorer();
    const report = await runFanoutEvalSuite(
      "suite-x",
      SPAWN_DECISION_SCENARIOS,
      scorer
    );

    expect(report.suiteId).toBe("suite-x");
    expect(report.scorerId).toBe(scorer.config.id);
    expect(report.scores.map((s) => s.caseId)).toEqual(
      SPAWN_DECISION_SCENARIOS.map((c) => c.id)
    );
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns a zero-score, non-passing report for an empty case list", async () => {
    const scorer = createSpawnDecisionScorer();
    const report = await runFanoutEvalSuite("empty-suite", [], scorer);

    expect(report).toMatchObject({
      aggregateScore: 0,
      passCount: 0,
      totalCount: 0,
      allPassed: false,
    });
  });
});

describe("runFanoutEvalSuites", () => {
  it("runs multiple scorer suites and returns one report per scorer", async () => {
    // Deliberately mismatched input types are avoided by scoping each scorer
    // to its own case set; this exercises the multi-scorer composition path
    // with report-accuracy cases (chosen because they're independent of policy wiring).
    const scorer = createFanoutReportAccuracyScorer();
    const reports = await runFanoutEvalSuites(
      "report-accuracy-suite",
      FANOUT_REPORT_ACCURACY_SCENARIOS,
      [scorer]
    );

    expect(reports).toHaveLength(1);
    expect(reports[0]?.allPassed).toBe(true);
  });
});
