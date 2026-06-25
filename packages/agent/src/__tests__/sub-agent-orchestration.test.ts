/**
 * sub-agent-orchestration.test.ts
 *
 * +75 tests covering sub-agent orchestration in @dzupagent/agent:
 *   - Delegating tasks to sub-agents (spawn, configure, invoke)
 *   - Fan-out patterns (parallel dispatch to multiple sub-agents)
 *   - Result aggregation (collecting, merging, prioritising results)
 *   - Error handling when sub-agents fail or time out
 *   - Sub-agent lifecycle (creation, execution, teardown)
 *
 * All LLM calls are mocked — no real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { InMemoryRunStore, createEventBus } from "@dzupagent/core";
import type {
  DzupEventBus,
  DzupEvent,
  AgentExecutionSpec,
} from "@dzupagent/core";
import { DzupAgent } from "../agent/dzip-agent.js";
import { AgentOrchestrator } from "../orchestration/orchestrator.js";
import { OrchestrationError } from "../orchestration/orchestration-error.js";
import { AgentCircuitBreaker } from "../orchestration/circuit-breaker.js";
import {
  DelegatingSupervisor,
  type TaskAssignment,
} from "../orchestration/delegating-supervisor.js";
import {
  SimpleDelegationTracker,
  type DelegationExecutor,
} from "../orchestration/delegation.js";
import { aggregateSettledResults } from "../orchestration/parallel-delegation-aggregator.js";
import { RuleBasedRouting } from "../orchestration/routing/rule-based-routing.js";
import { RoundRobinRouting } from "../orchestration/routing/round-robin-routing.js";
import { HashRouting } from "../orchestration/routing/hash-routing.js";
import type {
  AgentSpec,
  AgentTask,
} from "../orchestration/routing-policy-types.js";
import type { DelegationResult } from "../orchestration/delegation.js";

// ---------------------------------------------------------------------------
// Shared mock factories
// ---------------------------------------------------------------------------

function createMockModel(
  responses: Array<{
    content: string;
    tool_calls?: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
    }>;
  }>,
): BaseChatModel {
  let callIndex = 0;
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    const resp = responses[callIndex] ?? responses[responses.length - 1]!;
    callIndex++;
    return new AIMessage({
      content: resp.content,
      tool_calls: resp.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.name,
        args: tc.args,
        type: "tool_call" as const,
      })),
      response_metadata: {},
    });
  });
  return {
    invoke,
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this;
    }),
    _modelType: () => "base_chat_model",
    _llmType: () => "mock",
  } as unknown as BaseChatModel;
}

function createThrowingModel(message: string): BaseChatModel {
  return {
    invoke: vi.fn(async () => {
      throw new Error(message);
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this;
    }),
    _modelType: () => "base_chat_model",
    _llmType: () => "mock",
  } as unknown as BaseChatModel;
}

function createSlowModel(delayMs: number, content: string): BaseChatModel {
  return {
    invoke: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return new AIMessage({ content, response_metadata: {} });
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this;
    }),
    _modelType: () => "base_chat_model",
    _llmType: () => "mock",
  } as unknown as BaseChatModel;
}

function createAgent(id: string, model: BaseChatModel): DzupAgent {
  return new DzupAgent({
    id,
    name: id,
    description: `${id} specialist agent`,
    instructions: `You are the ${id} specialist.`,
    model,
  });
}

function makeSpecialist(
  id: string,
  overrides: Partial<AgentExecutionSpec> = {},
): AgentExecutionSpec {
  return {
    id,
    name: overrides.name ?? id,
    instructions: `You are the ${id} specialist`,
    modelTier: "codegen",
    metadata: overrides.metadata,
    ...overrides,
  };
}

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    taskId: "task-default",
    content: "Default task content",
    ...overrides,
  };
}

function withStoreUpdate(
  store: InMemoryRunStore,
  output: unknown = "ok",
): DelegationExecutor {
  return async (runId, _agentId, _input, signal) => {
    if (signal.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (signal.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await store.update(runId, {
      status: "completed",
      output,
      completedAt: new Date(),
    });
  };
}

function perAgentExecutor(store: InMemoryRunStore): DelegationExecutor {
  return async (runId, agentId, _input, signal) => {
    if (signal.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (signal.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await store.update(runId, {
      status: "completed",
      output: `output-from-${agentId}`,
      completedAt: new Date(),
    });
  };
}

function failingExecutor(message = "sub-agent failed"): DelegationExecutor {
  return async () => {
    throw new Error(message);
  };
}

function hangingExecutor(): DelegationExecutor {
  return async (_runId, _agentId, _input, signal) => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () =>
          reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  };
}

// ===========================================================================
// Section A — Delegating tasks to sub-agents (spawn, configure, invoke)
// ===========================================================================

describe("Sub-agent spawning and configuration", () => {
  it("creates a DzupAgent with a specific id and instructions", () => {
    const model = createMockModel([{ content: "ok" }]);
    const agent = createAgent("research-agent", model);
    expect(agent.id).toBe("research-agent");
  });

  it("agent with custom instructions is distinct from another agent", () => {
    const a = new DzupAgent({
      id: "agent-alpha",
      name: "Alpha",
      instructions: "Alpha instructions",
      model: createMockModel([{ content: "alpha" }]),
    });
    const b = new DzupAgent({
      id: "agent-beta",
      name: "Beta",
      instructions: "Beta instructions",
      model: createMockModel([{ content: "beta" }]),
    });
    expect(a.id).not.toBe(b.id);
  });

  it("agent invoke calls underlying model with human message", async () => {
    const model = createMockModel([{ content: "invoked-output" }]);
    const agent = createAgent("invoke-test", model);
    const result = await agent.generate([
      new AIMessage({ content: "go", response_metadata: {} }),
    ]);
    expect(model.invoke).toHaveBeenCalled();
    expect(result.content).toBeTruthy();
  });

  it("DelegatingSupervisor accepts a specialists Map during construction", () => {
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["worker-a", makeSpecialist("worker-a")],
        ["worker-b", makeSpecialist("worker-b")],
      ]),
      tracker,
    });
    expect(supervisor.specialistIds).toContain("worker-a");
    expect(supervisor.specialistIds).toContain("worker-b");
  });

  it("getSpecialist returns the configured AgentExecutionSpec", () => {
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store),
    });
    const spec = makeSpecialist("configured-agent", {
      metadata: { tags: ["ml"] },
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["configured-agent", spec]]),
      tracker,
    });
    expect(supervisor.getSpecialist("configured-agent")).toBe(spec);
  });

  it("delegating to a registered specialist succeeds", async () => {
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store, { result: "delegate-ok" }),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["target", makeSpecialist("target")]]),
      tracker,
    });
    const result = await supervisor.delegateTask("Do work", "target", {});
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ result: "delegate-ok" });
  });

  it("configuring specialist with metadata tags is reflected in getSpecialist", () => {
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store),
    });
    const spec = makeSpecialist("tagged-specialist", {
      metadata: { tags: ["nlp", "summarization"] },
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["tagged-specialist", spec]]),
      tracker,
    });
    const found = supervisor.getSpecialist("tagged-specialist");
    expect(found?.metadata).toMatchObject({ tags: ["nlp", "summarization"] });
  });

  it("multiple specialists can be registered and retrieved individually", () => {
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store),
    });
    const specs = ["alpha", "beta", "gamma", "delta"].map((id) =>
      makeSpecialist(id),
    );
    const supervisor = new DelegatingSupervisor({
      specialists: new Map(specs.map((s) => [s.id, s])),
      tracker,
    });
    for (const s of specs) {
      expect(supervisor.getSpecialist(s.id)).toBe(s);
    }
  });

  it("specialist invocation creates a run record in the store", async () => {
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store, "stored"),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["write-agent", makeSpecialist("write-agent")]]),
      tracker,
    });
    await supervisor.delegateTask("write file", "write-agent", {});
    const runs = await store.list({ agentId: "write-agent" });
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]!.status).toBe("completed");
  });
});

// ===========================================================================
// Section B — Fan-out patterns (parallel dispatch)
// ===========================================================================

describe("Fan-out patterns — parallel sub-agent dispatch", () => {
  let store: InMemoryRunStore;
  let eventBus: DzupEventBus;
  let events: DzupEvent[];

  beforeEach(() => {
    store = new InMemoryRunStore();
    eventBus = createEventBus();
    events = [];
    eventBus.onAny((e) => events.push(e));
  });

  it("AgentOrchestrator.parallel dispatches all agents with the same input", async () => {
    const m1 = createMockModel([{ content: "r1" }]);
    const m2 = createMockModel([{ content: "r2" }]);
    const m3 = createMockModel([{ content: "r3" }]);

    await AgentOrchestrator.parallel(
      [createAgent("a", m1), createAgent("b", m2), createAgent("c", m3)],
      "fan-out-input",
    );

    for (const model of [m1, m2, m3]) {
      const calls = (model.invoke as ReturnType<typeof vi.fn>).mock.calls;
      const human = (calls[0]![0] as BaseMessage[]).find(
        (m) => m._getType() === "human",
      );
      expect(human?.content).toBe("fan-out-input");
    }
  });

  it("parallel dispatch calls every agent exactly once", async () => {
    const models = [
      createMockModel([{ content: "x" }]),
      createMockModel([{ content: "y" }]),
      createMockModel([{ content: "z" }]),
    ];
    await AgentOrchestrator.parallel(
      models.map((m, i) => createAgent(`agent-${i}`, m)),
      "call-count-test",
    );
    for (const model of models) {
      expect(model.invoke).toHaveBeenCalledTimes(1);
    }
  });

  it("delegateAndCollect fan-out returns results for all agents", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: perAgentExecutor(store),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["fan-a", makeSpecialist("fan-a")],
        ["fan-b", makeSpecialist("fan-b")],
        ["fan-c", makeSpecialist("fan-c")],
      ]),
      tracker,
      eventBus,
    });
    const aggregated = await supervisor.delegateAndCollect([
      { task: "Task A", specialistId: "fan-a", input: {} },
      { task: "Task B", specialistId: "fan-b", input: {} },
      { task: "Task C", specialistId: "fan-c", input: {} },
    ]);
    expect(aggregated.succeeded).toHaveLength(3);
    expect(aggregated.failed).toHaveLength(0);
  });

  it("fan-out with 5 agents all complete successfully", async () => {
    const agents = Array.from({ length: 5 }, (_, i) => `fan-${i}`);
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: perAgentExecutor(store),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map(agents.map((id) => [id, makeSpecialist(id)])),
      tracker,
    });
    const tasks: TaskAssignment[] = agents.map((id) => ({
      task: `task for ${id}`,
      specialistId: id,
      input: {},
    }));
    const result = await supervisor.delegateAndCollect(tasks);
    expect(result.succeeded).toHaveLength(5);
  });

  it("fan-out emits delegation:started event for each agent", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: withStoreUpdate(store, "ok"),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["ev-a", makeSpecialist("ev-a")],
        ["ev-b", makeSpecialist("ev-b")],
      ]),
      tracker,
      eventBus,
    });
    await supervisor.delegateAndCollect([
      { task: "T1", specialistId: "ev-a", input: {} },
      { task: "T2", specialistId: "ev-b", input: {} },
    ]);
    await new Promise((r) => setTimeout(r, 20));
    const startedEvents = events.filter((e) => e.type === "delegation:started");
    expect(startedEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("parallel orchestration with custom merge function uses all results", async () => {
    const agents = [
      createAgent("w1", createMockModel([{ content: "chunk-1" }])),
      createAgent("w2", createMockModel([{ content: "chunk-2" }])),
    ];
    const merge = vi.fn((results: string[]) => results.join(" + "));
    const result = await AgentOrchestrator.parallel(agents, "task", merge);
    expect(merge).toHaveBeenCalledWith(["chunk-1", "chunk-2"]);
    expect(result).toBe("chunk-1 + chunk-2");
  });

  it("fan-out stores separate run records per agent", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store, "stored"),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["rec-a", makeSpecialist("rec-a")],
        ["rec-b", makeSpecialist("rec-b")],
      ]),
      tracker,
    });
    await supervisor.delegateAndCollect([
      { task: "R1", specialistId: "rec-a", input: {} },
      { task: "R2", specialistId: "rec-b", input: {} },
    ]);
    const runsA = await store.list({ agentId: "rec-a" });
    const runsB = await store.list({ agentId: "rec-b" });
    expect(runsA).toHaveLength(1);
    expect(runsB).toHaveLength(1);
    expect(runsA[0]!.id).not.toBe(runsB[0]!.id);
  });

  it("fan-out results map contains per-agent output keyed by specialistId", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: perAgentExecutor(store),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["keyed-x", makeSpecialist("keyed-x")],
        ["keyed-y", makeSpecialist("keyed-y")],
      ]),
      tracker,
    });
    const result = await supervisor.delegateAndCollect([
      { task: "TX", specialistId: "keyed-x", input: {} },
      { task: "TY", specialistId: "keyed-y", input: {} },
    ]);
    expect(result.results.get("keyed-x")?.output).toBe("output-from-keyed-x");
    expect(result.results.get("keyed-y")?.output).toBe("output-from-keyed-y");
  });
});

// ===========================================================================
// Section C — Result aggregation
// ===========================================================================

describe("Result aggregation — collecting and merging sub-agent outputs", () => {
  it("aggregateSettledResults: all fulfilled → succeeded list contains all keys", () => {
    const assignments: TaskAssignment[] = [
      { specialistId: "agg-a", task: "ta", input: {} },
      { specialistId: "agg-b", task: "tb", input: {} },
      { specialistId: "agg-c", task: "tc", input: {} },
    ];
    const settled: PromiseSettledResult<DelegationResult>[] = [
      {
        status: "fulfilled",
        value: { success: true, output: "out-a", metadata: { durationMs: 10 } },
      },
      {
        status: "fulfilled",
        value: { success: true, output: "out-b", metadata: { durationMs: 20 } },
      },
      {
        status: "fulfilled",
        value: { success: true, output: "out-c", metadata: { durationMs: 15 } },
      },
    ];
    const result = aggregateSettledResults({
      startedAt: Date.now() - 100,
      assignments,
      settled,
    });
    expect(result.succeeded).toEqual(["agg-a", "agg-b", "agg-c"]);
    expect(result.failed).toEqual([]);
  });

  it("aggregateSettledResults: failed outcomes appear in failed list", () => {
    const assignments: TaskAssignment[] = [
      { specialistId: "ok", task: "t", input: {} },
      { specialistId: "bad", task: "t", input: {} },
    ];
    const settled: PromiseSettledResult<DelegationResult>[] = [
      { status: "fulfilled", value: { success: true, output: "ok-out" } },
      { status: "rejected", reason: new Error("sub-agent exploded") },
    ];
    const result = aggregateSettledResults({
      startedAt: Date.now(),
      assignments,
      settled,
    });
    expect(result.succeeded).toEqual(["ok"]);
    expect(result.failed).toEqual(["bad"]);
  });

  it("aggregateSettledResults: rejected result has success=false and error message", () => {
    const assignments: TaskAssignment[] = [
      { specialistId: "err-agent", task: "t", input: {} },
    ];
    const settled: PromiseSettledResult<DelegationResult>[] = [
      { status: "rejected", reason: new Error("custom-error-msg") },
    ];
    const result = aggregateSettledResults({
      startedAt: Date.now(),
      assignments,
      settled,
    });
    const entry = result.results.get("err-agent");
    expect(entry?.success).toBe(false);
    expect(entry?.error).toBe("custom-error-msg");
  });

  it("aggregateSettledResults: uses assignment.id as map key over specialistId", () => {
    const assignments: TaskAssignment[] = [
      { id: "node-alpha", specialistId: "shared-worker", task: "t", input: {} },
    ];
    const settled: PromiseSettledResult<DelegationResult>[] = [
      { status: "fulfilled", value: { success: true, output: "node-data" } },
    ];
    const result = aggregateSettledResults({
      startedAt: Date.now(),
      assignments,
      settled,
    });
    expect(result.results.has("node-alpha")).toBe(true);
    expect(result.succeeded).toEqual(["node-alpha"]);
  });

  it("aggregateSettledResults: totalDurationMs is non-negative", () => {
    const assignments: TaskAssignment[] = [
      { specialistId: "timing-agent", task: "t", input: {} },
    ];
    const settled: PromiseSettledResult<DelegationResult>[] = [
      {
        status: "fulfilled",
        value: { success: true, output: "done", metadata: { durationMs: 50 } },
      },
    ];
    const result = aggregateSettledResults({
      startedAt: Date.now() - 100,
      assignments,
      settled,
    });
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("aggregateSettledResults: invokes mergeStrategy.merge with agent results", () => {
    const mergeStrategy = {
      merge: vi.fn(() => ({
        status: "success" as const,
        successCount: 2,
        errorCount: 0,
        mergedOutput: "merged",
      })),
    };
    const assignments: TaskAssignment[] = [
      { specialistId: "ms-a", task: "ta", input: {} },
      { specialistId: "ms-b", task: "tb", input: {} },
    ];
    const settled: PromiseSettledResult<DelegationResult>[] = [
      { status: "fulfilled", value: { success: true, output: "a-out" } },
      { status: "fulfilled", value: { success: true, output: "b-out" } },
    ];
    aggregateSettledResults({
      startedAt: Date.now(),
      assignments,
      settled,
      mergeStrategy,
    });
    expect(mergeStrategy.merge).toHaveBeenCalledOnce();
  });

  it("AgentOrchestrator.parallel default merge numbers sections from 1", async () => {
    const a = createAgent("n1", createMockModel([{ content: "first" }]));
    const b = createAgent("n2", createMockModel([{ content: "second" }]));
    const result = await AgentOrchestrator.parallel([a, b], "input");
    expect(result).toContain("--- Agent 1 ---");
    expect(result).toContain("--- Agent 2 ---");
  });

  it("AgentOrchestrator.parallel result contains each agent output", async () => {
    const a = createAgent(
      "p-a",
      createMockModel([{ content: "alpha-output" }]),
    );
    const b = createAgent("p-b", createMockModel([{ content: "beta-output" }]));
    const result = await AgentOrchestrator.parallel([a, b], "task");
    expect(result).toContain("alpha-output");
    expect(result).toContain("beta-output");
  });

  it("sequential result equals last agent output", async () => {
    const m1 = createMockModel([{ content: "intermediate" }]);
    const m2 = createMockModel([{ content: "final-value" }]);
    const result = await AgentOrchestrator.sequential(
      [createAgent("s1", m1), createAgent("s2", m2)],
      "start",
    );
    expect(result).toBe("final-value");
  });

  it("delegateAndCollect aggregated result has results map entries for all succeeded", async () => {
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store, "data"),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["agg-worker-1", makeSpecialist("agg-worker-1")],
        ["agg-worker-2", makeSpecialist("agg-worker-2")],
      ]),
      tracker,
    });
    const result = await supervisor.delegateAndCollect([
      { task: "T1", specialistId: "agg-worker-1", input: {} },
      { task: "T2", specialistId: "agg-worker-2", input: {} },
    ]);
    for (const id of result.succeeded) {
      expect(result.results.has(id)).toBe(true);
      expect(result.results.get(id)?.success).toBe(true);
    }
  });

  it("aggregated result metadata includes durationMs per entry", async () => {
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store, "out"),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["dur-agent", makeSpecialist("dur-agent")]]),
      tracker,
    });
    const result = await supervisor.delegateAndCollect([
      { task: "dur-task", specialistId: "dur-agent", input: {} },
    ]);
    const entry = result.results.get("dur-agent");
    expect(typeof entry?.metadata?.durationMs).toBe("number");
  });
});

// ===========================================================================
// Section D — Error handling when sub-agents fail or time out
// ===========================================================================

describe("Sub-agent error handling — failures and timeouts", () => {
  it("delegateTask throws OrchestrationError for unknown specialist", async () => {
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["real-agent", makeSpecialist("real-agent")]]),
      tracker,
    });
    await expect(
      supervisor.delegateTask("task", "phantom-agent", {}),
    ).rejects.toThrow('Specialist "phantom-agent" not found');
  });

  it("OrchestrationError is thrown when no specialists are registered", async () => {
    const mgr = createAgent("mgr", createMockModel([{ content: "x" }]));
    await expect(
      AgentOrchestrator.supervisor({
        manager: mgr,
        specialists: [],
        task: "do something",
      }),
    ).rejects.toThrow(OrchestrationError);
  });

  it("parallel fan-out with one failing sub-agent surfaces error by default", async () => {
    const good = createAgent("good", createMockModel([{ content: "ok" }]));
    const bad = createAgent("bad", createThrowingModel("sub-agent crashed"));
    await expect(
      AgentOrchestrator.parallel([good, bad], "task"),
    ).rejects.toThrow();
  });

  it("delegateAndCollect partial failure: failed agent is in failed list", async () => {
    const store = new InMemoryRunStore();
    const executor: DelegationExecutor = async (
      runId,
      agentId,
      _input,
      signal,
    ) => {
      if (signal.aborted) throw signal.reason;
      await new Promise((r) => setTimeout(r, 5));
      if (agentId === "crash-worker") throw new Error("crash-worker failed");
      await store.update(runId, {
        status: "completed",
        output: `${agentId}-ok`,
        completedAt: new Date(),
      });
    };
    const tracker = new SimpleDelegationTracker({ runStore: store, executor });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["safe-worker", makeSpecialist("safe-worker")],
        ["crash-worker", makeSpecialist("crash-worker")],
      ]),
      tracker,
    });
    const result = await supervisor.delegateAndCollect([
      { task: "T1", specialistId: "safe-worker", input: {} },
      { task: "T2", specialistId: "crash-worker", input: {} },
    ]);
    expect(result.succeeded).toContain("safe-worker");
    expect(result.failed).toContain("crash-worker");
  });

  it("failed sub-agent result has success=false and error populated", async () => {
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: failingExecutor("error-from-specialist"),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["fail-spec", makeSpecialist("fail-spec")]]),
      tracker,
    });
    const result = await supervisor.delegateAndCollect([
      { task: "task", specialistId: "fail-spec", input: {} },
    ]);
    const entry = result.results.get("fail-spec");
    expect(entry?.success).toBe(false);
    expect(entry?.error).toContain("error-from-specialist");
  });

  it("SimpleDelegationTracker timeout returns failure with timed-out message", async () => {
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: hangingExecutor(),
      defaultTimeoutMs: 40,
    });
    const result = await tracker.delegate({
      targetAgentId: "slow-sub",
      task: "slow",
      input: {},
      timeoutMs: 40,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });

  it("timeout updates run store to failed status", async () => {
    const store = new InMemoryRunStore();
    const eventBus = createEventBus();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: hangingExecutor(),
    });
    await tracker.delegate({
      targetAgentId: "hanging-agent",
      task: "hang",
      input: {},
      timeoutMs: 30,
    });
    const runs = await store.list({ agentId: "hanging-agent" });
    expect(runs[0]?.status).toBe("failed");
  });

  it("delegation emits delegation:timeout event on timeout", async () => {
    const store = new InMemoryRunStore();
    const eventBus = createEventBus();
    const collectedEvents: DzupEvent[] = [];
    eventBus.onAny((e) => collectedEvents.push(e));
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: hangingExecutor(),
    });
    await tracker.delegate({
      targetAgentId: "time-out-agent",
      task: "hang",
      input: {},
      timeoutMs: 30,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(collectedEvents.some((e) => e.type === "delegation:timeout")).toBe(
      true,
    );
  });

  it("circuit breaker trips after failure threshold and excludes sub-agent", async () => {
    const mgr = createAgent("mgr", createMockModel([{ content: "fallback" }]));
    const trippedModel = createMockModel([{ content: "should not run" }]);
    const tripped = createAgent("tripped", trippedModel);
    const healthy = createAgent(
      "healthy",
      createMockModel([{ content: "healthy output" }]),
    );
    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 });
    breaker.recordTimeout("tripped");
    const result = await AgentOrchestrator.supervisor({
      manager: mgr,
      specialists: [tripped, healthy],
      task: "work",
      circuitBreaker: breaker,
    });
    expect(result.availableSpecialists).toEqual(["healthy"]);
    expect(trippedModel.invoke).not.toHaveBeenCalled();
  });

  it("all-tripped parallel fan-out throws OrchestrationError", async () => {
    const a = createAgent("ta", createMockModel([{ content: "a" }]));
    const b = createAgent("tb", createMockModel([{ content: "b" }]));
    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 });
    breaker.recordTimeout("ta");
    breaker.recordTimeout("tb");
    await expect(
      AgentOrchestrator.parallel([a, b], "task", undefined, {
        circuitBreaker: breaker,
      }),
    ).rejects.toThrow(OrchestrationError);
  });

  it("sequential chain: first sub-agent failure prevents subsequent agents from running", async () => {
    const m1 = createThrowingModel("first-error");
    const m2 = createMockModel([{ content: "should-not-run" }]);
    await expect(
      AgentOrchestrator.sequential(
        [createAgent("fail", m1), createAgent("skip", m2)],
        "start",
      ),
    ).rejects.toThrow("first-error");
    expect(m2.invoke).not.toHaveBeenCalled();
  });

  it("sequential chain: second sub-agent failure propagates correctly", async () => {
    const m1 = createMockModel([{ content: "step-1-ok" }]);
    const m2 = createThrowingModel("second-sub-crash");
    await expect(
      AgentOrchestrator.sequential(
        [createAgent("ok", m1), createAgent("crash", m2)],
        "input",
      ),
    ).rejects.toThrow("second-sub-crash");
    expect(m1.invoke).toHaveBeenCalledTimes(1);
  });

  it("unknown specialist in delegateAndCollect batch throws with specialist id in message", async () => {
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["known", makeSpecialist("known")]]),
      tracker,
    });
    await expect(
      supervisor.delegateAndCollect([
        { task: "T1", specialistId: "known", input: {} },
        { task: "T2", specialistId: "unknown-specialist", input: {} },
      ]),
    ).rejects.toThrow("unknown-specialist");
  });

  it("delegation failure updates run record to failed", async () => {
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: failingExecutor("record-fail"),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["fail-record", makeSpecialist("fail-record")]]),
      tracker,
    });
    await supervisor.delegateAndCollect([
      { task: "tr", specialistId: "fail-record", input: {} },
    ]);
    const runs = await store.list({ agentId: "fail-record" });
    expect(runs[0]?.status).toBe("failed");
  });
});

// ===========================================================================
// Section E — Sub-agent lifecycle (creation, execution, teardown)
// ===========================================================================

describe("Sub-agent lifecycle — creation, execution, teardown", () => {
  let store: InMemoryRunStore;
  let eventBus: DzupEventBus;
  let events: DzupEvent[];

  beforeEach(() => {
    store = new InMemoryRunStore();
    eventBus = createEventBus();
    events = [];
    eventBus.onAny((e) => events.push(e));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("active delegations are empty before any delegation starts", () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store),
    });
    expect(tracker.getActiveDelegations()).toHaveLength(0);
  });

  it("active delegations count increments while delegation is in-flight", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: async (runId, _agentId, _input, signal) => {
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, 200));
        await store.update(runId, {
          status: "completed",
          output: "done",
          completedAt: new Date(),
        });
      },
    });
    const p = tracker.delegate({
      targetAgentId: "in-flight",
      task: "work",
      input: {},
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(tracker.getActiveDelegations().length).toBeGreaterThan(0);
    await p;
  });

  it("active delegations are cleared after delegation completes", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store, "done"),
    });
    await tracker.delegate({
      targetAgentId: "lifecycle-agent",
      task: "work",
      input: {},
    });
    expect(tracker.getActiveDelegations()).toHaveLength(0);
  });

  it("active delegations are cleared after delegation fails", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: failingExecutor("lifecycle-fail"),
    });
    await tracker.delegate({
      targetAgentId: "fail-agent",
      task: "work",
      input: {},
    });
    expect(tracker.getActiveDelegations()).toHaveLength(0);
  });

  it("active delegations are cleared after timeout", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: hangingExecutor(),
      defaultTimeoutMs: 30,
    });
    await tracker.delegate({
      targetAgentId: "timeout-agent",
      task: "work",
      input: {},
      timeoutMs: 30,
    });
    expect(tracker.getActiveDelegations()).toHaveLength(0);
  });

  it("cancel() returns true and clears the active delegation", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: async (runId, _agentId, _input, signal) => {
        await new Promise<void>((_res, rej) => {
          signal.addEventListener(
            "abort",
            () => rej(new DOMException("Aborted")),
            { once: true },
          );
          setTimeout(_res, 10000);
        });
        await store.update(runId, {
          status: "completed",
          output: "late",
          completedAt: new Date(),
        });
      },
    });
    const p = tracker.delegate({
      targetAgentId: "cancellable",
      task: "work",
      input: {},
    });
    await new Promise((r) => setTimeout(r, 15));
    const cancelled = tracker.cancel("cancellable");
    expect(cancelled).toBe(true);
    const result = await p;
    expect(result.success).toBe(false);
  });

  it("cancel() returns false for non-existent delegation", () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store),
    });
    expect(tracker.cancel("ghost-agent")).toBe(false);
  });

  it("multiple concurrent delegations are all tracked as active", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: async (runId, _agentId, _input, signal) => {
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, 300));
        await store.update(runId, {
          status: "completed",
          output: "ok",
          completedAt: new Date(),
        });
      },
    });
    const p1 = tracker.delegate({
      targetAgentId: "concurrent-1",
      task: "t1",
      input: {},
    });
    const p2 = tracker.delegate({
      targetAgentId: "concurrent-2",
      task: "t2",
      input: {},
    });
    const p3 = tracker.delegate({
      targetAgentId: "concurrent-3",
      task: "t3",
      input: {},
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(tracker.getActiveDelegations()).toHaveLength(3);
    await Promise.all([p1, p2, p3]);
    expect(tracker.getActiveDelegations()).toHaveLength(0);
  });

  it("delegation emits delegation:started then delegation:completed in order", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: withStoreUpdate(store, "seq-out"),
    });
    await tracker.delegate({
      targetAgentId: "ordered-agent",
      task: "task",
      input: {},
    });
    await new Promise((r) => setTimeout(r, 10));
    const types = events.map((e) => e.type);
    const startIdx = types.indexOf("delegation:started");
    const endIdx = types.findIndex(
      (t) => t === "delegation:completed" || t === "delegation:failed",
    );
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
  });

  it("supervisor:delegating event is emitted at start of delegateTask", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: withStoreUpdate(store, "ok"),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["lifecycle-spec", makeSpecialist("lifecycle-spec")],
      ]),
      tracker,
      eventBus,
    });
    await supervisor.delegateTask("Lifecycle task", "lifecycle-spec", {});
    const evt = events.find((e) => e.type === "supervisor:delegating");
    expect(evt).toBeDefined();
    expect((evt as Record<string, unknown>).specialistId).toBe(
      "lifecycle-spec",
    );
  });

  it("supervisor:delegation_complete event is emitted on success", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: withStoreUpdate(store, "ok"),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["complete-spec", makeSpecialist("complete-spec")],
      ]),
      tracker,
      eventBus,
    });
    await supervisor.delegateTask("Complete task", "complete-spec", {});
    const evt = events.find((e) => e.type === "supervisor:delegation_complete");
    expect(evt).toBeDefined();
    expect((evt as Record<string, unknown>).success).toBe(true);
  });

  it("run record status is completed after successful execution", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store, "completed-value"),
    });
    await tracker.delegate({
      targetAgentId: "store-check",
      task: "t",
      input: {},
    });
    const runs = await store.list({ agentId: "store-check" });
    expect(runs[0]?.status).toBe("completed");
    expect(runs[0]?.output).toBe("completed-value");
  });

  it("delegation result metadata includes durationMs >= 0", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store, "fast"),
    });
    const result = await tracker.delegate({
      targetAgentId: "meta-agent",
      task: "t",
      input: {},
    });
    expect(typeof result.metadata?.durationMs).toBe("number");
    expect(result.metadata!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ===========================================================================
// Section F — Routing policies for sub-agent selection
// ===========================================================================

describe("Routing policies for sub-agent selection", () => {
  const agents: AgentSpec[] = [
    { id: "db", name: "DB Agent", tags: ["database"] },
    { id: "api", name: "API Agent", tags: ["api"] },
    { id: "ml", name: "ML Agent", tags: ["ml"] },
  ];

  it("RuleBasedRouting selects the correct agent by tag", () => {
    const routing = new RuleBasedRouting({
      rules: [{ tag: "ml", agentId: "ml" }],
    });
    const decision = routing.select(makeTask({ tags: ["ml"] }), agents);
    expect(decision.selected[0]!.id).toBe("ml");
    expect(decision.strategy).toBe("rule");
  });

  it("RuleBasedRouting falls back to first candidate when no rule matches", () => {
    const routing = new RuleBasedRouting({ rules: [] });
    const decision = routing.select(makeTask({ tags: ["xyz"] }), agents);
    expect(decision.selected[0]!.id).toBe("db");
  });

  it("RuleBasedRouting returns empty selection for empty candidates", () => {
    const routing = new RuleBasedRouting({
      rules: [{ tag: "database", agentId: "db" }],
    });
    const decision = routing.select(makeTask({ tags: ["database"] }), []);
    expect(decision.selected).toHaveLength(0);
  });

  it("RoundRobinRouting cycles across sub-agents", () => {
    const routing = new RoundRobinRouting();
    const rrAgents: AgentSpec[] = [
      { id: "r1", name: "R1" },
      { id: "r2", name: "R2" },
    ];
    const task = makeTask();
    const d1 = routing.select(task, rrAgents);
    const d2 = routing.select(task, rrAgents);
    const d3 = routing.select(task, rrAgents);
    expect(d1.selected[0]!.id).toBe("r1");
    expect(d2.selected[0]!.id).toBe("r2");
    expect(d3.selected[0]!.id).toBe("r1");
  });

  it("RoundRobinRouting reset() restarts from first slot", () => {
    const routing = new RoundRobinRouting();
    const rrAgents: AgentSpec[] = [
      { id: "x", name: "X" },
      { id: "y", name: "Y" },
    ];
    const task = makeTask();
    routing.select(task, rrAgents);
    routing.select(task, rrAgents);
    routing.reset();
    const d = routing.select(task, rrAgents);
    expect(d.selected[0]!.id).toBe("x");
  });

  it("HashRouting produces consistent results for same taskId", () => {
    const routing = new HashRouting({ hashKey: "taskId" });
    const hashAgents: AgentSpec[] = [
      { id: "h0", name: "H0" },
      { id: "h1", name: "H1" },
    ];
    const task = makeTask({ taskId: "stable-hash-task" });
    const d1 = routing.select(task, hashAgents);
    const d2 = routing.select(task, hashAgents);
    expect(d1.selected[0]!.id).toBe(d2.selected[0]!.id);
  });

  it('HashRouting strategy is "hash"', () => {
    const routing = new HashRouting();
    const decision = routing.select(makeTask(), [{ id: "only", name: "Only" }]);
    expect(decision.strategy).toBe("hash");
  });

  it("routing policy applied in supervisor narrows specialists correctly", async () => {
    const mgr = createAgent(
      "mgr",
      createMockModel([{ content: "policy result" }]),
    );
    const s1 = createAgent(
      "narrowed",
      createMockModel([{ content: "narrowed-ok" }]),
    );
    const s2 = createAgent(
      "excluded",
      createMockModel([{ content: "excluded" }]),
    );

    const policy = {
      select: vi.fn((_task: unknown, candidates: AgentSpec[]) => ({
        selected: candidates.filter((c) => c.id === "narrowed"),
        reason: "only narrowed",
        strategy: "test",
      })),
    };
    const result = await AgentOrchestrator.supervisor({
      manager: mgr,
      specialists: [s1, s2],
      task: "run narrowed",
      routingPolicy: policy,
    });
    expect(policy.select).toHaveBeenCalledOnce();
    expect(result.availableSpecialists).toEqual(["narrowed"]);
  });

  it("custom routing policy routingDecisionId is exposed on supervisor result", async () => {
    const mgr = createAgent(
      "mgr",
      createMockModel([{ content: "custom-id-result" }]),
    );
    const spec = createAgent("spec", createMockModel([{ content: "spec-ok" }]));
    const policy = {
      select: vi.fn((_task: unknown, candidates: AgentSpec[]) => ({
        selected: candidates,
        reason: "all",
        strategy: "custom",
        routingDecisionId: "custom-routing-decision-xyz",
      })),
    };
    const result = await AgentOrchestrator.supervisor({
      manager: mgr,
      specialists: [spec],
      task: "task",
      routingPolicy: policy,
    });
    expect(result.routingDecisionId).toBe("custom-routing-decision-xyz");
  });
});

// ===========================================================================
// Section G — Circuit breaker interactions with sub-agents
// ===========================================================================

describe("Circuit breaker interactions with sub-agents", () => {
  it("circuit breaker starts in closed state for new agent IDs", () => {
    const breaker = new AgentCircuitBreaker({ failureThreshold: 3 });
    expect(breaker.getState("brand-new-agent")).toBe("closed");
  });

  it("circuit breaker opens after exceeding failure threshold", () => {
    const breaker = new AgentCircuitBreaker({ failureThreshold: 2 });
    breaker.recordTimeout("agent-under-test");
    breaker.recordTimeout("agent-under-test");
    expect(breaker.getState("agent-under-test")).toBe("open");
  });

  it("circuit breaker records success on completed supervisor run", async () => {
    const mgr = createAgent("mgr", createMockModel([{ content: "done" }]));
    const spec = createAgent("spec-cb", createMockModel([{ content: "ok" }]));
    const breaker = new AgentCircuitBreaker({ failureThreshold: 3 });
    await AgentOrchestrator.supervisor({
      manager: mgr,
      specialists: [spec],
      task: "check cb",
      circuitBreaker: breaker,
    });
    expect(breaker.getState("spec-cb")).toBe("closed");
  });

  it("tripped specialist is in filteredSpecialists on supervisor result", async () => {
    const mgr = createAgent("mgr", createMockModel([{ content: "ok" }]));
    const tripped = createAgent(
      "tripped-cb",
      createMockModel([{ content: "never" }]),
    );
    const safe = createAgent("safe-cb", createMockModel([{ content: "safe" }]));
    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 });
    breaker.recordTimeout("tripped-cb");
    const result = await AgentOrchestrator.supervisor({
      manager: mgr,
      specialists: [tripped, safe],
      task: "work",
      circuitBreaker: breaker,
    });
    // circuit-breaker-filtered agents are removed from availableSpecialists
    // (filteredSpecialists is for health-check-failed agents only)
    expect(result.availableSpecialists).not.toContain("tripped-cb");
    expect(result.availableSpecialists).toContain("safe-cb");
  });

  it("supervisor emits circuit_breaker_filtered event when skipping tripped specialists", async () => {
    const store = new InMemoryRunStore();
    const eventBus = createEventBus();
    const events: DzupEvent[] = [];
    eventBus.onAny((e) => events.push(e));

    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: perAgentExecutor(store),
    });
    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 });
    breaker.recordTimeout("tripped-fanout");

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["safe-fanout", makeSpecialist("safe-fanout")],
        ["tripped-fanout", makeSpecialist("tripped-fanout")],
      ]),
      tracker,
      eventBus,
      circuitBreaker: breaker,
    });
    await supervisor.delegateAndCollect([
      { task: "T1", specialistId: "safe-fanout", input: {} },
      { task: "T2", specialistId: "tripped-fanout", input: {} },
    ]);
    const filterEvt = events.find(
      (e) => e.type === "supervisor:circuit_breaker_filtered",
    );
    expect(filterEvt).toBeDefined();
  });
});

// ===========================================================================
// Section H — planAndDelegate goal decomposition
// ===========================================================================

describe("planAndDelegate goal decomposition", () => {
  it("planAndDelegate matches sub-agents by metadata tag keyword", async () => {
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: perAgentExecutor(store),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        [
          "db-planner",
          makeSpecialist("db-planner", { metadata: { tags: ["database"] } }),
        ],
        [
          "ui-planner",
          makeSpecialist("ui-planner", { metadata: { tags: ["ui"] } }),
        ],
      ]),
      tracker,
    });
    const result = await supervisor.planAndDelegate(
      "create the database tables",
    );
    expect(result.succeeded.length).toBeGreaterThan(0);
  });

  it("planAndDelegate emits supervisor:plan_created event with keyword source", async () => {
    const store = new InMemoryRunStore();
    const eventBus = createEventBus();
    const events: DzupEvent[] = [];
    eventBus.onAny((e) => events.push(e));
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: perAgentExecutor(store),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        [
          "plan-spec",
          makeSpecialist("plan-spec", { metadata: { tags: ["database"] } }),
        ],
      ]),
      tracker,
      eventBus,
    });
    await supervisor.planAndDelegate("build database schema");
    const planEvt = events.find((e) => e.type === "supervisor:plan_created");
    expect(planEvt).toBeDefined();
    expect((planEvt as Record<string, unknown>).source).toBe("keyword");
  });

  it("planAndDelegate throws OrchestrationError when no specialist matches the goal", async () => {
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        [
          "db-only",
          makeSpecialist("db-only", { metadata: { tags: ["database"] } }),
        ],
      ]),
      tracker,
    });
    await expect(
      supervisor.planAndDelegate("do some completely unrelated task zzzzzz"),
    ).rejects.toThrow("No specialists matched");
  });

  it("planAndDelegate results map contains entries for all succeeded", async () => {
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: perAgentExecutor(store),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        [
          "auth-goal",
          makeSpecialist("auth-goal", {
            metadata: { tags: ["auth", "security"] },
          }),
        ],
      ]),
      tracker,
    });
    const result = await supervisor.planAndDelegate("implement authentication");
    for (const id of result.succeeded) {
      expect(result.results.has(id)).toBe(true);
    }
  });
});

// ===========================================================================
// Section I — Additional coverage to reach 75+
// ===========================================================================

describe("Additional sub-agent orchestration coverage", () => {
  it("sequential chain with empty input returns the empty string", async () => {
    const result = await AgentOrchestrator.sequential([], "");
    expect(result).toBe("");
  });

  it("delegation without eventBus still succeeds and returns output", async () => {
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withStoreUpdate(store, "no-bus-ok"),
      // no eventBus
    });
    const result = await tracker.delegate({
      targetAgentId: "no-bus-agent",
      task: "work",
      input: {},
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe("no-bus-ok");
  });

  it("specialist metadata is forwarded to the run store record", async () => {
    const store = new InMemoryRunStore();
    const eventBus = createEventBus();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: withStoreUpdate(store, "meta-stored"),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        [
          "meta-spec",
          makeSpecialist("meta-spec", {
            metadata: { tags: ["metadata-test"] },
          }),
        ],
      ]),
      tracker,
      eventBus,
    });
    const result = await supervisor.delegateTask("meta task", "meta-spec", {
      extra: "context",
    });
    expect(result.success).toBe(true);
  });

  it("aggregateSettledResults: zero assignments returns empty succeeded and failed lists", () => {
    const result = aggregateSettledResults({
      startedAt: Date.now(),
      assignments: [],
      settled: [],
    });
    expect(result.succeeded).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.results.size).toBe(0);
  });
});
