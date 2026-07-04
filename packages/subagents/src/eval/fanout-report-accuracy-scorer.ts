import type { FanoutReport, FanoutReportItem } from "../tools/fanout-tool.js";
import type { FanoutBatchRecord } from "../contracts/fanout-batch-store.js";
import { fanoutBatchRecordToReport } from "../tools/fanout-tool.js";
import type { FanoutEvalResult, FanoutScorer } from "./types.js";

/**
 * Fan-out report accuracy (eval area 3). Ground truth is the structural
 * invariant `fanout-tool.ts` documents: every declared item appears EXACTLY
 * ONCE in `items`, in declared order, and the `settled` counters + `dispatched`
 * + `uncovered` are a pure function of the per-item statuses. Rather than
 * re-deriving those counts independently (which would just duplicate the
 * production code and pass whenever both copies share the same bug), this
 * scorer treats `FanoutReport` as a report ABOUT an authoritative set of
 * "actual per-item outcomes" supplied by the eval case (e.g. captured from a
 * test double's recorded calls, or reconstructed via
 * `fanoutBatchRecordToReport` from a `FanoutBatchRecord`), and checks the
 * report faithfully reflects that ground truth.
 *
 * `fanout-governance.test.ts` / `fanout-tool.test.ts` already unit-test the
 * PRODUCTION code paths that build these reports end-to-end; this scorer is
 * deliberately narrower and reusable — it is the reusable *invariant check*
 * those tests could delegate to, and the artifact a future eval run (e.g.
 * replaying real fan-out batches captured in CI or from a live host) can
 * score without re-running the whole subagent runtime.
 */
export interface FanoutReportAccuracyCase {
  /** The report under test (from `fanout_template.invoke(...)` or `fanoutBatchRecordToReport`). */
  report: FanoutReport;
  /** Authoritative per-item outcomes the report SHOULD reflect. */
  actualOutcomes: Array<{
    key: string;
    status: FanoutReportItem["status"];
  }>;
}

const SETTLED_KEYS = [
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "denied",
  "aborted_budget",
] as const;

type SettledKey = (typeof SETTLED_KEYS)[number];

function isSettledKey(status: string): status is SettledKey {
  return (SETTLED_KEYS as readonly string[]).includes(status);
}

/**
 * Check the internal consistency of a `FanoutReport` alone (no external
 * ground truth needed): coverage (every declared item exactly once),
 * `dispatched` count, `uncovered` list, and `settled` counters must all be
 * derivable from `items`. This is the same invariant
 * `fanoutBatchRecordToReport` computes when rebuilding from a ledger.
 */
export function checkReportInternalConsistency(
  report: FanoutReport
): { consistent: true } | { consistent: false; reasons: string[] } {
  const reasons: string[] = [];

  const keyCounts = new Map<string, number>();
  for (const item of report.items) {
    keyCounts.set(item.key, (keyCounts.get(item.key) ?? 0) + 1);
  }
  for (const [key, count] of keyCounts) {
    if (count !== 1) {
      reasons.push(
        `item key "${key}" appears ${count} times (expected exactly 1)`
      );
    }
  }

  const expectedSettled: Record<SettledKey, number> = {
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    expired: 0,
    denied: 0,
    aborted_budget: 0,
  };
  const expectedUncovered: string[] = [];
  let expectedDispatched = 0;

  for (const item of report.items) {
    if (isSettledKey(item.status)) {
      expectedSettled[item.status] += 1;
    }
    if (item.status === "never_dispatched") {
      expectedUncovered.push(item.key);
    }
    if (item.status !== "never_dispatched" && item.status !== "denied") {
      expectedDispatched += 1;
    }
  }

  for (const key of SETTLED_KEYS) {
    if (report.settled[key] !== expectedSettled[key]) {
      reasons.push(
        `settled.${key} = ${report.settled[key]}, expected ${expectedSettled[key]} (derived from items)`
      );
    }
  }

  const sortedActualUncovered = [...report.uncovered].sort();
  const sortedExpectedUncovered = [...expectedUncovered].sort();
  if (
    sortedActualUncovered.length !== sortedExpectedUncovered.length ||
    sortedActualUncovered.some((k, i) => k !== sortedExpectedUncovered[i])
  ) {
    reasons.push(
      `uncovered = [${report.uncovered.join(
        ", "
      )}], expected [${expectedUncovered.join(
        ", "
      )}] (items with status "never_dispatched")`
    );
  }

  if (report.dispatched !== expectedDispatched) {
    reasons.push(
      `dispatched = ${report.dispatched}, expected ${expectedDispatched} (items neither never_dispatched nor denied)`
    );
  }

  if (report.items.length !== report.declared) {
    reasons.push(
      `items.length = ${report.items.length}, expected declared = ${report.declared}`
    );
  }

  return reasons.length === 0
    ? { consistent: true }
    : { consistent: false, reasons };
}

