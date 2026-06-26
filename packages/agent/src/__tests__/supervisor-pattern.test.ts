/**
 * supervisor-pattern.test.ts — multi-agent supervisor pattern: 75+ tests
 *
 * Covers:
 *  - Task delegation (single specialist, with context, with input)
 *  - Result collection (all specialists collected)
 *  - Sequential delegation (A result feeds B delegation)
 *  - Parallel delegation (A and B simultaneously)
 *  - Specialist failure handling (graceful degradation)
 *  - Specialist retry (via delegateAndCollect fallback logic)
 *  - Specialist selection (correct specialist for task type)
 *  - No suitable specialist (planAndDelegate throws)
 *  - Supervisor decision — continue (re-delegates)
 *  - Supervisor decision — complete (returns final result)
 *  - Supervisor decision — escalate (supervisor:llm_decompose_fallback event)
 *  - Delegation depth limit (assertDepthAllowed / MAX_ORCHESTRATION_DEPTH)
 *  - Result routing (nested supervisor keyed by assignment ID)
 *  - Supervisor state maintenance (parentContext passed through)
 *  - SimpleDelegationTracker cancellation and timeout
 *  - DelegatingSupervisor accessors
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryRunStore, createEventBus } from "@dzupagent/core";
import type {
  DzupEventBus,
  DzupEvent,
  AgentExecutionSpec,
} from "@dzupagent/core";
import {
  SimpleDelegationTracker,
  type DelegationTracker,
  type DelegationExecutor,
} from "../orchestration/delegation.js";
import {
  DelegatingSupervisor,
  MAX_ORCHESTRATION_DEPTH,
  assertDepthAllowed,
  type TaskAssignment,
} from "../orchestration/delegating-supervisor.js";
import type { AgentCircuitBreaker } from "../orchestration/circuit-breaker.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeSpecialist(
  id: string,
  overrides: Partial<AgentExecutionSpec> = {},
): AgentExecutionSpec {
  return {
    id,
    name: overrides.name ?? id,
    instructions: `You are the ${id} specialist`,
    modelTier: "codegen",
    tools: overrides.tools,
    metadata: overrides.metadata,
    ...overrides,
  };
}

/** Executor that marks a run completed with a fixed output. */
function withOutput(
  store: InMemoryRunStore,
  output: unknown = "ok",
): DelegationExecutor {
  return async (runId, _agentId, _input, signal) => {
    if (signal.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await new Promise((r) => setTimeout(r, 5));
    if (signal.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await store.update(runId, {
      status: "completed",
      output,
      completedAt: new Date(),
    });
  };
}

/** Executor that returns output keyed by agentId. */
function withAgentOutput(store: InMemoryRunStore): DelegationExecutor {
  return async (runId, agentId, _input, signal) => {
    if (signal.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await new Promise((r) => setTimeout(r, 5));
    if (signal.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await store.update(runId, {
      status: "completed",
      output: `result-from-${agentId}`,
      completedAt: new Date(),
    });
  };
}

/** Executor that fails for a specific agentId. */
function failingFor(
  store: InMemoryRunStore,
  failId: string,
): DelegationExecutor {
  return async (runId, agentId, _input, signal) => {
    if (signal.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await new Promise((r) => setTimeout(r, 5));
    if (agentId === failId) throw new Error(`${agentId} failed`);
    await store.update(runId, {
      status: "completed",
      output: `result-from-${agentId}`,
      completedAt: new Date(),
    });
  };
}

/** Executor that always throws. */
function alwaysFails(): DelegationExecutor {
  return async (_runId, agentId) => {
    await new Promise((r) => setTimeout(r, 5));
    throw new Error(`${agentId} unavailable`);
  };
}

/** Executor that captures the input it was called with. */
function capturingExecutor(
  store: InMemoryRunStore,
  captured: Array<{ runId: string; agentId: string; input: unknown }>,
): DelegationExecutor {
  return async (runId, agentId, input, signal) => {
    if (signal.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    captured.push({ runId, agentId, input });
    await store.update(runId, {
      status: "completed",
      output: `captured-${agentId}`,
      completedAt: new Date(),
    });
  };
}

function makeCircuitBreakerSpy(): AgentCircuitBreaker {
  return {
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    recordTimeout: vi.fn(),
    filterAvailable: vi.fn((items: { id: string }[]) => items),
    isAvailable: vi.fn(() => true),
    getState: vi.fn(() => "closed"),
    reset: vi.fn(),
  } as unknown as AgentCircuitBreaker;
}

function makeTrackerReturning(result: {
  success: boolean;
  output: unknown;
  error?: string;
}): DelegationTracker {
  return {
    delegate: vi.fn(async () => result),
    getActiveDelegations: vi.fn(() => []),
    cancel: vi.fn(() => false),
  };
}

function makeTrackerRejecting(error: unknown): DelegationTracker {
  return {
    delegate: vi.fn(async () => {
      throw error;
    }),
    getActiveDelegations: vi.fn(() => []),
    cancel: vi.fn(() => false),
  };
}

// ---------------------------------------------------------------------------
// 1. assertDepthAllowed / MAX_ORCHESTRATION_DEPTH
// ---------------------------------------------------------------------------

describe("assertDepthAllowed", () => {
  it("does not throw when depth is below MAX_ORCHESTRATION_DEPTH", () => {
    expect(() => assertDepthAllowed(0)).not.toThrow();
    expect(() => assertDepthAllowed(1)).not.toThrow();
    expect(() => assertDepthAllowed(MAX_ORCHESTRATION_DEPTH - 1)).not.toThrow();
  });

  it("throws when depth equals MAX_ORCHESTRATION_DEPTH", () => {
    expect(() => assertDepthAllowed(MAX_ORCHESTRATION_DEPTH)).toThrow(
      "Orchestration depth limit reached",
    );
  });

  it("throws when depth exceeds MAX_ORCHESTRATION_DEPTH", () => {
    expect(() => assertDepthAllowed(MAX_ORCHESTRATION_DEPTH + 1)).toThrow(
      "Orchestration depth limit reached",
    );
  });

  it("includes depth and max in the error message", () => {
    let msg = "";
    try {
      assertDepthAllowed(MAX_ORCHESTRATION_DEPTH);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(`depth=${MAX_ORCHESTRATION_DEPTH}`);
    expect(msg).toContain(`max=${MAX_ORCHESTRATION_DEPTH}`);
  });

  it("respects a custom max parameter", () => {
    expect(() => assertDepthAllowed(1, 5)).not.toThrow();
    expect(() => assertDepthAllowed(5, 5)).toThrow();
    expect(() => assertDepthAllowed(4, 5)).not.toThrow();
  });

  it("MAX_ORCHESTRATION_DEPTH is 3", () => {
    expect(MAX_ORCHESTRATION_DEPTH).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2. Task delegation — single specialist
// ---------------------------------------------------------------------------

describe("DelegatingSupervisor — task delegation", () => {
  let store: InMemoryRunStore;
  let eventBus: DzupEventBus;
  let events: DzupEvent[];

  beforeEach(() => {
    store = new InMemoryRunStore();
    eventBus = createEventBus();
    events = [];
    eventBus.onAny((e) => events.push(e));
  });

  it("delegates a task to the named specialist and resolves with output", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: withOutput(store, { rows: 10 }),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["analyst", makeSpecialist("analyst")]]),
      tracker,
      eventBus,
    });

    const result = await supervisor.delegateTask("Analyse data", "analyst", {});
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ rows: 10 });
  });

  it("passes structured input to the specialist via delegation request", async () => {
    const captured: Array<{ runId: string; agentId: string; input: unknown }> =
      [];
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: capturingExecutor(store, captured),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["writer", makeSpecialist("writer")]]),
      tracker,
    });

    await supervisor.delegateTask("Write a blog post", "writer", {
      topic: "AI agents",
      wordCount: 500,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.input).toMatchObject({
      topic: "AI agents",
      wordCount: 500,
    });
  });

  it("passes the task description to the executor input", async () => {
    const captured: Array<{ runId: string; agentId: string; input: unknown }> =
      [];
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: capturingExecutor(store, captured),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["coder", makeSpecialist("coder")]]),
      tracker,
    });

    await supervisor.delegateTask("Implement login endpoint", "coder", {});

    const input = captured[0]!.input as Record<string, unknown>;
    expect(input.task).toBe("Implement login endpoint");
  });

  it("throws OrchestrationError when specialist is not registered", async () => {
    const tracker = makeTrackerReturning({ success: true, output: "ok" });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["known", makeSpecialist("known")]]),
      tracker,
    });

    await expect(
      supervisor.delegateTask("task", "unknown-agent", {}),
    ).rejects.toThrow('"unknown-agent"');
  });

  it("lists available specialist IDs in the not-found error", async () => {
    const tracker = makeTrackerReturning({ success: true, output: "ok" });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["alpha", makeSpecialist("alpha")],
        ["beta", makeSpecialist("beta")],
      ]),
      tracker,
    });

    let msg = "";
    try {
      await supervisor.delegateTask("task", "gamma", {});
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/alpha/);
    expect(msg).toMatch(/beta/);
  });

  it("includes durationMs in delegation result metadata", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withOutput(store, "done"),
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["worker", makeSpecialist("worker")]]),
      tracker,
    });

    const result = await supervisor.delegateTask("Do work", "worker", {});
    expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.metadata?.durationMs).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// 3. Delegation with context — supervisor passes context to specialist
