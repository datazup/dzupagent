import { afterEach, describe, it, expect, vi } from "vitest";
import { createSubagentTools } from "../tools/subagent-tools.js";
import { createInProcessSubagentRuntime } from "../runtime/create-runtime.js";
import { allowAllSpawnPolicy } from "../governance/spawn-gate.js";
import type {
  SpawnPolicy,
  SpawnApprovalGate,
} from "../governance/spawn-gate.js";
import type { SubagentResult } from "../contracts/background-task.js";
import type { FanoutBatchStore } from "../contracts/fanout-batch-store.js";
import { InMemoryFanoutBatchStore } from "../store/in-memory-fanout-batch-store.js";
import type { FanoutReport } from "../tools/fanout-tool.js";
import {
  ControllableExecutor,
  RecordingEventSink,
  RecordingGovernanceSink,
  sequentialIds,
} from "./helpers.js";

/**
 * Batch-governance coverage for `fanout_template` (dynamic-subagents Spec 03
 * Phase B hardening). These exercise the batch-level gate (`evaluateBatch`), the
 * scope-narrowing invariant, and the durable batch ledger — the surface added on
 * top of the v1 fan-out mechanics (which are covered in `fanout-tool.test.ts`).
 */
function setup(
  opts: {
    executorMode?: "manual" | "instant";
    instantResult?: SubagentResult;
    policy?: SpawnPolicy;
    maxConcurrent?: number;
    maxQueued?: number;
    fanoutBatchStore?: FanoutBatchStore;
    approvalGate?: SpawnApprovalGate;
  } = {}
) {
  const events = new RecordingEventSink();
  const governance = new RecordingGovernanceSink();
  const executor = new ControllableExecutor(
    opts.executorMode ?? "manual",
    opts.instantResult
  );
  const runtime = createInProcessSubagentRuntime({
    executor,
    events,
    generateId: sequentialIds(),
    policy: opts.policy ?? allowAllSpawnPolicy,
    ...(opts.approvalGate !== undefined
      ? { approvalGate: opts.approvalGate }
      : {}),
    governance,
    lifecyclePolicy: {
      ...(opts.maxConcurrent !== undefined
        ? { maxConcurrentBackground: opts.maxConcurrent }
        : {}),
      ...(opts.maxQueued !== undefined
        ? { maxQueuedTasks: opts.maxQueued }
        : {}),
    },
  });
  const tools = createSubagentTools({
    runtime,
    resolveParentRunId: () => "run-1",
    fanout: {
      generateBatchId: sequentialIds("batch"),
      ...(opts.fanoutBatchStore !== undefined
        ? { fanoutBatchStore: opts.fanoutBatchStore }
        : {}),
    },
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { runtime, executor, events, governance, byName };
}

describe("fanout_template batch governance", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps every spawned task with the batch id", async () => {
    const { byName, events } = setup({
      executorMode: "instant",
      instantResult: { output: "ok" },
    });
    await byName.fanout_template!.invoke({
      items: [
        { key: "a", input: "alpha" },
        { key: "b", input: "beta" },
        { key: "c", input: "gamma" },
      ],
      spec: { agentId: "x" },
    });
    expect(
      events.events
        .filter((event) => event.type === "subagent:spawned")
        .map((event) => ("batchId" in event ? event.batchId : undefined))
    ).toEqual(["batch1", "batch1", "batch1"]);
  });

  it("requests one batch approval and does not ask per item", async () => {
    const approvalCalls: Array<{ runId: string; approvalId: string }> = [];
    // Batch-aware policy: the batch-level gate requires approval, but once the
    // batch is approved (ctx.batch.approved === true) the per-item spawns run
    // under that single approval and do NOT re-request one.
    const policy: SpawnPolicy = {
      check: () => ({ allow: true, requiresApproval: false }),
      checkWithContext: (_spec, ctx) =>
        ctx.batch?.approved === true
          ? { allow: true, requiresApproval: false }
          : { allow: true, requiresApproval: true },
    };
    const { byName, executor, governance } = setup({
      executorMode: "instant",
      policy,
      approvalGate: {
        waitForInterrupt: async (runId, approvalId) => {
          approvalCalls.push({ runId, approvalId });
          return { decision: "granted" };
        },
      },
    });

    const report = (await byName.fanout_template!.invoke({
      items: [
        { key: "a", input: "allowed-a" },
        { key: "b", input: "allowed-b" },
        { key: "c", input: "allowed-c" },
      ],
      spec: { agentId: "x" },
    })) as FanoutReport;

    expect(report).toMatchObject({
      batchId: "batch1",
      dispatched: 3,
      settled: { succeeded: 3, denied: 0 },
    });
    // A single batch-level approval keyed by batchId — not one-per-item.
    expect(approvalCalls).toEqual([{ runId: "run-1", approvalId: "batch1" }]);
    expect(
      governance.events.filter(
        (event) => event.type === "governance:approval_requested"
      )
    ).toEqual([
      {
        type: "governance:approval_requested",
        runId: "run-1",
        approvalId: "batch1",
      },
    ]);
    expect(executor.runCalls).toHaveLength(3);
  });

  it("turns a rejected batch approval into a denied report with zero spawns", async () => {
    const fanoutBatchStore = new InMemoryFanoutBatchStore();
    const policy: SpawnPolicy = {
      check: () => ({ allow: true, requiresApproval: true }),
    };
    const { byName, executor, events } = setup({
      executorMode: "instant",
      policy,
      fanoutBatchStore,
      approvalGate: {
        waitForInterrupt: async () => ({
          decision: "rejected",
          reason: "not approved",
        }),
      },
    });

    const report = (await byName.fanout_template!.invoke({
      items: [
        { key: "a", input: "allowed-a" },
        { key: "b", input: "allowed-b" },
      ],
      spec: { agentId: "x" },
    })) as FanoutReport;

    expect(report).toMatchObject({
      dispatched: 0,
      uncovered: [],
      settled: { succeeded: 0, denied: 2 },
      items: [
        { key: "a", status: "denied", error: "not approved" },
        { key: "b", status: "denied", error: "not approved" },
      ],
    });
    expect(executor.runCalls).toEqual([]);
    expect(
      events.events.filter((event) => event.type === "fanout:aborted")
    ).toEqual([
      {
        type: "fanout:aborted",
        batchId: "batch1",
        reason: "denied",
        dispatched: 0,
      },
    ]);
    expect(await fanoutBatchStore.get("batch1")).toMatchObject({
      status: "aborted",
      abortedReason: "not approved",
      declared: ["a", "b"],
      items: [
        { key: "a", status: "denied", error: "not approved" },
        { key: "b", status: "denied", error: "not approved" },
      ],
    });
  });

  it("denies the batch before spawning when policy rejects the template", async () => {
    let checkCalls = 0;
    const policy: SpawnPolicy = {
      check: () => {
        checkCalls += 1;
        return { allow: false, reason: "batch_not_allowed" };
      },
    };
    const { byName, executor } = setup({ executorMode: "instant", policy });

    const report = (await byName.fanout_template!.invoke({
      items: [
        { key: "a", input: "allowed-a" },
        { key: "b", input: "allowed-b" },
      ],
      spec: { agentId: "x" },
    })) as FanoutReport;

    // Exactly one policy call: the batch-level gate short-circuits per-item spawns.
    expect(checkCalls).toBe(1);
    expect(report).toMatchObject({
      dispatched: 0,
      settled: { denied: 2 },
      items: [
        { key: "a", status: "denied", error: "batch_not_allowed" },
        { key: "b", status: "denied", error: "batch_not_allowed" },
      ],
    });
    expect(executor.runCalls).toEqual([]);
  });

  it("persists a reconstructable batch record when a batch store is configured", async () => {
    const fanoutBatchStore = new InMemoryFanoutBatchStore();
    const { byName } = setup({
      executorMode: "instant",
      instantResult: { output: "ok", usage: { outputTokens: 3 } },
      fanoutBatchStore,
    });

    const report = (await byName.fanout_template!.invoke({
      items: [
        { key: "a", input: "alpha" },
        { key: "b", input: "beta" },
      ],
      spec: { agentId: "x" },
    })) as FanoutReport;

    const record = await fanoutBatchStore.get(report.batchId);
    expect(record).toMatchObject({
      batchId: "batch1",
      parentRunId: "run-1",
      mode: "template",
      status: "completed",
      declared: ["a", "b"],
      items: [
        {
          key: "a",
          taskId: report.items[0]!.taskId,
          status: "succeeded",
          result: { output: "ok", usage: { outputTokens: 3 } },
          outputTokens: 3,
        },
        {
          key: "b",
          taskId: report.items[1]!.taskId,
          status: "succeeded",
          result: { output: "ok", usage: { outputTokens: 3 } },
          outputTokens: 3,
        },
      ],
    });
  });

  it("records a budget-token abort in the batch ledger", async () => {
    const fanoutBatchStore = new InMemoryFanoutBatchStore();
    const { byName, executor } = setup({
      executorMode: "instant",
      instantResult: { output: "ok", usage: { outputTokens: 4 } },
      fanoutBatchStore,
    });

    const report = (await byName.fanout_template!.invoke({
      items: [
        { key: "a", input: "alpha" },
        { key: "b", input: "beta" },
        { key: "c", input: "gamma" },
      ],
      spec: { agentId: "x" },
      concurrency: 1,
      budget: { maxTotalOutputTokens: 7 },
    })) as FanoutReport;

    // Origin v1 budget semantics: once the aggregate token budget trips, the
    // remaining item is never dispatched (uncovered), and the abort reason is
    // "budget_exceeded" on the batch.
    expect(report.settled.succeeded).toBe(2);
    expect(report.budget.aborted).toBe(true);
    expect(report.budget.outputTokensUsed).toBe(8);
    expect(executor.runCalls.map((call) => call.input)).toEqual([
      "alpha",
      "beta",
    ]);
    const record = await fanoutBatchStore.get(report.batchId);
    expect(record).toMatchObject({
      status: "aborted",
      budgetAborted: true,
      abortedReason: "budget_exceeded",
    });
  });

  it("records a wall-clock abort in the batch ledger", async () => {
    const fanoutBatchStore = new InMemoryFanoutBatchStore();
    const { byName, executor } = setup({
      executorMode: "manual",
      fanoutBatchStore,
    });

    // A "manual" executor hangs (never resolves), so the dispatched item stays
    // non-terminal until the fan-out wall clock (25ms real time) trips. With
    // concurrency 1 the second item is never dispatched.
    const report = (await byName.fanout_template!.invoke({
      items: [
        { key: "a", input: "alpha" },
        { key: "b", input: "beta" },
      ],
      spec: { agentId: "x" },
      concurrency: 1,
      budget: { maxWallClockMs: 25 },
    })) as FanoutReport;

    // Origin v1 wall-clock semantics: the dispatched-but-unsettled item is
    // aborted_budget, the undispatched item is never_dispatched, abort reason
    // is "timeout".
    expect(executor.runCalls.map((call) => call.input)).toEqual(["alpha"]);
    expect(report.budget.aborted).toBe(true);
    expect(report.dispatched).toBe(1);
    expect(report.items[0]).toMatchObject({
      key: "a",
      status: "aborted_budget",
    });
    expect(report.items[1]).toMatchObject({
      key: "b",
      status: "never_dispatched",
    });
    const record = await fanoutBatchStore.get(report.batchId);
    expect(record).toMatchObject({
      status: "aborted",
      abortedReason: "timeout",
    });
  });
});
