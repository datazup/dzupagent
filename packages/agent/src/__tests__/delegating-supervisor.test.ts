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
  type TaskAssignment,
} from "../orchestration/delegating-supervisor.js";
import type { AgentCircuitBreaker } from "../orchestration/circuit-breaker.js";
import type { ProviderExecutionPort } from "../orchestration/provider-adapter/provider-execution-port.js";
import type { RoutingPolicy } from "../orchestration/routing-policy-types.js";

// Top-level mock so vi.mocked(PlanningAgent) works in the LLM-path tests.
vi.mock("../orchestration/planning-agent.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates an executor that marks the run as completed in the store. */
function withStoreUpdate(
  store: InMemoryRunStore,
  output: unknown = "specialist result"
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

/** Creates an executor that returns specialist-specific output. */
function specialistExecutor(store: InMemoryRunStore): DelegationExecutor {
  return async (runId, agentId, _input, signal) => {
    if (signal.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (signal.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await store.update(runId, {
      status: "completed",
      output: `Result from ${agentId}`,
      completedAt: new Date(),
    });
  };
}

/** Creates a failing executor for a specific agent. */
function failingForAgent(
  store: InMemoryRunStore,
  failAgentId: string
): DelegationExecutor {
  return async (runId, agentId, _input, signal) => {
    if (signal.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (agentId === failAgentId) {
      throw new Error(`Agent ${agentId} failed`);
    }
    await store.update(runId, {
      status: "completed",
      output: `Result from ${agentId}`,
      completedAt: new Date(),
    });
  };
}

function makeSpecialist(
  id: string,
  overrides: Partial<AgentExecutionSpec> = {}
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
// Tests
// ---------------------------------------------------------------------------

describe("DelegatingSupervisor", () => {
  let store: InMemoryRunStore;
  let eventBus: DzupEventBus;
  let events: DzupEvent[];

  beforeEach(() => {
    vi.resetAllMocks();
    store = new InMemoryRunStore();
    eventBus = createEventBus();
    events = [];
    eventBus.onAny((e) => events.push(e));
  });

  // -----------------------------------------------------------------------
  // Single delegation
  // -----------------------------------------------------------------------
  describe("delegateTask", () => {
    it("records circuit-breaker success for successful delegation results", async () => {
      const circuitBreaker = makeCircuitBreakerSpy();
      const supervisor = new DelegatingSupervisor({
        specialists: new Map([["agent-ok", makeSpecialist("agent-ok")]]),
        tracker: makeTrackerReturning({ success: true, output: "ok" }),
        circuitBreaker,
      });

      await supervisor.delegateTask("Task A", "agent-ok", {});

      expect(circuitBreaker.recordSuccess).toHaveBeenCalledWith("agent-ok");
      expect(circuitBreaker.recordTimeout).not.toHaveBeenCalled();
      expect(circuitBreaker.recordFailure).not.toHaveBeenCalled();
    });

    it("records circuit-breaker timeout for timeout delegation results", async () => {
      const circuitBreaker = makeCircuitBreakerSpy();
      const supervisor = new DelegatingSupervisor({
        specialists: new Map([
          ["agent-timeout", makeSpecialist("agent-timeout")],
        ]),
        tracker: makeTrackerReturning({
          success: false,
          output: null,
          error: "Delegation timeout after 50ms",
        }),
        circuitBreaker,
      });

      await supervisor.delegateTask("Task A", "agent-timeout", {});

      expect(circuitBreaker.recordTimeout).toHaveBeenCalledWith(
        "agent-timeout"
      );
      expect(circuitBreaker.recordFailure).not.toHaveBeenCalled();
      expect(circuitBreaker.recordSuccess).not.toHaveBeenCalled();
    });

    it("records circuit-breaker failure for generic unsuccessful delegation results", async () => {
      const circuitBreaker = makeCircuitBreakerSpy();
      const supervisor = new DelegatingSupervisor({
        specialists: new Map([["agent-fail", makeSpecialist("agent-fail")]]),
        tracker: makeTrackerReturning({
          success: false,
          output: null,
          error: "Model returned invalid output",
        }),
        circuitBreaker,
      });

      await supervisor.delegateTask("Task A", "agent-fail", {});

      expect(circuitBreaker.recordFailure).toHaveBeenCalledWith("agent-fail");
      expect(circuitBreaker.recordTimeout).not.toHaveBeenCalled();
      expect(circuitBreaker.recordSuccess).not.toHaveBeenCalled();
    });

    it("delegates a single task to a specialist and returns the result", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: withStoreUpdate(store, {
          schema: "CREATE TABLE users (...)",
        }),
      });

      const specialists = new Map<string, AgentExecutionSpec>([
        [
          "db-specialist",
          makeSpecialist("db-specialist", {
            metadata: { tags: ["database", "sql"] },
          }),
        ],
      ]);

      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
        parentContext: {
          parentRunId: "parent-1",
          decisions: ["Use PostgreSQL"],
          constraints: [],
          relevantFiles: [],
        },
      });

      const result = await supervisor.delegateTask(
        "Create the users table schema",
        "db-specialist",
        { tables: ["users"] }
      );

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ schema: "CREATE TABLE users (...)" });
      expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("throws OrchestrationError when specialist not found", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        executor: withStoreUpdate(store),
      });

      const supervisor = new DelegatingSupervisor({
        specialists: new Map([
          ["db-specialist", makeSpecialist("db-specialist")],
        ]),
        tracker,
      });

      await expect(
        supervisor.delegateTask("Do something", "nonexistent-agent", {})
      ).rejects.toThrow('Specialist "nonexistent-agent" not found');
    });

    it("includes available specialists in the error message", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        executor: withStoreUpdate(store),
      });

      const supervisor = new DelegatingSupervisor({
        specialists: new Map([
          ["agent-db", makeSpecialist("agent-db")],
          ["agent-api", makeSpecialist("agent-api")],
        ]),
        tracker,
      });

      await expect(
        supervisor.delegateTask("task", "missing", {})
      ).rejects.toThrow(/agent-db.*agent-api|agent-api.*agent-db/);
    });

    it("emits supervisor:delegating and supervisor:delegation_complete events", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: withStoreUpdate(store, "ok"),
      });

      const supervisor = new DelegatingSupervisor({
        specialists: new Map([
          ["db-specialist", makeSpecialist("db-specialist")],
        ]),
        tracker,
        eventBus,
      });

      await supervisor.delegateTask("Create schema", "db-specialist", {});

      const delegating = events.find((e) => e.type === "supervisor:delegating");
      const complete = events.find(
        (e) => e.type === "supervisor:delegation_complete"
      );

      expect(delegating).toBeDefined();
      expect((delegating as Record<string, unknown>).specialistId).toBe(
        "db-specialist"
      );
      expect((delegating as Record<string, unknown>).task).toBe(
        "Create schema"
      );

      expect(complete).toBeDefined();
      expect((complete as Record<string, unknown>).success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Parallel delegation
  // -----------------------------------------------------------------------
  describe("delegateAndCollect", () => {
    it("records circuit-breaker failure for rejected delegateTask promises", async () => {
      const circuitBreaker = makeCircuitBreakerSpy();
      const supervisor = new DelegatingSupervisor({
        specialists: new Map([
          ["agent-reject", makeSpecialist("agent-reject")],
        ]),
        tracker: makeTrackerRejecting(new Error("Transport closed")),
        circuitBreaker,
      });

      const aggregated = await supervisor.delegateAndCollect([
        { task: "Task A", specialistId: "agent-reject", input: {} },
      ]);

      expect(aggregated.failed).toEqual(["agent-reject"]);
      expect(aggregated.results.get("agent-reject")).toMatchObject({
        success: false,
        output: null,
        error: "Transport closed",
      });
      expect(circuitBreaker.recordFailure).toHaveBeenCalledTimes(1);
      expect(circuitBreaker.recordFailure).toHaveBeenCalledWith("agent-reject");
      expect(circuitBreaker.recordTimeout).not.toHaveBeenCalled();
      expect(circuitBreaker.recordSuccess).not.toHaveBeenCalled();
    });

    it("delegates multiple tasks in parallel and collects results", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: specialistExecutor(store),
      });

      const specialists = new Map<string, AgentExecutionSpec>([
        ["agent-db", makeSpecialist("agent-db")],
        ["agent-api", makeSpecialist("agent-api")],
        ["agent-ui", makeSpecialist("agent-ui")],
      ]);

      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
      });

      const tasks: TaskAssignment[] = [
        { task: "Create DB schema", specialistId: "agent-db", input: {} },
        { task: "Build REST API", specialistId: "agent-api", input: {} },
        { task: "Create UI components", specialistId: "agent-ui", input: {} },
      ];

      const aggregated = await supervisor.delegateAndCollect(tasks);

      expect(aggregated.succeeded).toHaveLength(3);
      expect(aggregated.failed).toHaveLength(0);
      expect(aggregated.totalDurationMs).toBeGreaterThanOrEqual(0);

      expect(aggregated.results.get("agent-db")?.output).toBe(
        "Result from agent-db"
      );
      expect(aggregated.results.get("agent-api")?.output).toBe(
        "Result from agent-api"
      );
      expect(aggregated.results.get("agent-ui")?.output).toBe(
        "Result from agent-ui"
      );
    });

    it("handles mixed success/failure in parallel delegation", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: failingForAgent(store, "agent-api"),
      });

      const specialists = new Map<string, AgentExecutionSpec>([
        ["agent-db", makeSpecialist("agent-db")],
        ["agent-api", makeSpecialist("agent-api")],
      ]);

      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
      });

      const tasks: TaskAssignment[] = [
        { task: "Create schema", specialistId: "agent-db", input: {} },
        { task: "Build API", specialistId: "agent-api", input: {} },
      ];

      const aggregated = await supervisor.delegateAndCollect(tasks);

      expect(aggregated.succeeded).toContain("agent-db");
      expect(aggregated.failed).toContain("agent-api");

      const dbResult = aggregated.results.get("agent-db");
      expect(dbResult?.success).toBe(true);

      const apiResult = aggregated.results.get("agent-api");
      expect(apiResult?.success).toBe(false);
      expect(apiResult?.error).toContain("agent-api");
    });

    it("keys duplicate-specialist assignments by assignment ID", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: specialistExecutor(store),
      });

      const specialists = new Map<string, AgentExecutionSpec>([
        ["agent-coder", makeSpecialist("agent-coder")],
      ]);

      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
      });

      const tasks: TaskAssignment[] = [
        {
          id: "node-a",
          task: "Implement A",
          specialistId: "agent-coder",
          input: {},
        },
        {
          id: "node-b",
          task: "Implement B",
          specialistId: "agent-coder",
          input: {},
        },
      ];

      const aggregated = await supervisor.delegateAndCollect(tasks);

      expect(aggregated.succeeded).toEqual(["node-a", "node-b"]);
      expect(aggregated.failed).toEqual([]);
      expect(aggregated.results.get("node-a")?.output).toBe(
        "Result from agent-coder"
      );
      expect(aggregated.results.get("node-a")?.metadata).toMatchObject({
        assignmentId: "node-a",
        specialistId: "agent-coder",
      });
      expect(aggregated.results.get("node-b")?.metadata).toMatchObject({
        assignmentId: "node-b",
        specialistId: "agent-coder",
      });
      expect(
        events.some(
          (e) => e.type === "supervisor:duplicate_specialist_assignment_ids"
        )
      ).toBe(false);
    });

    it("warns direct callers when duplicate-specialist assignments do not all have IDs", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: specialistExecutor(store),
      });

      const supervisor = new DelegatingSupervisor({
        specialists: new Map([["agent-coder", makeSpecialist("agent-coder")]]),
        tracker,
        eventBus,
      });

      await supervisor.delegateAndCollect([
        { task: "Implement A", specialistId: "agent-coder", input: {} },
        {
          id: "node-b",
          task: "Implement B",
          specialistId: "agent-coder",
          input: {},
        },
      ]);

      const warning = events.find(
        (e) => e.type === "supervisor:duplicate_specialist_assignment_ids"
      );
      expect(warning).toMatchObject({
        mode: "warn",
        duplicateSpecialists: [
          {
            specialistId: "agent-coder",
            assignmentIndexes: [0, 1],
            missingAssignmentIdIndexes: [0],
          },
        ],
      });
      expect((warning as { message?: string } | undefined)?.message).toContain(
        "TaskAssignment.id"
      );
    });

    it("throws before delegation in strict mode when duplicate-specialist assignments do not all have IDs", async () => {
      const tracker = makeTrackerReturning({ success: true, output: "ok" });

      const supervisor = new DelegatingSupervisor({
        specialists: new Map([["agent-coder", makeSpecialist("agent-coder")]]),
        tracker,
        duplicateSpecialistAssignmentIdMode: "strict",
      });

      await expect(
        supervisor.delegateAndCollect([
          { task: "Implement A", specialistId: "agent-coder", input: {} },
          { task: "Implement B", specialistId: "agent-coder", input: {} },
        ])
      ).rejects.toThrow(
        "duplicate specialist assignments without stable assignment IDs"
      );

      expect(tracker.delegate).not.toHaveBeenCalled();
    });

    it("throws when a specialist in the task list is not registered", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        executor: withStoreUpdate(store),
      });

      const supervisor = new DelegatingSupervisor({
        specialists: new Map([["agent-db", makeSpecialist("agent-db")]]),
        tracker,
      });

      const tasks: TaskAssignment[] = [
        { task: "Create schema", specialistId: "agent-db", input: {} },
        { task: "Build API", specialistId: "agent-unknown", input: {} },
      ];

      await expect(supervisor.delegateAndCollect(tasks)).rejects.toThrow(
        'Specialist "agent-unknown" not found'
      );
    });
  });

  // -----------------------------------------------------------------------
  // planAndDelegate
  // -----------------------------------------------------------------------
  describe("planAndDelegate", () => {
    it("decomposes a goal and delegates to matching specialists", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: specialistExecutor(store),
      });

      const specialists = new Map<string, AgentExecutionSpec>([
        [
          "db-specialist",
          makeSpecialist("db-specialist", {
            metadata: { tags: ["database", "schema"] },
          }),
        ],
        [
          "api-specialist",
          makeSpecialist("api-specialist", {
            metadata: { tags: ["api", "backend", "rest"] },
          }),
        ],
      ]);

      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
      });

      const aggregated = await supervisor.planAndDelegate(
        "create the database schema and build the REST API endpoints"
      );

      // Should have matched at least some sub-tasks to specialists
      expect(aggregated.results.size).toBeGreaterThan(0);
      expect(aggregated.succeeded.length).toBeGreaterThan(0);
    });

    it("matches specialists by metadata tags", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: specialistExecutor(store),
      });

      const specialists = new Map<string, AgentExecutionSpec>([
        [
          "security-agent",
          makeSpecialist("security-agent", {
            metadata: { tags: ["security", "auth"] },
          }),
        ],
        [
          "ui-agent",
          makeSpecialist("ui-agent", {
            metadata: { tags: ["ui", "frontend", "component"] },
          }),
        ],
      ]);

      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
      });

      const aggregated = await supervisor.planAndDelegate(
        "implement authentication, build the login component"
      );

      // Both specialists should have been matched
      const specialistIds = [...aggregated.results.keys()];
      expect(specialistIds).toContain("security-agent");
      expect(specialistIds).toContain("ui-agent");
    });

    it("throws when no specialists match the goal", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: withStoreUpdate(store),
      });

      const specialists = new Map<string, AgentExecutionSpec>([
        [
          "db-specialist",
          makeSpecialist("db-specialist", {
            metadata: { tags: ["database"] },
          }),
        ],
      ]);

      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
      });

      await expect(
        supervisor.planAndDelegate("do something completely unrelated xyz")
      ).rejects.toThrow("No specialists matched");
    });

    it("emits supervisor:plan_created event with assignments", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: specialistExecutor(store),
      });

      const specialists = new Map<string, AgentExecutionSpec>([
        [
          "db-specialist",
          makeSpecialist("db-specialist", {
            metadata: { tags: ["database"] },
          }),
        ],
      ]);

      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
      });

      await supervisor.planAndDelegate("set up the database schema");

      const planEvent = events.find(
        (e) => e.type === "supervisor:plan_created"
      );
      expect(planEvent).toBeDefined();
      expect((planEvent as Record<string, unknown>).goal).toBe(
        "set up the database schema"
      );
      expect((planEvent as Record<string, unknown>).assignments).toBeDefined();
    });

    // --- LLM path ---
    // vi.mock is hoisted, so beforeEach resets the PlanningAgent constructor mock
    // before each LLM-path branch test configures its own implementation.

    it("calls PlanningAgent.decompose only when llm option is provided and returns succeeded node IDs", async () => {
      const { PlanningAgent } = await import(
        "../orchestration/planning-agent.js"
      );
      const decomposeMock = vi.fn().mockResolvedValue({
        goal: "build the api",
        nodes: [
          {
            id: "node-1",
            task: "task 1",
            specialistId: "spec-a",
            input: {},
            dependsOn: [],
          },
        ],
        executionLevels: [["node-1"]],
      });
      vi.mocked(PlanningAgent).mockImplementation(
        () =>
          ({
            decompose: decomposeMock,
            executePlan: vi.fn().mockResolvedValue({
              plan: { goal: "build the api", nodes: [], executionLevels: [] },
              results: new Map([["node-1", { success: true, output: "done" }]]),
              success: true,
              totalDurationMs: 10,
              failedNodes: [],
              skippedNodes: [],
            }),
          } as unknown as InstanceType<typeof PlanningAgent>)
      );

      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: specialistExecutor(store),
      });
      const specialists = new Map<string, AgentExecutionSpec>([
        ["spec-a", makeSpecialist("spec-a", { metadata: { tags: ["api"] } })],
      ]);
      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
      });

      const mockLlm = { invoke: vi.fn().mockResolvedValue({ content: "" }) };
      const result = await supervisor.planAndDelegate("build the api", {
        llm: mockLlm,
      });

      expect(result.succeeded).toContain("node-1");
      expect(decomposeMock).toHaveBeenCalledWith(
        "build the api",
        mockLlm,
        {}
      );

      vi.mocked(PlanningAgent).mockClear();
      decomposeMock.mockClear();

      const keywordResult = await supervisor.planAndDelegate(
        "build the api endpoint"
      );

      expect(keywordResult.succeeded).toContain("spec-a");
      expect(PlanningAgent).not.toHaveBeenCalled();
      expect(decomposeMock).not.toHaveBeenCalled();
    });

    it("emits supervisor:llm_decompose_fallback only on LLM failure and falls back to keyword matching", async () => {
      const { PlanningAgent } = await import(
        "../orchestration/planning-agent.js"
      );
      const successfulDecompose = vi.fn().mockResolvedValue({
        goal: "set up the database schema",
        nodes: [
          {
            id: "llm-node",
            task: "schema task",
            specialistId: "db-specialist",
            input: {},
            dependsOn: [],
          },
        ],
        executionLevels: [["llm-node"]],
      });
      const executePlanMock = vi.fn().mockResolvedValue({
        plan: {
          goal: "set up the database schema",
          nodes: [],
          executionLevels: [],
        },
        results: new Map([["llm-node", { success: true, output: "llm done" }]]),
        success: true,
        totalDurationMs: 4,
        failedNodes: [],
        skippedNodes: [],
      });
      const failingDecompose = vi
        .fn()
        .mockRejectedValue(new Error("LLM unavailable"));
      vi.mocked(PlanningAgent).mockImplementation(
        () =>
          ({
            decompose: successfulDecompose,
            executePlan: executePlanMock,
          } as unknown as InstanceType<typeof PlanningAgent>)
      );

      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: specialistExecutor(store),
      });
      const specialists = new Map<string, AgentExecutionSpec>([
        [
          "db-specialist",
          makeSpecialist("db-specialist", { metadata: { tags: ["database"] } }),
        ],
      ]);
      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
      });

      const mockLlm = { invoke: vi.fn() };
      const llmResult = await supervisor.planAndDelegate(
        "set up the database schema",
        {
          llm: mockLlm,
        }
      );

      expect(llmResult.succeeded).toEqual(["llm-node"]);
      expect(
        events.some((e) => e.type === "supervisor:llm_decompose_fallback")
      ).toBe(false);

      vi.mocked(PlanningAgent).mockImplementation(
        () =>
          ({
            decompose: failingDecompose,
          } as unknown as InstanceType<typeof PlanningAgent>)
      );

      const fallbackResult = await supervisor.planAndDelegate(
        "set up the database schema",
        {
          llm: mockLlm,
        }
      );

      expect(fallbackResult.succeeded).toContain("db-specialist");

      const fallbackEvent = events.find(
        (e) => e.type === "supervisor:llm_decompose_fallback"
      );
      expect(fallbackEvent).toMatchObject({
        type: "supervisor:llm_decompose_fallback",
        goal: "set up the database schema",
        error: "LLM unavailable",
      });
      const keywordPlanCreatedEvents = events.filter(
        (e) =>
          e.type === "supervisor:plan_created" &&
          (e as Record<string, unknown>).source === "keyword"
      );
      expect(keywordPlanCreatedEvents).toHaveLength(1);
    });

    it("forwards acknowledgeUnresolvedNodes to PlanningAgent.decompose only when set", async () => {
      const decomposeMock = vi.fn().mockResolvedValue({
        goal: "build the api",
        nodes: [
          {
            id: "node-1",
            task: "task 1",
            specialistId: "spec-a",
            input: {},
            dependsOn: [],
          },
        ],
        executionLevels: [["node-1"]],
      });
      const { PlanningAgent } = await import(
        "../orchestration/planning-agent.js"
      );
      vi.mocked(PlanningAgent).mockImplementation(
        () =>
          ({
            decompose: decomposeMock,
            executePlan: vi.fn().mockResolvedValue({
              plan: { goal: "build the api", nodes: [], executionLevels: [] },
              results: new Map([["node-1", { success: true, output: "done" }]]),
              success: true,
              totalDurationMs: 5,
              failedNodes: [],
              skippedNodes: [],
            }),
          } as unknown as InstanceType<typeof PlanningAgent>)
      );

      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: specialistExecutor(store),
      });
      const specialists = new Map<string, AgentExecutionSpec>([
        ["spec-a", makeSpecialist("spec-a", { metadata: { tags: ["api"] } })],
      ]);
      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
      });

      const mockLlm = { invoke: vi.fn().mockResolvedValue({ content: "" }) };
      await supervisor.planAndDelegate("build the api", {
        llm: mockLlm,
      });

      await supervisor.planAndDelegate("build the api", {
        llm: mockLlm,
        acknowledgeUnresolvedNodes: true,
      });

      const defaultOptions = decomposeMock.mock.calls[0]?.[2];
      const acknowledgedOptions = decomposeMock.mock.calls[1]?.[2];
      expect(defaultOptions).not.toHaveProperty(
        "acknowledgeUnresolvedNodes",
        true
      );
      expect(acknowledgedOptions).toMatchObject({
        acknowledgeUnresolvedNodes: true,
      });
    });

    // --- Routing-policy path ---

    it("calls routeSubtasksViaPolicy instead of keyword matching when routingPolicy is set", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: specialistExecutor(store),
      });
      const specialists = new Map<string, AgentExecutionSpec>([
        [
          "api-agent",
          makeSpecialist("api-agent", { metadata: { tags: ["api"] } }),
        ],
      ]);
      const routingPolicy: RoutingPolicy = {
        select: (_task, candidates) => ({
          selected: candidates.slice(0, 1),
          reason: "first candidate",
          strategy: "rule",
        }),
      };
      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
        routingPolicy,
      });

      const result = await supervisor.planAndDelegate("build the api endpoint");

      expect(result.results.size).toBeGreaterThan(0);
      expect(result.succeeded.length).toBeGreaterThan(0);
    });

    it("returns succeeded specialist IDs from policy-routed assignments", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: specialistExecutor(store),
      });
      const specialists = new Map<string, AgentExecutionSpec>([
        [
          "api-agent",
          makeSpecialist("api-agent", { metadata: { tags: ["api"] } }),
        ],
      ]);
      const routingPolicy: RoutingPolicy = {
        select: (_task, candidates) => ({
          selected: candidates,
          reason: "all candidates",
          strategy: "rule",
        }),
      };
      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
        routingPolicy,
      });

      const result = await supervisor.planAndDelegate("build the api endpoint");

      expect(result.succeeded).toContain("api-agent");
    });

    it("throws OrchestrationError when routingPolicy returns empty selection for all subtasks", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: withStoreUpdate(store),
      });
      const specialists = new Map<string, AgentExecutionSpec>([
        [
          "api-agent",
          makeSpecialist("api-agent", { metadata: { tags: ["api"] } }),
        ],
      ]);
      const routingPolicy: RoutingPolicy = {
        select: () => ({
          selected: [],
          reason: "no match",
          strategy: "rule",
        }),
      };
      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
        routingPolicy,
      });

      await expect(
        supervisor.planAndDelegate("do something unrelated xyz")
      ).rejects.toThrow("No specialists matched");
    });
  });

  // -----------------------------------------------------------------------
  // Result aggregation
  // -----------------------------------------------------------------------
  describe("result aggregation", () => {
    it("separates succeeded and failed specialist IDs", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: failingForAgent(store, "agent-broken"),
      });

      const specialists = new Map<string, AgentExecutionSpec>([
        ["agent-ok", makeSpecialist("agent-ok")],
        ["agent-broken", makeSpecialist("agent-broken")],
      ]);

      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
      });

      const tasks: TaskAssignment[] = [
        { task: "Task A", specialistId: "agent-ok", input: {} },
        { task: "Task B", specialistId: "agent-broken", input: {} },
      ];

      const aggregated = await supervisor.delegateAndCollect(tasks);

      expect(aggregated.succeeded).toEqual(["agent-ok"]);
      expect(aggregated.failed).toEqual(["agent-broken"]);
      expect(aggregated.results.size).toBe(2);
    });

    it("records totalDurationMs for the entire batch", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: withStoreUpdate(store, "ok"),
      });

      const specialists = new Map<string, AgentExecutionSpec>([
        ["agent-a", makeSpecialist("agent-a")],
        ["agent-b", makeSpecialist("agent-b")],
      ]);

      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
      });

      const tasks: TaskAssignment[] = [
        { task: "Task A", specialistId: "agent-a", input: {} },
        { task: "Task B", specialistId: "agent-b", input: {} },
      ];

      const aggregated = await supervisor.delegateAndCollect(tasks);

      expect(aggregated.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(typeof aggregated.totalDurationMs).toBe("number");
    });
  });

  // -----------------------------------------------------------------------
  // delegateAndCollect — circuit breaker filtering
  // -----------------------------------------------------------------------
  describe("delegateAndCollect — circuit breaker filtering", () => {
    it("skips tasks for agents filtered out by the circuit breaker", async () => {
      const circuitBreaker: AgentCircuitBreaker = {
        recordSuccess: vi.fn(),
        recordFailure: vi.fn(),
        recordTimeout: vi.fn(),
        // filterAvailable only returns agent-ok; agent-tripped is excluded
        filterAvailable: vi.fn((items: { id: string }[]) =>
          items.filter((a) => a.id !== "agent-tripped")
        ),
        isAvailable: vi.fn(() => true),
        getState: vi.fn(() => "closed"),
        reset: vi.fn(),
      } as unknown as AgentCircuitBreaker;

      const tracker = makeTrackerReturning({ success: true, output: "ok" });

      const supervisor = new DelegatingSupervisor({
        specialists: new Map([
          ["agent-ok", makeSpecialist("agent-ok")],
          ["agent-tripped", makeSpecialist("agent-tripped")],
        ]),
        tracker,
        circuitBreaker,
      });

      const aggregated = await supervisor.delegateAndCollect([
        { task: "Task A", specialistId: "agent-ok", input: {} },
        { task: "Task B", specialistId: "agent-tripped", input: {} },
      ]);

      // agent-tripped is filtered out — only agent-ok executes
      expect(aggregated.succeeded).toEqual(["agent-ok"]);
      expect(aggregated.failed).toEqual([]);
      expect(tracker.delegate).toHaveBeenCalledTimes(1);
    });

    it("emits supervisor:circuit_breaker_filtered when tasks are skipped", async () => {
      const localEventBus = createEventBus();
      const localEvents: DzupEvent[] = [];
      localEventBus.onAny((e) => localEvents.push(e));

      const circuitBreaker: AgentCircuitBreaker = {
        recordSuccess: vi.fn(),
        recordFailure: vi.fn(),
        recordTimeout: vi.fn(),
        filterAvailable: vi.fn((items: { id: string }[]) =>
          items.filter((a) => a.id === "agent-healthy")
        ),
        isAvailable: vi.fn(() => true),
        getState: vi.fn(() => "closed"),
        reset: vi.fn(),
      } as unknown as AgentCircuitBreaker;

      const supervisor = new DelegatingSupervisor({
        specialists: new Map([
          ["agent-healthy", makeSpecialist("agent-healthy")],
          ["agent-open", makeSpecialist("agent-open")],
        ]),
        tracker: makeTrackerReturning({ success: true, output: "ok" }),
        circuitBreaker,
        eventBus: localEventBus,
      });

      await supervisor.delegateAndCollect([
        { task: "Task A", specialistId: "agent-healthy", input: {} },
        { task: "Task B", specialistId: "agent-open", input: {} },
      ]);

      const filtered = localEvents.find(
        (e) => e.type === "supervisor:circuit_breaker_filtered"
      );
      expect(filtered).toBeDefined();
      expect((filtered as Record<string, unknown>).skipped).toContain(
        "agent-open"
      );
    });

    it("returns empty results when all tasks are circuit-breaker filtered", async () => {
      const circuitBreaker: AgentCircuitBreaker = {
        recordSuccess: vi.fn(),
        recordFailure: vi.fn(),
        recordTimeout: vi.fn(),
        filterAvailable: vi.fn(() => []), // everything filtered
        isAvailable: vi.fn(() => false),
        getState: vi.fn(() => "open"),
        reset: vi.fn(),
      } as unknown as AgentCircuitBreaker;

      const tracker = makeTrackerReturning({ success: true, output: "ok" });

      const supervisor = new DelegatingSupervisor({
        specialists: new Map([
          ["agent-a", makeSpecialist("agent-a")],
          ["agent-b", makeSpecialist("agent-b")],
        ]),
        tracker,
        circuitBreaker,
      });

      const aggregated = await supervisor.delegateAndCollect([
        { task: "Task A", specialistId: "agent-a", input: {} },
        { task: "Task B", specialistId: "agent-b", input: {} },
      ]);

      expect(aggregated.succeeded).toHaveLength(0);
      expect(aggregated.failed).toHaveLength(0);
      expect(aggregated.results.size).toBe(0);
      expect(tracker.delegate).not.toHaveBeenCalled();
    });

    it("does not filter when no circuit breaker is configured", async () => {
      const tracker = makeTrackerReturning({ success: true, output: "ok" });

      const supervisor = new DelegatingSupervisor({
        specialists: new Map([
          ["agent-a", makeSpecialist("agent-a")],
          ["agent-b", makeSpecialist("agent-b")],
        ]),
        tracker,
        // no circuitBreaker
      });

      const aggregated = await supervisor.delegateAndCollect([
        { task: "Task A", specialistId: "agent-a", input: {} },
        { task: "Task B", specialistId: "agent-b", input: {} },
      ]);

      expect(aggregated.succeeded).toHaveLength(2);
      expect(tracker.delegate).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------
  describe("accessors", () => {
    it("returns specialist IDs via specialistIds getter", () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        executor: withStoreUpdate(store),
      });

      const specialists = new Map<string, AgentExecutionSpec>([
        ["agent-db", makeSpecialist("agent-db")],
        ["agent-api", makeSpecialist("agent-api")],
      ]);

      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
      });

      expect(supervisor.specialistIds.sort()).toEqual([
        "agent-api",
        "agent-db",
      ]);
    });

    it("returns specialist definition via getSpecialist()", () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        executor: withStoreUpdate(store),
      });

      const dbDef = makeSpecialist("agent-db", {
        metadata: { tags: ["database"] },
      });
      const specialists = new Map<string, AgentExecutionSpec>([
        ["agent-db", dbDef],
      ]);

      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
      });

      expect(supervisor.getSpecialist("agent-db")).toBe(dbDef);
      expect(supervisor.getSpecialist("nonexistent")).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // delegateTask with providerPort
  // -----------------------------------------------------------------------
  describe("delegateTask with providerPort", () => {
    it("delegates via providerPort.run() when providerPort is set", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: withStoreUpdate(store, "tracker result"),
      });

      const mockProviderPort = {
        run: vi.fn(async () => ({
          content: "provider-port result",
          providerId: "claude" as const,
          attemptedProviders: ["claude" as const],
          fallbackAttempts: 0,
        })),
        stream: vi.fn(),
      };

      const specialists = new Map<string, AgentExecutionSpec>([
        [
          "db-specialist",
          makeSpecialist("db-specialist", {
            metadata: { tags: ["database", "sql"] },
          }),
        ],
      ]);

      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
        providerPort: mockProviderPort,
      });

      const result = await supervisor.delegateTask(
        "Create users table",
        "db-specialist",
        { tables: ["users"] }
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe("provider-port result");
      expect(mockProviderPort.run).toHaveBeenCalledTimes(1);
    });

    it("builds TaskDescriptor from TaskAssignment metadata", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        executor: withStoreUpdate(store),
      });

      const capturedTasks: unknown[] = [];
      const mockProviderPort = {
        run: vi.fn(async (_input: unknown, task: unknown) => {
          capturedTasks.push(task);
          return {
            content: "result",
            providerId: "claude" as const,
            attemptedProviders: ["claude" as const],
            fallbackAttempts: 0,
          };
        }),
        stream: vi.fn(),
      };

      const specialists = new Map<string, AgentExecutionSpec>([
        [
          "api-specialist",
          makeSpecialist("api-specialist", {
            metadata: { tags: ["api", "backend"] },
          }),
        ],
      ]);

      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
        providerPort: mockProviderPort,
      });

      await supervisor.delegateTask(
        "Build REST endpoints",
        "api-specialist",
        {}
      );

      expect(capturedTasks).toHaveLength(1);
      const task = capturedTasks[0] as { prompt: string; tags: string[] };
      expect(task.prompt).toBe("Build REST endpoints");
      expect(task.tags).toEqual(["api", "backend"]);
    });

    it("passes structured input, parent context, run options, and provider metadata through providerPort", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        executor: withStoreUpdate(store),
      });
      const parentContext = {
        parentRunId: "parent-run-1",
        decisions: ["Use PostgreSQL"],
        constraints: ["No schema drift"],
        relevantFiles: ["src/schema.ts"],
      };
      const structuredInput = {
        tables: ["users"],
        migration: { transactional: true },
      };
      const controller = new AbortController();
      const captured: Array<Parameters<ProviderExecutionPort["run"]>> = [];
      const mockProviderPort: ProviderExecutionPort = {
        run: vi.fn(
          async (...args: Parameters<ProviderExecutionPort["run"]>) => {
            captured.push(args);
            await new Promise((resolve) => setTimeout(resolve, 5));
            return {
              content: "provider result",
              providerId: "codex",
              attemptedProviders: ["claude", "codex"],
              fallbackAttempts: 1,
              metadata: {
                sessionId: "session-1",
                usageCents: 3,
              },
            };
          }
        ),
        stream: vi.fn(),
      };

      const supervisor = new DelegatingSupervisor({
        specialists: new Map([
          [
            "db-specialist",
            makeSpecialist("db-specialist", {
              metadata: { tags: ["database", "sql"] },
            }),
          ],
        ]),
        tracker,
        eventBus,
        parentContext,
        providerPort: mockProviderPort,
      });

      const result = await supervisor.delegateTask(
        "Create users table",
        "db-specialist",
        structuredInput,
        { runId: "delegation-run-1", signal: controller.signal }
      );

      expect(captured).toHaveLength(1);
      const [agentInput, taskDescriptor, runOptions] = captured[0]!;
      expect(agentInput.prompt).toBe("Create users table");
      expect(agentInput.signal).toBe(controller.signal);
      expect(agentInput.correlationId).toBe("delegation-run-1");
      expect(agentInput.options?.delegation).toEqual({
        task: "Create users table",
        specialistId: "db-specialist",
        input: structuredInput,
        context: parentContext,
      });
      expect(taskDescriptor).toEqual({
        prompt: "Create users table",
        tags: ["database", "sql"],
      });
      expect(runOptions).toEqual({
        runId: "delegation-run-1",
        signal: controller.signal,
      });
      expect(result.metadata).toMatchObject({
        specialistId: "db-specialist",
        providerId: "codex",
        attemptedProviders: ["claude", "codex"],
        fallbackAttempts: 1,
        providerMetadata: {
          sessionId: "session-1",
          usageCents: 3,
        },
      });
      expect(result.metadata?.durationMs).toBeGreaterThan(0);
    });

    it("emits supervisor events even when using providerPort", async () => {
      const tracker = new SimpleDelegationTracker({
        runStore: store,
        eventBus,
        executor: withStoreUpdate(store),
      });

      const mockProviderPort = {
        run: vi.fn(async () => ({
          content: "port result",
          providerId: "gemini" as const,
          attemptedProviders: ["gemini" as const],
          fallbackAttempts: 0,
        })),
        stream: vi.fn(),
      };

      const specialists = new Map<string, AgentExecutionSpec>([
        [
          "ui-specialist",
          makeSpecialist("ui-specialist", {
            metadata: { tags: ["ui"] },
          }),
        ],
      ]);

      const supervisor = new DelegatingSupervisor({
        specialists,
        tracker,
        eventBus,
        providerPort: mockProviderPort,
      });

      await supervisor.delegateTask("Build login page", "ui-specialist", {});

      const delegating = events.find((e) => e.type === "supervisor:delegating");
      const complete = events.find(
        (e) => e.type === "supervisor:delegation_complete"
      );

      expect(delegating).toBeDefined();
      expect((delegating as Record<string, unknown>).specialistId).toBe(
        "ui-specialist"
      );
      expect((delegating as Record<string, unknown>).task).toBe(
        "Build login page"
      );

      expect(complete).toBeDefined();
      expect((complete as Record<string, unknown>).success).toBe(true);
    });
  });
});
