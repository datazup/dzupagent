import type {
  BackgroundTask,
  SubagentSpec,
  TaskStatus,
} from "../../contracts/background-task.js";
import { isTerminalStatus } from "../../contracts/background-task.js";
import type { Clock } from "../../contracts/clock.js";
import type { FanoutRuntimeEvent } from "../../contracts/events.js";
import type { FanoutBatchItemUpdate } from "../../contracts/fanout-batch-store.js";
import type { BackgroundSubagentRuntime } from "../../runtime/background-subagent-runtime.js";
import {
  capResult,
  roundBudgetUsd,
  sleep,
  substitutePlaceholders,
} from "./helpers.js";
import type {
  FanoutItem,
  FanoutLimits,
  FanoutReportItem,
  FanoutTemplateArgs,
} from "./types.js";

/**
 * Per-invocation abort flag shared by the worker pool. The first abort reason
 * wins; `detailReason` carries the specific USD-budget reason used for item
 * errors and ledger writes.
 */
export interface AbortState {
  aborted: boolean;
  reason?: "budget_exceeded" | "timeout";
  detailReason?: string;
}

/**
 * Mutable accounting the worker pool reads and updates while dispatching and
 * settling declared items. All fields are owned by a single `invoke` call;
 * the worker pool mutates them in place so the final report can read the
 * settled totals.
 */
export interface FanoutRunState {
  readonly records: Map<string, FanoutReportItem>;
  readonly abortState: AbortState;
  dispatched: number;
  outputTokensUsed: number;
  sawUsage: boolean;
  budgetUsdReserved: number | undefined;
  budgetUsdActual: number | undefined;
}

/**
 * Immutable per-invocation context handed to the worker pipeline: resolved
 * limits/budgets, the injected clock, the approved batch descriptor, and the
 * best-effort ledger writer.
 */
export interface FanoutPipelineContext {
  readonly runtime: BackgroundSubagentRuntime;
  readonly clock: Clock;
  readonly limits: FanoutLimits;
  readonly args: FanoutTemplateArgs;
  readonly parentRunId: string;
  readonly batchId: string;
  readonly deadline: number;
  readonly maxTotalOutputTokens: number | undefined;
  readonly maxTotalBudgetUsd: number | undefined;
  readonly perItemBudgetUsd: number | undefined;
  readonly estimatedCostUsd: number | undefined;
  /** Per-item spawn context carrying the approved template (Phase B). */
  readonly batch: {
    batchId: string;
    batchSize: number;
    mode: "template";
    approved: true;
    template: SubagentSpec;
  };
  readonly state: FanoutRunState;
  readonly emit: (event: FanoutRuntimeEvent) => void;
  readonly recordItem: (
    itemKey: string,
    update: FanoutBatchItemUpdate
  ) => Promise<void>;
}

/**
 * Build the `processItem` worker used by the bounded-concurrency pool. Returns
 * a single async function; all shared mutation goes through `ctx.state` so the
 * coordinator can read the settled totals after the pool drains.
 */
