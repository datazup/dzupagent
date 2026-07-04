import type {
  BackgroundTask,
  SubagentSpec,
  TaskStatus,
} from "../contracts/background-task.js";
import { isTerminalStatus } from "../contracts/background-task.js";
import type { Clock } from "../contracts/clock.js";
import { systemClock } from "../contracts/clock.js";
import type { FanoutRuntimeEvent } from "../contracts/events.js";
import type {
  FanoutBatchItemUpdate,
  FanoutBatchStore,
} from "../contracts/fanout-batch-store.js";
import type { BackgroundSubagentRuntime } from "../runtime/background-subagent-runtime.js";
import type { SubagentToolDescriptor } from "./subagent-tools.js";

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

/** Aggregate limits for a single fan-out invocation (Spec 01 §2). */
export interface FanoutLimits {
  /** Max declared items per batch. Default 200. */
  maxBatchSize: number;
  /** Max in-flight dispatch/settle workers. Default 4. */
  maxConcurrent: number;
  /** Aggregate output-token budget across items (advisory if adapters report no usage). */
  maxTotalOutputTokens?: number;
  /** Whole-fan-out wall clock. Default 15 min. */
  maxWallClockMs: number;
  /** Per-item returned output cap in bytes. Default 2 KiB. */
  maxResultBytes: number;
}

export const DEFAULT_FANOUT_LIMITS: FanoutLimits = {
  maxBatchSize: 200,
  maxConcurrent: 4,
  maxWallClockMs: 15 * 60 * 1000, // 15 minutes
  maxResultBytes: 2048, // 2 KiB
};

export interface FanoutToolConfig {
  runtime: BackgroundSubagentRuntime;
  /** Resolves the parent run id for the current tool invocation. */
  resolveParentRunId: () => string;
  /** Deterministic batch-id generator; defaults to a clock+counter id. */
  generateBatchId?: () => string;
  /** Overrides merged over {@link DEFAULT_FANOUT_LIMITS}. */
  limits?: Partial<FanoutLimits>;
  /** Injected clock (no `Date.now()` in core paths); defaults to systemClock. */
  clock?: Clock;
  /**
   * Optional durable ledger for per-item fan-out progress (Phase B hardening).
   * When supplied, the coordinator records the batch and every item lifecycle
   * transition (dispatched → settled/denied/aborted) so a batch's progress and
   * per-item reports survive coordinator loss and remain queryable by `batchId`.
   * Omit for pure in-memory fan-out (the returned {@link FanoutReport} is still
   * complete regardless).
   */
  fanoutBatchStore?: FanoutBatchStore;
}

/** A declared fan-out item. Keys must be unique within a batch. */
export interface FanoutItem {
  key: string;
  input: string | Record<string, unknown>;
}

/** Template-mode arguments (Spec 01 §2.1). */
export type FanoutTemplateArgs = {
  items: FanoutItem[];
  spec: {
    agentId: string;
    /** May contain `{{key}}` / `{{input}}` placeholders. */
    instructions?: string;
    outboundScope?: string[];
    memoryScope?: SubagentSpec["memoryScope"];
  };
  /** Clamped to `limits.maxConcurrent`. */
  concurrency?: number;
  ttlMs?: number;
  budget?: { maxTotalOutputTokens?: number; maxWallClockMs?: number };
};

/** Honest terminal status of a declared item (NFR4). */
export type FanoutItemStatus =
  | TaskStatus
  | "denied"
  | "aborted_budget"
  | "never_dispatched";

export interface FanoutReportItem {
  key: string;
  taskId?: string;
  status: FanoutItemStatus;
  /** Truncated to `limits.maxResultBytes`; retrieve full output via check_subagent. */
  result?: unknown;
  /** Set when the cap trimmed `result`. */
  resultTruncated?: boolean;
  /** Adapter actually used. Left undefined in v1 (routing is Phase C). */
  provider?: string;
  error?: string;
  durationMs?: number;
  outputTokens?: number;
}

/** Structured fan-out result (Spec 01 §5). */
export interface FanoutReport {
  batchId: string;
  mode: "template" | "script";
  declared: number;
  dispatched: number;
  settled: {
    succeeded: number;
    failed: number;
    cancelled: number;
    expired: number;
    denied: number;
    aborted_budget: number;
  };
  /** Declared keys never dispatched — MUST be [] for a clean run. */
  uncovered: string[];
  /** Every declared item, exactly once, in declared order. */
  items: FanoutReportItem[];
  /** Script mode only; always [] in template mode. */
  extraDispatches: Array<{ key: string; taskId: string; status: string }>;
  budget: {
    outputTokensUsed?: number;
    wallClockMs: number;
    aborted: boolean;
  };
  /** Script `log()` lines; always [] in template mode. */
  logs: string[];
}

