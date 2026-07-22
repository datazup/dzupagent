import type { SubagentSpec } from "../../contracts/background-task.js";
import { systemClock } from "../../contracts/clock.js";
import type { FanoutRuntimeEvent } from "../../contracts/events.js";
import type { FanoutBatchItemUpdate } from "../../contracts/fanout-batch-store.js";
import type { SubagentToolDescriptor } from "../types.js";
import {
  nextBatchCounter,
  roundBudgetUsd,
  templateBudgetHints,
} from "./helpers.js";
import { createItemPipeline, type FanoutRunState } from "./item-pipeline.js";
import {
  FANOUT_TEMPLATE_TOOL_DESCRIPTION,
  FANOUT_TEMPLATE_TOOL_NAME,
  FANOUT_TEMPLATE_TOOL_PARAMETERS,
} from "./schema.js";
import {
  DEFAULT_FANOUT_LIMITS,
  type FanoutLimits,
  type FanoutReport,
  type FanoutReportItem,
  type FanoutTemplateArgs,
  type FanoutToolConfig,
  type FanoutValidationError,
} from "./types.js";

/**
 * `fanout_template` — v1 (template-only) batch fan-out tool
 * (dynamic-subagents Spec 01). The host loops over a declared item list,
 * builds a per-item {@link SubagentSpec} from a template, and dispatches every
 * item through `runtime.spawn(...)` — the SAME gate, store, and lifecycle path
 * as `spawn_subagent`. Coverage is structural (guaranteed by this host loop),
 * not probabilistic; the returned {@link FanoutReport} makes any coverage
 * failure machine-checkable via `uncovered`.
 *
 * Script mode (`fanout_script`) is deliberately NOT implemented here — it is a
 * later, flag-gated track (decision OQ1) that must never make this package
 * depend on a sandbox implementation (NFR3).
 */

/**
 * Build the `fanout_template` tool descriptor. Same descriptor shape and
 * `resolveParentRunId` wiring as the four single-task tools.
 */
export function createFanoutTemplateTool(
  config: FanoutToolConfig
): SubagentToolDescriptor<
  FanoutTemplateArgs,
  FanoutReport | FanoutValidationError
