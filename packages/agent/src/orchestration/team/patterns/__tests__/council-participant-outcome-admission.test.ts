import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DzupAgent } from "../../../../agent/dzip-agent.js";
import type {
  DebateInvocationOutcome,
  DebateInvocationStart,
} from "../../../debate-types.js";
import { AgentOrchestrator } from "../../../orchestrator.js";
import type { ParticipantDefinition } from "../../team-definition.js";
import { TeamRuntime } from "../../team-runtime.js";
import type { TeamSpawnedAgent } from "../../team-workspace.js";
import { councilPattern } from "../council-pattern.js";
import type { ResolvedParticipant } from "../team-pattern.js";
import { buildContext, buildResolved } from "./test-helpers.js";

type ModelStep = { content: string } | { error: unknown };

function buildSequencedResolved(
  id: string,
  options: {
    role: string;
    model?: string;
    steps: ModelStep[];
  }
): { resolved: ResolvedParticipant; invoke: ReturnType<typeof vi.fn> } {
  let cursor = 0;
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    const step = options.steps[cursor++];
    if (!step) throw new Error(`No model step configured for ${id}`);
    if ("error" in step) throw step.error;
    return new AIMessage({ content: step.content, response_metadata: {} });
  });
  const model = {
    invoke,
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this;
    }),
    _modelType: () => "base_chat_model",
    _llmType: () => "mock",
  } as unknown as BaseChatModel;
  const agent = new DzupAgent({
    id,
    description: `${id} agent`,
    instructions: `You are ${id}.`,
    model,
  });
  const participant: ParticipantDefinition = {
    id,
    role: options.role,
    model: options.model ?? "mock-model",
  };
  return {
    resolved: {
      participant,
      spawned: {
        agent,
        status: "idle",
        role: options.role as TeamSpawnedAgent["role"],
        tags: [],
        spawnedAt: Date.now(),
      },
    },
    invoke,
  };
}

function success(
  agentId: string,
  role: "proposer" | "judge",
  invocationIndex: number,
  durationMs: number,
  content: string,
  round?: number
): DebateInvocationOutcome {
  return {
    agentId,
    role,
    invocationIndex,
    ...(round !== undefined ? { round } : {}),
    success: true,
    durationMs,
    content,
  };
}

function failure(
  agentId: string,
  role: "proposer" | "judge",
  invocationIndex: number,
  durationMs: number,
  error: string,
  round?: number
): DebateInvocationOutcome {
  return {
    agentId,
    role,
    invocationIndex,
    ...(round !== undefined ? { round } : {}),
    success: false,
    durationMs,
    error,
  };
}

type DetailedScript = {
  starts: DebateInvocationStart[];
  outcomes: DebateInvocationOutcome[];
  content: string;
  durationMs?: number;
  rejection?: unknown;
};

function installDetailedScript(script: DetailedScript) {
  const legacy = vi.spyOn(AgentOrchestrator, "debate");
  if (script.rejection !== undefined) {
    legacy.mockRejectedValue(script.rejection);
  } else {
    legacy.mockResolvedValue(script.content);
  }
  const detailed = vi
    .spyOn(AgentOrchestrator, "debateDetailed")
    .mockImplementation(async (_proposers, _judge, _task, options) => {
      for (const start of script.starts) {
        void options?.invocationObserver?.onStart?.(start);
      }
      for (const outcome of script.outcomes) {
        void options?.invocationObserver?.onComplete?.(outcome);
      }
      if (script.rejection !== undefined) throw script.rejection;
      return {
        content: script.content,
        invocations: script.outcomes,
        roundsExecuted: 1,
        durationMs: script.durationMs ?? 23,
      };
    });
  return { detailed, legacy };
}

