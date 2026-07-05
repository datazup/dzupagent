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
    key: string,
  ) => Promise<FanoutCoverageDispatch | FanoutCoverageDispatch[]>;
}

export interface FanoutCoverageEvalReport {
  declaredKeys: string[];
  dispatches: FanoutCoverageDispatch[];
}

export interface FanoutCoverageScore {
  declared: number;
  dispatched: number;
  uniqueDispatched: number;
  duplicateDispatches: number;
  uncovered: string[];
  coverage: number;
  exactOnce: boolean;
}

export async function runDeterministicFanoutCoverageEval(
  input: FanoutCoverageEvalInput,
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
  report: FanoutCoverageEvalReport,
): FanoutCoverageScore {
  const declared = new Set(report.declaredKeys);
  const perKey = new Map<string, number>();
  let dispatched = 0;
  for (const dispatch of report.dispatches) {
    if (!declared.has(dispatch.key)) continue;
    if (dispatch.status === "never_dispatched") continue;
    dispatched += 1;
    perKey.set(dispatch.key, (perKey.get(dispatch.key) ?? 0) + 1);
  }

  const uncovered = report.declaredKeys.filter((key) => !perKey.has(key));
  const duplicateDispatches = [...perKey.values()].reduce(
    (total, count) => total + Math.max(0, count - 1),
    0,
  );
  const uniqueDispatched = perKey.size;

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
    exactOnce: uncovered.length === 0 && duplicateDispatches === 0,
  };
}
