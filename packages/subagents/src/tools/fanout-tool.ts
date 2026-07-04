import type {
  SubagentResult,
  SubagentSpec,
  TaskStatus,
} from "../contracts/background-task.js";
import type { SubagentEventSink } from "../contracts/events.js";
import type {
  FanoutBatchItemUpdate,
  FanoutBatchRecord,
  FanoutBatchStore,
} from "../contracts/fanout-batch-store.js";
import type { ApprovedSpawnBatch } from "../governance/spawn-gate.js";
import type { BackgroundSubagentRuntime } from "../runtime/background-subagent-runtime.js";
import type { SubagentToolDescriptor } from "./subagent-tools.js";

type FanoutItemStatus =
  | TaskStatus
  | "denied"
  | "aborted_budget"
  | "never_dispatched";

export interface FanoutTemplateArgs extends Record<string, unknown> {
  items: Array<{ key: string; input: string | Record<string, unknown> }>;
  spec: {
    agentId: string;
    instructions?: string;
    outboundScope?: string[];
    memoryScope?: SubagentSpec["memoryScope"];
  };
  concurrency?: number;
  ttlMs?: number;
  budget?: FanoutBudget;
}

export interface FanoutBudget {
  maxTotalOutputTokens?: number;
  maxWallClockMs?: number;
}

export interface FanoutLimits {
  maxBatchSize: number;
  maxConcurrent: number;
  maxTotalOutputTokens?: number;
  maxWallClockMs: number;
  maxResultBytes: number;
}

export interface FanoutToolConfig {
  runtime: BackgroundSubagentRuntime;
  resolveParentRunId: () => string;
  events?: SubagentEventSink;
  generateBatchId?: () => string;
  fanoutBatchStore?: FanoutBatchStore;
  limits?: Partial<FanoutLimits>;
}

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
  uncovered: string[];
  items: FanoutReportItem[];
  extraDispatches: [];
  budget: {
    outputTokensUsed?: number;
    wallClockMs: number;
    aborted: boolean;
    abortedReason?: string;
  };
  logs: [];
}

export interface FanoutReportItem {
  key: string;
  taskId?: string;
  status: FanoutItemStatus;
  result?: SubagentResult;
  resultTruncated?: boolean;
  error?: string;
  durationMs?: number;
  outputTokens?: number;
}

export function fanoutBatchRecordToReport(
  record: FanoutBatchRecord,
): FanoutReport {
  const items = record.items.map(batchRecordItemToReportItem);
  const settled = countSettled(items);
  const dispatched = items.filter((item) => item.taskId !== undefined).length;
  const uncovered = items
    .filter((item) => item.status === "never_dispatched")
    .map((item) => item.key);
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
      wallClockMs,
      aborted: record.budgetAborted ?? false,
      ...(record.abortedReason !== undefined
        ? { abortedReason: record.abortedReason }
        : {}),
    },
    logs: [],
  };
}

const DEFAULT_LIMITS: FanoutLimits = {
  maxBatchSize: 200,
  maxConcurrent: 4,
  maxWallClockMs: 15 * 60 * 1000,
  maxResultBytes: 2 * 1024,
};

export function createFanoutTemplateTool(
  config: FanoutToolConfig,
): SubagentToolDescriptor<FanoutTemplateArgs, FanoutReport> {
  const limits = { ...DEFAULT_LIMITS, ...config.limits };

  return {
    name: "fanout_template",
    description:
      "Dispatch the same subagent task template across a declared list of items. Use when a known batch of three or more items must all be processed exactly once.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description:
            "Declared item universe. Every item key is reported exactly once.",
        },
        spec: {
          type: "object",
          description:
            "Per-item SubagentSpec template. instructions may contain {{key}} and {{input}} placeholders.",
        },
        concurrency: {
          type: "number",
          description: "Optional max item workers, clamped by fanout limits.",
        },
        ttlMs: {
          type: "number",
          description: "Optional TTL for each spawned subagent task.",
        },
        budget: {
          type: "object",
          description:
            "Optional aggregate fan-out budget: maxTotalOutputTokens and maxWallClockMs.",
        },
      },
      required: ["items", "spec"],
    },
    invoke: async (args) => runTemplateFanout(args, config, limits),
  };
}

