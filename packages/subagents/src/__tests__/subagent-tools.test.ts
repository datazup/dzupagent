import { describe, it, expect } from "vitest";
import { createSubagentTools } from "../tools/subagent-tools.js";
import { createInProcessSubagentRuntime } from "../runtime/create-runtime.js";
import { allowAllSpawnPolicy } from "../governance/spawn-gate.js";
import type { SpawnPolicy } from "../governance/spawn-gate.js";
import type { SubagentResult } from "../contracts/background-task.js";
import {
  ControllableExecutor,
  RecordingEventSink,
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
    maxResultBytes?: number;
  } = {},
) {
  const events = new RecordingEventSink();
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
    lifecyclePolicy: {
      ...(opts.maxConcurrent !== undefined
        ? { maxConcurrentBackground: opts.maxConcurrent }
        : {}),
      ...(opts.maxQueued !== undefined ? { maxQueuedTasks: opts.maxQueued } : {}),
    },
  });
  const tools = createSubagentTools({
    runtime,
    resolveParentRunId: () => "run-1",
    events,
    generateBatchId: sequentialIds("batch"),
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
    },
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { runtime, executor, events, tools, byName };
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
      expect(report.items).toEqual([
        { key: "a", taskId: "t1", status: "succeeded" },
        { key: "b", status: "denied" },
        { key: "c", taskId: "t3", status: "succeeded" },
      ]);
      expect(executor.runCalls.map((call) => call.input)).toEqual([
        "allowed-a",
        "allowed-c",
      ]);
    });
  });
});
