import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import {
  createEventBus,
  type AgentExecutionSpec,
  type DzupEvent,
} from "@dzupagent/core";
import { describe, expect, it, vi } from "vitest";
import { DzupAgent } from "../agent/dzip-agent.js";
import {
  DelegatingSupervisor,
  type PlanAndDelegateOptions,
} from "../orchestration/delegating-supervisor.js";
import type {
  DelegationRequest,
  DelegationResult,
  DelegationTracker,
} from "../orchestration/delegation.js";
import { AgentOrchestrator } from "../orchestration/orchestrator.js";
import { HashRouting } from "../orchestration/routing/hash-routing.js";
import { LLMRouting } from "../orchestration/routing/llm-routing.js";
import { RoundRobinRouting } from "../orchestration/routing/round-robin-routing.js";
import { RuleBasedRouting } from "../orchestration/routing/rule-based-routing.js";
import type {
  AgentSpec,
  AgentTask,
  RoutingDecision,
  RoutingPolicy,
} from "../orchestration/routing-policy-types.js";
import { routeSubtasksViaPolicy } from "../orchestration/specialist-selection.js";
import type { SupervisorConfig } from "../orchestration/supervisor-types.js";

function createMockModel(content = "done"): BaseChatModel {
  return {
    invoke: vi.fn(async (_messages: BaseMessage[]) =>
      new AIMessage({ content, response_metadata: {} })
    ),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this;
    }),
    _modelType: () => "base_chat_model",
    _llmType: () => "mock",
  } as unknown as BaseChatModel;
}

function createAgent(id: string, model = createMockModel()): DzupAgent {
  return new DzupAgent({
    id,
    name: id,
    description: `${id} specialist`,
    instructions: `You are ${id}.`,
    model,
  });
}

function executionSpec(id: string, tags: string[]): AgentExecutionSpec {
  return {
    id,
    name: id,
    instructions: `You are ${id}.`,
    modelTier: "codegen",
    metadata: { tags },
  };
}

function createTracker(): {
  tracker: DelegationTracker;
  requests: DelegationRequest[];
} {
  const requests: DelegationRequest[] = [];
  const tracker: DelegationTracker = {
    delegate: vi.fn(async (request): Promise<DelegationResult> => {
      requests.push(request);
      return {
        success: true,
        output: `output:${request.targetAgentId}`,
        metadata: {
          specialistId: request.targetAgentId,
          durationMs: 0,
        },
      };
    }),
    getActiveDelegations: vi.fn(() => []),
    cancel: vi.fn(() => false),
  };
  return { tracker, requests };
}

const candidates: AgentSpec[] = [
  { id: "db", name: "Database", tags: ["database"] },
  { id: "ui", name: "UI", tags: ["ui"] },
  { id: "api", name: "API", tags: ["api"] },
];

