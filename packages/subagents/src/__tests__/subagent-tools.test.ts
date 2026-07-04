import { afterEach, describe, it, expect, vi } from "vitest";
import { createSubagentTools } from "../tools/subagent-tools.js";
import type { SubagentToolContext } from "../tools/subagent-tools.js";
import { fanoutBatchRecordToReport } from "../tools/fanout-tool.js";
import { createInProcessSubagentRuntime } from "../runtime/create-runtime.js";
import { allowAllSpawnPolicy } from "../governance/spawn-gate.js";
import type { SpawnPolicy } from "../governance/spawn-gate.js";
import type { SubagentResult } from "../contracts/background-task.js";
import type { FanoutBatchStore } from "../contracts/fanout-batch-store.js";
import { InMemoryFanoutBatchStore } from "../store/in-memory-fanout-batch-store.js";
import {
  ControllableExecutor,
  RecordingEventSink,
  RecordingGovernanceSink,
  sequentialIds,
  flush,
} from "./helpers.js";

function setup(
  opts: {
    executorMode?: "manual" | "instant";
    instantResult?: SubagentResult;
    policy?: SpawnPolicy;
    maxConcurrent?: number;
    maxQueued?: number;
    maxBatchSize?: number;
    maxWallClockMs?: number;
    maxTotalOutputTokens?: number;
    maxResultBytes?: number;
    maxSpawnDepth?: number;
    spawnContext?: SubagentToolContext;
    fanoutBatchStore?: FanoutBatchStore;
    approvalGate?: {
      waitForApproval: (runId: string, approvalId: string) => Promise<unknown>;
    };
  } = {},
) {
  const events = new RecordingEventSink();
  const governance = new RecordingGovernanceSink();
  const executor = new ControllableExecutor(
    opts.executorMode ?? "manual",
    opts.instantResult,
  );
  const runtime = createInProcessSubagentRuntime({
    executor,
    events,
    generateId: sequentialIds(),
    // Base runtime now denies spawns by default (AGENT-H-03); this suite exercises
    // tool mechanics, not governance, so opt into the test-only allow-all policy.
    policy: opts.policy ?? allowAllSpawnPolicy,
    ...(opts.approvalGate !== undefined
      ? { approvalGate: opts.approvalGate }
      : {}),
    governance,
    lifecyclePolicy: {
      ...(opts.maxConcurrent !== undefined
        ? { maxConcurrentBackground: opts.maxConcurrent }
        : {}),
      ...(opts.maxQueued !== undefined ? { maxQueuedTasks: opts.maxQueued } : {}),
      ...(opts.maxSpawnDepth !== undefined
        ? { maxSpawnDepth: opts.maxSpawnDepth }
        : {}),
    },
  });
  const tools = createSubagentTools({
    runtime,
    resolveParentRunId: () => "run-1",
    ...(opts.spawnContext !== undefined
      ? { resolveSpawnContext: () => opts.spawnContext! }
      : {}),
    events,
    generateBatchId: sequentialIds("batch"),
    ...(opts.fanoutBatchStore !== undefined
      ? { fanoutBatchStore: opts.fanoutBatchStore }
      : {}),
    fanoutLimits: {
      ...(opts.maxBatchSize !== undefined
        ? { maxBatchSize: opts.maxBatchSize }
        : {}),
      ...(opts.maxConcurrent !== undefined
        ? { maxConcurrent: opts.maxConcurrent }
        : {}),
      ...(opts.maxResultBytes !== undefined
        ? { maxResultBytes: opts.maxResultBytes }
        : {}),
      ...(opts.maxWallClockMs !== undefined
        ? { maxWallClockMs: opts.maxWallClockMs }
        : {}),
      ...(opts.maxTotalOutputTokens !== undefined
        ? { maxTotalOutputTokens: opts.maxTotalOutputTokens }
        : {}),
    },
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { runtime, executor, events, governance, tools, byName };
}

/** Build a second tool-set bound to a different parent run over the same runtime. */
function toolsForRun(
  runtime: ReturnType<typeof createInProcessSubagentRuntime>,
  parentRunId: string,
) {
  const tools = createSubagentTools({
    runtime,
    resolveParentRunId: () => parentRunId,
  });
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

describe("subagent tools", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes the expected tools including template fan-out", () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "await_subagent",
      "cancel_subagent",
      "check_subagent",
      "fanout_template",
      "spawn_subagent",
    ]);
  });

  it("spawn → check → await round-trip", async () => {
    const { executor, byName } = setup();
    const spawned = (await byName.spawn_subagent!.invoke({
      agentId: "x",
      input: "go",
    })) as { ok: boolean; taskId: string };
    expect(spawned.ok).toBe(true);
    await flush();

    const checked = (await byName.check_subagent!.invoke({
      taskId: spawned.taskId,
    })) as {
      found: boolean;
      status: string;
    };
    expect(checked).toMatchObject({ found: true, status: "running" });

    executor.complete(spawned.taskId, { output: "done" });
    const awaited = (await byName.await_subagent!.invoke({
      taskId: spawned.taskId,
      timeoutMs: 1000,
    })) as { status: string; result: unknown };
    expect(awaited).toMatchObject({
      status: "succeeded",
      result: { output: "done" },
    });
  });

  it("propagates nested spawn depth and origin task id from the tool context", async () => {
    const seen: unknown[] = [];
    const policy: SpawnPolicy = {
      check: () => ({ allow: true, requiresApproval: false }),
      checkWithContext: (_spec, _parentRunId, context) => {
        seen.push(context);
        return { allow: true, requiresApproval: false };
      },
    };
    const { runtime, byName, events } = setup({
      executorMode: "instant",
      policy,
      spawnContext: {
        parentRunId: "run-1",
        depth: 1,
        originTaskId: "parent-task",
      },
    });

    const spawned = (await byName.spawn_subagent!.invoke({
      agentId: "x",
      input: "go",
    })) as { ok: boolean; taskId: string };

    expect(spawned.ok).toBe(true);
    await flush();
    const [task] = await runtime.list("run-1");
    expect(task).toMatchObject({ depth: 1 });
    expect(seen).toEqual([
      { kind: "spawn", depth: 1, originTaskId: "parent-task" },
    ]);
    expect(events.events.find((event) => event.type === "subagent:spawned")).toMatchObject(
      { depth: 1 },
    );
  });

  it("check reports not found for unknown task", async () => {
    const { byName } = setup();
    expect(await byName.check_subagent!.invoke({ taskId: "ghost" })).toEqual({
      found: false,
    });
  });

  it("cancel stops a running task", async () => {
    const { byName } = setup();
    const spawned = (await byName.spawn_subagent!.invoke({
      agentId: "x",
      input: "go",
    })) as { taskId: string };
    await flush();
    const cancelled = (await byName.cancel_subagent!.invoke({
      taskId: spawned.taskId,
    })) as { status: string };
    expect(cancelled.status).toBe("cancelled");
  });

  // ── SEC-M-04: cross-run task IDOR ──────────────────────────────────
  describe("ownership isolation (SEC-M-04)", () => {
    it("a foreign run cannot check, await, or cancel another run's task", async () => {
      const { runtime, executor, byName } = setup(); // owner = run-1
      const foreign = toolsForRun(runtime, "run-2");

      const spawned = (await byName.spawn_subagent!.invoke({
        agentId: "x",
        input: "go",
      })) as { ok: boolean; taskId: string };
      expect(spawned.ok).toBe(true);
      await flush();

      // run-2 must not be able to read run-1's task.
      expect(
        await foreign.check_subagent!.invoke({ taskId: spawned.taskId }),
      ).toEqual({ found: false });

      // run-2 must not be able to await it (resolves as not-found immediately).
      expect(
        await foreign.await_subagent!.invoke({
          taskId: spawned.taskId,
          timeoutMs: 50,
        }),
      ).toEqual({ found: false });

      // run-2's cancel must be a no-op — the task keeps running.
      expect(
        await foreign.cancel_subagent!.invoke({ taskId: spawned.taskId }),
      ).toEqual({ status: "not_found" });
      const stillOwned = (await byName.check_subagent!.invoke({
        taskId: spawned.taskId,
      })) as { found: boolean; status: string };
      expect(stillOwned).toMatchObject({ found: true, status: "running" });

      // The legitimate owner still has full access.
      executor.complete(spawned.taskId, { output: "done" });
      const awaited = (await byName.await_subagent!.invoke({
        taskId: spawned.taskId,
        timeoutMs: 1000,
      })) as { status: string; result: unknown };
      expect(awaited).toMatchObject({
        status: "succeeded",
        result: { output: "done" },
      });
    });
  });

  describe("fanout_template", () => {
    it("dispatches every declared item exactly once and reports coverage", async () => {
      const { byName, executor, events } = setup({
        executorMode: "instant",
        instantResult: { output: "ok", usage: { outputTokens: 3 } },
        maxBatchSize: 500,
      });

      const report = (await byName.fanout_template!.invoke({
        items: [
          { key: "a", input: "alpha" },
          { key: "b", input: { name: "beta" } },
          { key: "c", input: "gamma" },
        ],
        spec: {
          agentId: "x",
          instructions: "Review {{key}} with {{input}}",
        },
      })) as {
        batchId: string;
        declared: number;
        dispatched: number;
        uncovered: string[];
        settled: { succeeded: number; failed: number };
        items: Array<{ key: string; taskId?: string; status: string }>;
      };

      expect(report).toMatchObject({
        batchId: "batch1",
        declared: 3,
        dispatched: 3,
        uncovered: [],
        settled: { succeeded: 3, failed: 0 },
      });
      expect(report.items.map((item) => item.key)).toEqual(["a", "b", "c"]);
      expect(report.items.every((item) => item.status === "succeeded")).toBe(
        true,
      );
      expect(new Set(report.items.map((item) => item.taskId)).size).toBe(3);
      expect(executor.runCalls.map((call) => call.input)).toEqual([
        "alpha",
        { name: "beta" },
        "gamma",
      ]);
      expect(executor.runCalls.map((call) => call.instructions)).toEqual([
        "Review a with alpha",
        'Review b with {"name":"beta"}',
        "Review c with gamma",
      ]);
      const types = events.types();
      expect(types[0]).toBe("fanout:started");
      expect(types.at(-1)).toBe("fanout:completed");
      expect(types.filter((type) => type === "fanout:item_dispatched")).toHaveLength(3);
      expect(types.filter((type) => type === "fanout:item_settled")).toHaveLength(3);
      expect(
        events.events
          .filter((event) => event.type === "subagent:spawned")
          .map((event) => ("batchId" in event ? event.batchId : undefined)),
      ).toEqual(["batch1", "batch1", "batch1"]);
    });

    it("rejects duplicate item keys before spawning", async () => {
      const { byName, executor, events } = setup({ executorMode: "instant" });

      await expect(
        byName.fanout_template!.invoke({
          items: [
            { key: "same", input: "a" },
            { key: "same", input: "b" },
          ],
          spec: { agentId: "x" },
        }),
      ).rejects.toThrow('fanout_template item key "same" is duplicated');

      expect(executor.runCalls).toEqual([]);
      expect(events.types()).toEqual([]);
    });

    it("truncates large per-item results without dropping the task id", async () => {
      const { byName } = setup({
        executorMode: "instant",
        instantResult: { output: "abcdefghijklmnopqrstuvwxyz" },
        maxResultBytes: 8,
      });

      const report = (await byName.fanout_template!.invoke({
        items: [{ key: "a", input: "alpha" }],
        spec: { agentId: "x" },
      })) as {
        items: Array<{
          taskId?: string;
          result?: { output?: unknown };
          resultTruncated?: boolean;
        }>;
      };

      expect(report.items[0]).toMatchObject({
        taskId: "t1",
        result: { output: "abcdefgh" },
        resultTruncated: true,
      });
    });

    it("reports a policy-denied item and continues with siblings", async () => {
      const policy: SpawnPolicy = {
        check: (spec) =>
          spec.input === "blocked"
            ? { allow: false, reason: "blocked_by_test" }
            : { allow: true, requiresApproval: false },
      };
      const { byName, executor } = setup({ executorMode: "instant", policy });

      const report = (await byName.fanout_template!.invoke({
        items: [
          { key: "a", input: "allowed-a" },
          { key: "b", input: "blocked" },
          { key: "c", input: "allowed-c" },
        ],
        spec: { agentId: "x" },
      })) as {
        dispatched: number;
        uncovered: string[];
        settled: { succeeded: number; denied: number };
        items: Array<{ key: string; status: string; taskId?: string }>;
      };

      expect(report.dispatched).toBe(2);
      expect(report.uncovered).toEqual([]);
      expect(report.settled).toMatchObject({ succeeded: 2, denied: 1 });
      expect(report.items).toMatchObject([
        { key: "a", taskId: "t1", status: "succeeded" },
        { key: "b", status: "denied", error: "blocked_by_test" },
        { key: "c", taskId: "t3", status: "succeeded" },
      ]);
      expect(executor.runCalls.map((call) => call.input)).toEqual([
        "allowed-a",
        "allowed-c",
      ]);
    });

    it("reports over-depth fanout item spawns as denied without executor work", async () => {
      const checkWithContext = vi.fn(() => ({
        allow: true as const,
        requiresApproval: false,
      }));
      const { byName, executor, runtime, events } = setup({
        executorMode: "instant",
        maxSpawnDepth: 2,
        spawnContext: {
          parentRunId: "run-1",
          depth: 2,
          originTaskId: "parent-task",
        },
        policy: {
          check: () => ({ allow: true, requiresApproval: false }),
          checkWithContext,
        },
      });
      const spawnSpy = vi.spyOn(runtime, "spawn");

      const report = (await byName.fanout_template!.invoke({
        items: [
          { key: "a", input: "alpha" },
          { key: "b", input: "beta" },
        ],
        spec: { agentId: "x" },
      })) as {
        dispatched: number;
        uncovered: string[];
        settled: { denied: number };
        items: Array<{ key: string; status: string; error?: string }>;
      };

      expect(report.dispatched).toBe(0);
      expect(report.uncovered).toEqual([]);
      expect(report.settled.denied).toBe(2);
      expect(report.items).toMatchObject([
        { key: "a", status: "denied", error: "max_spawn_depth_exceeded" },
        { key: "b", status: "denied", error: "max_spawn_depth_exceeded" },
      ]);
      expect(spawnSpy).toHaveBeenCalledTimes(2);
      for (const call of spawnSpy.mock.calls) {
        expect(call[2]).toMatchObject({
          depth: 2,
          originTaskId: "parent-task",
        });
      }
      expect(executor.runCalls).toEqual([]);
      expect(checkWithContext).toHaveBeenCalledTimes(1);
      expect(events.types()).not.toContain("fanout:item_dispatched");
      expect(events.types()).toContain("fanout:completed");
    });

    it("requests one batch approval and does not ask per item", async () => {
      const approvalCalls: Array<{ runId: string; approvalId: string }> = [];
      const policy: SpawnPolicy = {
        check: () => ({ allow: true, requiresApproval: true }),
      };
      const { byName, executor, governance } = setup({
        executorMode: "instant",
        policy,
        approvalGate: {
          waitForApproval: async (runId, approvalId) => {
            approvalCalls.push({ runId, approvalId });
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
      })) as {
        batchId: string;
        dispatched: number;
        settled: { succeeded: number; denied: number };
      };

      expect(report).toMatchObject({
        batchId: "batch1",
        dispatched: 3,
        settled: { succeeded: 3, denied: 0 },
      });
      expect(approvalCalls).toEqual([
        { runId: "run-1", approvalId: "batch1" },
      ]);
      expect(
        governance.events.filter(
          (event) => event.type === "governance:approval_requested",
        ),
      ).toEqual([
        {
          type: "governance:approval_requested",
          runId: "run-1",
          approvalId: "batch1",
        },
      ]);
      expect(executor.runCalls).toHaveLength(3);
    });

    it("turns rejected batch approval into a denied report with zero spawns", async () => {
      const approvalCalls: Array<{ runId: string; approvalId: string }> = [];
      const fanoutBatchStore = new InMemoryFanoutBatchStore();
      const policy: SpawnPolicy = {
        check: () => ({ allow: true, requiresApproval: true }),
      };
      const { byName, executor, events } = setup({
        executorMode: "instant",
        policy,
        fanoutBatchStore,
        approvalGate: {
          waitForApproval: async (runId, approvalId) => {
            approvalCalls.push({ runId, approvalId });
            throw new Error("not approved");
          },
        },
      });

      const report = (await byName.fanout_template!.invoke({
        items: [
          { key: "a", input: "allowed-a" },
          { key: "b", input: "allowed-b" },
        ],
        spec: { agentId: "x" },
      })) as {
        dispatched: number;
        uncovered: string[];
        settled: { succeeded: number; denied: number };
        items: Array<{ key: string; status: string; error?: string }>;
      };

      expect(report).toMatchObject({
        dispatched: 0,
        uncovered: [],
        settled: { succeeded: 0, denied: 2 },
        items: [
          { key: "a", status: "denied", error: "not approved" },
          { key: "b", status: "denied", error: "not approved" },
        ],
      });
      expect(approvalCalls).toEqual([
        { runId: "run-1", approvalId: "batch1" },
      ]);
      expect(executor.runCalls).toEqual([]);
      expect(
        events.events.filter((event) => event.type === "fanout:aborted"),
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
      })) as {
        dispatched: number;
        settled: { denied: number };
        items: Array<{ key: string; status: string; error?: string }>;
      };

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

    it("persists a reconstructable batch report when a batch store is configured", async () => {
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
      })) as {
        batchId: string;
        items: Array<{ key: string; taskId?: string; status: string }>;
      };

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
      expect(fanoutBatchRecordToReport(record!)).toMatchObject({
        batchId: report.batchId,
        declared: 2,
        dispatched: 2,
        uncovered: [],
        settled: { succeeded: 2, failed: 0 },
        items: report.items,
      });
    });

    it("aborts undispatched items when aggregate output tokens exceed budget", async () => {
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
      })) as {
        batchId: string;
        dispatched: number;
        settled: { succeeded: number; aborted_budget: number };
        budget: {
          outputTokensUsed?: number;
          aborted: boolean;
          abortedReason?: string;
        };
        items: Array<{ key: string; status: string; outputTokens?: number }>;
      };

      expect(report).toMatchObject({
        dispatched: 2,
        settled: { succeeded: 2, aborted_budget: 1 },
        budget: {
          outputTokensUsed: 8,
          aborted: true,
          abortedReason: "max_total_output_tokens_exceeded",
        },
        items: [
          { key: "a", status: "succeeded", outputTokens: 4 },
          { key: "b", status: "succeeded", outputTokens: 4 },
          { key: "c", status: "aborted_budget" },
        ],
      });
      expect(executor.runCalls.map((call) => call.input)).toEqual([
        "alpha",
        "beta",
      ]);
      expect(await fanoutBatchStore.get(report.batchId)).toMatchObject({
        status: "aborted",
        budgetAborted: true,
        outputTokensUsed: 8,
        abortedReason: "max_total_output_tokens_exceeded",
        items: [
          { key: "a", status: "succeeded", outputTokens: 4 },
          { key: "b", status: "succeeded", outputTokens: 4 },
          { key: "c", status: "aborted_budget" },
        ],
      });
      expect(
        fanoutBatchRecordToReport((await fanoutBatchStore.get(report.batchId))!),
      ).toMatchObject({
        budget: {
          outputTokensUsed: 8,
          aborted: true,
          abortedReason: "max_total_output_tokens_exceeded",
        },
        settled: { succeeded: 2, aborted_budget: 1 },
      });
    });

    it("aborts in-flight and queued items when wall-clock budget expires", async () => {
      vi.useFakeTimers();
      const fanoutBatchStore = new InMemoryFanoutBatchStore();
      const { byName, executor } = setup({
        executorMode: "manual",
        fanoutBatchStore,
      });

      const pending = byName.fanout_template!.invoke({
        items: [
          { key: "a", input: "alpha" },
          { key: "b", input: "beta" },
        ],
        spec: { agentId: "x" },
        concurrency: 1,
        budget: { maxWallClockMs: 25 },
      }) as Promise<{
        batchId: string;
        dispatched: number;
        settled: { cancelled: number; aborted_budget: number };
        budget: { aborted: boolean; abortedReason?: string };
        items: Array<{ key: string; status: string }>;
      }>;

      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(executor.runCalls.map((call) => call.input)).toEqual(["alpha"]);

      await vi.advanceTimersByTimeAsync(25);
      const report = await pending;

      expect(report).toMatchObject({
        dispatched: 1,
        settled: { cancelled: 1, aborted_budget: 1 },
        budget: {
          aborted: true,
          abortedReason: "max_wall_clock_ms_exceeded",
        },
        items: [
          { key: "a", status: "cancelled" },
          { key: "b", status: "aborted_budget" },
        ],
      });
      expect(await fanoutBatchStore.get(report.batchId)).toMatchObject({
        status: "aborted",
        budgetAborted: true,
        abortedReason: "max_wall_clock_ms_exceeded",
        items: [
          { key: "a", status: "cancelled" },
          { key: "b", status: "aborted_budget" },
        ],
      });
    });
  });
});
