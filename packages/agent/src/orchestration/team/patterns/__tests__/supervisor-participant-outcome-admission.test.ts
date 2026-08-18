/**
 * Admission coverage for truthful supervisor specialist participation.
 *
 * The direct supervisor observations below exercise real LangChain tool
 * invocation. Pattern-only cases use a narrow supervisor double so lifecycle
 * aggregation can be asserted without a provider or wall-clock timing.
 */
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DzupAgent } from "../../../../agent/dzip-agent.js";
import { AgentOrchestrator } from "../../../orchestrator.js";
import { instrumentSpecialistTool } from "../../../specialist-tool-instrumentation.js";
import { TeamRuntime } from "../../team-runtime.js";
import type {
  ParticipantDefinition,
  TeamDefinition,
} from "../../team-definition.js";
import type { TeamSpawnedAgent } from "../../team-workspace.js";
import { supervisorPattern } from "../supervisor-pattern.js";
import { buildContext, buildResolved } from "./test-helpers.js";

interface InvocationStart {
  specialistId: string;
  invocationIndex: number;
}

interface InvocationOutcome extends InvocationStart {
  success: boolean;
  durationMs: number;
  error?: string;
}

interface InvocationObserver {
  onStart?: (invocation: InvocationStart) => unknown;
  onComplete?: (outcome: InvocationOutcome) => unknown;
}

interface ObservableSupervisorConfig {
  invocationObserver?: InvocationObserver;
}

interface ObservableSupervisorResult {
  content: string;
  availableSpecialists: string[];
  filteredSpecialists: string[];
  specialistInvocations?: InvocationOutcome[];
}

type ModelStep =
  | {
      content: string;
      toolCalls?: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
      }>;
    }
  | { error: Error };

function createSequencedModel(steps: ModelStep[]): {
  model: BaseChatModel;
  invoke: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    const step = steps[index] ?? steps[steps.length - 1]!;
    index += 1;
    if ("error" in step) throw step.error;
    return new AIMessage({
      content: step.content,
      ...(step.toolCalls
        ? {
            tool_calls: step.toolCalls.map((call) => ({
              ...call,
              type: "tool_call" as const,
            })),
          }
        : {}),
      response_metadata: {},
    });
  });
  return {
    model: {
      invoke,
      bindTools: vi.fn(function (this: BaseChatModel) {
        return this;
      }),
      _modelType: () => "base_chat_model",
      _llmType: () => "mock",
    } as unknown as BaseChatModel,
    invoke,
  };
}

function createAgent(id: string, model: BaseChatModel): DzupAgent {
  return new DzupAgent({
    id,
    description: `${id} agent`,
    instructions: `You are ${id}.`,
    model,
  });
}

function toolCall(id: string, specialistId: string) {
  return {
    content: "",
    toolCalls: [
      {
        id,
        name: `agent-${specialistId}`,
        args: { task: `task-${id}` },
      },
    ],
  } satisfies ModelStep;
}

function observeSupervisor(
  config: Record<string, unknown>,
  observer: InvocationObserver
): Promise<ObservableSupervisorResult> {
  return AgentOrchestrator.supervisor({
    ...config,
    invocationObserver: observer,
  } as never) as Promise<ObservableSupervisorResult>;
}

function mockPatternSupervisor(
  invocations: InvocationOutcome[],
  options?: { content?: string; error?: unknown }
) {
  return vi
    .spyOn(AgentOrchestrator, "supervisor")
    .mockImplementation(
      (async (rawConfig: unknown) => {
        const config = rawConfig as ObservableSupervisorConfig;
        for (const invocation of invocations) {
          await config.invocationObserver?.onStart?.({
            specialistId: invocation.specialistId,
            invocationIndex: invocation.invocationIndex,
          });
          await config.invocationObserver?.onComplete?.(invocation);
        }
        if (options && "error" in options) throw options.error;
        return {
          content: options?.content ?? "manager-result",
          availableSpecialists: [
            ...new Set(invocations.map((item) => item.specialistId)),
          ],
          filteredSpecialists: [],
          specialistInvocations: invocations,
        } satisfies ObservableSupervisorResult;
      }) as never
    );
}