describe("T2-4 routing task identity and admission", () => {
  it("routes a direct supervisor through real production task tags", async () => {
    const result = await AgentOrchestrator.supervisor({
      manager: createAgent("manager"),
      specialists: [createAgent("db"), createAgent("api")],
      task: "Add a database migration",
      routingPolicy: new RuleBasedRouting({
        rules: [{ tag: "database", agentId: "db" }],
        fallbackAgentId: "api",
      }),
    });

    expect(result.availableSpecialists).toEqual(["db"]);
  });

  it("routes every decomposed subtask through real production task tags", async () => {
    const { tracker, requests } = createTracker();
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["db", executionSpec("db", ["database"])],
        ["ui", executionSpec("ui", ["ui"])],
      ]),
      tracker,
      routingPolicy: new RuleBasedRouting({
        rules: [
          { tag: "database", agentId: "db" },
          { tag: "ui", agentId: "ui" },
        ],
        fallbackAgentId: "db",
      }),
    });

    await supervisor.planAndDelegate(
      "create a database migration and build a UI component"
    );

    expect(requests.map((request) => request.targetAgentId)).toEqual([
      "db",
      "ui",
    ]);
  });

  it("gives repeated direct tasks stable IDs and hash selections", async () => {
    const capturedTasks: AgentTask[] = [];
    const selected: string[] = [];
    const hash = new HashRouting();
    const routingPolicy: RoutingPolicy = {
      select(task, available) {
        capturedTasks.push(task);
        const decision = hash.select(task, available);
        selected.push(decision.selected[0]!.id);
        return decision;
      },
    };
    let tick = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => tick++);

    try {
      const config = {
        manager: createAgent("manager"),
        specialists: [createAgent("db"), createAgent("ui"), createAgent("api")],
        task: "route this stable database task",
        routingPolicy,
      };
      await AgentOrchestrator.supervisor(config);
      await AgentOrchestrator.supervisor(config);
    } finally {
      clock.mockRestore();
    }

    expect(capturedTasks).toHaveLength(2);
    expect(capturedTasks[0]!.taskId).toBe(capturedTasks[1]!.taskId);
    expect(selected[0]).toBe(selected[1]);
  });

  it("gives repeated decomposed subtasks stable and distinct task IDs", () => {
    const captured: AgentTask[][] = [[], []];
    const hash = new HashRouting();
    let run = 0;
    const routingPolicy: RoutingPolicy = {
      select(task, available) {
        captured[run]!.push(task);
        return hash.select(task, available);
      },
    };
    let tick = 2_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => tick++);
    const random = vi.spyOn(Math, "random").mockImplementation(() => tick++ / 10_000);

    try {
      routeSubtasksViaPolicy(
        ["database migration", "UI component"],
        routingPolicy,
        candidates
      );
      run = 1;
      routeSubtasksViaPolicy(
        ["database migration", "UI component"],
        routingPolicy,
        candidates
      );
    } finally {
      clock.mockRestore();
      random.mockRestore();
    }

    expect(captured[0]!.map((task) => task.taskId)).toEqual(
      captured[1]!.map((task) => task.taskId)
    );
    expect(new Set(captured[0]!.map((task) => task.taskId)).size).toBe(2);
  });

  it("mints unique decision IDs for every built-in policy under a fixed clock", () => {
    const task: AgentTask = { taskId: "stable-task", content: "database" };
    const policies: RoutingPolicy[] = [
      new RuleBasedRouting({ rules: [], fallbackAgentId: "db" }),
      new HashRouting(),
      new RoundRobinRouting(),
      new LLMRouting({ fallback: "first-candidate" }),
    ];
    const clock = vi.spyOn(Date, "now").mockReturnValue(42);

    try {
      for (const policy of policies) {
        const first = policy.select(task, candidates).routingDecisionId;
        const second = policy.select(task, candidates).routingDecisionId;
        expect(first).toEqual(expect.any(String));
        expect(second).toEqual(expect.any(String));
        expect(first).not.toBe(second);
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("correlates a direct custom-policy event/result with stable task and unique decision IDs", async () => {
    const bus = createEventBus();
    const events: DzupEvent[] = [];
    bus.onAny((event) => events.push(event));
    let capturedTask: AgentTask | undefined;
    const policy: RoutingPolicy = {
      select(task, available) {
        capturedTask = task;
        return {
          selected: [available[0]!],
          strategy: "custom",
          reason: "first",
        };
      },
    };

    const result = await AgentOrchestrator.supervisor({
      manager: createAgent("manager"),
      specialists: [createAgent("db")],
      task: "database task",
      routingPolicy: policy,
      eventBus: bus,
    });

    const event = events.find(
      (candidate) =>
        candidate.type === "supervisor:routing_decision" &&
        candidate.source === "direct-supervisor"
    );
    expect(capturedTask?.taskId).toEqual(expect.any(String));
    expect(result.routingDecisionId).toEqual(expect.any(String));
    expect(event).toMatchObject({
      taskId: capturedTask!.taskId,
      routingDecisionId: result.routingDecisionId,
    });
  });

  it("emits task and decision identity for delegating-supervisor routing", () => {
    const bus = createEventBus();
    const events: DzupEvent[] = [];
    bus.onAny((event) => events.push(event));
    const policy: RoutingPolicy = {
      select(_task, available) {
        return {
          selected: [available[0]!],
          strategy: "custom",
          reason: "first",
        };
      },
    };

    routeSubtasksViaPolicy(["database task"], policy, candidates, bus);

    const event = events.find(
      (candidate) =>
        candidate.type === "supervisor:routing_decision" &&
        candidate.source === "delegating-supervisor"
    );
    expect(event).toMatchObject({
      taskId: expect.any(String),
      routingDecisionId: expect.any(String),
    });
  });

  it("rejects an empty direct policy selection before manager or specialist effects", async () => {
    const managerModel = createMockModel();
    const specialist = createAgent("db");
    const asTool = vi.spyOn(specialist, "asTool");
    const policy: RoutingPolicy = {
      select: vi.fn((): RoutingDecision => ({
        selected: [],
        strategy: "custom",
        reason: "none",
      })),
    };

    await expect(
      AgentOrchestrator.supervisor({
        manager: createAgent("manager", managerModel),
        specialists: [specialist],
        task: "database task",
        routingPolicy: policy,
      })
    ).rejects.toThrow(/routing policy.*select/i);
    expect(managerModel.invoke).not.toHaveBeenCalled();
    expect(asTool).not.toHaveBeenCalled();
  });

  it("rejects a foreign-only direct selection before effects", async () => {
    const managerModel = createMockModel();
    const policy: RoutingPolicy = {
      select: vi.fn(() => ({
        selected: [{ id: "ghost", name: "Ghost" }],
        strategy: "custom",
        reason: "foreign",
      })),
    };

    await expect(
      AgentOrchestrator.supervisor({
        manager: createAgent("manager", managerModel),
        specialists: [createAgent("db")],
        task: "database task",
        routingPolicy: policy,
      })
    ).rejects.toThrow(/routing policy.*candidate/i);
    expect(managerModel.invoke).not.toHaveBeenCalled();
  });

  it("rejects one empty subtask decision before delegating any sibling", async () => {
    const { tracker, requests } = createTracker();
    let call = 0;
    const policy: RoutingPolicy = {
      select(_task, available) {
        call += 1;
        return {
          selected: call === 1 ? [available[0]!] : [],
          strategy: "custom",
          reason: call === 1 ? "first" : "none",
        };
      },
    };
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([
        ["db", executionSpec("db", ["database"])],
        ["ui", executionSpec("ui", ["ui"])],
      ]),
      tracker,
      routingPolicy: policy,
    });

    await expect(
      supervisor.planAndDelegate("database migration and UI component")
    ).rejects.toThrow(/routing policy.*select/i);
    expect(requests).toEqual([]);
  });

  it("does not turn candidate capability tags into task requirements", () => {
    let captured: AgentTask | undefined;
    const policy: RoutingPolicy = {
      select(task, available) {
        captured = task;
        return {
          selected: [available[0]!],
          strategy: "custom",
          reason: "capture",
        };
      },
    };

    routeSubtasksViaPolicy(
      ["neutral work"],
      policy,
      [{ id: "candidate", name: "Candidate", tags: ["candidate-only"] }]
    );

    expect(captured?.tags ?? []).not.toContain("candidate-only");
  });

  it("preserves explicit direct task identity, tags, and metadata", async () => {
    let captured: AgentTask | undefined;
    const policy: RoutingPolicy = {
      select(task, available) {
        captured = task;
        return {
          selected: [available[0]!],
          strategy: "custom",
          reason: "capture",
        };
      },
    };
    const config: SupervisorConfig & {
      routingTask: {
        taskId: string;
        tags: readonly string[];
        metadata: Record<string, unknown>;
      };
    } = {
      manager: createAgent("manager"),
      specialists: [createAgent("db")],
      task: "database task",
      routingPolicy: policy,
      routingTask: {
        taskId: "caller-task-7",
        tags: ["caller-tag"],
        metadata: { shard: "blue" },
      },
    };

    await AgentOrchestrator.supervisor(config);

    expect(captured).toMatchObject({
      taskId: "caller-task-7",
      tags: expect.arrayContaining(["caller-tag", "database"]),
      metadata: { shard: "blue" },
    });
  });

  it("preserves explicit goal context on deterministic subtask identities", async () => {
    const { tracker } = createTracker();
    const captured: AgentTask[] = [];
    const policy: RoutingPolicy = {
      select(task, available) {
        captured.push(task);
        return {
          selected: [available[0]!],
          strategy: "custom",
          reason: "capture",
        };
      },
    };
    const supervisor = new DelegatingSupervisor({
      specialists: new Map([["db", executionSpec("db", ["database"])]]),
      tracker,
      routingPolicy: policy,
    });
    const options = {
      routingTask: {
        taskId: "goal-task-9",
        tags: ["caller-tag"],
        metadata: { shard: "green" },
      },
    } as PlanAndDelegateOptions;

    await supervisor.planAndDelegate(
      "database migration and database schema",
      options
    );

    expect(captured).toHaveLength(2);
    expect(captured.map((task) => task.taskId)).toEqual([
      expect.stringMatching(/^goal-task-9:/),
      expect.stringMatching(/^goal-task-9:/),
    ]);
    expect(new Set(captured.map((task) => task.taskId)).size).toBe(2);
    for (const task of captured) {
      expect(task.tags).toEqual(expect.arrayContaining(["caller-tag", "database"]));
      expect(task.metadata).toEqual({ shard: "green" });
    }
  });

  it("rejects a blank explicit task ID before direct effects", async () => {
    const managerModel = createMockModel();
    const config = {
      manager: createAgent("manager", managerModel),
      specialists: [createAgent("db")],
      task: "database task",
      routingPolicy: new HashRouting(),
      routingTask: { taskId: "   " },
    } as SupervisorConfig;

    await expect(AgentOrchestrator.supervisor(config)).rejects.toThrow(
      /taskId.*non-blank/i
    );
    expect(managerModel.invoke).not.toHaveBeenCalled();
  });

  it("keeps legacy callers without routingTask compatible", async () => {
    const result = await AgentOrchestrator.supervisor({
      manager: createAgent("manager"),
      specialists: [createAgent("db")],
      task: "legacy task",
      routingPolicy: new HashRouting(),
    });

    expect(result.availableSpecialists).toEqual(["db"]);
    expect(result.routingDecisionId).toEqual(expect.any(String));
  });
});