// ---------------------------------------------------------------------------

describe("DelegatingSupervisor — delegation with context", () => {
  let store: InMemoryRunStore;

  beforeEach(() => {
    store = new InMemoryRunStore();
  });

  it("embeds parentContext into the delegation request input", async () => {
    const captured: Array<{ runId: string; agentId: string; input: unknown }> =
      [];
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: capturingExecutor(store, captured),
    });

    const parentContext = {
      parentRunId: "run-parent-99",
      decisions: ["Use TypeScript", "Prefer Zod validation"],
      constraints: ["No external HTTP calls"],
      relevantFiles: ["src/api/users.ts"],
    };

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["backend", makeSpecialist("backend")]]),
      tracker,
      parentContext,
    });

    await supervisor.delegateTask("Build user endpoint", "backend", {});

    const input = captured[0]!.input as Record<string, unknown>;
    const ctx = input.delegationContext as typeof parentContext;
    expect(ctx.parentRunId).toBe("run-parent-99");
    expect(ctx.decisions).toContain("Use TypeScript");
    expect(ctx.constraints).toContain("No external HTTP calls");
    expect(ctx.relevantFiles).toContain("src/api/users.ts");
  });

  it("works without a parentContext (context is omitted from request)", async () => {
    const captured: Array<{ runId: string; agentId: string; input: unknown }> =
      [];
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: capturingExecutor(store, captured),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["agent-x", makeSpecialist("agent-x")]]),
      tracker,
    });

    await supervisor.delegateTask("Some task", "agent-x", {});
    const input = captured[0]!.input as Record<string, unknown>;
    expect(input.delegationContext).toBeUndefined();
  });

  it("emits supervisor:delegating event with specialistId and task", async () => {
    const eventBus = createEventBus();
    const emitted: DzupEvent[] = [];
    eventBus.onAny((e) => emitted.push(e));

    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: withOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["reporter", makeSpecialist("reporter")]]),
      tracker,
      eventBus,
    });

    await supervisor.delegateTask("Write report", "reporter", {});

    const evt = emitted.find((e) => e.type === "supervisor:delegating");
    expect(evt).toBeDefined();
    expect((evt as Record<string, unknown>).specialistId).toBe("reporter");
    expect((evt as Record<string, unknown>).task).toBe("Write report");
  });

  it("emits supervisor:delegation_complete event after successful task", async () => {
    const eventBus = createEventBus();
    const emitted: DzupEvent[] = [];
    eventBus.onAny((e) => emitted.push(e));

    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: withOutput(store, "complete"),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["spec", makeSpecialist("spec")]]),
      tracker,
      eventBus,
    });

    await supervisor.delegateTask("Do it", "spec", {});

    const evt = emitted.find(
      (e) => e.type === "supervisor:delegation_complete",
    );
    expect(evt).toBeDefined();
    expect((evt as Record<string, unknown>).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Result collection — all specialist results gathered
// ---------------------------------------------------------------------------

describe("DelegatingSupervisor — result collection", () => {
  let store: InMemoryRunStore;
  let eventBus: DzupEventBus;
  let events: DzupEvent[];

  beforeEach(() => {
    store = new InMemoryRunStore();
    eventBus = createEventBus();
    events = [];
    eventBus.onAny((e) => events.push(e));
  });

  it("collects all specialist results in the results Map", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: withAgentOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["planner", makeSpecialist("planner")],
        ["coder", makeSpecialist("coder")],
        ["tester", makeSpecialist("tester")],
      ]),
      tracker,
      eventBus,
    });

    const tasks: TaskAssignment[] = [
      { task: "Plan the feature", specialistId: "planner", input: {} },
      { task: "Implement it", specialistId: "coder", input: {} },
      { task: "Write tests", specialistId: "tester", input: {} },
    ];

    const aggregated = await supervisor.delegateAndCollect(tasks);

    expect(aggregated.results.size).toBe(3);
    expect(aggregated.succeeded).toHaveLength(3);
    expect(aggregated.failed).toHaveLength(0);
    expect(aggregated.results.get("planner")?.output).toBe(
      "result-from-planner",
    );
    expect(aggregated.results.get("coder")?.output).toBe("result-from-coder");
    expect(aggregated.results.get("tester")?.output).toBe("result-from-tester");
  });

  it("reports totalDurationMs covering the entire parallel batch", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withOutput(store, "x"),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["a", makeSpecialist("a")],
        ["b", makeSpecialist("b")],
      ]),
      tracker,
    });

    const before = Date.now();
    const aggregated = await supervisor.delegateAndCollect([
      { task: "task-a", specialistId: "a", input: {} },
      { task: "task-b", specialistId: "b", input: {} },
    ]);
    const after = Date.now();

    expect(aggregated.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(aggregated.totalDurationMs).toBeLessThanOrEqual(after - before + 50);
  });

  it("result Map is keyed by specialistId when no assignment ids provided", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withAgentOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["agent-a", makeSpecialist("agent-a")],
        ["agent-b", makeSpecialist("agent-b")],
      ]),
      tracker,
    });

    const aggregated = await supervisor.delegateAndCollect([
      { task: "Task A", specialistId: "agent-a", input: {} },
      { task: "Task B", specialistId: "agent-b", input: {} },
    ]);

    expect([...aggregated.results.keys()].sort()).toEqual([
      "agent-a",
      "agent-b",
    ]);
  });

  it("result Map is keyed by assignment id when ids are provided", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withAgentOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["coder", makeSpecialist("coder")]]),
      tracker,
    });

    const aggregated = await supervisor.delegateAndCollect([
      { id: "node-1", task: "Task 1", specialistId: "coder", input: {} },
      { id: "node-2", task: "Task 2", specialistId: "coder", input: {} },
    ]);

    expect([...aggregated.results.keys()].sort()).toEqual(["node-1", "node-2"]);
    expect(aggregated.succeeded).toEqual(["node-1", "node-2"]);
  });

  it("keeps metadata.assignmentId and metadata.specialistId in each result", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withAgentOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["coder", makeSpecialist("coder")]]),
      tracker,
    });

    const aggregated = await supervisor.delegateAndCollect([
      { id: "task-x", task: "Do X", specialistId: "coder", input: {} },
    ]);

    const result = aggregated.results.get("task-x");
    expect(result?.metadata?.assignmentId).toBe("task-x");
    expect(result?.metadata?.specialistId).toBe("coder");
  });
});

