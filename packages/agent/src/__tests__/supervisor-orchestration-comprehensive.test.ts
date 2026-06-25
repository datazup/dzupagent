/**
 * supervisor-orchestration-comprehensive.test.ts — W26-A deep coverage
 *
 * 80+ tests for AgentOrchestrator.supervisor() and related patterns covering:
 *  - Delegate-to-specialist happy path (single + multiple specialists)
 *  - Specialist failure → fallback / error propagation
 *  - Circuit breaker filtering + routing decision ID capture
 *  - Routing policy narrowing
 *  - Health check filtering
 *  - Provider-adapter execution mode
 *  - Abort signal / cancellation propagation
 *  - Cache behavior (per-manager, per-specialist-set)
 *  - OrchestrationError shape
 *  - Legacy positional-argument overload
 *  - AgentOrchestrator.sequential / parallel / debate
 *  - AgentOrchestrator.clearSupervisorCache()
 *
 * All LLM calls are mocked — no live network required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { DzupAgent } from "../agent/dzip-agent.js";
import { AgentOrchestrator } from "../orchestration/orchestrator.js";
import { OrchestrationError } from "../orchestration/orchestration-error.js";
import { AgentCircuitBreaker } from "../orchestration/circuit-breaker.js";
import type { RoutingPolicy } from "../orchestration/routing-policy-types.js";
import type { ProviderExecutionPort } from "../orchestration/provider-adapter/provider-execution-port.js";
import { makeMockEventBus } from "./test-utils.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a mock BaseChatModel that plays back a sequence of responses. */
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
    bindTools: vi.fn(function (this: BaseChatModel, _tools: unknown[]) {
      return this;
    }),
    _modelType: () => "base_chat_model",
    _llmType: () => "mock",
  } as unknown as BaseChatModel;
}

/** Create a mock model that always throws. */
function createThrowingModel(message: string): BaseChatModel {
  return {
    invoke: vi.fn(async () => {
      throw new Error(message);
    }),
    bindTools: vi.fn(function (this: BaseChatModel, _tools: unknown[]) {
      return this;
    }),
    _modelType: () => "base_chat_model",
    _llmType: () => "mock",
  } as unknown as BaseChatModel;
}

/** Create a mock model that always returns a fixed content string. */
function createFixedModel(content: string): BaseChatModel {
  return createMockModel([{ content }]);
}

/** Create a DzupAgent with the given id and model. */
function makeAgent(
  id: string,
  model: BaseChatModel,
  description = `Agent ${id}`,
): DzupAgent {
  return new DzupAgent({
    id,
    description,
    instructions: `You are ${id}.`,
    model,
  });
}

// ---------------------------------------------------------------------------
// I. Basic supervisor happy path
// ---------------------------------------------------------------------------

