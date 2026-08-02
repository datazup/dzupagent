export type FanoutCoverageStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "denied"
  | "aborted_budget"
  | "never_dispatched";

export interface FanoutCoverageDispatch {
  key: string;
  status: FanoutCoverageStatus;
}

export interface FanoutCoverageEvalInput {
  declaredKeys: string[];
  dispatch: (
    key: string
  ) => Promise<FanoutCoverageDispatch | FanoutCoverageDispatch[]>;
}

export interface FanoutCoverageEvalReport {
  declaredKeys: string[];
  dispatches: FanoutCoverageDispatch[];
}

/**
 * Statuses proving the declared work actually ran. Every other status means
 * the fan-out reached the item but the work did not happen — the item was
 * refused, curtailed, or errored.
 */
const PERFORMED_STATUSES: ReadonlySet<FanoutCoverageStatus> = new Set([
  "succeeded",
]);

export interface FanoutCoverageScore {
  declared: number;
  dispatched: number;
  uniqueDispatched: number;
  duplicateDispatches: number;
  uncovered: string[];
  /**
   * Fraction of declared keys the fan-out reached at all. A denied or
   * budget-aborted item *was* reached, so it counts here. This answers
   * "did dispatch lose anything?", not "did the work happen?".
   */
  coverage: number;
  /**
   * Fraction of declared keys that reached a status proving the work ran.
   * Diverges from `coverage` exactly when items were denied, cancelled,
   * expired, budget-aborted, or failed. This is the number to gate on when
   * you care whether the fan-out accomplished its declared work.
   */
  effectiveCoverage: number;
  /** Declared keys that were reached but whose work did not run. */
  unperformed: string[];
  /** Every declared key dispatched exactly once, regardless of outcome. */
  exactOnce: boolean;
  /**
   * Every declared key dispatched exactly once *and* performed. `exactOnce`
   * alone is true for a fan-out in which every single item was denied.
   */
  exactOnceEffective: boolean;
}

export async function runDeterministicFanoutCoverageEval(
  input: FanoutCoverageEvalInput
): Promise<FanoutCoverageEvalReport> {
  const dispatches: FanoutCoverageDispatch[] = [];
  for (const key of input.declaredKeys) {
    const result = await input.dispatch(key);
    dispatches.push(...(Array.isArray(result) ? result : [result]));
  }
  return {
    declaredKeys: [...input.declaredKeys],
    dispatches,
  };
}

export function scoreFanoutCoverageReport(
  report: FanoutCoverageEvalReport
): FanoutCoverageScore {
  const declared = new Set(report.declaredKeys);
  const perKey = new Map<string, number>();
  const performedKeys = new Set<string>();
  let dispatched = 0;
  for (const dispatch of report.dispatches) {
    if (!declared.has(dispatch.key)) continue;
    if (dispatch.status === "never_dispatched") continue;
    dispatched += 1;
    perKey.set(dispatch.key, (perKey.get(dispatch.key) ?? 0) + 1);
    if (PERFORMED_STATUSES.has(dispatch.status)) {
      performedKeys.add(dispatch.key);
    }
  }

  const uncovered = report.declaredKeys.filter((key) => !perKey.has(key));
  const duplicateDispatches = [...perKey.values()].reduce(
    (total, count) => total + Math.max(0, count - 1),
    0
  );
  const uniqueDispatched = perKey.size;
  // Reached but did not do the declared work: denied, cancelled, expired,
  // budget-aborted, or failed. Distinct from `uncovered`, which never
  // arrived at all.
  const unperformed = report.declaredKeys.filter(
    (key) => perKey.has(key) && !performedKeys.has(key)
  );

  return {
    declared: report.declaredKeys.length,
    dispatched,
    uniqueDispatched,
    duplicateDispatches,
    uncovered,
    coverage:
      report.declaredKeys.length === 0
        ? 1
        : uniqueDispatched / report.declaredKeys.length,
    effectiveCoverage:
      report.declaredKeys.length === 0
        ? 1
        : performedKeys.size / report.declaredKeys.length,
    unperformed,
    exactOnce: uncovered.length === 0 && duplicateDispatches === 0,
    exactOnceEffective:
      uncovered.length === 0 &&
      duplicateDispatches === 0 &&
      unperformed.length === 0,
  };
}
