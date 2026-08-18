import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DzupAgent } from "../../../../agent/dzip-agent.js";
import { ContractNetManager } from "../../../contract-net/contract-net-manager.js";
import type {
  ContractNetConfig,
  ContractNetDetailedResult,
  ContractNetInvocationFailureKind,
  ContractNetInvocationOutcome,
  ContractNetInvocationStart,
  ContractResult,
} from "../../../contract-net/contract-net-types.js";
import type { ParticipantDefinition, TeamDefinition } from "../../team-definition.js";
import { TeamRuntime } from "../../team-runtime.js";
import type { TeamSpawnedAgent } from "../../team-workspace.js";
import { contractNetPattern } from "../contract-net-pattern.js";
import type { ResolvedParticipant } from "../team-pattern.js";
import { buildContext, buildResolved } from "./test-helpers.js";

type ModelStep = { content: string } | { error: unknown };

function bid(cost = 10, approach = "bid approach"): string {
  return JSON.stringify({
    estimatedCostCents: cost,
    estimatedDurationMs: 20,
    qualityEstimate: 0.8,
    confidence: 0.9,
    approach,
  });
}

function success(
  agentId: string,
  phase: "bid" | "execute",
  invocationIndex: number,
  durationMs: number,
  content: string,
  attempt?: number
): ContractNetInvocationOutcome {
  return {
    agentId,
    phase,
    invocationIndex,
    ...(attempt !== undefined ? { attempt } : {}),
    success: true,
    durationMs,
    content,
  };
}

function failure(
  agentId: string,
  phase: "bid" | "execute",
  invocationIndex: number,
  durationMs: number,
  failureKind: ContractNetInvocationFailureKind,
  error: string,
  attempt?: number
): ContractNetInvocationOutcome {
  return {
    agentId,
    phase,
    invocationIndex,
    ...(attempt !== undefined ? { attempt } : {}),
    success: false,
    durationMs,
    failureKind,
    error,
  };
}

type DetailedScript = {
  starts: ContractNetInvocationStart[];
  outcomes: ContractNetInvocationOutcome[];
  result: ContractResult;
  rejection?: unknown;
};

function installDetailedScript(script: DetailedScript) {
  const implementation = vi.fn(
    async (config: ContractNetConfig): Promise<ContractNetDetailedResult> => {
      for (const start of script.starts) {
        void config.invocationObserver?.onStart?.(start);
      }
      for (const outcome of script.outcomes) {
        void config.invocationObserver?.onComplete?.(outcome);
      }
      if (script.rejection !== undefined) throw script.rejection;
      return { result: script.result, invocations: script.outcomes };
    }
  );
  const legacy = vi.spyOn(ContractNetManager, "execute");
  const manager = ContractNetManager as typeof ContractNetManager & {
    executeDetailed?: (
      config: ContractNetConfig
    ) => Promise<ContractNetDetailedResult>;
  };
  if (typeof manager.executeDetailed === "function") {
    vi.spyOn(manager, "executeDetailed").mockImplementation(implementation);
  } else {
    legacy.mockImplementation(async (config) =>
      (await implementation(config)).result
    );
  }
  return { detailed: implementation, legacy };
}

function makeResult(overrides?: Partial<ContractResult>): ContractResult {
  return {
    cfpId: "cfp-scripted",
    agentId: "s1",
    success: true,
    result: "final execution",
    actualDurationMs: 9,
    ...overrides,
  };
}