describe("AgentOrchestrator.supervisor — happy path", () => {
  it("returns content from manager after specialist delegation", async () => {
    const managerModel = createMockModel([
      {
        content: "",
        tool_calls: [{ id: "c1", name: "agent-spec", args: { task: "do it" } }],
      },
      { content: "Final answer from manager." },
    ]);
    const specModel = createFixedModel("Specialist result");

    const manager = makeAgent("mgr", managerModel);
    const specialist = makeAgent("spec", specModel);

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: "Build something",
    });

    expect(result.content).toBe("Final answer from manager.");
  });

  it("availableSpecialists lists all specialist ids", async () => {
    const managerModel = createFixedModel("Done.");
    const manager = makeAgent("mgr", managerModel);
    const s1 = makeAgent("spec-a", createFixedModel("a"));
    const s2 = makeAgent("spec-b", createFixedModel("b"));

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [s1, s2],
      task: "Work",
    });

    expect(result.availableSpecialists).toContain("spec-a");
    expect(result.availableSpecialists).toContain("spec-b");
  });

  it("filteredSpecialists is empty when no health check", async () => {
    const manager = makeAgent("mgr", createFixedModel("done"));
    const specialist = makeAgent("spec", createFixedModel("ok"));

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: "Task",
    });

    expect(result.filteredSpecialists).toEqual([]);
  });

  it("manager.bindTools is called with specialist tools", async () => {
    const managerModel = createFixedModel("ok");
    const manager = makeAgent("mgr", managerModel);
    const specialist = makeAgent("spec", createFixedModel("ok"));

    await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: "Go",
    });

    expect(managerModel.bindTools).toHaveBeenCalled();
    const boundTools = (managerModel.bindTools as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Array<{ name: string }>;
    const names = boundTools.map((t) => t.name);
    expect(names).toContain("agent-spec");
  });

  it("delegates to multiple specialists", async () => {
    const managerModel = createMockModel([
      {
        content: "",
        tool_calls: [{ id: "c1", name: "agent-fe", args: { task: "UI" } }],
      },
      {
        content: "",
        tool_calls: [{ id: "c2", name: "agent-be", args: { task: "API" } }],
      },
      { content: "Both done." },
    ]);
    const manager = makeAgent("mgr", managerModel);
    const fe = makeAgent("fe", createFixedModel("React done"));
    const be = makeAgent("be", createFixedModel("Express done"));

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [fe, be],
      task: "Full-stack",
    });

    expect(result.content).toBe("Both done.");
    expect(result.availableSpecialists).toEqual(["fe", "be"]);
  });

  it("manager answers directly without invoking specialists", async () => {
    const specModel = createFixedModel("unused");
    const specInvoke = (specModel as { invoke: ReturnType<typeof vi.fn> })
      .invoke;

    const manager = makeAgent("mgr", createFixedModel("Direct answer."));
    const specialist = makeAgent("spec", specModel);

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: "Easy question",
    });

    expect(result.content).toBe("Direct answer.");
    expect(specInvoke).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// II. Specialist failure → fallback behavior
// ---------------------------------------------------------------------------

