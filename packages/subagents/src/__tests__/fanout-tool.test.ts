import { describe, it, expect, vi } from "vitest";
import type {
  SubagentResult,
  SubagentSpec,
} from "../contracts/background-task.js";
import type {
  SubagentExecutorPort,
  SubagentExecutionContext,
} from "../contracts/subagent-executor-port.js";
import { allowAllSpawnPolicy } from "../governance/spawn-gate.js";
import type { SpawnContext, SpawnPolicy } from "../governance/spawn-gate.js";
import { createInProcessSubagentRuntime } from "../runtime/create-runtime.js";
import type { LifecyclePolicy } from "../runtime/runtime-config.js";
import {
  createFanoutTemplateTool,
  isFanoutValidationError,
  type FanoutReport,
  type FanoutToolConfig,
} from "../tools/fanout-tool.js";
import { createSubagentTools } from "../tools/subagent-tools.js";
import { RecordingEventSink, sequentialIds } from "./helpers.js";

/**
 * Instant executor with scriptable per-input outcomes and a peak-concurrency
 * probe. Uses real (tiny) timers so settlements overlap and the fan-out's
 * bounded-concurrency clamp is observable.
 */
class ScriptableExecutor implements SubagentExecutorPort {
  readonly runCalls: SubagentSpec[] = [];
  private inFlight = 0;
  peakConcurrency = 0;

  constructor(
    private readonly behavior: (
      spec: SubagentSpec
    ) => "succeed" | "fail" | "hang" = () => "succeed",
    private readonly result: SubagentResult = { output: "ok" }
  ) {}

  async run(
    spec: SubagentSpec,
    ctx: SubagentExecutionContext
  ): Promise<SubagentResult> {
    this.runCalls.push(spec);
    this.inFlight += 1;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.inFlight);
    try {
      const mode = this.behavior(spec);
      if (mode === "hang") {
        return await new Promise<SubagentResult>((_resolve, reject) => {
          ctx.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true }
          );
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (mode === "fail") {
        throw new Error("scripted_failure");
      }
      return this.result;
    } finally {
      this.inFlight -= 1;
    }
  }
}

function setup(
  opts: {
    behavior?: (spec: SubagentSpec) => "succeed" | "fail" | "hang";
    result?: SubagentResult;
    policy?: SpawnPolicy;
    lifecyclePolicy?: Partial<LifecyclePolicy>;
    fanout?: Partial<Pick<FanoutToolConfig, "limits" | "generateBatchId">>;
  } = {}
) {
  const events = new RecordingEventSink();
  const executor = new ScriptableExecutor(opts.behavior, opts.result);
  const runtime = createInProcessSubagentRuntime({
    executor,
    events,
    generateId: sequentialIds(),
    policy: opts.policy ?? allowAllSpawnPolicy,
    ...(opts.lifecyclePolicy ? { lifecyclePolicy: opts.lifecyclePolicy } : {}),
  });
  const tool = createFanoutTemplateTool({
    runtime,
    resolveParentRunId: () => "run-1",
    generateBatchId: () => "batch-1",
    ...opts.fanout,
  });
  return { events, executor, runtime, tool };
}

function items(n: number): Array<{ key: string; input: string }> {
  return Array.from({ length: n }, (_, i) => ({
    key: `item-${i}`,
    input: `input-${i}`,
  }));
}

function asReport(result: unknown): FanoutReport {
  const value = result as FanoutReport;
  expect(isFanoutValidationError(value as never)).toBe(false);
  return value;
}