async function runProposerFailure(): Promise<{
  caught: unknown;
  error: Error;
  calls: ReturnType<typeof buildContext>["calls"];
}> {
  const error = new Error("proposer failed exactly");
  const good = buildSequencedResolved("good", {
    role: "proposer",
    steps: [{ content: "good proposal" }],
  });
  const bad = buildSequencedResolved("bad", {
    role: "proposer",
    steps: [{ error }],
  });
  const judge = buildSequencedResolved("judge", {
    role: "judge",
    model: "claude-opus-4-7",
    steps: [{ content: "must not run" }],
  });
  const { ctx, calls } = buildContext("council", [
    judge.resolved,
    good.resolved,
    bad.resolved,
  ]);
  let caught: unknown;
  try {
    await councilPattern.execute(ctx);
  } catch (thrown: unknown) {
    caught = thrown;
  }
  return { caught, error, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("council participant outcome admission", () => {
  it("emits actual proposer starts before the real judge start", async () => {
    const { ctx, calls } = buildContext("council", [
      buildResolved("judge", {
        role: "judge",
        model: "claude-opus-4-7",
        response: "verdict",
      }),
      buildResolved("p1", { role: "proposer", response: "proposal one" }),
      buildResolved("p2", { role: "proposer", response: "proposal two" }),
    ]);

    await councilPattern.execute(ctx);

    expect(calls.starts).toEqual(["p1", "p2", "judge"]);
  });

  it("returns each successful proposer's exact generated content", async () => {
    const { ctx } = buildContext("council", [
      buildResolved("judge", {
        role: "judge",
        model: "claude-opus-4-7",
        response: "verdict",
      }),
      buildResolved("p1", { role: "proposer", response: "proposal one" }),
      buildResolved("p2", { role: "proposer", response: "proposal two" }),
    ]);

    const result = await councilPattern.execute(ctx);

    expect(result.agentResults.find((item) => item.agentId === "p1")?.content)
      .toBe("proposal one");
    expect(result.agentResults.find((item) => item.agentId === "p2")?.content)
      .toBe("proposal two");
  });

  it("keeps the judge's exact verdict content", async () => {
    const { ctx } = buildContext("council", [
      buildResolved("judge", {
        role: "judge",
        model: "claude-opus-4-7",
        response: "exact verdict",
      }),
      buildResolved("p1", { role: "proposer", response: "proposal" }),
    ]);

    const result = await councilPattern.execute(ctx);

    expect(result.content).toBe("exact verdict");
    expect(
      result.agentResults.find((item) => item.agentId === "judge")?.content
    ).toBe("exact verdict");
  });

  it("uses each participant's invocation duration instead of team duration", async () => {
    const outcomes = [
      success("p1", "proposer", 0, 3, "proposal", 0),
      success("judge", "judge", 1, 7, "verdict"),
    ];
    installDetailedScript({
      starts: outcomes,
      outcomes,
      content: "verdict",
    });
    const { ctx, calls } = buildContext("council", [
      buildResolved("judge", { role: "judge", model: "claude-opus-4-7" }),
      buildResolved("p1", { role: "proposer" }),
    ]);
    ctx.startedAt -= 1_000;

    const result = await councilPattern.execute(ctx);

    expect(calls.completes).toEqual([
      { id: "p1", success: true, durationMs: 3 },
      { id: "judge", success: true, durationMs: 7 },
    ]);
    expect(result.agentResults.find((item) => item.agentId === "p1")?.durationMs)
      .toBe(3);
    expect(
      result.agentResults.find((item) => item.agentId === "judge")?.durationMs
    ).toBe(7);
  });

  it("renders successful results in participant-definition order", async () => {
    const outcomes = [
      success("p1", "proposer", 0, 2, "one", 0),
      success("p2", "proposer", 1, 2, "two", 0),
      success("judge", "judge", 2, 2, "verdict"),
    ];
    installDetailedScript({ starts: outcomes, outcomes, content: "verdict" });
    const { ctx } = buildContext("council", [
      buildResolved("p2", { role: "proposer" }),
      buildResolved("judge", { role: "judge", model: "claude-opus-4-7" }),
      buildResolved("p1", { role: "proposer" }),
    ]);

    const result = await councilPattern.execute(ctx);

    expect(result.agentResults.map((item) => item.agentId)).toEqual([
      "p2",
      "judge",
      "p1",
    ]);
  });

  it("reports a failed proposer and rethrows the exact model error", async () => {
    const { caught, error, calls } = await runProposerFailure();

    expect(caught).toBe(error);
    expect(calls.completes).toContainEqual({
      id: "bad",
      success: false,
      durationMs: expect.any(Number),
      error: "proposer failed exactly",
    });
  });

  it("keeps an already-settled sibling successful when a proposer fails", async () => {
    const error = new Error("later proposer failed");
    const outcomes = [
      success("good", "proposer", 0, 3, "settled proposal", 0),
      failure("bad", "proposer", 1, 4, error.message, 0),
    ];
    installDetailedScript({
      starts: outcomes,
      outcomes,
      content: "unused",
      rejection: error,
    });
    const { ctx, calls } = buildContext("council", [
      buildResolved("judge", { role: "judge", model: "claude-opus-4-7" }),
      buildResolved("good", { role: "proposer" }),
      buildResolved("bad", { role: "proposer" }),
    ]);

    await expect(councilPattern.execute(ctx)).rejects.toBe(error);

    expect(calls.completes).toContainEqual({
      id: "good",
      success: true,
      durationMs: 3,
    });
  });

  it("does not start or complete the judge after a proposer failure", async () => {
    const { calls } = await runProposerFailure();

    expect(calls.starts).not.toContain("judge");
    expect(calls.completes.some((call) => call.id === "judge")).toBe(false);
  });

  it("does not invent evidence for bounded proposers that never started", async () => {
    const error = new Error("first proposer failed");
    const firstFailure = failure("p1", "proposer", 0, 4, error.message, 0);
    installDetailedScript({
      starts: [firstFailure],
      outcomes: [firstFailure],
      content: "unused",
      rejection: error,
    });
    const { ctx, calls } = buildContext("council", [
      buildResolved("judge", { role: "judge", model: "claude-opus-4-7" }),
      buildResolved("p1", { role: "proposer" }),
      buildResolved("p2", { role: "proposer" }),
      buildResolved("p3", { role: "proposer" }),
    ]);

    await expect(councilPattern.execute(ctx)).rejects.toBe(error);

    expect(calls.starts).toEqual(["p1"]);
    expect(calls.completes.map((call) => call.id)).toEqual(["p1"]);
  });

  it("keeps a started pending sibling without a fabricated completion", async () => {
    const error = new Error("settled failure");
    const failed = failure("p1", "proposer", 0, 4, error.message, 0);
    installDetailedScript({
      starts: [
        { agentId: "p1", role: "proposer", invocationIndex: 0, round: 0 },
        { agentId: "p2", role: "proposer", invocationIndex: 1, round: 0 },
      ],
      outcomes: [failed],
      content: "unused",
      rejection: error,
    });
    const { ctx, calls } = buildContext("council", [
      buildResolved("judge", { role: "judge", model: "claude-opus-4-7" }),
      buildResolved("p1", { role: "proposer" }),
      buildResolved("p2", { role: "proposer" }),
    ]);

    await expect(councilPattern.execute(ctx)).rejects.toBe(error);

    expect(calls.starts).toEqual(["p1", "p2"]);
    expect(calls.completes.map((call) => call.id)).toEqual(["p1"]);
  });

  it("preserves proposer successes and reports only the judge's own failure", async () => {
    const judgeError = new Error("judge failed exactly");
    const proposer = buildSequencedResolved("p1", {
      role: "proposer",
      steps: [{ content: "proposal" }],
    });
    const judge = buildSequencedResolved("judge", {
      role: "judge",
      model: "claude-opus-4-7",
      steps: [{ error: judgeError }],
    });
    const { ctx, calls } = buildContext("council", [
      judge.resolved,
      proposer.resolved,
    ]);
    let caught: unknown;

    try {
      await councilPattern.execute(ctx);
    } catch (thrown: unknown) {
      caught = thrown;
    }

    expect(caught).toBe(judgeError);
    expect(calls.completes).toEqual([
      expect.objectContaining({ id: "p1", success: true }),
      expect.objectContaining({
        id: "judge",
        success: false,
        error: judgeError.message,
      }),
    ]);
  });

  it("emits no participant evidence for an already-aborted council", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx, calls } = buildContext(
      "council",
      [
        buildResolved("judge", {
          role: "judge",
          model: "claude-opus-4-7",
        }),
        buildResolved("p1", { role: "proposer" }),
      ],
      { signal: controller.signal }
    );

    await expect(councilPattern.execute(ctx)).rejects.toThrow(
      "aborted before execution"
    );
    expect(calls.starts).toEqual([]);
    expect(calls.completes).toEqual([]);
  });

  it("aggregates repeated outcomes with sticky failure and latest content", async () => {
    const outcomes = [
      success("p1", "proposer", 0, 2, "proposal v1", 0),
      failure("p1", "proposer", 1, 3, "first failure", 1),
      failure("p1", "proposer", 2, 5, "later failure", 2),
      success("p1", "proposer", 3, 7, "proposal v2", 3),
      success("judge", "judge", 4, 11, "verdict"),
    ];
    installDetailedScript({ starts: outcomes, outcomes, content: "verdict" });
    const { ctx } = buildContext("council", [
      buildResolved("judge", { role: "judge", model: "claude-opus-4-7" }),
      buildResolved("p1", { role: "proposer" }),
    ]);

    const result = await councilPattern.execute(ctx);
    const proposer = result.agentResults.find((item) => item.agentId === "p1");

    expect(proposer).toEqual({
      agentId: "p1",
      role: "proposer",
      content: "proposal v2",
      success: false,
      durationMs: 17,
      error: "first failure",
    });
  });

  it("emits one aggregate completion per repeatedly invoked participant", async () => {
    const outcomes = [
      success("p1", "proposer", 0, 2, "proposal v1", 0),
      failure("p1", "proposer", 1, 3, "first failure", 1),
      success("p1", "proposer", 2, 5, "proposal v2", 2),
      success("judge", "judge", 3, 7, "verdict"),
    ];
    installDetailedScript({ starts: outcomes, outcomes, content: "verdict" });
    const { ctx, calls } = buildContext("council", [
      buildResolved("judge", { role: "judge", model: "claude-opus-4-7" }),
      buildResolved("p1", { role: "proposer" }),
    ]);

    await councilPattern.execute(ctx);

    expect(calls.starts).toEqual(["p1", "p1", "p1", "judge"]);
    expect(calls.completes.filter((call) => call.id === "p1")).toHaveLength(1);
    expect(calls.completes.filter((call) => call.id === "judge")).toHaveLength(
      1
    );
  });

  it("ignores unknown observer IDs instead of attaching them to participants", async () => {
    const outcomes = [
      success("ghost", "proposer", 0, 1, "not retained", 0),
      success("p1", "proposer", 1, 2, "proposal", 0),
      success("judge", "judge", 2, 3, "verdict"),
    ];
    installDetailedScript({ starts: outcomes, outcomes, content: "verdict" });
    const { ctx, calls } = buildContext("council", [
      buildResolved("judge", { role: "judge", model: "claude-opus-4-7" }),
      buildResolved("p1", { role: "proposer" }),
    ]);

    const result = await councilPattern.execute(ctx);

    expect(calls.starts).not.toContain("ghost");
    expect(calls.completes.some((call) => call.id === "ghost")).toBe(false);
    expect(result.agentResults.some((item) => item.agentId === "ghost")).toBe(
      false
    );
  });

  it("trips only the participant with an actual aggregate failure", async () => {
    const badError = new Error("bad proposer");
    const judge = buildSequencedResolved("judge", {
      role: "judge",
      model: "claude-opus-4-7",
      steps: [{ content: "second-run verdict" }],
    });
    const good = buildSequencedResolved("good", {
      role: "proposer",
      steps: [{ content: "good one" }, { content: "good two" }],
    });
    const bad = buildSequencedResolved("bad", {
      role: "proposer",
      steps: [{ error: badError }],
    });
    const definition = {
      id: "truthful-council-breaker",
      name: "Truthful council breaker",
      coordinatorPattern: "council" as const,
      participants: [
        judge.resolved.participant,
        good.resolved.participant,
        bad.resolved.participant,
      ],
    };
    const entries = new Map(
      [judge.resolved, good.resolved, bad.resolved].map((entry) => [
        entry.participant.id,
        entry.spawned,
      ])
    );
    const runtime = new TeamRuntime({
      definition,
      resolveParticipant: async (participant) => entries.get(participant.id)!,
      supervisionPolicy: {
        maxFailuresBeforeCircuitBreak: 1,
        resetAfterMs: 60_000,
      },
    });

    await expect(runtime.execute("first run")).rejects.toBe(badError);
    const second = await runtime.execute("second run");

    expect(second.pattern).toBe("council");
    expect(second.content).toBe("second-run verdict");
    expect(bad.invoke).toHaveBeenCalledOnce();
    expect(good.invoke).toHaveBeenCalledTimes(2);
    expect(judge.invoke).toHaveBeenCalledOnce();
  });

  it("preserves the single-participant fallback", async () => {
    const { ctx, calls } = buildContext("council", [
      buildResolved("judge", {
        role: "judge",
        model: "claude-opus-4-7",
        response: "solo verdict",
      }),
    ]);

    const result = await councilPattern.execute(ctx);

    expect(result.pattern).toBe("single-participant");
    expect(result.content).toBe("solo verdict");
    expect(calls.starts).toEqual([]);
    expect(calls.completes).toEqual([]);
  });

  it("keeps judge selection, policy hook, final content, and council label", async () => {
    const outcomes = [
      success("p1", "proposer", 0, 2, "proposal", 0),
      success("selected-judge", "judge", 1, 3, "selected verdict"),
    ];
    const { detailed, legacy } = installDetailedScript({
      starts: outcomes,
      outcomes,
      content: "selected verdict",
    });
    const { ctx, calls } = buildContext(
      "council",
      [
        buildResolved("fallback", { role: "judge", model: "other" }),
        buildResolved("selected-judge", {
          role: "judge",
          model: "selected-model",
        }),
        buildResolved("p1", { role: "proposer" }),
      ],
      { policies: { governance: { judgeModel: "selected-model" } } }
    );

    const result = await councilPattern.execute(ctx);

    expect(detailed).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
    const [proposers, judge, task] = detailed.mock.calls[0]!;
    expect(proposers.map((agent) => agent.id)).toEqual(["fallback", "p1"]);
    expect(judge.id).toBe("selected-judge");
    expect(task).toBe("mock task");
    expect(calls.policyApplied).toEqual([
      { group: "governance", field: "judgeModel" },
    ]);
    expect(result.content).toBe("selected verdict");
    expect(result.pattern).toBe("council");
  });
});