async function runTemplateFanout(
  args: FanoutTemplateArgs,
  config: FanoutToolConfig,
  limits: FanoutLimits,
): Promise<FanoutReport> {
  validateArgs(args, limits);

  const batchId = config.generateBatchId?.() ?? `fanout-${Date.now()}`;
  const parentRunId = config.resolveParentRunId();
  const startedAt = Date.now();
  const itemReports = new Array<FanoutReportItem>(args.items.length);
  const concurrency = clampConcurrency(args.concurrency, limits, args.items.length);
  const budgetState = createBudgetState(args.budget, limits, startedAt);

  await config.fanoutBatchStore?.create({
    batchId,
    parentRunId,
    mode: "template",
    declared: args.items.map((item) => item.key),
    startedAt,
  });

  config.events?.emit({
    type: "fanout:started",
    batchId,
    parentRunId,
    mode: "template",
    declared: args.items.length,
  });

  const batchAdmission = await config.runtime.evaluateBatch({
    batchId,
    parentRunId,
    mode: "template",
    template: buildBatchTemplateSpec(args.spec),
    itemKeys: args.items.map((item) => item.key),
  });
  if (!batchAdmission.ok) {
    const report = buildDeniedBatchReport({
      args,
      batchId,
      startedAt,
      reason: batchAdmission.detail,
      events: config.events,
    });
    await persistReport(
      config.fanoutBatchStore,
      report,
      Date.now(),
      "aborted",
      batchAdmission.detail,
    );
    return report;
  }

  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= args.items.length) return;
      const item = args.items[index];
      if (item === undefined) return;
      if (budgetState.aborted) {
        const reportItem = buildBudgetAbortedItem(item.key, budgetState);
        itemReports[index] = reportItem;
        await persistItem(
          config.fanoutBatchStore,
          batchId,
          reportItem,
          Date.now(),
        );
        continue;
      }
      itemReports[index] = await runOneItem({
        item,
        template: args.spec,
        batchId,
        parentRunId,
        runtime: config.runtime,
        events: config.events,
        fanoutBatchStore: config.fanoutBatchStore,
        batch: batchAdmission.batch,
        ttlMs: args.ttlMs,
        startedAt: Date.now(),
        limits,
        budgetState,
      });
    }
  });

  await Promise.all(workers);

  const reports = Array.from({ length: args.items.length }, (_, index) => {
    const item = itemReports[index];
    if (item !== undefined) return item;
    const source = args.items[index];
    if (budgetState.aborted) {
      return buildBudgetAbortedItem(source?.key ?? String(index), budgetState);
    }
    return {
      key: source?.key ?? String(index),
      status: "never_dispatched" as const,
      error: "fanout_worker_did_not_process_item",
    };
  });
  const settled = countSettled(reports);
  const dispatched = reports.filter((item) => item.taskId !== undefined).length;
  const uncovered = reports
    .filter((item) => item.status === "never_dispatched")
    .map((item) => item.key);
  const wallClockMs = Date.now() - startedAt;
  const budget = buildBudgetReport(budgetState, wallClockMs);

  await persistReport(
    config.fanoutBatchStore,
    {
      batchId,
      mode: "template",
      declared: args.items.length,
      dispatched,
      settled,
      uncovered,
      items: reports,
      extraDispatches: [],
      budget,
      logs: [],
    },
    Date.now(),
    budget.aborted ? "aborted" : "completed",
    budget.abortedReason,
  );

  config.events?.emit({
    type: "fanout:completed",
    batchId,
    dispatched,
    succeeded: settled.succeeded,
    failed: settled.failed,
    uncovered: uncovered.length,
    wallClockMs,
  });
  if (budget.aborted) {
    config.events?.emit({
      type: "fanout:aborted",
      batchId,
      reason: "budget_exceeded",
      dispatched,
    });
  }

  return {
    batchId,
    mode: "template",
    declared: args.items.length,
    dispatched,
    settled,
    uncovered,
    items: reports,
    extraDispatches: [],
    budget,
    logs: [],
  };
}

function buildDeniedBatchReport(args: {
  args: FanoutTemplateArgs;
  batchId: string;
  startedAt: number;
  reason: string;
  events?: SubagentEventSink;
}): FanoutReport {
  const reports: FanoutReportItem[] = args.args.items.map((item) => ({
    key: item.key,
    status: "denied",
    error: args.reason,
  }));
  const settled = countSettled(reports);
  const wallClockMs = Date.now() - args.startedAt;

  args.events?.emit({
    type: "fanout:aborted",
    batchId: args.batchId,
    reason: "denied",
    dispatched: 0,
  });
  args.events?.emit({
    type: "fanout:completed",
    batchId: args.batchId,
    dispatched: 0,
    succeeded: 0,
    failed: 0,
    uncovered: 0,
    wallClockMs,
  });

  return {
    batchId: args.batchId,
    mode: "template",
    declared: args.args.items.length,
    dispatched: 0,
    settled,
    uncovered: [],
    items: reports,
    extraDispatches: [],
    budget: { wallClockMs, aborted: false },
    logs: [],
  };
}