export function createFanoutReportAccuracyScorer(): FanoutScorer<FanoutReportAccuracyCase> {
  return {
    config: {
      id: "fanout-report-accuracy",
      name: "Fan-out Report Accuracy",
      description:
        "Checks a FanoutReport's per-item statuses against authoritative " +
        "outcomes, and its dispatched/settled/uncovered counters against its " +
        "own items (internal consistency).",
      type: "deterministic",
    },
    score(input: FanoutReportAccuracyCase): FanoutEvalResult {
      const consistency = checkReportInternalConsistency(input.report);
      if (!consistency.consistent) {
        return {
          score: 0,
          pass: false,
          reasoning: `Report is internally inconsistent: ${consistency.reasons.join(
            "; "
          )}`,
          metadata: { reasons: consistency.reasons },
        };
      }

      const reportByKey = new Map(
        input.report.items.map((item) => [item.key, item])
      );
      const mismatches: Array<{
        key: string;
        expected: string;
        actual: string | undefined;
      }> = [];

      for (const expected of input.actualOutcomes) {
        const actualItem = reportByKey.get(expected.key);
        if (actualItem === undefined) {
          mismatches.push({
            key: expected.key,
            expected: expected.status,
            actual: "<missing from report>",
          });
          continue;
        }
        if (actualItem.status !== expected.status) {
          mismatches.push({
            key: expected.key,
            expected: expected.status,
            actual: actualItem.status,
          });
        }
      }

      // Symmetric check: the report must not contain keys absent from the
      // authoritative outcome list, and must not be missing declared keys.
      const expectedKeys = new Set(input.actualOutcomes.map((o) => o.key));
      const extraKeys = input.report.items
        .map((item) => item.key)
        .filter((key) => !expectedKeys.has(key));

      if (mismatches.length > 0 || extraKeys.length > 0) {
        const total = input.actualOutcomes.length + extraKeys.length;
        const wrong = mismatches.length + extraKeys.length;
        return {
          score: total === 0 ? 0 : 1 - wrong / total,
          pass: false,
          reasoning:
            `${mismatches.length} item(s) with a status mismatch` +
            (extraKeys.length > 0
              ? `, ${extraKeys.length} unexpected item key(s) in report`
              : "") +
            ".",
          metadata: { mismatches, extraKeys },
        };
      }

      return {
        score: 1,
        pass: true,
        reasoning: `Report matches all ${input.actualOutcomes.length} authoritative outcome(s) and is internally consistent.`,
      };
    },
  };
}

/**
 * Convenience: score a persisted `FanoutBatchRecord` (rebuilt via
 * `fanoutBatchRecordToReport`) against authoritative outcomes — useful for
 * scoring durable-ledger reconstructions the same way as a live
 * `fanout_template` report.
 */
export function scoreFanoutBatchRecord(
  scorer: FanoutScorer<FanoutReportAccuracyCase>,
  record: FanoutBatchRecord,
  actualOutcomes: FanoutReportAccuracyCase["actualOutcomes"]
): FanoutEvalResult | Promise<FanoutEvalResult> {
  return scorer.score({
    report: fanoutBatchRecordToReport(record),
    actualOutcomes,
  });
}