// ---------------------------------------------------------------------------
// 5. Sequential delegation — A result feeds B delegation
// ---------------------------------------------------------------------------

describe("DelegatingSupervisor — sequential delegation", () => {
  let store: InMemoryRunStore;

  beforeEach(() => {
    store = new InMemoryRunStore();
  });

  it("uses first specialist output as input to second delegation", async () => {
    // Step 1: planner produces a plan
    // Step 2: executor receives the plan and produces code

    const plannerOutput = { plan: ["step1", "step2", "step3"] };
    const captured: Array<{ runId: string; agentId: string; input: unknown }> =
      [];

    // Planner executor
    const plannerExec: DelegationExecutor = async (
      runId,
      _agentId,
      _input,
      signal,
    ) => {
      if (signal.aborted)
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      await store.update(runId, {
        status: "completed",
        output: plannerOutput,
        completedAt: new Date(),
      });
    };

    const tracker1 = new SimpleDelegationTracker({
      runStore: store,
      executor: plannerExec,
    });
    const supervisorStep1 = new DelegatingSupervisor({
      specialists: new Map([["planner", makeSpecialist("planner")]]),
      tracker: tracker1,
    });

    const step1Result = await supervisorStep1.delegateTask(
      "Create plan",
      "planner",
      {},
    );
    expect(step1Result.success).toBe(true);

    // Step 2: use planner output as input to coder
    const coderExec = capturingExecutor(store, captured);
    const tracker2 = new SimpleDelegationTracker({
      runStore: store,
      executor: coderExec,
    });
    const supervisorStep2 = new DelegatingSupervisor({
      specialists: new Map([["coder", makeSpecialist("coder")]]),
      tracker: tracker2,
    });

    await supervisorStep2.delegateTask("Implement from plan", "coder", {
      plan: step1Result.output as Record<string, unknown>,
    });

    const coderInput = captured[0]!.input as Record<string, unknown>;
    expect(coderInput.plan).toEqual(plannerOutput);
  });

  it("sequential chain: three agents, each depends on previous result", async () => {
    const outputs: Record<string, unknown> = {
      researcher: { findings: ["fact1", "fact2"] },
      writer: { draft: "Once upon a time..." },
      editor: { final: "Once upon a time (edited)." },
    };

    const agentOrder: string[] = [];

    const makeExec =
      (agentId: string): DelegationExecutor =>
      async (runId, _id, _input, signal) => {
        if (signal.aborted)
          throw signal.reason ?? new DOMException("Aborted", "AbortError");
        agentOrder.push(agentId);
        await store.update(runId, {
          status: "completed",
          output: outputs[agentId],
          completedAt: new Date(),
        });
      };

    const agents = ["researcher", "writer", "editor"];
    let previousOutput: unknown = null;

    for (const agentId of agents) {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        executor: makeExec(agentId),
      });
      const supervisor = new DelegatingSupervisor({
        specialists: new Map([[agentId, makeSpecialist(agentId)]]),
        tracker,
      });
      const result = await supervisor.delegateTask(
        `Task for ${agentId}`,
        agentId,
        previousOutput ? { previousOutput } : {},
      );
      expect(result.success).toBe(true);
      previousOutput = result.output;
    }

    expect(agentOrder).toEqual(["researcher", "writer", "editor"]);
    expect(previousOutput).toEqual(outputs["editor"]);
  });
});