async function runOneItem(args: {
  item: { key: string; input: string | Record<string, unknown> };
  template: FanoutTemplateArgs["spec"];
  batchId: string;
  parentRunId: string;
  runtime: BackgroundSubagentRuntime;
  events?: SubagentEventSink;
  fanoutBatchStore?: FanoutBatchStore;
  batch: ApprovedSpawnBatch;
  ttlMs?: number;
  startedAt: number;
  limits: FanoutLimits;
  budgetState: FanoutBudgetState;
}): Promise<FanoutReportItem> {
  const remainingWallClockMs = getRemainingWallClockMs(args.budgetState);
  if (remainingWallClockMs <= 0) {
    args.budgetState.abort("max_wall_clock_ms_exceeded");
    return buildBudgetAbortedItem(args.item.key, args.budgetState);
  }

  const spec = buildSpec(args.template, args.item);
  const spawned = await args.runtime.spawn(
    spec,
    args.parentRunId,
    {
      ...(args.ttlMs !== undefined ? { ttlMs: args.ttlMs } : {}),
      batch: args.batch,
      batchItemKey: args.item.key,
    },
  );

  if (!spawned.ok) {
    const reportItem = {
      key: args.item.key,
      status: spawned.reason === "denied" ? "denied" : "never_dispatched",
      error: spawned.detail ?? spawned.reason,
    } satisfies FanoutReportItem;
    await persistItem(args.fanoutBatchStore, args.batchId, reportItem, Date.now());
    return reportItem;
  }

  await args.fanoutBatchStore?.recordItem(args.batchId, args.item.key, {
    taskId: spawned.taskId,
    status: spawned.status,
    updatedAt: Date.now(),
  });

  args.events?.emit({
    type: "fanout:item_dispatched",
    batchId: args.batchId,
    itemKey: args.item.key,
    taskId: spawned.taskId,
  });

  const awaitTimeoutMs = getRemainingWallClockMs(args.budgetState);
  if (awaitTimeoutMs <= 0) {
    args.budgetState.abort("max_wall_clock_ms_exceeded");
    void args.runtime.cancel(spawned.taskId, {
      parentRunId: args.parentRunId,
    });
    const reportItem = buildSettledReportItem({
      itemKey: args.item.key,
      taskId: spawned.taskId,
      finalStatus: "cancelled",
      error: "max_wall_clock_ms_exceeded",
      durationMs: Date.now() - args.startedAt,
      limits: args.limits,
    });
    await persistItem(args.fanoutBatchStore, args.batchId, reportItem, Date.now());
    return reportItem;
  }

  const final = await args.runtime.await(
    spawned.taskId,
    { timeoutMs: awaitTimeoutMs },
    { parentRunId: args.parentRunId },
  );
  if (!final) {
    const reportItem = {
      key: args.item.key,
      taskId: spawned.taskId,
      status: "never_dispatched",
      error: "spawned_task_not_found",
    } satisfies FanoutReportItem;
    await persistItem(args.fanoutBatchStore, args.batchId, reportItem, Date.now());
    return reportItem;
  }

  if (!isFanoutTerminalStatus(final.status)) {
    args.budgetState.abort("max_wall_clock_ms_exceeded");
    void args.runtime.cancel(spawned.taskId, {
      parentRunId: args.parentRunId,
    });
    const reportItem = buildSettledReportItem({
      itemKey: args.item.key,
      taskId: spawned.taskId,
      finalStatus: "cancelled",
      error: "max_wall_clock_ms_exceeded",
      durationMs: Date.now() - args.startedAt,
      limits: args.limits,
    });
    await persistItem(args.fanoutBatchStore, args.batchId, reportItem, Date.now());
    return reportItem;
  }

  const durationMs = Date.now() - args.startedAt;
  args.events?.emit({
    type: "fanout:item_settled",
    batchId: args.batchId,
    itemKey: args.item.key,
    taskId: spawned.taskId,
    status: final.status,
    durationMs,
  });

  const reportItem = buildSettledReportItem({
    itemKey: args.item.key,
    taskId: spawned.taskId,
    finalStatus: final.status,
    result: final.result,
    error: final.error,
    durationMs,
    limits: args.limits,
  });
  recordOutputTokens(args.budgetState, reportItem.outputTokens);
  await persistItem(args.fanoutBatchStore, args.batchId, reportItem, Date.now());
  return reportItem;
}