> {
  const { runtime, resolveParentRunId } = config;
  const limits: FanoutLimits = { ...DEFAULT_FANOUT_LIMITS, ...config.limits };
  const clock = config.clock ?? systemClock;
  const store = config.fanoutBatchStore;
  const generateBatchId =
    config.generateBatchId ??
    (() => `fanout-${clock.now().toString(36)}-${nextBatchCounter()}`);
  const emit = (event: FanoutRuntimeEvent): void =>
    runtime.eventSink.emit(event);

  return {
    name: FANOUT_TEMPLATE_TOOL_NAME,
    description: FANOUT_TEMPLATE_TOOL_DESCRIPTION,
    parameters: FANOUT_TEMPLATE_TOOL_PARAMETERS,
    invoke: async (args) => {
      // --- Validation: reject before ANY spawn (Spec 01 AC1 companion). ---
      if (!Array.isArray(args.items) || args.items.length === 0) {
        return { error: "invalid_batch", detail: "items_empty" };
      }
      if (args.items.length > limits.maxBatchSize) {
        return {
          error: "invalid_batch",
          detail: `batch_size_exceeds_max:${limits.maxBatchSize}`,
        };
      }
      const seenKeys = new Set<string>();
      for (const item of args.items) {
        if (typeof item.key !== "string" || item.key.length === 0) {
          return { error: "invalid_batch", detail: "item_key_missing" };
        }
        if (seenKeys.has(item.key)) {
          return {
            error: "invalid_batch",
            detail: `duplicate_key:${item.key}`,
          };
        }
        seenKeys.add(item.key);
      }

      const parentRunId = resolveParentRunId();
      const batchId = generateBatchId();
      const declared = args.items.length;
      const maxWallClockMs = Math.min(
        args.budget?.maxWallClockMs ?? limits.maxWallClockMs,
        limits.maxWallClockMs
      );
      const maxTotalOutputTokens =
        args.budget?.maxTotalOutputTokens ?? limits.maxTotalOutputTokens;
      const maxTotalBudgetUsd =
        args.budget?.maxTotalBudgetUsd ?? limits.maxTotalBudgetUsd;
      const concurrency = Math.max(
        1,
        Math.min(args.concurrency ?? limits.maxConcurrent, limits.maxConcurrent)
      );
      const startedAt = clock.now();
      const deadline = startedAt + maxWallClockMs;

      /** Best-effort per-item ledger write; a store failure never aborts fan-out. */
      const recordItem = async (
        itemKey: string,
        update: FanoutBatchItemUpdate
      ): Promise<void> => {
        if (store === undefined) return;
        try {
          await store.recordItem(batchId, itemKey, update);
        } catch {
          // Non-fatal: the ledger is an observability aid, not the source of truth.
        }
      };

      // The template spec the batch is approved against. Per-item specs are
      // scope-narrowed against this by the gate (validateBatchScope) at spawn.
      const batchTemplateSpec: SubagentSpec = {
        agentId: args.spec.agentId,
        input: { fanoutMode: "template" },
        ...(args.spec.definition !== undefined
          ? { definition: args.spec.definition }
          : {}),
        ...(args.spec.instructions !== undefined
          ? { instructions: args.spec.instructions }
          : {}),
        ...(args.spec.outboundScope !== undefined
          ? { outboundScope: args.spec.outboundScope }
          : {}),
        ...(args.spec.memoryScope !== undefined
          ? { memoryScope: args.spec.memoryScope }
          : {}),
      };

      // Durable ledger: record the batch up front so per-item progress survives
      // coordinator loss. Non-fatal — a store failure never blocks the fan-out.
      if (store !== undefined) {
        try {
          await store.create({
            batchId,
            parentRunId,
            mode: "template",
            declared: args.items.map((item) => item.key),
            startedAt,
          });
        } catch {
          // Non-fatal.
        }
      }

      emit({
        type: "fanout:started",
        batchId,
        parentRunId,
        mode: "template",
        declared,
      });

      // Batch-level gate (Phase B hardening): one decision for the whole batch,
      // BEFORE the worker pool starts. On denial no item is dispatched; every
      // declared item is reported `denied` (honest coverage — uncovered stays []).
      const admission = await runtime.evaluateBatch({
        batchId,
        parentRunId,
        mode: "template",
        template: batchTemplateSpec,
        itemKeys: args.items.map((item) => item.key),
      });
      if (!admission.ok) {
        const wallClockMs = clock.now() - startedAt;
        const items: FanoutReportItem[] = args.items.map((item) => ({
          key: item.key,
          status: "denied" as const,
          error: admission.detail,
        }));
        for (const item of items) {
          await recordItem(item.key, {
            status: "denied",
            error: admission.detail,
            updatedAt: clock.now(),
          });
        }
        if (store !== undefined) {
          try {
            await store.complete(batchId, {
              status: "aborted",
              completedAt: clock.now(),
              wallClockMs,
              abortedReason: admission.detail,
            });
          } catch {
            // Non-fatal.
          }
        }
        emit({
          type: "fanout:aborted",
          batchId,
          reason: "denied",
          dispatched: 0,
        });
        return {
          batchId,
          mode: "template",
          declared,
          dispatched: 0,
          settled: {
            succeeded: 0,
            failed: 0,
            cancelled: 0,
            expired: 0,
            denied: declared,
            aborted_budget: 0,
          },
          uncovered: [],
          items,
          extraDispatches: [],
          budget: { wallClockMs, aborted: false },
          logs: [],
        };
      }

      // Per-item spawn context: carries the approved template so the gate runs
      // the scope-narrowing invariant on every per-item spec (Phase B).
      const batch = {
        batchId,
        batchSize: declared,
        mode: "template" as const,
        approved: true as const,
        template: admission.batch.template,
      };

      const state: FanoutRunState = {
        records: new Map<string, FanoutReportItem>(),
        abortState: { aborted: false },
        dispatched: 0,
        outputTokensUsed: 0,
        sawUsage: false,
        budgetUsdReserved: undefined,
        budgetUsdActual: undefined,
      };
      const { records, abortState } = state;

      const { perItemBudgetUsd, estimatedCostUsd } = templateBudgetHints(
        admission.batch.template
      );

      // Up-front reservation (reserve N × per-item maxBudgetUsd). When the whole
      // reservation cannot fit the aggregate USD cap, no item is dispatched and
      // every declared item is reported `aborted_budget` (honest coverage).
      if (perItemBudgetUsd !== undefined) {
        state.budgetUsdReserved = roundBudgetUsd(perItemBudgetUsd * declared);
        if (
          maxTotalBudgetUsd !== undefined &&
          state.budgetUsdReserved > maxTotalBudgetUsd
        ) {
          abortState.aborted = true;
          abortState.reason = "budget_exceeded";
          abortState.detailReason = "max_total_budget_usd_exceeded";
          const wallClockMs = clock.now() - startedAt;
          const items: FanoutReportItem[] = args.items.map((item) => ({
            key: item.key,
            status: "aborted_budget" as const,
            error: abortState.detailReason ?? "fanout_budget_aborted",
          }));
          for (const item of items) {
            await recordItem(item.key, {
              status: "aborted_budget",
              ...(item.error !== undefined ? { error: item.error } : {}),
              updatedAt: clock.now(),
            });
          }
          if (store !== undefined) {
            try {
              await store.complete(batchId, {
                status: "aborted",
                completedAt: clock.now(),
                wallClockMs,
                budgetUsdReserved: state.budgetUsdReserved,
                abortedReason: abortState.detailReason,
                budgetAborted: true,
              });
            } catch {
              // Non-fatal.
            }
          }
          emit({
            type: "fanout:aborted",
            batchId,
            reason: "budget_exceeded",
            dispatched: 0,
          });
          return {
            batchId,
            mode: "template",
            declared,
            dispatched: 0,
            settled: {
              succeeded: 0,
              failed: 0,
              cancelled: 0,
              expired: 0,
              denied: 0,
              aborted_budget: declared,
            },
            uncovered: [],
            items,
            extraDispatches: [],
            budget: {
              budgetUsdReserved: state.budgetUsdReserved,
              wallClockMs,
              aborted: true,
              ...(abortState.detailReason !== undefined
                ? { abortedReason: abortState.detailReason }
                : {}),
            },
            logs: [],
          };
        }
      }

      const processItem = createItemPipeline({
        runtime,
        clock,
        limits,
        args,
        parentRunId,
        batchId,
        deadline,
        maxTotalOutputTokens,
        maxTotalBudgetUsd,
        perItemBudgetUsd,
        estimatedCostUsd,
        batch,
        state,
        emit,
        recordItem,
      });

      // Bounded-concurrency worker pool over the declared items — the fan-out
      // clamps in-flight dispatches so a batch cannot flood maxQueuedTasks.
      let nextIndex = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= args.items.length) {
            return;
          }
          await processItem(
            args.items[index] as FanoutTemplateArgs["items"][number]
          );
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(concurrency, declared) }, () => worker())
      );

      // --- Assemble the report: every declared item exactly once (FR3/NFR4). ---
      const settled = {
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        expired: 0,
        denied: 0,
        aborted_budget: 0,
      };
      const uncovered: string[] = [];
      const items: FanoutReportItem[] = args.items.map((item) => {
        const record = records.get(item.key) ?? {
          key: item.key,
          status: "never_dispatched" as const,
        };
        switch (record.status) {
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
          default:
            break;
        }
        if (record.status === "never_dispatched") {
          uncovered.push(item.key);
        }
        return record;
      });

      const wallClockMs = clock.now() - startedAt;

      // Finalise the durable ledger (Phase B): mark the batch terminal so a
      // reader can distinguish a completed batch from one whose coordinator
      // died mid-run. Non-fatal — a store failure never fails the invocation.
      if (store !== undefined) {
        try {
          await store.complete(batchId, {
            status: abortState.aborted ? "aborted" : "completed",
            completedAt: clock.now(),
            wallClockMs,
            ...(state.sawUsage
              ? { outputTokensUsed: state.outputTokensUsed }
              : {}),
            ...(state.budgetUsdReserved !== undefined
              ? { budgetUsdReserved: state.budgetUsdReserved }
              : {}),
            ...(state.budgetUsdActual !== undefined
              ? { budgetUsdActual: state.budgetUsdActual }
              : {}),
            ...(abortState.aborted
              ? {
                  abortedReason:
                    abortState.detailReason ?? abortState.reason ?? "timeout",
                }
              : {}),
            ...(abortState.aborted && abortState.reason === "budget_exceeded"
              ? { budgetAborted: true }
              : {}),
          });
        } catch {
          // Non-fatal.
        }
      }

      if (abortState.aborted) {
        emit({
          type: "fanout:aborted",
          batchId,
          reason: abortState.reason ?? "timeout",
          dispatched: state.dispatched,
        });
      } else {
        emit({
          type: "fanout:completed",
          batchId,
          dispatched: state.dispatched,
          succeeded: settled.succeeded,
          failed: settled.failed,
          uncovered: uncovered.length,
          wallClockMs,
        });
      }

      return {
        batchId,
        mode: "template",
        declared,
        dispatched: state.dispatched,
        settled,
        uncovered,
        items,
        extraDispatches: [],
        budget: {
          ...(state.sawUsage
            ? { outputTokensUsed: state.outputTokensUsed }
            : {}),
          ...(state.budgetUsdReserved !== undefined
            ? { budgetUsdReserved: state.budgetUsdReserved }
            : {}),
          ...(state.budgetUsdActual !== undefined
            ? { budgetUsdActual: state.budgetUsdActual }
            : {}),
          wallClockMs,
          aborted: abortState.aborted,
          ...(abortState.aborted && abortState.detailReason !== undefined
            ? { abortedReason: abortState.detailReason }
            : {}),
        },
        logs: [],
      };
    },
  };
}
