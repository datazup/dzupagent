import { describe, it, expect } from "vitest";
import { createSubagentTools } from "../tools/subagent-tools.js";
import { createInProcessSubagentRuntime } from "../runtime/create-runtime.js";
import { allowAllSpawnPolicy } from "../governance/spawn-gate.js";
import {
  ControllableExecutor,
  RecordingEventSink,
  sequentialIds,
  flush,
} from "./helpers.js";
import { InMemoryFanoutBatchStore } from "../store/in-memory-fanout-batch-store.js";
import { fanoutBatchRecordToReport } from "../tools/fanout-tool.js";
import type { SubagentResult } from "../contracts/background-task.js";

/**
 * Tool-set bound to an instant executor and an optional durable batch ledger —
 * used by the `check_fanout` recovery tests. Mirrors the base {@link setup} but
 * runs fan-out to completion synchronously.
 */
function setupInstant(opts?: {
  fanoutBatchStore?: InMemoryFanoutBatchStore;
  instantResult?: SubagentResult;
}) {
  const events = new RecordingEventSink();
  const executor = new ControllableExecutor(
    "instant",
    opts?.instantResult ?? { output: "ok" }
  );
  const runtime = createInProcessSubagentRuntime({
    executor,
    events,
    generateId: sequentialIds(),
    policy: allowAllSpawnPolicy,
  });
  const tools = createSubagentTools({
    runtime,
    resolveParentRunId: () => "run-1",
    ...(opts?.fanoutBatchStore !== undefined
      ? { fanout: { fanoutBatchStore: opts.fanoutBatchStore } }
      : {}),
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { runtime, executor, tools, byName };
}

function setup() {
  const events = new RecordingEventSink();
  const executor = new ControllableExecutor("manual");
  const runtime = createInProcessSubagentRuntime({
    executor,
    events,
    generateId: sequentialIds(),
    // Base runtime now denies spawns by default (AGENT-H-03); this suite exercises
    // tool mechanics, not governance, so opt into the test-only allow-all policy.
    policy: allowAllSpawnPolicy,
  });
  const tools = createSubagentTools({
    runtime,
    resolveParentRunId: () => "run-1",
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { runtime, executor, tools, byName };
}

/** Build a second tool-set bound to a different parent run over the same runtime. */
function toolsForRun(
  runtime: ReturnType<typeof createInProcessSubagentRuntime>,
  parentRunId: string
) {
  const tools = createSubagentTools({
    runtime,
    resolveParentRunId: () => parentRunId,
  });
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

describe("subagent tools", () => {
  it("exposes the five expected tools", () => {
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
        await foreign.check_subagent!.invoke({ taskId: spawned.taskId })
      ).toEqual({ found: false });

      // run-2 must not be able to await it (resolves as not-found immediately).
      expect(
        await foreign.await_subagent!.invoke({
          taskId: spawned.taskId,
          timeoutMs: 50,
        })
      ).toEqual({ found: false });

      // run-2's cancel must be a no-op — the task keeps running.
      expect(
        await foreign.cancel_subagent!.invoke({ taskId: spawned.taskId })
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

  describe("check_fanout", () => {
    it("exposes check_fanout only when a batch store is configured", () => {
      const withoutStore = setupInstant();
      expect(withoutStore.tools.map((t) => t.name)).not.toContain(
        "check_fanout"
      );

      const fanoutBatchStore = new InMemoryFanoutBatchStore();
      const { tools } = setupInstant({ fanoutBatchStore });
      expect(tools.map((t) => t.name).sort()).toEqual([
        "await_subagent",
        "cancel_subagent",
        "check_fanout",
        "check_subagent",
        "fanout_template",
        "spawn_subagent",
      ]);
    });

    it("reconstructs a fanout report by batchId, or reports not found", async () => {
      const fanoutBatchStore = new InMemoryFanoutBatchStore();
      const { byName } = setupInstant({ fanoutBatchStore });

      const report = (await byName.fanout_template!.invoke({
        items: [
          { key: "a", input: "alpha" },
          { key: "b", input: "beta" },
        ],
        spec: { agentId: "x" },
      })) as { batchId: string };

      await expect(
        byName.check_fanout!.invoke({ batchId: report.batchId })
      ).resolves.toMatchObject({
        found: true,
        report: {
          batchId: report.batchId,
          declared: 2,
          dispatched: 2,
          uncovered: [],
          settled: { succeeded: 2 },
        },
      });
      await expect(
        byName.check_fanout!.invoke({ batchId: "missing" })
      ).resolves.toEqual({ found: false });
    });

    it("includes provider attribution in reconstructed report items", async () => {
      const fanoutBatchStore = new InMemoryFanoutBatchStore();
      const { byName } = setupInstant({
        fanoutBatchStore,
        instantResult: { output: "done", provider: "codex" },
      });

      const report = (await byName.fanout_template!.invoke({
        items: [{ key: "repo-a", input: "audit repo-a" }],
        spec: { agentId: "codex" },
      })) as {
        batchId: string;
        items: Array<{ key: string; status: string; provider?: string }>;
      };

      expect(report.items[0]).toMatchObject({
        key: "repo-a",
        status: "succeeded",
        provider: "codex",
      });

      await expect(
        byName.check_fanout!.invoke({ batchId: report.batchId })
      ).resolves.toMatchObject({
        found: true,
        report: {
          items: [{ key: "repo-a", provider: "codex" }],
        },
      });
    });

    it("aborts before dispatch when persona maxBudgetUsd exceeds aggregate budget", async () => {
      const fanoutBatchStore = new InMemoryFanoutBatchStore();
      const { byName, executor } = setupInstant({ fanoutBatchStore });

      const report = (await byName.fanout_template!.invoke({
        items: [
          { key: "a", input: "alpha" },
          { key: "b", input: "beta" },
          { key: "c", input: "gamma" },
        ],
        spec: {
          agentId: "inline",
          definition: {
            name: "inline-budgeted",
            personaPrompt: "Stay scoped.",
            constraints: { maxBudgetUsd: 0.5 },
          },
        },
        budget: { maxTotalBudgetUsd: 1 },
      })) as {
        batchId: string;
        dispatched: number;
        settled: { aborted_budget: number };
        budget: {
          budgetUsdReserved?: number;
          aborted: boolean;
          abortedReason?: string;
        };
        items: Array<{ key: string; status: string; error?: string }>;
      };

      expect(report).toMatchObject({
        dispatched: 0,
        settled: { aborted_budget: 3 },
        budget: {
          budgetUsdReserved: 1.5,
          aborted: true,
          abortedReason: "max_total_budget_usd_exceeded",
        },
        items: [
          {
            key: "a",
            status: "aborted_budget",
            error: "max_total_budget_usd_exceeded",
          },
          {
            key: "b",
            status: "aborted_budget",
            error: "max_total_budget_usd_exceeded",
          },
          {
            key: "c",
            status: "aborted_budget",
            error: "max_total_budget_usd_exceeded",
          },
        ],
      });
      expect(executor.runCalls).toEqual([]);
      expect(await fanoutBatchStore.get(report.batchId)).toMatchObject({
        status: "aborted",
        budgetAborted: true,
        budgetUsdReserved: 1.5,
        abortedReason: "max_total_budget_usd_exceeded",
      });
    });

    it("records actual USD consumption separately from reserved budget", async () => {
      const fanoutBatchStore = new InMemoryFanoutBatchStore();
      const { byName } = setupInstant({
        fanoutBatchStore,
        instantResult: {
          output: "ok",
          usage: { outputTokens: 4, costUsd: 0.125 },
        },
      });

      const report = (await byName.fanout_template!.invoke({
        items: [
          { key: "a", input: "alpha" },
          { key: "b", input: "beta" },
        ],
        spec: {
          agentId: "inline",
          definition: {
            name: "inline-budgeted",
            personaPrompt: "Stay scoped.",
            constraints: { maxBudgetUsd: 0.5 },
          },
        },
        budget: { maxTotalBudgetUsd: 2 },
      })) as {
        batchId: string;
        budget: {
          budgetUsdReserved?: number;
          budgetUsdActual?: number;
          aborted: boolean;
        };
      };

      expect(report.budget).toMatchObject({
        budgetUsdReserved: 1,
        budgetUsdActual: 0.25,
        aborted: false,
      });
      expect(await fanoutBatchStore.get(report.batchId)).toMatchObject({
        budgetUsdReserved: 1,
        budgetUsdActual: 0.25,
      });
      expect(
        fanoutBatchRecordToReport((await fanoutBatchStore.get(report.batchId))!)
      ).toMatchObject({
        budget: {
          budgetUsdReserved: 1,
          budgetUsdActual: 0.25,
          aborted: false,
        },
      });
    });

    it("aborts later queued items when actual USD consumption exceeds aggregate budget", async () => {
      const fanoutBatchStore = new InMemoryFanoutBatchStore();
      const { byName } = setupInstant({
        fanoutBatchStore,
        instantResult: {
          output: "ok",
          usage: { outputTokens: 1, costUsd: 0.75 },
        },
      });

      const report = (await byName.fanout_template!.invoke({
        concurrency: 1,
        items: [
          { key: "a", input: "alpha" },
          { key: "b", input: "beta" },
          { key: "c", input: "gamma" },
        ],
        spec: {
          agentId: "inline",
          definition: {
            name: "inline-costed",
            personaPrompt: "Stay scoped.",
          },
        },
        budget: { maxTotalBudgetUsd: 1 },
      })) as {
        batchId: string;
        dispatched: number;
        settled: { succeeded: number; aborted_budget: number };
        budget: {
          budgetUsdActual?: number;
          aborted: boolean;
          abortedReason?: string;
        };
        items: Array<{ key: string; status: string; costUsd?: number }>;
      };

      expect(report).toMatchObject({
        dispatched: 2,
        settled: { succeeded: 2, aborted_budget: 1 },
        budget: {
          budgetUsdActual: 1.5,
          aborted: true,
          abortedReason: "max_total_budget_usd_exceeded",
        },
        items: [
          { key: "a", status: "succeeded", costUsd: 0.75 },
          { key: "b", status: "succeeded", costUsd: 0.75 },
          { key: "c", status: "aborted_budget" },
        ],
      });
      expect(
        fanoutBatchRecordToReport((await fanoutBatchStore.get(report.batchId))!)
      ).toMatchObject({
        budget: {
          budgetUsdActual: 1.5,
          aborted: true,
          abortedReason: "max_total_budget_usd_exceeded",
        },
        settled: { succeeded: 2, aborted_budget: 1 },
      });
    });

    it("uses per-item cost estimates to avoid dispatching queued items that cannot fit remaining budget", async () => {
      const fanoutBatchStore = new InMemoryFanoutBatchStore();
      const { byName, executor } = setupInstant({
        fanoutBatchStore,
        instantResult: {
          output: "ok",
          usage: { outputTokens: 1, costUsd: 0.25 },
        },
      });

      const report = (await byName.fanout_template!.invoke({
        concurrency: 1,
        items: [
          { key: "a", input: "alpha" },
          { key: "b", input: "beta" },
          { key: "c", input: "gamma" },
        ],
        spec: {
          agentId: "inline",
          definition: {
            name: "inline-estimated",
            personaPrompt: "Stay scoped.",
            constraints: { estimatedCostUsd: 0.6 },
          },
        },
        budget: { maxTotalBudgetUsd: 1 },
      })) as {
        batchId: string;
        dispatched: number;
        settled: { succeeded: number; aborted_budget: number };
        budget: {
          budgetUsdReserved?: number;
          budgetUsdActual?: number;
          aborted: boolean;
          abortedReason?: string;
        };
        items: Array<{
          key: string;
          status: string;
          costUsd?: number;
          error?: string;
        }>;
      };

      expect(report).toMatchObject({
        dispatched: 2,
        settled: { succeeded: 2, aborted_budget: 1 },
        budget: {
          budgetUsdReserved: 1.2,
          budgetUsdActual: 0.5,
          aborted: true,
          abortedReason: "max_total_budget_usd_preflight_exceeded",
        },
        items: [
          { key: "a", status: "succeeded", costUsd: 0.25 },
          { key: "b", status: "succeeded", costUsd: 0.25 },
          {
            key: "c",
            status: "aborted_budget",
            error: "max_total_budget_usd_preflight_exceeded",
          },
        ],
      });
      expect(executor.runCalls.map((call) => call.input)).toEqual([
        "alpha",
        "beta",
      ]);
      expect(await fanoutBatchStore.get(report.batchId)).toMatchObject({
        status: "aborted",
        budgetAborted: true,
        budgetUsdReserved: 1.2,
        budgetUsdActual: 0.5,
        abortedReason: "max_total_budget_usd_preflight_exceeded",
      });
    });
  });
});