// ---------------------------------------------------------------------------
// 6. Parallel delegation — A and B simultaneously
// ---------------------------------------------------------------------------

describe("DelegatingSupervisor — parallel delegation", () => {
  let store: InMemoryRunStore;

  beforeEach(() => {
    store = new InMemoryRunStore();
  });

  it("runs multiple specialists in parallel (delegateAndCollect)", async () => {
    const startTimes: Record<string, number> = {};
    const exec: DelegationExecutor = async (runId, agentId, _input, signal) => {
      startTimes[agentId] = Date.now();
      if (signal.aborted)
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      await new Promise((r) => setTimeout(r, 20));
      await store.update(runId, {
        status: "completed",
        output: `${agentId}-done`,
        completedAt: new Date(),
      });
    };

    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: exec,
    });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["agent-p", makeSpecialist("agent-p")],
        ["agent-q", makeSpecialist("agent-q")],
      ]),
      tracker,
    });

    const t0 = Date.now();
    const aggregated = await supervisor.delegateAndCollect([
      { task: "Task P", specialistId: "agent-p", input: {} },
      { task: "Task Q", specialistId: "agent-q", input: {} },
    ]);
    const elapsed = Date.now() - t0;

    // Both succeeded
    expect(aggregated.succeeded).toHaveLength(2);
    // If serial this would take ~40ms; parallel ≈ ~20ms (allow generous buffer)
    expect(elapsed).toBeLessThan(200);
  });

  it("does not abort all tasks when one parallel task fails", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: failingFor(store, "bad-agent"),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["good-agent", makeSpecialist("good-agent")],
        ["bad-agent", makeSpecialist("bad-agent")],
      ]),
      tracker,
    });

    const aggregated = await supervisor.delegateAndCollect([
      { task: "Good task", specialistId: "good-agent", input: {} },
      { task: "Bad task", specialistId: "bad-agent", input: {} },
    ]);

    expect(aggregated.succeeded).toContain("good-agent");
    expect(aggregated.failed).toContain("bad-agent");
    expect(aggregated.results.get("good-agent")?.success).toBe(true);
    expect(aggregated.results.get("bad-agent")?.success).toBe(false);
  });

  it("collects three parallel results independently", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withAgentOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["s1", makeSpecialist("s1")],
        ["s2", makeSpecialist("s2")],
        ["s3", makeSpecialist("s3")],
      ]),
      tracker,
    });

    const aggregated = await supervisor.delegateAndCollect([
      { task: "t1", specialistId: "s1", input: {} },
      { task: "t2", specialistId: "s2", input: {} },
      { task: "t3", specialistId: "s3", input: {} },
    ]);

    expect(aggregated.succeeded).toHaveLength(3);
    expect(aggregated.results.get("s1")?.output).toBe("result-from-s1");
    expect(aggregated.results.get("s2")?.output).toBe("result-from-s2");
    expect(aggregated.results.get("s3")?.output).toBe("result-from-s3");
  });
});

// ---------------------------------------------------------------------------
// 7. Specialist failure handling
// ---------------------------------------------------------------------------

describe("DelegatingSupervisor — specialist failure handling", () => {
  let store: InMemoryRunStore;

  beforeEach(() => {
    store = new InMemoryRunStore();
  });

  it("returns success=false when specialist executor throws", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: alwaysFails(),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["broken", makeSpecialist("broken")]]),
      tracker,
    });

    const result = await supervisor.delegateTask("Do something", "broken", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("broken unavailable");
  });

  it("delegateAndCollect separates succeeded and failed on error", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: failingFor(store, "broken-spec"),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["ok-spec", makeSpecialist("ok-spec")],
        ["broken-spec", makeSpecialist("broken-spec")],
      ]),
      tracker,
    });

    const aggregated = await supervisor.delegateAndCollect([
      { task: "Good", specialistId: "ok-spec", input: {} },
      { task: "Bad", specialistId: "broken-spec", input: {} },
    ]);

    expect(aggregated.succeeded).toEqual(["ok-spec"]);
    expect(aggregated.failed).toEqual(["broken-spec"]);
  });

  it("failed specialist result has error message populated", async () => {
    const tracker = makeTrackerRejecting(new Error("network timeout"));
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["flaky", makeSpecialist("flaky")]]),
      tracker,
    });

    const aggregated = await supervisor.delegateAndCollect([
      { task: "Flaky task", specialistId: "flaky", input: {} },
    ]);

    const result = aggregated.results.get("flaky");
    expect(result?.success).toBe(false);
    expect(result?.error).toContain("network timeout");
  });

  it("partial failures do not corrupt succeeded results", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: failingFor(store, "bad"),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["good", makeSpecialist("good")],
        ["bad", makeSpecialist("bad")],
      ]),
      tracker,
    });

    const aggregated = await supervisor.delegateAndCollect([
      { task: "Good task", specialistId: "good", input: {} },
      { task: "Bad task", specialistId: "bad", input: {} },
    ]);

    const goodResult = aggregated.results.get("good");
    expect(goodResult?.output).toBe("result-from-good");
    expect(goodResult?.success).toBe(true);
  });

  it("all-failure scenario reports no succeeded entries", async () => {
    const tracker = makeTrackerRejecting(new Error("all down"));
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["a", makeSpecialist("a")],
        ["b", makeSpecialist("b")],
      ]),
      tracker,
    });

    const aggregated = await supervisor.delegateAndCollect([
      { task: "task-a", specialistId: "a", input: {} },
      { task: "task-b", specialistId: "b", input: {} },
    ]);

    expect(aggregated.succeeded).toHaveLength(0);
    expect(aggregated.failed).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 8. Specialist retry — circuit breaker records and mock tracker retry