function validateArgs(args: FanoutTemplateArgs, limits: FanoutLimits): void {
  if (!Array.isArray(args.items)) {
    throw new Error("fanout_template requires an items array");
  }
  if (args.items.length > limits.maxBatchSize) {
    throw new Error(
      `fanout_template item count ${args.items.length} exceeds maxBatchSize ${limits.maxBatchSize}`,
    );
  }
  if (typeof args.spec?.agentId !== "string" || args.spec.agentId.length === 0) {
    throw new Error("fanout_template spec.agentId is required");
  }
  const seen = new Set<string>();
  for (const item of args.items) {
    if (typeof item.key !== "string" || item.key.length === 0) {
      throw new Error("fanout_template item keys must be non-empty strings");
    }
    if (seen.has(item.key)) {
      throw new Error(`fanout_template item key "${item.key}" is duplicated`);
    }
    seen.add(item.key);
  }
}

function buildSpec(
  template: FanoutTemplateArgs["spec"],
  item: { key: string; input: string | Record<string, unknown> },
): SubagentSpec {
  return {
    agentId: template.agentId,
    input: item.input,
    ...(template.instructions !== undefined
      ? { instructions: renderTemplate(template.instructions, item) }
      : {}),
    ...(template.outboundScope !== undefined
      ? { outboundScope: template.outboundScope }
      : {}),
    ...(template.memoryScope !== undefined ? { memoryScope: template.memoryScope } : {}),
  };
}

function buildBatchTemplateSpec(
  template: FanoutTemplateArgs["spec"],
): SubagentSpec {
  return {
    agentId: template.agentId,
    input: { fanoutMode: "template" },
    ...(template.instructions !== undefined
      ? { instructions: template.instructions }
      : {}),
    ...(template.outboundScope !== undefined
      ? { outboundScope: template.outboundScope }
      : {}),
    ...(template.memoryScope !== undefined ? { memoryScope: template.memoryScope } : {}),
  };
}

function renderTemplate(
  value: string,
  item: { key: string; input: string | Record<string, unknown> },
): string {
  return value
    .replaceAll("{{key}}", item.key)
    .replaceAll("{{input}}", renderInput(item.input));
}

function renderInput(input: string | Record<string, unknown>): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

function clampConcurrency(
  requested: number | undefined,
  limits: FanoutLimits,
  itemCount: number,
): number {
  if (itemCount === 0) return 1;
  const raw = requested ?? limits.maxConcurrent;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.max(1, Math.min(Math.floor(raw), limits.maxConcurrent, itemCount));
}

function countSettled(items: FanoutReportItem[]): FanoutReport["settled"] {
  const counts: FanoutReport["settled"] = {
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    expired: 0,
    denied: 0,
    aborted_budget: 0,
  };
  for (const item of items) {
    switch (item.status) {
      case "succeeded":
        counts.succeeded += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "cancelled":
        counts.cancelled += 1;
        break;
      case "expired":
        counts.expired += 1;
        break;
      case "denied":
        counts.denied += 1;
        break;
      case "aborted_budget":
        counts.aborted_budget += 1;
        break;
      default:
        break;
    }
  }
  return counts;
}

interface FanoutBudgetState {
  readonly startedAt: number;
  readonly maxWallClockMs: number;
  readonly maxTotalOutputTokens?: number;
  outputTokensUsed: number;
  aborted: boolean;
  abortedReason?: string;
  abort(reason: string): void;
}

function createBudgetState(
  budget: FanoutBudget | undefined,
  limits: FanoutLimits,
  startedAt: number,
): FanoutBudgetState {
  const maxWallClockMs =
    budget?.maxWallClockMs !== undefined
      ? budget.maxWallClockMs
      : limits.maxWallClockMs;
  const maxTotalOutputTokens =
    budget?.maxTotalOutputTokens !== undefined
      ? budget.maxTotalOutputTokens
      : limits.maxTotalOutputTokens;

  return {
    startedAt,
    maxWallClockMs,
    ...(maxTotalOutputTokens !== undefined ? { maxTotalOutputTokens } : {}),
    outputTokensUsed: 0,
    aborted: false,
    abort(reason: string): void {
      if (this.aborted) return;
      this.aborted = true;
      this.abortedReason = reason;
    },
  };
}

function getRemainingWallClockMs(state: FanoutBudgetState): number {
  return Math.max(0, state.startedAt + state.maxWallClockMs - Date.now());
}