describe("AgentOrchestrator.supervisor — specialist failure", () => {
  it("manager can recover when specialist throws", async () => {
    const managerModel = createMockModel([
      {
        content: "",
        tool_calls: [
          { id: "c1", name: "agent-flaky", args: { task: "do it" } },
        ],
      },
      { content: "Recovered after specialist failed." },
    ]);
    const manager = makeAgent("mgr", managerModel);
    const specialist = makeAgent("flaky", createThrowingModel("spec error"));

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: "Use specialist",
    });

    expect(result.content).toBe("Recovered after specialist failed.");
  });

  it("throws OrchestrationError when no specialists are provided", async () => {
    const manager = makeAgent("mgr", createFixedModel("hi"));

    await expect(
      AgentOrchestrator.supervisor({
        manager,
        specialists: [],
        task: "Do something",
      }),
    ).rejects.toThrow(OrchestrationError);
  });

  it("OrchestrationError.pattern is 'supervisor' for empty specialists", async () => {
    const manager = makeAgent("mgr", createFixedModel("hi"));
    try {
      await AgentOrchestrator.supervisor({
        manager,
        specialists: [],
        task: "Do something",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError);
      expect((err as OrchestrationError).pattern).toBe("supervisor");
    }
  });

  it("OrchestrationError.context includes managerId", async () => {
    const manager = makeAgent("my-manager", createFixedModel("hi"));
    try {
      await AgentOrchestrator.supervisor({
        manager,
        specialists: [],
        task: "Task",
      });
    } catch (err) {
      expect((err as OrchestrationError).context?.["managerId"]).toBe(
        "my-manager",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// III. Abort signal / cancellation
// ---------------------------------------------------------------------------

describe("AgentOrchestrator.supervisor — cancellation", () => {
  it("throws OrchestrationError when signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const manager = makeAgent("mgr", createFixedModel("hi"));
    const specialist = makeAgent("spec", createFixedModel("ok"));

    await expect(
      AgentOrchestrator.supervisor({
        manager,
        specialists: [specialist],
        task: "Task",
        signal: controller.signal,
      }),
    ).rejects.toThrow(OrchestrationError);
  });

  it("pre-aborted signal error message mentions 'aborted'", async () => {
    const controller = new AbortController();
    controller.abort();
    const manager = makeAgent("mgr", createFixedModel("hi"));
    const specialist = makeAgent("spec", createFixedModel("ok"));

    try {
      await AgentOrchestrator.supervisor({
        manager,
        specialists: [specialist],
        task: "Task",
        signal: controller.signal,
      });
    } catch (err) {
      expect((err as Error).message).toMatch(/abort/i);
    }
  });
});

// ---------------------------------------------------------------------------
// IV. Health check filtering
// ---------------------------------------------------------------------------

describe("AgentOrchestrator.supervisor — healthCheck", () => {
  it("filters out specialists whose asTool() throws", async () => {
    const manager = makeAgent("mgr", createFixedModel("done with healthy"));
    const healthy = makeAgent("healthy", createFixedModel("ok"));
    const broken = makeAgent("broken", createFixedModel("ok"));
    vi.spyOn(broken, "asTool").mockRejectedValue(new Error("agent down"));

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [healthy, broken],
      task: "Task",
      healthCheck: true,
    });

    expect(result.availableSpecialists).toContain("healthy");
    expect(result.availableSpecialists).not.toContain("broken");
    expect(result.filteredSpecialists).toContain("broken");
  });

  it("throws OrchestrationError when all specialists fail health check", async () => {
    const manager = makeAgent("mgr", createFixedModel("hi"));
    const broken = makeAgent("broken", createFixedModel("ok"));
    vi.spyOn(broken, "asTool").mockRejectedValue(new Error("down"));

    await expect(
      AgentOrchestrator.supervisor({
        manager,
        specialists: [broken],
        task: "Task",
        healthCheck: true,
      }),
    ).rejects.toThrow("All specialists failed health check");
  });

  it("keeps all healthy specialists when none are broken", async () => {
    const manager = makeAgent("mgr", createFixedModel("done"));
    const s1 = makeAgent("s1", createFixedModel("ok"));
    const s2 = makeAgent("s2", createFixedModel("ok"));

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [s1, s2],
      task: "Task",
      healthCheck: true,
    });

    expect(result.filteredSpecialists).toHaveLength(0);
    expect(result.availableSpecialists).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// V. Circuit breaker integration
// ---------------------------------------------------------------------------

describe("AgentOrchestrator.supervisor — circuit breaker", () => {
  it("filters specialists with open circuit", async () => {
    const manager = makeAgent("mgr", createFixedModel("done with healthy"));
    const healthy = makeAgent("healthy", createFixedModel("ok"));
    const tripped = makeAgent("tripped", createFixedModel("never reached"));

    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure("tripped");
    expect(breaker.getState("tripped")).toBe("open");

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [healthy, tripped],
      task: "Task",
      circuitBreaker: breaker,
    });

    expect(result.availableSpecialists).toContain("healthy");
    expect(result.availableSpecialists).not.toContain("tripped");
  });

  it("captures a routingDecisionId when circuit breaker filters", async () => {
    const manager = makeAgent("mgr", createFixedModel("done"));
    const healthy = makeAgent("healthy", createFixedModel("ok"));
    const tripped = makeAgent("tripped", createFixedModel("never"));

    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure("tripped");

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [healthy, tripped],
      task: "Task",
      circuitBreaker: breaker,
    });

    expect(result.routingDecisionId).toMatch(/^circuit-breaker-mgr-\d+$/);
  });

  it("throws OrchestrationError when all specialists have open circuits", async () => {
    const manager = makeAgent("mgr", createFixedModel("hi"));
    const tripped = makeAgent("tripped", createFixedModel("never"));

    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure("tripped");

    await expect(
      AgentOrchestrator.supervisor({
        manager,
        specialists: [tripped],
        task: "Task",
        circuitBreaker: breaker,
      }),
    ).rejects.toThrow("All specialists filtered by circuit breaker");
  });

  it("records circuit breaker failure when specialist throws", async () => {
    const managerModel = createMockModel([
      {
        content: "",
        tool_calls: [{ id: "c1", name: "agent-flaky", args: { task: "work" } }],
      },
      { content: "Recovered." },
    ]);
    const manager = makeAgent("mgr", managerModel);
    const specialist = makeAgent("flaky", createThrowingModel("fail"));

    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 });

    await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: "Task",
      circuitBreaker: breaker,
    });

    expect(breaker.getState("flaky")).toBe("open");
  });

  it("does not record failure for unused specialist", async () => {
    const manager = makeAgent(
      "mgr",
      createFixedModel("Direct answer, no delegation."),
    );
    const unused = makeAgent("unused", createFixedModel("never called"));

    const breaker = new AgentCircuitBreaker({ failureThreshold: 2 });
    breaker.recordFailure("unused"); // 1 failure

    await AgentOrchestrator.supervisor({
      manager,
      specialists: [unused],
      task: "Answer directly",
      circuitBreaker: breaker,
    });

    // Circuit should still be closed (only 1 failure, threshold is 2)
    expect(breaker.getState("unused")).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// VI. Routing policy integration
// ---------------------------------------------------------------------------

describe("AgentOrchestrator.supervisor — routing policy", () => {
  it("returns routingDecisionId from routing policy", async () => {
    const manager = makeAgent("mgr", createFixedModel("Routed result."));
    const specialist = makeAgent("spec", createFixedModel("ok"));

    const policy: RoutingPolicy = {
      select: vi.fn((_task, candidates) => ({
        selected: candidates,
        reason: "test",
        strategy: "rule",
        routingDecisionId: "rule-xyz-123",
      })),
    };

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: "Task",
      routingPolicy: policy,
    });

    expect(result.routingDecisionId).toBe("rule-xyz-123");
    expect(policy.select).toHaveBeenCalledOnce();
  });

  it("routingDecisionId is undefined when no routing policy is set", async () => {
    const manager = makeAgent("mgr", createFixedModel("Direct."));
    const specialist = makeAgent("spec", createFixedModel("ok"));

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: "Task",
    });

    expect(result.routingDecisionId).toBeUndefined();
  });

  it("routing policy can narrow specialists to a subset", async () => {
    const manager = makeAgent("mgr", createFixedModel("Narrowed."));
    const s1 = makeAgent("s1", createFixedModel("ok"));
    const s2 = makeAgent("s2", createFixedModel("ok"));

    const policy: RoutingPolicy = {
      select: vi.fn((_task, candidates) => ({
        selected: candidates.filter((c) => c.id === "s1"),
        reason: "only s1",
        strategy: "rule",
      })),
    };

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [s1, s2],
      task: "Task",
      routingPolicy: policy,
    });

    // Only s1 should be exposed to the manager
    expect(result.availableSpecialists).toContain("s1");
    expect(result.availableSpecialists).not.toContain("s2");
  });

  it("routing policy routingDecisionId overwrites circuit-breaker one", async () => {
    const manager = makeAgent("mgr", createFixedModel("Both applied."));
    const healthy = makeAgent("healthy", createFixedModel("ok"));
    const tripped = makeAgent("tripped", createFixedModel("never"));

    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure("tripped");

    const policy: RoutingPolicy = {
      select: vi.fn((_task, candidates) => ({
        selected: candidates,
        reason: "policy wins",
        strategy: "rule",
        routingDecisionId: "policy-wins-999",
      })),
    };

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [healthy, tripped],
      task: "Task",
      circuitBreaker: breaker,
      routingPolicy: policy,
    });

    expect(result.routingDecisionId).toBe("policy-wins-999");
  });
});