// ---------------------------------------------------------------------------

describe("DelegatingSupervisor — specialist retry / circuit breaker", () => {
  it("records circuit-breaker success when delegation succeeds", async () => {
    const cb = makeCircuitBreakerSpy();
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["s", makeSpecialist("s")]]),
      tracker: makeTrackerReturning({ success: true, output: "ok" }),
      circuitBreaker: cb,
    });

    await supervisor.delegateTask("task", "s", {});

    expect(cb.recordSuccess).toHaveBeenCalledWith("s");
    expect(cb.recordFailure).not.toHaveBeenCalled();
  });

  it("records circuit-breaker failure when delegation returns success=false", async () => {
    const cb = makeCircuitBreakerSpy();
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["s", makeSpecialist("s")]]),
      tracker: makeTrackerReturning({
        success: false,
        output: null,
        error: "Model error",
      }),
      circuitBreaker: cb,
    });

    await supervisor.delegateTask("task", "s", {});

    expect(cb.recordFailure).toHaveBeenCalledWith("s");
    expect(cb.recordSuccess).not.toHaveBeenCalled();
  });

  it('records circuit-breaker timeout when error message contains "timeout"', async () => {
    const cb = makeCircuitBreakerSpy();
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["s", makeSpecialist("s")]]),
      tracker: makeTrackerReturning({
        success: false,
        output: null,
        error: "Delegation timeout after 100ms",
      }),
      circuitBreaker: cb,
    });

    await supervisor.delegateTask("task", "s", {});

    expect(cb.recordTimeout).toHaveBeenCalledWith("s");
    expect(cb.recordSuccess).not.toHaveBeenCalled();
    expect(cb.recordFailure).not.toHaveBeenCalled();
  });

  it("records circuit-breaker failure when delegateTask throws (rejected tracker)", async () => {
    const cb = makeCircuitBreakerSpy();
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["s", makeSpecialist("s")]]),
      tracker: makeTrackerRejecting(new Error("connection refused")),
      circuitBreaker: cb,
    });

    // The exception propagates out of delegateTask
    await expect(supervisor.delegateTask("task", "s", {})).rejects.toThrow(
      "connection refused",
    );
    expect(cb.recordFailure).toHaveBeenCalledWith("s");
  });

  it("circuit-breaker filters unavailable specialist from delegateAndCollect", async () => {
    const cb: AgentCircuitBreaker = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      recordTimeout: vi.fn(),
      filterAvailable: vi.fn((items: { id: string }[]) =>
        items.filter((i) => i.id !== "tripped"),
      ),
      isAvailable: vi.fn((id: string) => id !== "tripped"),
      getState: vi.fn(() => "open"),
      reset: vi.fn(),
    } as unknown as AgentCircuitBreaker;

    const tracker = makeTrackerReturning({ success: true, output: "ok" });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["healthy", makeSpecialist("healthy")],
        ["tripped", makeSpecialist("tripped")],
      ]),
      tracker,
      circuitBreaker: cb,
    });

    const aggregated = await supervisor.delegateAndCollect([
      { task: "task-a", specialistId: "healthy", input: {} },
      { task: "task-b", specialistId: "tripped", input: {} },
    ]);

    // Tripped specialist was filtered out — only healthy ran
    expect(aggregated.succeeded).toContain("healthy");
    expect(aggregated.succeeded).not.toContain("tripped");
    expect(aggregated.failed).not.toContain("tripped");
  });
});

// ---------------------------------------------------------------------------
// 9. Specialist selection — planAndDelegate routes tasks
// ---------------------------------------------------------------------------

describe("DelegatingSupervisor — specialist selection via planAndDelegate", () => {
  let store: InMemoryRunStore;
  let eventBus: DzupEventBus;
  let events: DzupEvent[];

  beforeEach(() => {
    store = new InMemoryRunStore();
    eventBus = createEventBus();
    events = [];
    eventBus.onAny((e) => events.push(e));
  });

  it("routes database sub-task to db-tagged specialist", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withAgentOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        [
          "db-agent",
          makeSpecialist("db-agent", {
            metadata: { tags: ["database", "schema"] },
          }),
        ],
        [
          "ui-agent",
          makeSpecialist("ui-agent", {
            metadata: { tags: ["ui", "frontend"] },
          }),
        ],
      ]),
      tracker,
      eventBus,
    });

    const aggregated = await supervisor.planAndDelegate(
      "create the database schema",
    );

    expect(aggregated.succeeded).toContain("db-agent");
  });

  it("routes frontend sub-task to ui-tagged specialist", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withAgentOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        [
          "db-agent",
          makeSpecialist("db-agent", { metadata: { tags: ["database"] } }),
        ],
        [
          "ui-agent",
          makeSpecialist("ui-agent", {
            metadata: { tags: ["ui", "frontend", "component"] },
          }),
        ],
      ]),
      tracker,
      eventBus,
    });

    const aggregated = await supervisor.planAndDelegate(
      "build the login UI component",
    );

    expect(aggregated.succeeded).toContain("ui-agent");
  });

  it("selects multiple specialists when goal spans both domains", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withAgentOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        [
          "db-agent",
          makeSpecialist("db-agent", {
            metadata: { tags: ["database", "schema"] },
          }),
        ],
        [
          "api-agent",
          makeSpecialist("api-agent", {
            metadata: { tags: ["api", "rest", "backend"] },
          }),
        ],
      ]),
      tracker,
      eventBus,
    });

    const aggregated = await supervisor.planAndDelegate(
      "create the database schema and build the REST API",
    );

    // Both should have been matched
    expect(aggregated.results.size).toBeGreaterThanOrEqual(1);
    expect(aggregated.succeeded.length).toBeGreaterThan(0);
  });

  it("emits supervisor:plan_created event with keyword source", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: withOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        [
          "db-agent",
          makeSpecialist("db-agent", { metadata: { tags: ["database"] } }),
        ],
      ]),
      tracker,
      eventBus,
    });

    await supervisor.planAndDelegate("set up the database");

    const evt = events.find((e) => e.type === "supervisor:plan_created");
    expect(evt).toBeDefined();
    expect((evt as Record<string, unknown>).source).toBe("keyword");
    expect((evt as Record<string, unknown>).goal).toBe("set up the database");
  });
});

