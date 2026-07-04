import { describe, it, expect } from "vitest";
import {
  createFanoutReportAccuracyScorer,
  checkReportInternalConsistency,
  scoreFanoutBatchRecord,
} from "../fanout-report-accuracy-scorer.js";
import { runFanoutEvalSuite } from "../harness.js";
import {
  FANOUT_REPORT_ACCURACY_SCENARIOS,
  FANOUT_REPORT_ACCURACY_KNOWN_BAD_CASE,
} from "../scenarios/fanout-report-accuracy-scenarios.js";
import type { FanoutBatchRecord } from "../../contracts/fanout-batch-store.js";

describe("createFanoutReportAccuracyScorer", () => {
  it("passes every known-good scenario with score 1", async () => {
    const scorer = createFanoutReportAccuracyScorer();
    const report = await runFanoutEvalSuite(
      "fanout-report-accuracy",
      FANOUT_REPORT_ACCURACY_SCENARIOS,
      scorer
    );

    expect(report.allPassed).toBe(true);
    expect(report.aggregateScore).toBe(1);
    expect(report.totalCount).toBe(FANOUT_REPORT_ACCURACY_SCENARIOS.length);
  });

  it("fails a known-bad case with a duplicate item key and status mismatch", async () => {
    const scorer = createFanoutReportAccuracyScorer();
    const result = await scorer.score(
      FANOUT_REPORT_ACCURACY_KNOWN_BAD_CASE.input
    );

    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reasoning).toContain("internally inconsistent");
  });

  it("detects a settled-counter that disagrees with the item statuses", async () => {
    const scorer = createFanoutReportAccuracyScorer();
    const result = await scorer.score({
      report: {
        batchId: "b1",
        mode: "template",
        declared: 1,
        dispatched: 1,
        // Wrong: item is succeeded but settled.failed is set instead of settled.succeeded.
        settled: {
          succeeded: 0,
          failed: 1,
          cancelled: 0,
          expired: 0,
          denied: 0,
          aborted_budget: 0,
        },
        uncovered: [],
        items: [{ key: "a", taskId: "t-a", status: "succeeded" }],
        extraDispatches: [],
        budget: { wallClockMs: 10, aborted: false },
        logs: [],
      },
      actualOutcomes: [{ key: "a", status: "succeeded" }],
    });

    expect(result.pass).toBe(false);
    expect(result.reasoning).toContain("internally inconsistent");
    const metadata = result.metadata as { reasons: string[] };
    expect(metadata.reasons.some((r) => r.includes("settled.succeeded"))).toBe(
      true
    );
    expect(metadata.reasons.some((r) => r.includes("settled.failed"))).toBe(
      true
    );
  });

  it("detects a status mismatch against authoritative outcomes despite internal consistency", async () => {
    const scorer = createFanoutReportAccuracyScorer();
    const result = await scorer.score({
      report: {
        batchId: "b1",
        mode: "template",
        declared: 1,
        dispatched: 1,
        settled: {
          succeeded: 1,
          failed: 0,
          cancelled: 0,
          expired: 0,
          denied: 0,
          aborted_budget: 0,
        },
        uncovered: [],
        items: [{ key: "a", taskId: "t-a", status: "succeeded" }],
        extraDispatches: [],
        budget: { wallClockMs: 10, aborted: false },
        logs: [],
      },
      // Ground truth says it actually failed — internally consistent report,
      // but wrong relative to what really happened.
      actualOutcomes: [{ key: "a", status: "failed" }],
    });

    expect(result.pass).toBe(false);
    expect(result.metadata).toMatchObject({
      mismatches: [{ key: "a", expected: "failed", actual: "succeeded" }],
    });
  });

  it("scores fanoutBatchRecordToReport reconstructions the same way as a live report", async () => {
    const record: FanoutBatchRecord = {
      batchId: "batch-ledger-1",
      parentRunId: "run-1",
      mode: "template",
      status: "completed",
      declared: ["a", "b"],
      startedAt: 0,
      updatedAt: 20,
      completedAt: 20,
      wallClockMs: 20,
      items: [
        { key: "a", taskId: "t-a", status: "succeeded", updatedAt: 10 },
        {
          key: "b",
          taskId: "t-b",
          status: "failed",
          error: "boom",
          updatedAt: 15,
        },
      ],
    };

    const scorer = createFanoutReportAccuracyScorer();
    const result = await scoreFanoutBatchRecord(scorer, record, [
      { key: "a", status: "succeeded" },
      { key: "b", status: "failed" },
    ]);

    expect(result).toMatchObject({ pass: true, score: 1 });
  });
});

describe("checkReportInternalConsistency", () => {
  it("flags items.length disagreeing with declared", () => {
    const result = checkReportInternalConsistency({
      batchId: "b1",
      mode: "template",
      declared: 3,
      dispatched: 1,
      settled: {
        succeeded: 1,
        failed: 0,
        cancelled: 0,
        expired: 0,
        denied: 0,
        aborted_budget: 0,
      },
      uncovered: [],
      items: [{ key: "a", taskId: "t-a", status: "succeeded" }],
      extraDispatches: [],
      budget: { wallClockMs: 10, aborted: false },
      logs: [],
    });

    expect(result.consistent).toBe(false);
    if (!result.consistent) {
      expect(result.reasons.some((r) => r.includes("items.length"))).toBe(true);
    }
  });
});