/** Typed validation failure — returned (never thrown) with zero spawns performed. */
export interface FanoutValidationError {
  error: "invalid_batch";
  detail: string;
}

export function isFanoutValidationError(
  value: FanoutReport | FanoutValidationError,
): value is FanoutValidationError {
  return "error" in value;
}

let batchCounter = 0;

/** Substitute `{{key}}` / `{{input}}` placeholders in an instruction template. */
function substitutePlaceholders(template: string, item: FanoutItem): string {
  const inputText =
    typeof item.input === "string" ? item.input : JSON.stringify(item.input);
  return template
    .replaceAll("{{key}}", item.key)
    .replaceAll("{{input}}", inputText);
}

/**
 * Truncate an item result to the per-item byte cap. The `taskId` stays in the
 * report so a supervisor can `check_subagent` for the full output.
 */
function capResult(
  output: unknown,
  maxResultBytes: number,
): { result?: unknown; resultTruncated?: boolean } {
  if (output === undefined) {
    return {};
  }
  const serialized =
    typeof output === "string" ? output : JSON.stringify(output);
  if (serialized === undefined) {
    return {};
  }
  if (Buffer.byteLength(serialized, "utf8") <= maxResultBytes) {
    return { result: output };
  }
  // Byte-accurate truncation; a split multi-byte tail is dropped by decode.
  const truncated = Buffer.from(serialized, "utf8")
    .subarray(0, maxResultBytes)
    .toString("utf8");
  return { result: truncated, resultTruncated: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Build the `fanout_template` tool descriptor. Same descriptor shape and
 * `resolveParentRunId` wiring as the four single-task tools.
 */
export function createFanoutTemplateTool(
  config: FanoutToolConfig,
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
    (() => `fanout-${clock.now().toString(36)}-${(batchCounter += 1)}`);
  const emit = (event: FanoutRuntimeEvent): void =>
    runtime.eventSink.emit(event);

  /** Best-effort per-item ledger write; a store failure never aborts fan-out. */
  const recordItem = async (
    batchId: string,
    itemKey: string,
    update: FanoutBatchItemUpdate,
  ): Promise<void> => {
    if (store === undefined) return;
    try {
      await store.recordItem(batchId, itemKey, update);
    } catch {
      // Non-fatal: the ledger is an observability aid, not the source of truth.
    }
  };

  return {
    name: "fanout_template",
    description:
      "Dispatch the SAME operation across a known list of items (use for ≥3 items) with a structural coverage guarantee: every declared item is spawned as a background subagent exactly once and reported with an honest terminal status. Provide unique item keys and a per-item spec template ({{key}}/{{input}} placeholders are substituted into instructions). Returns a FanoutReport; a non-empty `uncovered` array means coverage failed. Use spawn_subagent/await_subagent for singleton or interactive work.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description:
            "Declared items to process. Every item MUST be listed here — coverage is measured against this list.",
          items: {
            type: "object",
            properties: {
              key: {
                type: "string",
                description: "Unique key identifying the item.",
              },
              input: { description: "The per-item task input." },
            },
            required: ["key", "input"],
          },
        },
        spec: {
          type: "object",
          description: "Per-item SubagentSpec template.",
          properties: {
            agentId: {
              type: "string",
              description: "Which agent to dispatch for every item.",
            },
            instructions: {
              type: "string",
              description:
                "Optional instruction template; {{key}} and {{input}} are substituted per item.",
            },
            outboundScope: { type: "array", items: { type: "string" } },
            memoryScope: {
              type: "string",
              enum: ["global", "workspace", "project", "agent"],
            },
          },
          required: ["agentId"],
        },
        concurrency: {
          type: "number",
          description: "Max in-flight items (clamped to the host limit).",
        },
        ttlMs: {
          type: "number",
          description: "Optional per-item time-to-live in milliseconds.",
        },
        budget: {
          type: "object",
          properties: {
            maxTotalOutputTokens: { type: "number" },
            maxWallClockMs: { type: "number" },
          },
        },
      },
      required: ["items", "spec"],
    },
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
        limits.maxWallClockMs,
      );
      const maxTotalOutputTokens =
        args.budget?.maxTotalOutputTokens ?? limits.maxTotalOutputTokens;
      const concurrency = Math.max(
        1,
        Math.min(
          args.concurrency ?? limits.maxConcurrent,
          limits.maxConcurrent,
        ),
      );
      const startedAt = clock.now();
      const deadline = startedAt + maxWallClockMs;

      // The template spec the batch is approved against. Per-item specs are
      // scope-narrowed against this by the gate (validateBatchScope) at spawn.
      const batchTemplateSpec: SubagentSpec = {
        agentId: args.spec.agentId,
        input: { fanoutMode: "template" },
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
          await recordItem(batchId, item.key, {
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
        approved: true,
        template: admission.batch.template,
      };

      const records = new Map<string, FanoutReportItem>();
      const abortState: {
        aborted: boolean;
        reason?: "budget_exceeded" | "timeout";
      } = { aborted: false };
      let dispatched = 0;
      let outputTokensUsed = 0;
      let sawUsage = false;

      const buildSpec = (item: FanoutItem): SubagentSpec => ({
        agentId: args.spec.agentId,
        input: item.input,
        ...(args.spec.instructions !== undefined
          ? {
              instructions: substitutePlaceholders(
                args.spec.instructions,
                item,
              ),
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
        item: FanoutItem,
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
              ...(outcome.detail !== undefined
                ? { detail: outcome.detail }
                : {}),
            };
          }
          // queue_full — retry with backoff while inside the wall clock.
          await sleep(Math.min(backoffMs, Math.max(1, deadline - clock.now())));
          backoffMs = Math.min(backoffMs * 2, 1000);
        }
      };

      const settleItem = async (
        item: FanoutItem,
        taskId: string,
      ): Promise<void> => {
        const remaining = deadline - clock.now();
        const task: BackgroundTask | null = await runtime.await(
          taskId,
          { timeoutMs: Math.max(0, remaining), pollIntervalMs: 5 },
          { parentRunId },
        );
        if (task && isTerminalStatus(task.status)) {
          const durationMs =
            task.startedAt !== undefined && task.endedAt !== undefined
              ? task.endedAt - task.startedAt
              : undefined;
          const outputTokens = task.result?.usage?.outputTokens;
          if (outputTokens !== undefined) {
            sawUsage = true;
            outputTokensUsed += outputTokens;
            if (
              maxTotalOutputTokens !== undefined &&
              outputTokensUsed > maxTotalOutputTokens &&
              !abortState.aborted
            ) {
              abortState.aborted = true;
              abortState.reason = "budget_exceeded";
            }
          }
          const settledRecord: FanoutReportItem = {
            key: item.key,
            taskId,
            status: task.status,
            ...capResult(task.result?.output, limits.maxResultBytes),
            ...(task.error !== undefined ? { error: task.error } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          };
          records.set(item.key, settledRecord);
          await recordItem(batchId, item.key, {
            taskId,
            status: task.status,
            ...(task.result !== undefined ? { result: task.result } : {}),
            ...(settledRecord.resultTruncated !== undefined
              ? { resultTruncated: settledRecord.resultTruncated }
              : {}),
            ...(task.error !== undefined ? { error: task.error } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
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
        await recordItem(batchId, item.key, {
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

      const processItem = async (item: FanoutItem): Promise<void> => {
        if (abortState.aborted || clock.now() >= deadline) {
          records.set(item.key, {
            key: item.key,
            status: "never_dispatched",
          });
          return;
        }
        const dispatch = await dispatchItem(item);
        if (dispatch.kind === "denied") {
          records.set(item.key, {
            key: item.key,
            status: "denied",
            ...(dispatch.detail !== undefined
              ? { error: dispatch.detail }
              : {}),
          });
          await recordItem(batchId, item.key, {
            status: "denied",
            ...(dispatch.detail !== undefined
              ? { error: dispatch.detail }
              : {}),
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
          await recordItem(batchId, item.key, {
            status: "never_dispatched",
            updatedAt: clock.now(),
          });
          return;
        }
        dispatched += 1;
        await recordItem(batchId, item.key, {
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
          await processItem(args.items[index] as FanoutItem);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(concurrency, declared) }, () => worker()),
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
            ...(sawUsage ? { outputTokensUsed } : {}),
            ...(abortState.aborted
              ? { abortedReason: abortState.reason ?? "timeout" }
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
          dispatched,
        });
      } else {
        emit({
          type: "fanout:completed",
          batchId,
          dispatched,
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
        dispatched,
        settled,
        uncovered,
        items,
        extraDispatches: [],
        budget: {
          ...(sawUsage ? { outputTokensUsed } : {}),
          wallClockMs,
          aborted: abortState.aborted,
        },
        logs: [],
      };
    },
  };
}