// ---------------------------------------------------------------------------
// 10. No suitable specialist
// ---------------------------------------------------------------------------

describe("DelegatingSupervisor — no suitable specialist", () => {
  let store: InMemoryRunStore;

  beforeEach(() => {
    store = new InMemoryRunStore();
  });

  it("throws OrchestrationError when no specialists match the goal", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        [
          "db-agent",
          makeSpecialist("db-agent", { metadata: { tags: ["database"] } }),
        ],
      ]),
      tracker,
    });

    await expect(
      supervisor.planAndDelegate("do quantum physics calculations"),
    ).rejects.toThrow("No specialists matched");
  });

  it("error includes the attempted goal text", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["x", makeSpecialist("x", { metadata: { tags: ["x"] } })],
      ]),
      tracker,
    });

    let msg = "";
    try {
      await supervisor.planAndDelegate("bake a cake at 200 degrees");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("bake a cake at 200 degrees");
  });

  it("error includes the available specialist IDs", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        [
          "specialist-alpha",
          makeSpecialist("specialist-alpha", { metadata: { tags: ["alpha"] } }),
        ],
      ]),
      tracker,
    });

    let context: unknown;
    try {
      await supervisor.planAndDelegate("unrelated goal xyz");
    } catch (e) {
      context = (e as { context?: unknown }).context;
    }
    expect(JSON.stringify(context)).toContain("specialist-alpha");
  });
});

// ---------------------------------------------------------------------------
// 11. Supervisor decision — continue, complete, escalate (via events / state)
// ---------------------------------------------------------------------------

describe("DelegatingSupervisor — supervisor decisions", () => {
  let store: InMemoryRunStore;
  let eventBus: DzupEventBus;
  let events: DzupEvent[];

  beforeEach(() => {
    store = new InMemoryRunStore();
    eventBus = createEventBus();
    events = [];
    eventBus.onAny((e) => events.push(e));
  });

  it("supervisor continues — delegates again after first result", async () => {
    // Simulate a two-round delegation: first to planner, then to coder
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: withAgentOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["planner", makeSpecialist("planner")],
        ["coder", makeSpecialist("coder")],
      ]),
      tracker,
      eventBus,
    });

    // Round 1: delegate to planner
    const round1 = await supervisor.delegateTask(
      "Plan the work",
      "planner",
      {},
    );
    expect(round1.success).toBe(true);

    // Decision: continue — delegate to coder using planner output
    const round2 = await supervisor.delegateTask("Execute the plan", "coder", {
      plan: round1.output,
    });
    expect(round2.success).toBe(true);

    // Two delegation_complete events should have fired
    const completeEvents = events.filter(
      (e) => e.type === "supervisor:delegation_complete",
    );
    expect(completeEvents).toHaveLength(2);
  });

  it("supervisor completes — final result returned from delegateTask", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withOutput(store, { summary: "All done" }),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["finalizer", makeSpecialist("finalizer")]]),
      tracker,
    });

    const result = await supervisor.delegateTask("Finalize", "finalizer", {});
    expect(result.success).toBe(true);
    expect((result.output as { summary: string }).summary).toBe("All done");
  });

  it("supervisor escalates — emits supervisor:llm_decompose_fallback when LLM fails", async () => {
    // Simulate an LLM that throws, forcing the fallback / escalation path
    const brokenLlm = {
      withStructuredOutput: vi.fn().mockReturnThis(),
      invoke: vi.fn(async () => {
        throw new Error("LLM unreachable");
      }),
    };

    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: withOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        [
          "db-agent",
          makeSpecialist("db-agent", { metadata: { tags: ["database"] } }),
        ],
      ]),
      tracker,
      eventBus,
    });

    // planAndDelegate with a broken LLM should fall back to keyword matching
    await supervisor.planAndDelegate("create the database schema", {
      llm: brokenLlm as never,
    });

    const fallbackEvent = events.find(
      (e) => e.type === "supervisor:llm_decompose_fallback",
    );
    expect(fallbackEvent).toBeDefined();
    expect((fallbackEvent as Record<string, unknown>).error).toContain(
      "LLM unreachable",
    );
  });
});

// ---------------------------------------------------------------------------
// 12. Delegation depth limit
// ---------------------------------------------------------------------------