export function createItemPipeline(
  ctx: FanoutPipelineContext
): (item: FanoutItem) => Promise<void> {
  const {
    runtime,
    clock,
    limits,
    args,
    parentRunId,
    batchId,
    deadline,
    maxTotalOutputTokens,
    maxTotalBudgetUsd,
    estimatedCostUsd,
    batch,
    state,
    emit,
    recordItem,
  } = ctx;
  const { records, abortState } = state;

  /** First abort reason wins; also records the specific detail string. */
  const abortBudget = (detailReason: string): void => {
    if (abortState.aborted) return;
    abortState.aborted = true;
    abortState.reason = "budget_exceeded";
    abortState.detailReason = detailReason;
  };

  const buildSpec = (item: FanoutItem): SubagentSpec => ({
    agentId: args.spec.agentId,
    input: item.input,
    ...(args.spec.definition !== undefined
      ? { definition: args.spec.definition }
      : {}),
    ...(args.spec.instructions !== undefined
      ? {
          instructions: substitutePlaceholders(args.spec.instructions, item),
        }
      : {}),
    ...(args.spec.outboundScope !== undefined
      ? { outboundScope: args.spec.outboundScope }
      : {}),
    ...(args.spec.memoryScope !== undefined
      ? { memoryScope: args.spec.memoryScope }
      : {}),
  });

  /** Dispatch one item, retrying `queue_full` with backoff inside the wall clock. */
  const dispatchItem = async (
    item: FanoutItem
  ): Promise<
    | { kind: "dispatched"; taskId: string }
    | { kind: "denied"; detail?: string }
    | { kind: "never_dispatched" }
  > => {
    let backoffMs = 10;
    for (;;) {
      if (abortState.aborted || clock.now() >= deadline) {
        return { kind: "never_dispatched" };
      }
      const outcome = await runtime.spawn(buildSpec(item), parentRunId, {
        ...(args.ttlMs !== undefined ? { ttlMs: args.ttlMs } : {}),
        batchId,
        batch,
      });
      if (outcome.ok) {
        return { kind: "dispatched", taskId: outcome.taskId };
      }
      if (outcome.reason === "denied") {
        return {
          kind: "denied",
          ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        };
      }
      // queue_full — retry with backoff while inside the wall clock.
      await sleep(Math.min(backoffMs, Math.max(1, deadline - clock.now())));
      backoffMs = Math.min(backoffMs * 2, 1000);
    }
  };

  const settleItem = async (
    item: FanoutItem,
    taskId: string
  ): Promise<void> => {
    const remaining = deadline - clock.now();
    const task: BackgroundTask | null = await runtime.await(
      taskId,
      { timeoutMs: Math.max(0, remaining), pollIntervalMs: 5 },
      { parentRunId }
    );
    if (task && isTerminalStatus(task.status)) {
      const durationMs =
        task.startedAt !== undefined && task.endedAt !== undefined
          ? task.endedAt - task.startedAt
          : undefined;
      const outputTokens = task.result?.usage?.outputTokens;
      if (outputTokens !== undefined) {
        state.sawUsage = true;
        state.outputTokensUsed += outputTokens;
        if (
          maxTotalOutputTokens !== undefined &&
          state.outputTokensUsed > maxTotalOutputTokens &&
          !abortState.aborted
        ) {
          abortState.aborted = true;
          abortState.reason = "budget_exceeded";
        }
      }
      // Record actual USD spend and abort remaining work if it overruns the
      // aggregate cap (later queued items then report `aborted_budget`).
      const rawCostUsd = task.result?.usage?.costUsd;
      const costUsd =
        rawCostUsd !== undefined ? roundBudgetUsd(rawCostUsd) : undefined;
      if (costUsd !== undefined) {
        state.budgetUsdActual = roundBudgetUsd(
          (state.budgetUsdActual ?? 0) + costUsd
        );
        if (
          maxTotalBudgetUsd !== undefined &&
          state.budgetUsdActual > maxTotalBudgetUsd
        ) {
          abortBudget("max_total_budget_usd_exceeded");
        }
      }
      const provider = task.result?.provider;
      const settledRecord: FanoutReportItem = {
        key: item.key,
        taskId,
        status: task.status,
        ...capResult(task.result?.output, limits.maxResultBytes),
        ...(provider !== undefined ? { provider } : {}),
        ...(task.error !== undefined ? { error: task.error } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
      records.set(item.key, settledRecord);
      await recordItem(item.key, {
        taskId,
        status: task.status,
        ...(task.result !== undefined ? { result: task.result } : {}),
        ...(settledRecord.resultTruncated !== undefined
          ? { resultTruncated: settledRecord.resultTruncated }
          : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(task.error !== undefined ? { error: task.error } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        updatedAt: clock.now(),
      });
      emit({
        type: "fanout:item_settled",
        batchId,
        itemKey: item.key,
        taskId,
        status: task.status,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      return;
    }
    // Wall clock exhausted while the task is still non-terminal: the
    // fan-out budget aborts it (Spec 01 §6). Cancel and report honestly.
    if (!abortState.aborted) {
      abortState.aborted = true;
      abortState.reason = "timeout";
    }
    const cancelled = await runtime.cancel(taskId, { parentRunId });
    const finalStatus: TaskStatus = cancelled?.status ?? "cancelled";
    records.set(item.key, {
      key: item.key,
      taskId,
      status: "aborted_budget",
      error: "fanout_wall_clock_exceeded",
    });
    await recordItem(item.key, {
      taskId,
      status: "aborted_budget",
      error: "fanout_wall_clock_exceeded",
      updatedAt: clock.now(),
    });
    emit({
      type: "fanout:item_settled",
      batchId,
      itemKey: item.key,
      taskId,
      status: finalStatus,
    });
  };

  return async (item: FanoutItem): Promise<void> => {
    // A USD-budget abort already tripped — later items are aborted_budget
    // (honest coverage), NOT never_dispatched (which would be `uncovered`).
    if (abortState.aborted && abortState.detailReason !== undefined) {
      records.set(item.key, {
        key: item.key,
        status: "aborted_budget",
        error: abortState.detailReason,
      });
      await recordItem(item.key, {
        status: "aborted_budget",
        error: abortState.detailReason,
        updatedAt: clock.now(),
      });
      return;
    }
    if (abortState.aborted || clock.now() >= deadline) {
      records.set(item.key, {
        key: item.key,
        status: "never_dispatched",
      });
      return;
    }
    // Per-item preflight reservation against the estimated cost. If this item
    // cannot fit the remaining aggregate USD budget, abort before dispatch;
    // this and every later item are reported `aborted_budget`.
    if (estimatedCostUsd !== undefined) {
      const rounded = roundBudgetUsd(estimatedCostUsd);
      if (
        maxTotalBudgetUsd !== undefined &&
        roundBudgetUsd((state.budgetUsdActual ?? 0) + rounded) >
          maxTotalBudgetUsd
      ) {
        abortBudget("max_total_budget_usd_preflight_exceeded");
        records.set(item.key, {
          key: item.key,
          status: "aborted_budget",
          error: abortState.detailReason,
        });
        await recordItem(item.key, {
          status: "aborted_budget",
          ...(abortState.detailReason !== undefined
            ? { error: abortState.detailReason }
            : {}),
          updatedAt: clock.now(),
        });
        return;
      }
      state.budgetUsdReserved = roundBudgetUsd(
        (state.budgetUsdReserved ?? 0) + rounded
      );
    }
    const dispatch = await dispatchItem(item);
    if (dispatch.kind === "denied") {
      records.set(item.key, {
        key: item.key,
        status: "denied",
        ...(dispatch.detail !== undefined ? { error: dispatch.detail } : {}),
      });
      await recordItem(item.key, {
        status: "denied",
        ...(dispatch.detail !== undefined ? { error: dispatch.detail } : {}),
        updatedAt: clock.now(),
      });
      return;
    }
    if (dispatch.kind === "never_dispatched") {
      if (!abortState.aborted) {
        abortState.aborted = true;
        abortState.reason = "timeout";
      }
      records.set(item.key, {
        key: item.key,
        status: "never_dispatched",
      });
      await recordItem(item.key, {
        status: "never_dispatched",
        updatedAt: clock.now(),
      });
      return;
    }
    state.dispatched += 1;
    await recordItem(item.key, {
      taskId: dispatch.taskId,
      status: "running",
      updatedAt: clock.now(),
    });
    emit({
      type: "fanout:item_dispatched",
      batchId,
      itemKey: item.key,
      taskId: dispatch.taskId,
    });
    await settleItem(item, dispatch.taskId);
  };
}