function recordOutputTokens(
  state: FanoutBudgetState,
  outputTokens: number | undefined,
): void {
  if (outputTokens === undefined) return;
  state.outputTokensUsed += outputTokens;
  if (
    state.maxTotalOutputTokens !== undefined &&
    state.outputTokensUsed > state.maxTotalOutputTokens
  ) {
    state.abort("max_total_output_tokens_exceeded");
  }
}

function buildBudgetReport(
  state: FanoutBudgetState,
  wallClockMs: number,
): FanoutReport["budget"] {
  return {
    ...(state.outputTokensUsed > 0
      ? { outputTokensUsed: state.outputTokensUsed }
      : {}),
    wallClockMs,
    aborted: state.aborted,
    ...(state.abortedReason !== undefined
      ? { abortedReason: state.abortedReason }
      : {}),
  };
}

function buildBudgetAbortedItem(
  key: string,
  state: FanoutBudgetState,
): FanoutReportItem {
  return {
    key,
    status: "aborted_budget",
    error: state.abortedReason ?? "fanout_budget_aborted",
  };
}

function buildSettledReportItem(args: {
  itemKey: string;
  taskId: string;
  finalStatus: TaskStatus;
  result?: SubagentResult;
  error?: string;
  durationMs: number;
  limits: FanoutLimits;
}): FanoutReportItem {
  return {
    key: args.itemKey,
    taskId: args.taskId,
    status: args.finalStatus,
    ...truncateResult(args.result, args.limits.maxResultBytes),
    ...(args.error !== undefined ? { error: args.error } : {}),
    durationMs: args.durationMs,
    ...(args.result?.usage?.outputTokens !== undefined
      ? { outputTokens: args.result.usage.outputTokens }
      : {}),
  };
}

function isFanoutTerminalStatus(status: TaskStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired"
  );
}

function batchRecordItemToReportItem(
  item: FanoutBatchRecord["items"][number],
): FanoutReportItem {
  return {
    key: item.key,
    status: item.status,
    ...(item.taskId !== undefined ? { taskId: item.taskId } : {}),
    ...(item.result !== undefined ? { result: item.result } : {}),
    ...(item.resultTruncated !== undefined
      ? { resultTruncated: item.resultTruncated }
      : {}),
    ...(item.error !== undefined ? { error: item.error } : {}),
    ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
    ...(item.outputTokens !== undefined ? { outputTokens: item.outputTokens } : {}),
  };
}

async function persistReport(
  store: FanoutBatchStore | undefined,
  report: FanoutReport,
  updatedAt: number,
  status: "completed" | "aborted" = "completed",
  abortedReason?: string,
): Promise<void> {
  if (store === undefined) return;
  for (const item of report.items) {
    await persistItem(store, report.batchId, item, updatedAt);
  }
  await store.complete(report.batchId, {
    status,
    completedAt: updatedAt,
    wallClockMs: report.budget.wallClockMs,
    ...(report.budget.outputTokensUsed !== undefined
      ? { outputTokensUsed: report.budget.outputTokensUsed }
      : {}),
    ...(abortedReason !== undefined ? { abortedReason } : {}),
    ...(report.budget.aborted ? { budgetAborted: true } : {}),
  });
}

async function persistItem(
  store: FanoutBatchStore | undefined,
  batchId: string,
  item: FanoutReportItem,
  updatedAt: number,
): Promise<void> {
  if (store === undefined) return;
  const update: FanoutBatchItemUpdate = {
    status: item.status,
    updatedAt,
  };
  if (item.taskId !== undefined) update.taskId = item.taskId;
  if (item.result !== undefined) update.result = item.result;
  if (item.resultTruncated !== undefined) {
    update.resultTruncated = item.resultTruncated;
  }
  if (item.error !== undefined) update.error = item.error;
  if (item.durationMs !== undefined) update.durationMs = item.durationMs;
  if (item.outputTokens !== undefined) update.outputTokens = item.outputTokens;

  await store.recordItem(batchId, item.key, update);
}

function truncateResult(
  result: SubagentResult | undefined,
  maxResultBytes: number,
): Pick<FanoutReportItem, "result" | "resultTruncated"> {
  if (result === undefined) return {};
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, "utf8") <= maxResultBytes) {
    return { result };
  }
  if (typeof result.output === "string") {
    return {
      result: { ...result, output: result.output.slice(0, maxResultBytes) },
      resultTruncated: true,
    };
  }
  return {
    result: { output: serialized.slice(0, maxResultBytes) },
    resultTruncated: true,
  };
}