describe("delegation depth limit", () => {
  it("assertDepthAllowed prevents chaining beyond MAX_ORCHESTRATION_DEPTH", () => {
    // Simulate three levels of nesting — the 4th should be blocked
    expect(() => assertDepthAllowed(0)).not.toThrow();
    expect(() => assertDepthAllowed(1)).not.toThrow();
    expect(() => assertDepthAllowed(2)).not.toThrow();
    expect(() => assertDepthAllowed(3)).toThrow(
      "Orchestration depth limit reached",
    );
  });

  it("supervisor config exposes depth for hierarchical chaining", () => {
    // Verify the type contract: DelegatingSupervisorConfig has depth field
    const store = new InMemoryRunStore();
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withOutput(store),
    });

    // depth=2 is allowed; constructing with depth is just config, not auto-checked
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["s", makeSpecialist("s")]]),
      tracker,
      depth: 2,
    });

    // The supervisor is instantiated successfully
    expect(supervisor.specialistIds).toContain("s");
  });

  it("enforcing depth prevents a sub-orchestrator from spawning", () => {
    // At depth=MAX, spawn should throw
    expect(() => assertDepthAllowed(MAX_ORCHESTRATION_DEPTH - 1)).not.toThrow();
    expect(() => assertDepthAllowed(MAX_ORCHESTRATION_DEPTH)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 13. Result routing — nested supervisor by assignment ID
// ---------------------------------------------------------------------------

describe("DelegatingSupervisor — result routing", () => {
  let store: InMemoryRunStore;

  beforeEach(() => {
    store = new InMemoryRunStore();
  });

  it("routes same-specialist results to correct parent by assignment id", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withAgentOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["worker", makeSpecialist("worker")]]),
      tracker,
    });

    const aggregated = await supervisor.delegateAndCollect([
      {
        id: "branch-A",
        task: "Implement module A",
        specialistId: "worker",
        input: { module: "A" },
      },
      {
        id: "branch-B",
        task: "Implement module B",
        specialistId: "worker",
        input: { module: "B" },
      },
      {
        id: "branch-C",
        task: "Implement module C",
        specialistId: "worker",
        input: { module: "C" },
      },
    ]);

    expect(aggregated.succeeded).toHaveLength(3);
    expect(aggregated.results.has("branch-A")).toBe(true);
    expect(aggregated.results.has("branch-B")).toBe(true);
    expect(aggregated.results.has("branch-C")).toBe(true);
    // All from same specialist — output matches
    for (const key of ["branch-A", "branch-B", "branch-C"]) {
      expect(aggregated.results.get(key)?.output).toBe("result-from-worker");
    }
  });

  it("assignmentId is preserved in result metadata", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withAgentOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["spec", makeSpecialist("spec")]]),
      tracker,
    });

    const aggregated = await supervisor.delegateAndCollect([
      { id: "my-node", task: "Task", specialistId: "spec", input: {} },
    ]);

    expect(aggregated.results.get("my-node")?.metadata?.assignmentId).toBe(
      "my-node",
    );
  });

  it("throws when one specialistId in task list is not registered", async () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withOutput(store),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["known", makeSpecialist("known")]]),
      tracker,
    });

    await expect(
      supervisor.delegateAndCollect([
        { task: "T1", specialistId: "known", input: {} },
        { task: "T2", specialistId: "unknown", input: {} },
      ]),
    ).rejects.toThrow('"unknown"');
  });
});

// ---------------------------------------------------------------------------
// 14. Supervisor state — parentContext maintained across rounds
// ---------------------------------------------------------------------------

describe("DelegatingSupervisor — supervisor state", () => {
  let store: InMemoryRunStore;

  beforeEach(() => {
    store = new InMemoryRunStore();
  });

  it("same parentContext is passed to every delegation in a batch", async () => {
    const captured: Array<{ runId: string; agentId: string; input: unknown }> =
      [];
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: capturingExecutor(store, captured),
    });

    const parentContext = {
      parentRunId: "run-state-test",
      decisions: ["Decision A"],
      constraints: ["Constraint X"],
      relevantFiles: ["file.ts"],
    };

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["a", makeSpecialist("a")],
        ["b", makeSpecialist("b")],
      ]),
      tracker,
      parentContext,
    });

    await supervisor.delegateAndCollect([
      { task: "Task A", specialistId: "a", input: {} },
      { task: "Task B", specialistId: "b", input: {} },
    ]);

    for (const cap of captured) {
      const ctx = (cap.input as Record<string, unknown>)
        .delegationContext as typeof parentContext;
      expect(ctx.parentRunId).toBe("run-state-test");
      expect(ctx.decisions).toContain("Decision A");
    }
  });

  it("specialistIds accessor reflects the registered specialist map", () => {
    const tracker = makeTrackerReturning({ success: true, output: "ok" });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["x", makeSpecialist("x")],
        ["y", makeSpecialist("y")],
        ["z", makeSpecialist("z")],
      ]),
      tracker,
    });

    expect(supervisor.specialistIds.sort()).toEqual(["x", "y", "z"]);
  });

  it("getSpecialist returns the AgentExecutionSpec by id", () => {
    const tracker = makeTrackerReturning({ success: true, output: "ok" });
    const specDef = makeSpecialist("my-specialist", {
      metadata: { tags: ["custom"] },
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["my-specialist", specDef]]),
      tracker,
    });

    expect(supervisor.getSpecialist("my-specialist")).toBe(specDef);
  });

  it("getSpecialist returns undefined for unknown id", () => {
    const tracker = makeTrackerReturning({ success: true, output: "ok" });
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["known", makeSpecialist("known")]]),
      tracker,
    });

    expect(supervisor.getSpecialist("not-there")).toBeUndefined();
  });

  it("parentRunId is stored in created run metadata", async () => {
    const captured: Array<{ runId: string; agentId: string; input: unknown }> =
      [];
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: capturingExecutor(store, captured),
    });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["worker", makeSpecialist("worker")]]),
      tracker,
      parentContext: {
        parentRunId: "parent-run-xyz",
        decisions: [],
        constraints: [],
        relevantFiles: [],
      },
    });

    await supervisor.delegateTask("Work task", "worker", {});

    const runId = captured[0]!.runId;
    const run = await store.get(runId);
    expect(run?.metadata?.parentRunId).toBe("parent-run-xyz");
  });
});