function buildSequencedResolved(
  id: string,
  role: string,
  steps: ModelStep[]
): { resolved: ResolvedParticipant; invoke: ReturnType<typeof vi.fn> } {
  let cursor = 0;
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    const step = steps[cursor++];
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
    role,
    model: "mock-model",
  };
  return {
    resolved: {
      participant,
      spawned: {
        agent,
        status: "idle",
        role: role as TeamSpawnedAgent["role"],
        tags: [],
        spawnedAt: Date.now(),
      },
    },
    invoke,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("contract-net participant outcome admission", () => {
  it("emits starts only for actual participants and only on first invocation", async () => {
    const outcomes = [
      success("s2", "bid", 0, 2, "s2 bid", 0),
      success("s1", "bid", 1, 3, "s1 bid", 0),
      success("s2", "execute", 2, 5, "s2 execution"),
    ];
    installDetailedScript({
      starts: outcomes,
      outcomes,
      result: makeResult({ agentId: "s2", result: "s2 execution" }),
    });
    const { ctx, calls } = buildContext("contract_net", [
      buildResolved("mgr", { role: "supervisor" }),
      buildResolved("s1", { role: "specialist" }),
      buildResolved("s2", { role: "specialist" }),
    ]);

    await contractNetPattern.execute(ctx);

    expect(calls.starts).toEqual(["s2", "s1"]);
    expect(calls.starts).not.toContain("mgr");
  });

  it("returns each losing bid and the winner execution with own durations", async () => {
    const s1Bid = bid(30, "s1 losing approach");
    const s2Bid = bid(5, "s2 winning approach");
    const outcomes = [
      success("s1", "bid", 0, 2, s1Bid, 0),
      success("s2", "bid", 1, 3, s2Bid, 0),
      success("s2", "execute", 2, 7, "s2 final execution"),
    ];
    installDetailedScript({
      starts: outcomes,
      outcomes,
      result: makeResult({ agentId: "s2", result: "s2 final execution" }),
    });
    const { ctx } = buildContext("contract_net", [
      buildResolved("mgr", { role: "supervisor" }),
      buildResolved("s1", { role: "specialist" }),
      buildResolved("s2", { role: "specialist" }),
    ]);

    const result = await contractNetPattern.execute(ctx);

    expect(result.agentResults).toEqual([
      {
        agentId: "s1",
        role: "specialist",
        content: s1Bid,
        success: true,
        durationMs: 2,
      },
      {
        agentId: "s2",
        role: "specialist",
        content: "s2 final execution",
        success: true,
        durationMs: 10,
      },
    ]);
  });

  it("keeps aggregate failure sticky with first error and latest success", async () => {
    const outcomes = [
      failure("s1", "bid", 0, 2, "invalid_bid", "first failure", 0),
      success("s1", "bid", 1, 3, "valid retry bid", 1),
      failure("s1", "execute", 2, 5, "model_error", "later failure"),
    ];
    installDetailedScript({
      starts: outcomes,
      outcomes,
      result: {
        cfpId: "cfp-scripted",
        agentId: "s1",
        success: false,
        error: "later failure",
        actualDurationMs: 9,
      },
    });
    const { ctx } = buildContext("contract_net", [
      buildResolved("mgr", { role: "supervisor" }),
      buildResolved("s1", { role: "specialist" }),
    ]);

    const result = await contractNetPattern.execute(ctx);

    expect(result.agentResults).toEqual([
      {
        agentId: "s1",
        role: "specialist",
        content: "valid retry bid",
        success: false,
        durationMs: 10,
        error: "first failure",
      },
    ]);
  });

  it("emits exactly one aggregate completion for repeated invocations", async () => {
    const outcomes = [
      success("s1", "bid", 0, 2, "bid one", 0),
      failure("s1", "bid", 1, 3, "invalid_bid", "retry failed", 1),
      success("s1", "execute", 2, 5, "execution"),
    ];
    installDetailedScript({
      starts: outcomes,
      outcomes,
      result: makeResult({ result: "execution" }),
    });
    const { ctx, calls } = buildContext("contract_net", [
      buildResolved("mgr", { role: "supervisor" }),
      buildResolved("s1", { role: "specialist" }),
    ]);

    await contractNetPattern.execute(ctx);

    expect(calls.starts).toEqual(["s1"]);
    expect(calls.completes).toEqual([
      { id: "s1", success: false, durationMs: 10, error: "retry failed" },
    ]);
  });

  it("orders completed results by participant definition rather than start race", async () => {
    const outcomes = [
      success("s1", "bid", 0, 2, "one", 0),
      success("s2", "bid", 1, 3, "two", 0),
      success("s1", "execute", 2, 5, "one final"),
    ];
    installDetailedScript({
      starts: outcomes,
      outcomes,
      result: makeResult({ result: "one final" }),
    });
    const { ctx } = buildContext("contract_net", [
      buildResolved("mgr", { role: "supervisor" }),
      buildResolved("s2", { role: "specialist" }),
      buildResolved("s1", { role: "specialist" }),
    ]);

    const result = await contractNetPattern.execute(ctx);

    expect(result.agentResults.map((item) => item.agentId)).toEqual([
      "s2",
      "s1",
    ]);
  });

  it("keeps settled siblings truthful and rethrows the exact outer error", async () => {
    const outerError = new Error("exact outer failure");
    const starts: ContractNetInvocationStart[] = [
      { agentId: "good", phase: "bid", attempt: 0, invocationIndex: 0 },
      { agentId: "bad", phase: "bid", attempt: 0, invocationIndex: 1 },
      { agentId: "pending", phase: "bid", attempt: 0, invocationIndex: 2 },
    ];
    installDetailedScript({
      starts,
      outcomes: [
        success("good", "bid", 0, 2, "good bid", 0),
        failure("bad", "bid", 1, 3, "model_error", "bad bid", 0),
      ],
      result: makeResult(),
      rejection: outerError,
    });
    const { ctx, calls } = buildContext("contract_net", [
      buildResolved("mgr", { role: "supervisor" }),
      buildResolved("good", { role: "specialist" }),
      buildResolved("bad", { role: "specialist" }),
      buildResolved("pending", { role: "specialist" }),
    ]);

    await expect(contractNetPattern.execute(ctx)).rejects.toBe(outerError);

    expect(calls.starts).toEqual(["good", "bad", "pending"]);
    expect(calls.completes).toEqual([
      { id: "good", success: true, durationMs: 2 },
      { id: "bad", success: false, durationMs: 3, error: "bad bid" },
    ]);
    expect(calls.completes.some((call) => call.id === "pending")).toBe(false);
    expect(calls.completes.some((call) => call.id === "mgr")).toBe(false);
  });

  it("does not invent never-started bounded specialists", async () => {
    const outerError = new Error("first bid failed");
    const failed = failure(
      "s1",
      "bid",
      0,
      3,
      "model_error",
      outerError.message,
      0
    );
    installDetailedScript({
      starts: [failed],
      outcomes: [failed],
      result: makeResult(),
      rejection: outerError,
    });
    const { ctx, calls } = buildContext("contract_net", [
      buildResolved("mgr", { role: "supervisor" }),
      buildResolved("s1", { role: "specialist" }),
      buildResolved("s2", { role: "specialist" }),
      buildResolved("s3", { role: "specialist" }),
    ]);

    await expect(contractNetPattern.execute(ctx)).rejects.toBe(outerError);

    expect(calls.starts).toEqual(["s1"]);
    expect(calls.completes.map((call) => call.id)).toEqual(["s1"]);
  });

  it("ignores unknown invocation IDs instead of misattributing them", async () => {
    const outcomes = [
      success("ghost", "bid", 0, 1, "ghost bid", 0),
      success("s1", "bid", 1, 2, "real bid", 0),
      success("s1", "execute", 2, 3, "real execution"),
    ];
    installDetailedScript({
      starts: outcomes,
      outcomes,
      result: makeResult({ result: "real execution" }),
    });
    const { ctx, calls } = buildContext("contract_net", [
      buildResolved("mgr", { role: "supervisor" }),
      buildResolved("s1", { role: "specialist" }),
    ]);

    const result = await contractNetPattern.execute(ctx);

    expect(calls.starts).toEqual(["s1"]);
    expect(result.agentResults.map((item) => item.agentId)).toEqual(["s1"]);
  });

  it("returns execution failure without converting it into a throw", async () => {
    const outcomes = [
      success("s1", "bid", 0, 2, "valid bid", 0),
      failure("s1", "execute", 1, 4, "model_error", "execution failed"),
    ];
    installDetailedScript({
      starts: outcomes,
      outcomes,
      result: {
        cfpId: "cfp-scripted",
        agentId: "s1",
        success: false,
        error: "execution failed",
        actualDurationMs: 9,
      },
    });
    const { ctx } = buildContext("contract_net", [
      buildResolved("mgr", { role: "supervisor" }),
      buildResolved("s1", { role: "specialist" }),
    ]);

    const result = await contractNetPattern.execute(ctx);

    expect(result.content).toBe("");
    expect(result.agentResults[0]).toEqual(
      expect.objectContaining({
        agentId: "s1",
        success: false,
        durationMs: 6,
        error: "execution failed",
      })
    );
  });

  it("emits no participant evidence when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx, calls } = buildContext(
      "contract_net",
      [
        buildResolved("mgr", { role: "supervisor" }),
        buildResolved("s1", { role: "specialist" }),
      ],
      { signal: controller.signal }
    );

    await expect(contractNetPattern.execute(ctx)).rejects.toThrow(
      "aborted before execution"
    );
    expect(calls.starts).toEqual([]);
    expect(calls.completes).toEqual([]);
  });

  it("preserves the single-participant fallback", async () => {
    const { ctx, calls } = buildContext("contract_net", [
      buildResolved("solo", { role: "supervisor", response: "solo result" }),
    ]);

    const result = await contractNetPattern.execute(ctx);

    expect(result.pattern).toBe("single-participant");
    expect(result.content).toBe("solo result");
    expect(calls.starts).toEqual([]);
    expect(calls.completes).toEqual([]);
  });

  it("uses the detailed path once while retaining all config threading", async () => {
    const outcomes = [
      success("s1", "bid", 0, 2, "bid", 0),
      success("s1", "execute", 1, 3, "final"),
    ];
    const { detailed, legacy } = installDetailedScript({
      starts: outcomes,
      outcomes,
      result: makeResult({ result: "final" }),
    });
    const controller = new AbortController();
    const strategy = { evaluate: vi.fn((bids) => bids) };
    const eventBus = {
      emit: vi.fn(),
      on: vi.fn(() => () => {}),
      once: vi.fn(() => () => {}),
      onAny: vi.fn(() => () => {}),
    };
    const { ctx } = buildContext(
      "contract_net",
      [
        buildResolved("mgr", { role: "supervisor" }),
        buildResolved("s1", { role: "specialist" }),
      ],
      {
        policies: {
          contractNet: {
            maxCostCents: 77,
            requiredCapabilities: ["review"],
            bidDeadlineMs: 123,
            retryOnNoBids: true,
          },
        },
        signal: controller.signal,
        eventBus: eventBus as never,
        contractNet: { strategy },
      }
    );

    const result = await contractNetPattern.execute(ctx);

    expect(detailed).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
    expect(detailed.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        task: "mock task",
        maxCostCents: 77,
        requiredCapabilities: ["review"],
        bidDeadlineMs: 123,
        retryOnNoBids: true,
        strategy,
        signal: controller.signal,
        eventBus,
        invocationObserver: expect.any(Object),
      })
    );
    expect(result.content).toBe("final");
    expect(result.pattern).toBe("contract-net");
  });

  it("fails closed before execution when spawned agent IDs are ambiguous", async () => {
    const manager = buildResolved("mgr", { role: "supervisor" });
    const first = buildResolved("first", { role: "specialist" });
    const duplicate: ResolvedParticipant = {
      participant: {
        id: "second-definition",
        role: "specialist",
        model: "mock-model",
      },
      spawned: first.spawned,
    };
    const { ctx, calls } = buildContext("contract_net", [
      manager,
      first,
      duplicate,
    ]);

    await expect(contractNetPattern.execute(ctx)).rejects.toThrow(
      "duplicate spawned agent id"
    );
    expect(calls.starts).toEqual([]);
    expect(calls.completes).toEqual([]);
  });

  it("trips only the specialist with an actual bid failure", async () => {
    const manager = buildSequencedResolved("mgr", "supervisor", []);
    const good = buildSequencedResolved("good", "specialist", [
      { content: bid(5, "good first bid") },
      { content: "good first execution" },
      { content: bid(5, "good second bid") },
      { content: "good second execution" },
    ]);
    const bad = buildSequencedResolved("bad", "specialist", [
      { error: new Error("bad bid failed") },
      { content: bid(50, "bad second bid") },
    ]);
    const definition: TeamDefinition = {
      id: "truthful-contract-net-breaker",
      name: "Truthful contract-net breaker",
      coordinatorPattern: "contract_net",
      participants: [
        manager.resolved.participant,
        good.resolved.participant,
        bad.resolved.participant,
      ],
    };
    const entries = new Map(
      [manager.resolved, good.resolved, bad.resolved].map((entry) => [
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

    const firstRun = await runtime.execute("first run");
    const secondRun = await runtime.execute("second run");

    expect(firstRun.content).toBe("good first execution");
    expect(secondRun.content).toBe("good second execution");
    expect(manager.invoke).not.toHaveBeenCalled();
    expect(good.invoke).toHaveBeenCalledTimes(4);
    expect(bad.invoke).toHaveBeenCalledOnce();
  });
});