describe("fanout_template validation (zero spawns on rejection)", () => {
  it("rejects 201 items under default limits with zero spawns", async () => {
    const { tool, executor, runtime } = setup();
    const spawnSpy = vi.spyOn(runtime, "spawn");
    const result = await tool.invoke({
      items: items(201),
      spec: { agentId: "echo" },
    });
    expect(result).toEqual({
      error: "invalid_batch",
      detail: "batch_size_exceeds_max:200",
    });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(executor.runCalls).toHaveLength(0);
  });

  it("rejects duplicate keys with zero spawns", async () => {
    const { tool, runtime } = setup();
    const spawnSpy = vi.spyOn(runtime, "spawn");
    const result = await tool.invoke({
      items: [
        { key: "a", input: "1" },
        { key: "b", input: "2" },
        { key: "a", input: "3" },
      ],
      spec: { agentId: "echo" },
    });
    expect(result).toEqual({
      error: "invalid_batch",
      detail: "duplicate_key:a",
    });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("rejects an empty item list", async () => {
    const { tool } = setup();
    const result = await tool.invoke({ items: [], spec: { agentId: "echo" } });
    expect(result).toEqual({ error: "invalid_batch", detail: "items_empty" });
  });
});

describe("fanout_template coverage (Spec 01 AC1)", () => {
  it("covers all 500 items with an explicit maxBatchSize override", async () => {
    const { tool, events, executor } = setup({
      fanout: { limits: { maxBatchSize: 500 } },
      lifecyclePolicy: { maxQueuedTasks: 500 },
    });
    const report = asReport(
      await tool.invoke({ items: items(500), spec: { agentId: "echo" } })
    );

    expect(report.declared).toBe(500);
    expect(report.dispatched).toBe(500);
    expect(report.uncovered).toEqual([]);
    expect(report.settled.succeeded).toBe(500);
    expect(report.items).toHaveLength(500);
    expect(
      report.items.every((i) => i.status === "succeeded" && i.taskId)
    ).toBe(true);
    expect(report.budget.aborted).toBe(false);
    // Bounded concurrency: never more than maxConcurrent in flight.
    expect(executor.peakConcurrency).toBeLessThanOrEqual(4);
    // Event lifecycle: started → N dispatched → N settled → completed.
    expect(events.types().filter((t) => t === "fanout:started")).toHaveLength(
      1
    );
    expect(
      events.types().filter((t) => t === "fanout:item_dispatched")
    ).toHaveLength(500);
    expect(
      events.types().filter((t) => t === "fanout:item_settled")
    ).toHaveLength(500);
    expect(events.types().filter((t) => t === "fanout:completed")).toHaveLength(
      1
    );
  }, 25_000);

  it("substitutes {{key}}/{{input}} placeholders into per-item instructions", async () => {
    const { tool, executor } = setup();
    asReport(
      await tool.invoke({
        items: [
          { key: "k1", input: "hello" },
          { key: "k2", input: { nested: true } },
        ],
        spec: { agentId: "echo", instructions: "Process {{key}}: {{input}}" },
      })
    );
    const instructions = executor.runCalls.map((s) => s.instructions).sort();
    expect(instructions).toEqual([
      "Process k1: hello",
      'Process k2: {"nested":true}',
    ]);
  });

  it("truncates oversized per-item results with a resultTruncated marker", async () => {
    const { tool } = setup({ result: { output: "x".repeat(5000) } });
    const report = asReport(
      await tool.invoke({ items: items(1), spec: { agentId: "echo" } })
    );
    const item = report.items[0]!;
    expect(item.status).toBe("succeeded");
    expect(item.resultTruncated).toBe(true);
    expect(Buffer.byteLength(String(item.result))).toBeLessThanOrEqual(2048);
    // taskId retained so the supervisor can check_subagent for full output.
    expect(item.taskId).toBeDefined();
  });
});

describe("fanout_template per-item denial (Spec 01 AC3)", () => {
  it("reports a denied item as denied, siblings unaffected", async () => {
    const policy: SpawnPolicy = {
      check: (spec) =>
        spec.instructions === "bad"
          ? { allow: false, reason: "agent_not_allowed" }
          : { allow: true, requiresApproval: false },
    };
    const { tool, events } = setup({ policy });
    const report = asReport(
      await tool.invoke({
        items: [
          { key: "good-1", input: "a" },
          { key: "bad", input: "b" },
          { key: "good-2", input: "c" },
        ],
        spec: { agentId: "echo", instructions: "{{key}}" },
      })
    );
    expect(report.dispatched).toBe(2);
    expect(report.settled).toMatchObject({ succeeded: 2, denied: 1 });
    const denied = report.items.find((i) => i.key === "bad")!;
    expect(denied.status).toBe("denied");
    expect(denied.taskId).toBeUndefined();
    // Denied items are honestly reported; they are not "uncovered".
    expect(report.uncovered).toEqual([]);
    expect(
      events.types().filter((t) => t === "fanout:item_dispatched")
    ).toHaveLength(2);
  });
});

describe("fanout_template queue_full handling (Spec 01 §6)", () => {
  it("retries queue_full and dispatches once capacity frees", async () => {
    const { tool, runtime } = setup();
    const original = runtime.spawn.bind(runtime);
    let denials = 0;
    const spawnSpy = vi
      .spyOn(runtime, "spawn")
      .mockImplementation(async (spec, parentRunId, options) => {
        if (denials < 2) {
          denials += 1;
          return { ok: false, reason: "queue_full" };
        }
        return original(spec, parentRunId, options);
      });
    const report = asReport(
      await tool.invoke({ items: items(1), spec: { agentId: "echo" } })
    );
    expect(report.dispatched).toBe(1);
    expect(report.uncovered).toEqual([]);
    expect(spawnSpy.mock.calls.length).toBe(3); // 2 queue_full + 1 success
  });

  it("reports never_dispatched + uncovered when queue_full persists to the wall clock", async () => {
    const { tool, events, runtime } = setup({
      lifecyclePolicy: { maxQueuedTasks: 0 },
      fanout: { limits: { maxWallClockMs: 150 } },
    });
    const spawnSpy = vi.spyOn(runtime, "spawn");
    const report = asReport(
      await tool.invoke({
        items: items(3),
        spec: { agentId: "echo" },
        concurrency: 1,
      })
    );
    expect(report.dispatched).toBe(0);
    expect(report.items.every((i) => i.status === "never_dispatched")).toBe(
      true
    );
    expect(report.uncovered).toEqual(["item-0", "item-1", "item-2"]);
    expect(report.budget.aborted).toBe(true);
    // Retried at least once before giving up at the deadline.
    expect(spawnSpy.mock.calls.length).toBeGreaterThan(1);
    expect(events.types()).toContain("fanout:aborted");
    expect(events.types()).not.toContain("fanout:completed");
  });
});

describe("fanout_template wall-clock budget abort (Spec 03 AC5-style accounting)", () => {
  it("settled + aborted + uncovered == declared when the wall clock trips", async () => {
    const { tool, events } = setup({
      behavior: () => "hang",
      fanout: { limits: { maxWallClockMs: 250 } },
    });
    const report = asReport(
      await tool.invoke({
        items: items(6),
        spec: { agentId: "echo" },
        concurrency: 4,
      })
    );

    expect(report.declared).toBe(6);
    expect(report.budget.aborted).toBe(true);
    // Dispatched-but-unsettled items are cancelled and reported aborted_budget;
    // undispatched items are never_dispatched and uncovered.
    expect(report.settled.aborted_budget).toBe(report.dispatched);
    const settledTotal =
      report.settled.succeeded +
      report.settled.failed +
      report.settled.cancelled +
      report.settled.expired +
      report.settled.denied +
      report.settled.aborted_budget;
    expect(settledTotal + report.uncovered.length).toBe(report.declared);
    // Every declared item appears exactly once with an honest status.
    expect(report.items).toHaveLength(6);
    const aborted = events.events.find((e) => e.type === "fanout:aborted");
    expect(aborted).toMatchObject({
      type: "fanout:aborted",
      reason: "timeout",
      dispatched: report.dispatched,
    });
  }, 15_000);
});

describe("fanout_template report/event count invariant (Spec 03 AC6)", () => {
  it("item_dispatched events == report.dispatched == fanout:completed.dispatched", async () => {
    const { tool, events } = setup({
      behavior: (spec) =>
        typeof spec.input === "string" && spec.input.endsWith("2")
          ? "fail"
          : "succeed",
    });
    const report = asReport(
      await tool.invoke({ items: items(8), spec: { agentId: "echo" } })
    );
    const dispatchedEvents = events.events.filter(
      (e) => e.type === "fanout:item_dispatched"
    );
    const completed = events.events.find((e) => e.type === "fanout:completed");
    expect(dispatchedEvents).toHaveLength(report.dispatched);
    expect(completed).toMatchObject({
      dispatched: report.dispatched,
      succeeded: report.settled.succeeded,
      failed: report.settled.failed,
      uncovered: 0,
    });
    const nonDispatched = report.items.filter(
      (i) => i.status === "never_dispatched" || i.status === "denied"
    );
    expect(report.dispatched).toBe(report.items.length - nonDispatched.length);
    expect(report.settled.failed).toBe(1);
  });
});

describe("fanout_template governance context (Spec 03 §2)", () => {
  it("hands context-aware policies the full batch context", async () => {
    const contexts: SpawnContext[] = [];
    const policy: SpawnPolicy = {
      check: vi.fn(() => ({ allow: true as const, requiresApproval: false })),
      checkWithContext: (_spec, ctx) => {
        contexts.push(ctx);
        return { allow: true, requiresApproval: false };
      },
    };
    const { tool } = setup({ policy });
    asReport(await tool.invoke({ items: items(3), spec: { agentId: "echo" } }));
    // Phase B hardening: the fan-out now runs a batch-level gate ONCE (the
    // template check, `approved: false`) before dispatching, then a per-item
    // check for each of the 3 items (`approved: true`) — 4 context-aware calls.
    expect(contexts).toHaveLength(4);
    // Call 0 is the batch-level gate over the template.
    expect(contexts[0]).toMatchObject({
      parentRunId: "run-1",
      depth: 0,
      batch: {
        batchId: "batch-1",
        batchSize: 3,
        mode: "template",
        approved: false,
      },
    });
    // Calls 1..3 are the per-item spawns, running under the passed batch approval.
    expect(contexts[1]).toMatchObject({
      parentRunId: "run-1",
      depth: 0,
      batch: {
        batchId: "batch-1",
        batchSize: 3,
        mode: "template",
        approved: true,
      },
    });
    // checkWithContext takes precedence — legacy check is never invoked.
    expect(policy.check).not.toHaveBeenCalled();
  });

  it("legacy policies receive a plain parentRunId string (Spec 03 AC4)", async () => {
    const seen: string[] = [];
    const policy: SpawnPolicy = {
      check: (_spec, parentRunId) => {
        // Would throw on an object — the regression this rule prevents.
        seen.push(String(parentRunId.startsWith("run-")));
        return { allow: true, requiresApproval: false };
      },
    };
    const { tool } = setup({ policy });
    const report = asReport(
      await tool.invoke({ items: items(2), spec: { agentId: "echo" } })
    );
    expect(report.settled.succeeded).toBe(2);
    // Phase B: one batch-level gate call over the template + one per item — a
    // legacy policy still ALWAYS receives a plain `parentRunId` string, never
    // the context object (the regression this rule prevents).
    expect(seen).toEqual(["true", "true", "true"]);
  });
});

describe("createSubagentTools integration", () => {
  it("exposes fanout_template alongside the four singleton tools", async () => {
    const events = new RecordingEventSink();
    const runtime = createInProcessSubagentRuntime({
      executor: new ScriptableExecutor(),
      events,
      generateId: sequentialIds(),
      policy: allowAllSpawnPolicy,
    });
    const tools = createSubagentTools({
      runtime,
      resolveParentRunId: () => "run-1",
    });
    const fanout = tools.find((t) => t.name === "fanout_template")!;
    expect(fanout).toBeDefined();
    const report = asReport(
      await fanout.invoke({
        items: [{ key: "only", input: "x" }],
        spec: { agentId: "echo" },
      })
    );
    expect(report.dispatched).toBe(1);
    expect(report.uncovered).toEqual([]);
  });
});