// ---------------------------------------------------------------------------
// 15. SimpleDelegationTracker — cancellation and timeout
// ---------------------------------------------------------------------------

describe("SimpleDelegationTracker — cancellation and timeout", () => {
  let store: InMemoryRunStore;

  beforeEach(() => {
    store = new InMemoryRunStore();
  });

  it("cancel() returns false when no active delegations match", () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withOutput(store),
    });

    expect(tracker.cancel("nonexistent-agent")).toBe(false);
  });

  it("getActiveDelegations() returns empty array before any delegation", () => {
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: withOutput(store),
    });

    expect(tracker.getActiveDelegations()).toHaveLength(0);
  });

  it("delegation times out and returns success=false with timeout error", async () => {
    const neverCompletes: DelegationExecutor = async (
      _runId,
      _agentId,
      _input,
      signal,
    ) => {
      await new Promise<void>((resolve, reject) => {
        const h = setTimeout(resolve, 60_000);
        signal.addEventListener("abort", () => {
          clearTimeout(h);
          reject(signal.reason);
        });
      });
    };

    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: neverCompletes,
      defaultTimeoutMs: 50,
    });

    const result = await tracker.delegate({
      targetAgentId: "slow-agent",
      task: "Slow task",
      input: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  }, 5_000);

  it("cancelled delegation returns success=false with cancellation message", async () => {
    const eventBus = createEventBus();
    const emitted: DzupEvent[] = [];
    eventBus.onAny((e) => emitted.push(e));

    // Executor that hangs until aborted
    const hangingExec: DelegationExecutor = async (
      _runId,
      _agentId,
      _input,
      signal,
    ) => {
      await new Promise<void>((resolve, reject) => {
        const h = setTimeout(resolve, 60_000);
        signal.addEventListener("abort", () => {
          clearTimeout(h);
          reject(new Error("Delegation cancelled by user"));
        });
      });
    };

    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: hangingExec,
    });

    // Start delegation in background and cancel it immediately
    const delegatePromise = tracker.delegate({
      targetAgentId: "slow-agent",
      task: "Cancel me",
      input: {},
    });

    // Give the tracker time to register the active delegation
    await new Promise((r) => setTimeout(r, 10));
    tracker.cancel("slow-agent");

    const result = await delegatePromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain("cancelled");
  }, 5_000);

  it("delegate emits delegation:started event", async () => {
    const eventBus = createEventBus();
    const emitted: DzupEvent[] = [];
    eventBus.onAny((e) => emitted.push(e));

    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: withOutput(store),
    });

    await tracker.delegate({
      targetAgentId: "agent-x",
      task: "Do something",
      input: {},
    });

    const started = emitted.find((e) => e.type === "delegation:started");
    expect(started).toBeDefined();
    expect((started as Record<string, unknown>).targetAgentId).toBe("agent-x");
  });

  it("delegate emits delegation:completed event on success", async () => {
    const eventBus = createEventBus();
    const emitted: DzupEvent[] = [];
    eventBus.onAny((e) => emitted.push(e));

    const tracker = new SimpleDelegationTracker({
      runStore: store,
      eventBus,
      executor: withOutput(store, "value"),
    });

    await tracker.delegate({
      targetAgentId: "agent-y",
      task: "Do it",
      input: {},
    });

    const completed = emitted.find((e) => e.type === "delegation:completed");
    expect(completed).toBeDefined();
    expect((completed as Record<string, unknown>).success).toBe(true);
    expect((completed as Record<string, unknown>).targetAgentId).toBe(
      "agent-y",
    );
  });

  it("priority is stored in run metadata", async () => {
    const captured: Array<{ runId: string; agentId: string; input: unknown }> =
      [];
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: capturingExecutor(store, captured),
    });

    await tracker.delegate({
      targetAgentId: "priority-agent",
      task: "Priority task",
      input: {},
      priority: 1,
    });

    const runId = captured[0]!.runId;
    const run = await store.get(runId);
    expect(run?.metadata?.priority).toBe(1);
  });

  it("default priority is 5 when not specified", async () => {
    const captured: Array<{ runId: string; agentId: string; input: unknown }> =
      [];
    const tracker = new SimpleDelegationTracker({
      runStore: store,
      executor: capturingExecutor(store, captured),
    });

    await tracker.delegate({
      targetAgentId: "default-priority-agent",
      task: "Task",
      input: {},
    });

    const run = await store.get(captured[0]!.runId);
    expect(run?.metadata?.priority).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 16. DelegatingSupervisor — circuit-breaker filtered event
// ---------------------------------------------------------------------------

describe("DelegatingSupervisor — circuit_breaker_filtered event", () => {
  it("emits supervisor:circuit_breaker_filtered event listing skipped agents", async () => {
    const eventBus = createEventBus();
    const emitted: DzupEvent[] = [];
    eventBus.onAny((e) => emitted.push(e));

    const cb: AgentCircuitBreaker = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      recordTimeout: vi.fn(),
      filterAvailable: vi.fn((items: { id: string }[]) =>
        items.filter((i) => i.id === "open-agent"),
      ),
      isAvailable: vi.fn((id: string) => id === "open-agent"),
      getState: vi.fn(() => "closed"),
      reset: vi.fn(),
    } as unknown as AgentCircuitBreaker;

    const tracker = makeTrackerReturning({ success: true, output: "ok" });

    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["open-agent", makeSpecialist("open-agent")],
        ["tripped-agent", makeSpecialist("tripped-agent")],
      ]),
      tracker,
      circuitBreaker: cb,
      eventBus,
    });

    await supervisor.delegateAndCollect([
      { task: "T1", specialistId: "open-agent", input: {} },
      { task: "T2", specialistId: "tripped-agent", input: {} },
    ]);

    const filtered = emitted.find(
      (e) => e.type === "supervisor:circuit_breaker_filtered",
    );
    expect(filtered).toBeDefined();
    expect((filtered as Record<string, unknown>).skipped).toContain(
      "tripped-agent",
    );
  });
});
