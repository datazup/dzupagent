import type { FanoutBatchRecord } from "../../contracts/fanout-batch-store.js";
import type { FanoutReport, FanoutReportItem } from "./types.js";

/**
 * Reconstruct a {@link FanoutReport} from a persisted {@link FanoutBatchRecord}
 * (Phase B hardening). Lets a host rebuild the machine-checkable fan-out report
 * from the durable ledger after the coordinator that ran the batch is gone —
 * every declared item appears exactly once, in declared order, with its last
 * persisted status. `dispatched` counts items that reached a `taskId`;
 * `uncovered` lists any item still `never_dispatched`.
 */
export function fanoutBatchRecordToReport(
  record: FanoutBatchRecord
): FanoutReport {
  const items: FanoutReportItem[] = record.items.map((item) => ({
    key: item.key,
    status: item.status,
    ...(item.taskId !== undefined ? { taskId: item.taskId } : {}),
    ...(item.result !== undefined ? { result: item.result } : {}),
    ...(item.resultTruncated !== undefined
      ? { resultTruncated: item.resultTruncated }
      : {}),
    ...(item.provider !== undefined ? { provider: item.provider } : {}),
    ...(item.error !== undefined ? { error: item.error } : {}),
    ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
    ...(item.outputTokens !== undefined
      ? { outputTokens: item.outputTokens }
      : {}),
    ...(item.costUsd !== undefined ? { costUsd: item.costUsd } : {}),
  }));

  const settled = {
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    expired: 0,
    denied: 0,
    aborted_budget: 0,
  };
  const uncovered: string[] = [];
  let dispatched = 0;
  for (const item of items) {
    if (item.taskId !== undefined) {
      dispatched += 1;
    }
    switch (item.status) {
      case "succeeded":
        settled.succeeded += 1;
        break;
      case "failed":
        settled.failed += 1;
        break;
      case "cancelled":
        settled.cancelled += 1;
        break;
      case "expired":
        settled.expired += 1;
        break;
      case "denied":
        settled.denied += 1;
        break;
      case "aborted_budget":
        settled.aborted_budget += 1;
        break;
      case "never_dispatched":
        uncovered.push(item.key);
        break;
      default:
        break;
    }
  }

  const wallClockMs =
    record.wallClockMs ??
    Math.max(0, (record.completedAt ?? record.updatedAt) - record.startedAt);

  return {
    batchId: record.batchId,
    mode: record.mode,
    declared: record.declared.length,
    dispatched,
    settled,
    uncovered,
    items,
    extraDispatches: [],
    budget: {
      ...(record.outputTokensUsed !== undefined
        ? { outputTokensUsed: record.outputTokensUsed }
        : {}),
      ...(record.budgetUsdReserved !== undefined
        ? { budgetUsdReserved: record.budgetUsdReserved }
        : {}),
      ...(record.budgetUsdActual !== undefined
        ? { budgetUsdActual: record.budgetUsdActual }
        : {}),
      wallClockMs,
      aborted: record.budgetAborted ?? false,
      ...(record.abortedReason !== undefined
        ? { abortedReason: record.abortedReason }
        : {}),
    },
    logs: [],
  };
}
