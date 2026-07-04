import type { FanoutReport } from "../../tools/fanout-tool.js";
import type { FanoutEvalCase } from "../types.js";
import type { FanoutReportAccuracyCase } from "../fanout-report-accuracy-scorer.js";

function baseReport(overrides: Partial<FanoutReport>): FanoutReport {
  return {
    batchId: "batch1",
    mode: "template",
    declared: 0,
    dispatched: 0,
    settled: {
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      expired: 0,
      denied: 0,
      aborted_budget: 0,
    },
    uncovered: [],
    items: [],
    extraDispatches: [],
    budget: { wallClockMs: 100, aborted: false },
    logs: [],
    ...overrides,
  };
}

export const FANOUT_REPORT_ACCURACY_SCENARIOS: Array<
  FanoutEvalCase<FanoutReportAccuracyCase>
> = [
  {
    id: "fra-001-all-succeeded-matches",
    description:
      "a fully-succeeded batch report matches the authoritative outcomes.",
    tags: ["known-good"],
    input: {
      report: baseReport({
        declared: 2,
        dispatched: 2,
        settled: {
          succeeded: 2,
          failed: 0,
          cancelled: 0,
          expired: 0,
          denied: 0,
          aborted_budget: 0,
        },
        items: [
          { key: "a", taskId: "t-a", status: "succeeded" },
          { key: "b", taskId: "t-b", status: "succeeded" },
        ],
      }),
      actualOutcomes: [
        { key: "a", status: "succeeded" },
        { key: "b", status: "succeeded" },
      ],
    },
  },
  {
    id: "fra-002-mixed-outcomes-with-uncovered",
    description:
      "a mixed batch (succeeded/failed/never_dispatched) reports uncovered correctly.",
    tags: ["known-good"],
    input: {
      report: baseReport({
        declared: 3,
        dispatched: 2,
        settled: {
          succeeded: 1,
          failed: 1,
          cancelled: 0,
          expired: 0,
          denied: 0,
          aborted_budget: 0,
        },
        uncovered: ["c"],
        items: [
          { key: "a", taskId: "t-a", status: "succeeded" },
          { key: "b", taskId: "t-b", status: "failed", error: "boom" },
          { key: "c", status: "never_dispatched" },
        ],
      }),
      actualOutcomes: [
        { key: "a", status: "succeeded" },
        { key: "b", status: "failed" },
        { key: "c", status: "never_dispatched" },
      ],
    },
  },
  {
    id: "fra-003-denied-batch-zero-spawns",
    description:
      "a denied batch reports every item denied with zero dispatched.",
    tags: ["known-good"],
    input: {
      report: baseReport({
        declared: 2,
        dispatched: 0,
        settled: {
          succeeded: 0,
          failed: 0,
          cancelled: 0,
          expired: 0,
          denied: 2,
          aborted_budget: 0,
        },
        items: [
          { key: "a", status: "denied", error: "policy_denied" },
          { key: "b", status: "denied", error: "policy_denied" },
        ],
      }),
      actualOutcomes: [
        { key: "a", status: "denied" },
        { key: "b", status: "denied" },
      ],
    },
  },
  {
    id: "fra-004-budget-abort-mixed-terminal-states",
    description:
      "a budget-aborted batch mixes succeeded, aborted_budget, and never_dispatched.",
    tags: ["known-good"],
    input: {
      report: baseReport({
        declared: 3,
        dispatched: 2,
        settled: {
          succeeded: 1,
          failed: 0,
          cancelled: 0,
          expired: 0,
          denied: 0,
          aborted_budget: 1,
        },
        uncovered: ["c"],
        items: [
          { key: "a", taskId: "t-a", status: "succeeded" },
          {
            key: "b",
            taskId: "t-b",
            status: "aborted_budget",
            error: "fanout_wall_clock_exceeded",
          },
          { key: "c", status: "never_dispatched" },
        ],
        budget: { wallClockMs: 25, aborted: true },
      }),
      actualOutcomes: [
        { key: "a", status: "succeeded" },
        { key: "b", status: "aborted_budget" },
        { key: "c", status: "never_dispatched" },
      ],
    },
  },
];

/**
 * Deliberately WRONG cases used only by the scorer meta-tests: a report that
 * both (a) duplicates an item key (breaking "exactly once" coverage) and
 * (b) disagrees with the authoritative outcome for a key. Any real report
 * built by `fanout_template`/`fanoutBatchRecordToReport` cannot exhibit (a);
 * this is a corrupted/hand-built fixture whose sole purpose is to prove the
 * scorer's internal-consistency check actually fires.
 */
export const FANOUT_REPORT_ACCURACY_KNOWN_BAD_CASE: FanoutEvalCase<FanoutReportAccuracyCase> =
  {
    id: "fra-bad-001-duplicate-item-and-status-mismatch",
    description:
      "corrupted report: duplicate item key and a status that disagrees with ground truth.",
    tags: ["known-bad"],
    input: {
      report: baseReport({
        declared: 2,
        dispatched: 2,
        settled: {
          succeeded: 2,
          failed: 0,
          cancelled: 0,
          expired: 0,
          denied: 0,
          aborted_budget: 0,
        },
        items: [
          { key: "a", taskId: "t-a", status: "succeeded" },
          { key: "a", taskId: "t-a2", status: "succeeded" },
        ],
      }),
      actualOutcomes: [
        { key: "a", status: "failed" },
        { key: "b", status: "succeeded" },
      ],
    },
  };