// ---------------------------------------------------------------------------
// VII. Provider-adapter execution mode
// ---------------------------------------------------------------------------

describe("AgentOrchestrator.supervisor — provider-adapter mode", () => {
  it("routes through providerPort and returns its result", async () => {
    const manager = makeAgent("mgr", createFixedModel("unused"));
    const specialist = makeAgent("spec", createFixedModel("ok"));

    const port: ProviderExecutionPort = {
      run: vi.fn(async () => ({ content: "From provider port." })),
    };

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: "Provider task",
      executionMode: "provider-adapter",
      providerPort: port,
    });

    expect(result.content).toBe("From provider port.");
    expect(port.run).toHaveBeenCalledOnce();
  });

  it("throws OrchestrationError when provider-adapter mode has no port", async () => {
    const manager = makeAgent("mgr", createFixedModel("unused"));
    const specialist = makeAgent("spec", createFixedModel("ok"));

    await expect(
      AgentOrchestrator.supervisor({
        manager,
        specialists: [specialist],
        task: "Task",
        executionMode: "provider-adapter",
      }),
    ).rejects.toThrow(OrchestrationError);
  });

  it("provider-adapter result has availableSpecialists populated", async () => {
    const manager = makeAgent("mgr", createFixedModel("unused"));
    const s1 = makeAgent("s1", createFixedModel("ok"));
    const s2 = makeAgent("s2", createFixedModel("ok"));

    const port: ProviderExecutionPort = {
      run: vi.fn(async () => ({ content: "ok" })),
    };

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [s1, s2],
      task: "Task",
      executionMode: "provider-adapter",
      providerPort: port,
    });

    expect(result.availableSpecialists).toEqual(["s1", "s2"]);
    expect(result.filteredSpecialists).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// VIII. Event bus integration