beforeEach(() => {
  AgentOrchestrator.clearSupervisorCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("direct supervisor specialist invocation evidence", () => {
  it("observes one real successful invocation in start/completion order", async () => {
    const manager = createAgent(
      "manager-success",
      createSequencedModel([
        toolCall("call-success", "successful"),
        { content: "manager completed" },
      ]).model
    );
    const specialist = createAgent(
      "successful",
      createSequencedModel([{ content: "specialist completed" }]).model
    );
    const events: string[] = [];

    const result = await observeSupervisor(
      { manager, specialists: [specialist], task: "delegate" },
      {
        onStart: (item) => events.push(`start:${item.specialistId}`),
        onComplete: (item) =>
          events.push(`complete:${item.specialistId}:${item.success}`),
      }
    );

    expect(events).toEqual([
      "start:successful",
      "complete:successful:true",
    ]);
    expect(result.specialistInvocations).toEqual([
      expect.objectContaining({
        specialistId: "successful",
        invocationIndex: 0,
        success: true,
      }),
    ]);
    expect(result.specialistInvocations![0]!.durationMs).toBeGreaterThanOrEqual(
      0
    );
    expect(Object.keys(result.specialistInvocations![0]!).sort()).toEqual([
      "durationMs",
      "invocationIndex",
      "specialistId",
      "success",
    ]);
    expect("error" in result.specialistInvocations![0]!).toBe(false);
  });

  it("retains a failed invocation when the manager recovers", async () => {
    const manager = createAgent(
      "manager-recovery",
      createSequencedModel([
        toolCall("call-failure", "flaky"),
        { content: "manager recovered" },
      ]).model
    );
    const specialistError = new Error("specialist rejected");
    const specialist = createAgent(
      "flaky",
      createSequencedModel([{ error: specialistError }]).model
    );

    const result = await observeSupervisor(
      { manager, specialists: [specialist], task: "recover" },
      {}
    );

    expect(result.content).toBe("manager recovered");
    expect(result.specialistInvocations).toEqual([
      expect.objectContaining({
        specialistId: "flaky",
        invocationIndex: 0,
        success: false,
        error: "specialist rejected",
      }),
    ]);
    expect(Object.keys(result.specialistInvocations![0]!).sort()).toEqual([
      "durationMs",
      "error",
      "invocationIndex",
      "specialistId",
      "success",
    ]);
  });

  it("assigns monotonic indices to repeated real invocations", async () => {
    const manager = createAgent(
      "manager-repeat",
      createSequencedModel([
        toolCall("call-1", "repeat"),
        toolCall("call-2", "repeat"),
        { content: "manager combined" },
      ]).model
    );
    const specialist = createAgent(
      "repeat",
      createSequencedModel([
        { error: new Error("first failed") },
        { content: "second succeeded" },
      ]).model
    );

    const result = await observeSupervisor(
      { manager, specialists: [specialist], task: "repeat" },
      {}
    );

    expect(
      result.specialistInvocations?.map((item) => [
        item.specialistId,
        item.invocationIndex,
        item.success,
      ])
    ).toEqual([
      ["repeat", 0, false],
      ["repeat", 1, true],
    ]);
  });

  it("isolates successful tool results from throwing observer callbacks", async () => {
    const manager = createAgent(
      "manager-observer-success",
      createSequencedModel([
        toolCall("call-observer-success", "observer-success"),
        { content: "observer failure ignored" },
      ]).model
    );
    const specialist = createAgent(
      "observer-success",
      createSequencedModel([{ content: "tool result" }]).model
    );
    const onStart = vi.fn(async () => {
      throw new Error("start observer failed");
    });
    const onComplete = vi.fn(() => {
      throw new Error("completion observer failed");
    });

    const result = await observeSupervisor(
      { manager, specialists: [specialist], task: "observe" },
      { onStart, onComplete }
    );

    expect(result.content).toBe("observer failure ignored");
    expect(onStart).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(result.specialistInvocations?.[0]?.success).toBe(true);
  });

  it("brackets the real call and records the direct breaker exactly once", async () => {
    const order: string[] = [];
    const invoke = vi.fn(async () => {
      order.push("invoke");
      return "tool result";
    });
    const circuitBreaker = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      recordTimeout: vi.fn(),
    };
    const wrapped = instrumentSpecialistTool(
      { invoke } as never,
      "breaker-specialist",
      circuitBreaker as never,
      {
        nextInvocationIndex: () => 3,
        observer: {
          onStart: () => order.push("start"),
          onComplete: () => order.push("complete"),
        },
      } as never
    ) as unknown as { invoke(input: unknown): Promise<unknown> };

    await expect(wrapped.invoke({ task: "not retained" })).resolves.toBe(
      "tool result"
    );
    expect(order).toEqual(["start", "invoke", "complete"]);
    expect(circuitBreaker.recordSuccess).toHaveBeenCalledOnce();
    expect(circuitBreaker.recordSuccess).toHaveBeenCalledWith(
      "breaker-specialist"
    );
    expect(circuitBreaker.recordFailure).not.toHaveBeenCalled();
    expect(circuitBreaker.recordTimeout).not.toHaveBeenCalled();
  });

  it("rethrows the original tool exception after best-effort observation", async () => {
    const originalError = new Error("original tool failure");
    const invoke = vi.fn(async () => {
      throw originalError;
    });
    const onStart = vi.fn(() => {
      throw new Error("ignored start observer failure");
    });
    const onComplete = vi.fn(() => {
      throw new Error("ignored completion observer failure");
    });
    const wrapped = instrumentSpecialistTool(
      { invoke } as never,
      "exact-error",
      undefined,
      {
        nextInvocationIndex: () => 0,
        observer: { onStart, onComplete },
      } as never
    ) as unknown as { invoke(input: unknown): Promise<unknown> };

    let caught: unknown;
    try {
      await wrapped.invoke({ task: "hidden" });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBe(originalError);
    expect(onStart).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        specialistId: "exact-error",
        invocationIndex: 0,
        success: false,
        error: "original tool failure",
      })
    );
  });

  it("does not reuse a cached wrapper with the previous run observer", async () => {
    const manager = createAgent(
      "manager-cache-observer",
      createSequencedModel([
        toolCall("call-run-1", "cache-specialist"),
        { content: "run one" },
        toolCall("call-run-2", "cache-specialist"),
        { content: "run two" },
      ]).model
    );
    const specialist = createAgent(
      "cache-specialist",
      createSequencedModel([
        { content: "first" },
        { content: "second" },
      ]).model
    );
    const asTool = vi.spyOn(specialist, "asTool");
    const first = vi.fn();
    const second = vi.fn();

    await observeSupervisor(
      { manager, specialists: [specialist], task: "run one" },
      { onComplete: first }
    );
    await observeSupervisor(
      { manager, specialists: [specialist], task: "run two" },
      { onComplete: second }
    );

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(asTool).toHaveBeenCalledTimes(2);
  });

  it("omits filtered specialists from observed invocation evidence", async () => {
    const manager = createAgent(
      "manager-routing",
      createSequencedModel([
        toolCall("call-selected", "selected"),
        { content: "selected only" },
      ]).model
    );
    const selected = createAgent(
      "selected",
      createSequencedModel([{ content: "selected result" }]).model
    );
    const filtered = createAgent(
      "filtered",
      createSequencedModel([{ content: "must not run" }]).model
    );
    const starts: string[] = [];

    const result = await observeSupervisor(
      {
        manager,
        specialists: [selected, filtered],
        task: "route",
        routingPolicy: {
          select: (_task: unknown, candidates: Array<{ id: string }>) => ({
            selected: candidates.filter((candidate) => candidate.id === "selected"),
            reason: "admission selection",
            strategy: "rule",
            routingDecisionId: "admission-route",
          }),
        },
      },
      { onStart: (item) => starts.push(item.specialistId) }
    );

    expect(starts).toEqual(["selected"]);
    expect(result.specialistInvocations?.map((item) => item.specialistId)).toEqual([
      "selected",
    ]);
  });

  it("reports no local invocation evidence in provider-adapter mode", async () => {
    const manager = createAgent(
      "manager-provider-adapter",
      createSequencedModel([{ content: "unused" }]).model
    );
    const specialist = createAgent(
      "provider-specialist",
      createSequencedModel([{ content: "unused" }]).model
    );
    const onStart = vi.fn();
    const onComplete = vi.fn();

    const result = await observeSupervisor(
      {
        manager,
        specialists: [specialist],
        task: "adapter execution",
        executionMode: "provider-adapter",
        providerPort: {
          run: vi.fn(async () => ({ content: "adapter result" })),
        },
      },
      { onStart, onComplete }
    );

    expect(result.content).toBe("adapter result");
    expect(result.specialistInvocations).toEqual([]);
    expect(onStart).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("keeps the legacy positional supervisor result as a string", async () => {
    const manager = createAgent(
      "legacy-manager-admission",
      createSequencedModel([{ content: "legacy string" }]).model
    );
    const specialist = createAgent(
      "legacy-specialist-admission",
      createSequencedModel([{ content: "unused" }]).model
    );

    const result = await AgentOrchestrator.supervisor(
      manager,
      [specialist],
      "legacy task"
    );

    expect(result).toBe("legacy string");
    expect(typeof result).toBe("string");
  });
});

describe("supervisor team participant outcome aggregation", () => {
  it("omits an available but uninvoked specialist from lifecycle and results", async () => {
    mockPatternSupervisor([]);
    const { ctx, calls } = buildContext("supervisor", [
      buildResolved("manager", { role: "supervisor" }),
      buildResolved("unused", { role: "specialist" }),
    ]);

    const result = await supervisorPattern.execute(ctx);

    expect(calls.starts).toEqual(["manager"]);
    expect(calls.completes.map((call) => call.id)).toEqual(["manager"]);
    expect(result.agentResults.map((item) => item.agentId)).toEqual(["manager"]);
  });

  it("reports one invoked successful specialist exactly once", async () => {
    mockPatternSupervisor([
      {
        specialistId: "successful",
        invocationIndex: 0,
        success: true,
        durationMs: 4,
      },
    ]);
    const { ctx, calls } = buildContext("supervisor", [
      buildResolved("manager", { role: "supervisor" }),
      buildResolved("successful", { role: "specialist" }),
    ]);

    const result = await supervisorPattern.execute(ctx);

    expect(calls.starts).toEqual(["manager", "successful"]);
    expect(calls.completes.filter((call) => call.id === "successful")).toEqual([
      expect.objectContaining({ success: true, durationMs: 4 }),
    ]);
    expect(result.agentResults.find((item) => item.agentId === "successful")).toEqual(
      expect.objectContaining({ success: true, durationMs: 4, content: "" })
    );
  });

  it("keeps a recovered specialist failure while the manager succeeds", async () => {
    mockPatternSupervisor(
      [
        {
          specialistId: "flaky",
          invocationIndex: 0,
          success: false,
          durationMs: 7,
          error: "flaky failed",
        },
      ],
      { content: "manager recovered" }
    );
    const { ctx, calls } = buildContext("supervisor", [
      buildResolved("manager", { role: "supervisor" }),
      buildResolved("flaky", { role: "specialist" }),
    ]);

    const result = await supervisorPattern.execute(ctx);

    expect(result.agentResults[0]).toEqual(
      expect.objectContaining({ agentId: "manager", success: true })
    );
    expect(result.agentResults[1]).toEqual(
      expect.objectContaining({
        agentId: "flaky",
        success: false,
        durationMs: 7,
        error: "flaky failed",
      })
    );
    expect(calls.completes.find((call) => call.id === "flaky")?.success).toBe(
      false
    );
  });

  it("aggregates repeated calls and never lets later success erase failure", async () => {
    mockPatternSupervisor([
      {
        specialistId: "repeat",
        invocationIndex: 0,
        success: false,
        durationMs: 2,
        error: "first failure",
      },
      {
        specialistId: "repeat",
        invocationIndex: 1,
        success: true,
        durationMs: 3,
      },
    ]);
    const { ctx, calls } = buildContext("supervisor", [
      buildResolved("manager", { role: "supervisor" }),
      buildResolved("repeat", { role: "specialist" }),
    ]);

    const result = await supervisorPattern.execute(ctx);
    const specialistResult = result.agentResults.find(
      (item) => item.agentId === "repeat"
    );

    expect(calls.starts).toEqual(["manager", "repeat", "repeat"]);
    expect(calls.completes.filter((call) => call.id === "repeat")).toHaveLength(
      1
    );
    expect(specialistResult).toEqual(
      expect.objectContaining({
        success: false,
        durationMs: 5,
        error: "first failure",
      })
    );
  });

  it("orders specialist results by first real invocation", async () => {
    mockPatternSupervisor([
      {
        specialistId: "beta",
        invocationIndex: 0,
        success: true,
        durationMs: 1,
      },
      {
        specialistId: "alpha",
        invocationIndex: 1,
        success: true,
        durationMs: 1,
      },
    ]);
    const { ctx } = buildContext("supervisor", [
      buildResolved("manager", { role: "supervisor" }),
      buildResolved("alpha", { role: "specialist" }),
      buildResolved("beta", { role: "specialist" }),
    ]);

    const result = await supervisorPattern.execute(ctx);

    expect(result.agentResults.map((item) => item.agentId)).toEqual([
      "manager",
      "beta",
      "alpha",
    ]);
  });

  it("retains completed specialist outcomes when the manager fails", async () => {
    const managerError = new Error("manager failed");
    mockPatternSupervisor(
      [
        {
          specialistId: "ran",
          invocationIndex: 0,
          success: true,
          durationMs: 6,
        },
      ],
      { error: managerError }
    );
    const { ctx, calls } = buildContext("supervisor", [
      buildResolved("manager", { role: "supervisor" }),
      buildResolved("ran", { role: "specialist" }),
      buildResolved("unused", { role: "specialist" }),
    ]);

    let caught: unknown;
    try {
      await supervisorPattern.execute(ctx);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBe(managerError);
    expect(calls.completes).toEqual([
      expect.objectContaining({ id: "manager", success: false }),
      expect.objectContaining({ id: "ran", success: true, durationMs: 6 }),
    ]);
    expect(calls.completes.some((call) => call.id === "unused")).toBe(false);
  });

  it("preserves the no-specialist single-participant fallback", async () => {
    const { ctx } = buildContext("supervisor", [
      buildResolved("manager", {
        role: "supervisor",
        response: "single result",
      }),
    ]);

    const result = await supervisorPattern.execute(ctx);

    expect(result.pattern).toBe("single-participant");
    expect(result.content).toBe("single result");
  });
});

describe("supervisor team breaker truthfulness", () => {
  it("trips on actual recovered failures and an uninvoked run cannot reset history", async () => {
    const managerSequence = createSequencedModel([
      toolCall("failure-1", "flaky-team"),
      { content: "recovered one" },
      { content: "did not delegate" },
      toolCall("failure-2", "flaky-team"),
      { content: "recovered two" },
      { content: "specialist filtered" },
    ]);
    const specialistSequence = createSequencedModel([
      { error: new Error("first team failure") },
      { error: new Error("second team failure") },
    ]);
    const manager = createAgent("manager-team", managerSequence.model);
    const specialist = createAgent("flaky-team", specialistSequence.model);
    const definition: TeamDefinition = {
      id: "truthful-supervisor-team",
      name: "Truthful supervisor team",
      coordinatorPattern: "supervisor",
      participants: [
        { id: "manager-team", role: "supervisor", model: "mock" },
        { id: "flaky-team", role: "specialist", model: "mock" },
      ],
    };
    const participants = new Map<string, DzupAgent>([
      ["manager-team", manager],
      ["flaky-team", specialist],
    ]);
    const resolver = async (
      participant: ParticipantDefinition
    ): Promise<TeamSpawnedAgent> => ({
      agent: participants.get(participant.id)!,
      status: "idle",
      role: participant.role as TeamSpawnedAgent["role"],
      tags: [],
      spawnedAt: Date.now(),
    });
    const runtime = new TeamRuntime({
      definition,
      resolveParticipant: resolver,
      supervisionPolicy: {
        maxFailuresBeforeCircuitBreak: 2,
        resetAfterMs: 60_000,
      },
    });

    const first = await runtime.execute("first");
    const uninvoked = await runtime.execute("uninvoked");
    const second = await runtime.execute("second");
    const filtered = await runtime.execute("filtered");

    expect(first.agentResults.find((item) => item.agentId === "flaky-team"))
      .toEqual(expect.objectContaining({ success: false }));
    expect(
      uninvoked.agentResults.some((item) => item.agentId === "flaky-team")
    ).toBe(false);
    expect(second.agentResults.find((item) => item.agentId === "flaky-team"))
      .toEqual(expect.objectContaining({ success: false }));
    expect(specialistSequence.invoke).toHaveBeenCalledTimes(2);
    expect(
      filtered.agentResults.some((item) => item.agentId === "flaky-team")
    ).toBe(false);
    expect(filtered.pattern).toBe("single-participant");
  });
});