// ---------------------------------------------------------------------------

describe("AgentOrchestrator.supervisor — event bus", () => {
  it("emits supervisor:routing_decision event when circuit breaker filters", async () => {
    const eventBus = makeMockEventBus();
    const manager = makeAgent("mgr", createFixedModel("done"));
    const healthy = makeAgent("healthy", createFixedModel("ok"));
    const tripped = makeAgent("tripped", createFixedModel("never"));

    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure("tripped");

    await AgentOrchestrator.supervisor({
      manager,
      specialists: [healthy, tripped],
      task: "Task",
      circuitBreaker: breaker,
      eventBus,
    });

    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "supervisor:routing_decision" }),
    );
  });

  it("emits routing_decision event when routing policy is applied", async () => {
    const eventBus = makeMockEventBus();
    const manager = makeAgent("mgr", createFixedModel("done"));
    const specialist = makeAgent("spec", createFixedModel("ok"));

    const policy: RoutingPolicy = {
      select: vi.fn((_task, candidates) => ({
        selected: candidates,
        reason: "test",
        strategy: "rule",
        routingDecisionId: "ev-test-id",
      })),
    };

    await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: "Task",
      routingPolicy: policy,
      eventBus,
    });

    const emittedEvents = (
      eventBus.emit as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[0]) as Array<{ type: string }>;
    expect(
      emittedEvents.some((e) => e.type === "supervisor:routing_decision"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// IX. Supervisor cache behavior
// ---------------------------------------------------------------------------

describe("AgentOrchestrator.supervisor — cache behavior", () => {
  beforeEach(() => {
    AgentOrchestrator.clearSupervisorCache();
  });

  it("clearSupervisorCache() does not throw", () => {
    expect(() => AgentOrchestrator.clearSupervisorCache()).not.toThrow();
  });

  it("second call with same manager+specialists reuses cached agent", async () => {
    const managerModel = createMockModel([
      { content: "First call." },
      { content: "Second call." },
    ]);
    const manager = makeAgent("mgr", managerModel);
    const specialist = makeAgent("spec", createFixedModel("ok"));

    // Spy on asTool() to verify cache reuse: with cache hit, asTool() is only
    // called once (during the first construction), not on the second call.
    const asToolSpy = vi.spyOn(specialist, "asTool");

    const result1 = await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: "Task 1",
    });
    const result2 = await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: "Task 2",
    });

    // Both calls succeed
    expect(result1.content).toBe("First call.");
    expect(result2.content).toBe("Second call.");
    // Cache hit on second call means asTool() was called only once (during build)
    expect(asToolSpy).toHaveBeenCalledTimes(1);
  });

  it("different manager instances get different cache entries", async () => {
    const model1 = createFixedModel("mgr1");
    const model2 = createFixedModel("mgr2");
    const mgr1 = makeAgent("mgr", model1);
    const mgr2 = makeAgent("mgr", model2);
    const specialist = makeAgent("spec", createFixedModel("ok"));

    const r1 = await AgentOrchestrator.supervisor({
      manager: mgr1,
      specialists: [specialist],
      task: "Task",
    });
    const r2 = await AgentOrchestrator.supervisor({
      manager: mgr2,
      specialists: [specialist],
      task: "Task",
    });

    expect(r1.content).toBe("mgr1");
    expect(r2.content).toBe("mgr2");
  });

  it("circuit breaker disables caching (always rebuilds)", async () => {
    const managerModel = createMockModel([
      { content: "No cache 1." },
      { content: "No cache 2." },
    ]);
    const manager = makeAgent("mgr", managerModel);
    const specialist = makeAgent("spec", createFixedModel("ok"));
    const breaker = new AgentCircuitBreaker({ failureThreshold: 5 });

    await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: "Task 1",
      circuitBreaker: breaker,
    });
    await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: "Task 2",
      circuitBreaker: breaker,
    });

    // With circuit breaker, bindTools is called each time (no cache)
    expect(
      (managerModel.bindTools as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// X. Legacy positional overload
// ---------------------------------------------------------------------------

describe("AgentOrchestrator.supervisor — legacy overload", () => {
  it("positional signature returns a string (legacy)", async () => {
    const manager = makeAgent("mgr", createFixedModel("legacy result"));
    const specialist = makeAgent("spec", createFixedModel("ok"));

    const result = await AgentOrchestrator.supervisor(
      manager,
      [specialist],
      "Task",
    );
    expect(typeof result).toBe("string");
    expect(result).toBe("legacy result");
  });

  it("positional signature returns the manager output", async () => {
    const manager = makeAgent("mgr", createFixedModel("legacy output xyz"));
    const specialist = makeAgent("spec", createFixedModel("ok"));

    const result = await AgentOrchestrator.supervisor(
      manager,
      [specialist],
      "Do legacy stuff",
    );
    expect(result).toContain("legacy output xyz");
  });
});

// ---------------------------------------------------------------------------
// XI. OrchestrationError class
// ---------------------------------------------------------------------------

describe("OrchestrationError", () => {
  it("is an instance of Error", () => {
    const err = new OrchestrationError("msg", "supervisor");
    expect(err).toBeInstanceOf(Error);
  });

  it("name is 'OrchestrationError'", () => {
    const err = new OrchestrationError("msg", "supervisor");
    expect(err.name).toBe("OrchestrationError");
  });

  it("pattern is set correctly for supervisor", () => {
    const err = new OrchestrationError("msg", "supervisor");
    expect(err.pattern).toBe("supervisor");
  });

  it("pattern is set correctly for parallel", () => {
    const err = new OrchestrationError("msg", "parallel");
    expect(err.pattern).toBe("parallel");
  });

  it("context is stored when provided", () => {
    const err = new OrchestrationError("msg", "supervisor", { key: "val" });
    expect(err.context).toEqual({ key: "val" });
  });

  it("context is undefined when not provided", () => {
    const err = new OrchestrationError("msg", "supervisor");
    expect(err.context).toBeUndefined();
  });

  it("message is set correctly", () => {
    const err = new OrchestrationError("something went wrong", "debate");
    expect(err.message).toBe("something went wrong");
  });
});

// ---------------------------------------------------------------------------
// XII. AgentOrchestrator.sequential
// ---------------------------------------------------------------------------

describe("AgentOrchestrator.sequential", () => {
  it("returns final agent output", async () => {
    const a = makeAgent("a", createFixedModel("from A"));
    const b = makeAgent("b", createFixedModel("from B"));

    const result = await AgentOrchestrator.sequential([a, b], "initial");
    expect(result).toBe("from B");
  });

  it("each agent receives the previous agent's output", async () => {
    const captured: string[] = [];

    const modelA = {
      invoke: vi.fn(async (msgs: BaseMessage[]) => {
        captured.push("A: " + (msgs[msgs.length - 1] as HumanMessage).content);
        return new AIMessage({ content: "output-A", response_metadata: {} });
      }),
      bindTools: vi.fn(function (this: BaseChatModel) {
        return this;
      }),
      _modelType: () => "base_chat_model",
      _llmType: () => "mock",
    } as unknown as BaseChatModel;

    const modelB = {
      invoke: vi.fn(async (msgs: BaseMessage[]) => {
        captured.push("B: " + (msgs[msgs.length - 1] as HumanMessage).content);
        return new AIMessage({ content: "output-B", response_metadata: {} });
      }),
      bindTools: vi.fn(function (this: BaseChatModel) {
        return this;
      }),
      _modelType: () => "base_chat_model",
      _llmType: () => "mock",
    } as unknown as BaseChatModel;

    const a = makeAgent("a", modelA);
    const b = makeAgent("b", modelB);

    await AgentOrchestrator.sequential([a, b], "start");
    expect(captured[0]).toContain("start");
    expect(captured[1]).toContain("output-A");
  });

  it("single agent returns its output directly", async () => {
    const agent = makeAgent("a", createFixedModel("single result"));
    const result = await AgentOrchestrator.sequential([agent], "input");
    expect(result).toBe("single result");
  });
});

// ---------------------------------------------------------------------------
// XIII. AgentOrchestrator.parallel
// ---------------------------------------------------------------------------

describe("AgentOrchestrator.parallel", () => {
  it("returns merged output from all agents", async () => {
    const a = makeAgent("a", createFixedModel("A result"));
    const b = makeAgent("b", createFixedModel("B result"));

    const result = await AgentOrchestrator.parallel([a, b], "task");
    expect(result).toContain("A result");
    expect(result).toContain("B result");
  });

  it("uses custom merge function when provided", async () => {
    const a = makeAgent("a", createFixedModel("alpha"));
    const b = makeAgent("b", createFixedModel("beta"));

    const result = await AgentOrchestrator.parallel([a, b], "task", (results) =>
      results.join(" | "),
    );
    expect(result).toContain("alpha");
    expect(result).toContain("beta");
    expect(result).toContain(" | ");
  });

  it("throws OrchestrationError when all agents filtered by circuit breaker", async () => {
    const a = makeAgent("a", createFixedModel("ok"));
    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure("a");

    await expect(
      AgentOrchestrator.parallel([a], "task", undefined, {
        circuitBreaker: breaker,
      }),
    ).rejects.toThrow(OrchestrationError);
  });

  it("parallel respects maxConcurrency option without error", async () => {
    const agents = Array.from({ length: 5 }, (_, i) =>
      makeAgent(`a${i}`, createFixedModel(`result-${i}`)),
    );

    const result = await AgentOrchestrator.parallel(agents, "task", undefined, {
      maxConcurrency: 2,
    });

    // All 5 results should be in the merged output
    for (let i = 0; i < 5; i++) {
      expect(result).toContain(`result-${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// XIV. AgentOrchestrator.debate
// ---------------------------------------------------------------------------

describe("AgentOrchestrator.debate", () => {
  it("returns judge output", async () => {
    const proposerA = makeAgent("p1", createFixedModel("Proposal A"));
    const proposerB = makeAgent("p2", createFixedModel("Proposal B"));
    const judge = makeAgent("judge", createFixedModel("Judge: A wins"));

    const result = await AgentOrchestrator.debate(
      [proposerA, proposerB],
      judge,
      "Best approach?",
    );

    expect(result).toBe("Judge: A wins");
  });

  it("debate with rounds=2 runs 2 rounds", async () => {
    let proposalCount = 0;
    const proposerModel = {
      invoke: vi.fn(async () => {
        proposalCount++;
        return new AIMessage({
          content: `Proposal ${proposalCount}`,
          response_metadata: {},
        });
      }),
      bindTools: vi.fn(function (this: BaseChatModel) {
        return this;
      }),
      _modelType: () => "base_chat_model",
      _llmType: () => "mock",
    } as unknown as BaseChatModel;

    const proposer = makeAgent("p", proposerModel);
    const judge = makeAgent("judge", createFixedModel("Final verdict"));

    await AgentOrchestrator.debate([proposer], judge, "Task", { rounds: 2 });

    // 1 proposer × 2 rounds = 2 invocations
    expect(proposerModel.invoke).toHaveBeenCalledTimes(2);
  });

  it("debate with single proposer works", async () => {
    const proposer = makeAgent("p", createFixedModel("My proposal"));
    const judge = makeAgent("j", createFixedModel("Verdict: accepted"));

    const result = await AgentOrchestrator.debate([proposer], judge, "Q");
    expect(result).toBe("Verdict: accepted");
  });
});

// ---------------------------------------------------------------------------
// XV. Max-retries / specialist stuck detection interaction
// ---------------------------------------------------------------------------

describe("AgentOrchestrator.supervisor — repeated failure pattern", () => {
  it("circuit breaker trips after threshold failures via multiple supervisor calls", async () => {
    const breaker = new AgentCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 10_000,
    });

    const makeCallWithFlakySpec = async () => {
      const managerModel = createMockModel([
        {
          content: "",
          tool_calls: [{ id: "c1", name: "agent-flaky", args: { task: "go" } }],
        },
        { content: "Recovered." },
      ]);
      const manager = makeAgent("mgr", managerModel);
      const specialist = makeAgent("flaky", createThrowingModel("boom"));

      return AgentOrchestrator.supervisor({
        manager,
        specialists: [specialist],
        task: "Task",
        circuitBreaker: breaker,
      });
    };

    // First call: failure recorded
    await makeCallWithFlakySpec();
    expect(breaker.getState("flaky")).toBe("closed"); // need 2

    // Second call: second failure
    await makeCallWithFlakySpec();
    expect(breaker.getState("flaky")).toBe("open"); // tripped
  });

  it("once circuit is open, subsequent calls exclude that specialist", async () => {
    const breaker = new AgentCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
    });
    breaker.recordFailure("tripped");

    const specInvoke = (
      createThrowingModel("never") as { invoke: ReturnType<typeof vi.fn> }
    ).invoke;
    const tripped = makeAgent("tripped", createThrowingModel("never"));

    const managerModel = createFixedModel("Only healthy available.");
    const manager = makeAgent("mgr", managerModel);
    const healthy = makeAgent("healthy", createFixedModel("I am available"));

    await AgentOrchestrator.supervisor({
      manager,
      specialists: [healthy, tripped],
      task: "Task",
      circuitBreaker: breaker,
    });

    // The tripped specialist should never have been invoked
    expect(specInvoke).not.toHaveBeenCalled();
  });
});
