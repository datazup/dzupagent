import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DzupAgent } from "../agent/dzip-agent.js";
import { ContractNetManager } from "../orchestration/contract-net/contract-net-manager.js";
import type {
  ContractNetConfig,
  ContractNetInvocationOutcome,
  ContractNetInvocationStart,
} from "../orchestration/contract-net/contract-net-types.js";
import { OrchestrationError } from "../orchestration/orchestration-error.js";

type ModelStep =
  | { content: string }
  | { error: unknown }
  | { pending: Promise<AIMessage> };

function bid(overrides?: {
  cost?: number;
  duration?: number;
  quality?: number;
  confidence?: number;
  approach?: string;
}): string {
  return JSON.stringify({
    estimatedCostCents: overrides?.cost ?? 10,
    estimatedDurationMs: overrides?.duration ?? 20,
    qualityEstimate: overrides?.quality ?? 0.8,
    confidence: overrides?.confidence ?? 0.9,
    approach: overrides?.approach ?? "focused approach",
  });
}

function createAgent(
  id: string,
  steps: ModelStep[]
): { agent: DzupAgent; invoke: ReturnType<typeof vi.fn> } {
  let cursor = 0;
  const invoke = vi.fn(
    async (_messages: BaseMessage[], _options?: { signal?: AbortSignal }) => {
      const step = steps[cursor++];
      if (!step) throw new Error(`No model step configured for ${id}`);
      if ("error" in step) throw step.error;
      if ("pending" in step) return step.pending;
      return new AIMessage({ content: step.content, response_metadata: {} });
    }
  );
  const model = {
    invoke,
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this;
    }),
    _modelType: () => "base_chat_model",
    _llmType: () => "mock",
  } as unknown as BaseChatModel;
  return {
    agent: new DzupAgent({
      id,
      description: `${id} specialist`,
      instructions: `You are ${id}.`,
      model,
    }),
    invoke,
  };
}

function captureEvidence(): {
  starts: ContractNetInvocationStart[];
  outcomes: ContractNetInvocationOutcome[];
  observer: NonNullable<ContractNetConfig["invocationObserver"]>;
} {
  const starts: ContractNetInvocationStart[] = [];
  const outcomes: ContractNetInvocationOutcome[] = [];
  return {
    starts,
    outcomes,
    observer: {
      onStart: (start) => starts.push(start),
      onComplete: (outcome) => outcomes.push(outcome),
    },
  };
}

async function flushInvocationStart(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ContractNetManager detailed invocation evidence", () => {
  it("returns an ordered valid bid and winner execution outcome", async () => {
    const validBid = bid({ approach: "exact bid approach" });
    const specialist = createAgent("winner", [
      { content: validBid },
      { content: "exact execution result" },
    ]);
    const evidence = captureEvidence();

    const detailed = await ContractNetManager.executeDetailed({
      specialists: [specialist.agent],
      task: "ship it",
      invocationObserver: evidence.observer,
    });

    expect(detailed.result.result).toBe("exact execution result");
    expect(detailed.invocations.map((item) => item.invocationIndex)).toEqual([
      0, 1,
    ]);
    expect(detailed.invocations).toEqual(evidence.outcomes);
    expect(detailed.invocations[0]).toEqual({
      agentId: "winner",
      phase: "bid",
      attempt: 0,
      invocationIndex: 0,
      success: true,
      durationMs: expect.any(Number),
      content: validBid,
    });
    expect(detailed.invocations[1]).toEqual({
      agentId: "winner",
      phase: "execute",
      invocationIndex: 1,
      success: true,
      durationMs: expect.any(Number),
      content: "exact execution result",
    });
  });

  it("numbers actual bidder starts before the later winner execution", async () => {
    const first = createAgent("first", [
      { content: bid({ cost: 5 }) },
      { content: "first executed" },
    ]);
    const second = createAgent("second", [{ content: bid({ cost: 50 }) }]);
    const evidence = captureEvidence();

    const detailed = await ContractNetManager.executeDetailed({
      specialists: [first.agent, second.agent],
      task: "ordered work",
      invocationObserver: evidence.observer,
    });

    expect(evidence.starts.map(({ agentId, phase, invocationIndex }) => ({
      agentId,
      phase,
      invocationIndex,
    }))).toEqual([
      { agentId: "first", phase: "bid", invocationIndex: 0 },
      { agentId: "second", phase: "bid", invocationIndex: 1 },
      { agentId: "first", phase: "execute", invocationIndex: 2 },
    ]);
    expect(detailed.invocations.map((item) => item.agentId)).toEqual([
      "first",
      "second",
      "first",
    ]);
  });

  it("records a bid model rejection before the no-bid error", async () => {
    const modelError = new Error("bid model failed exactly");
    const specialist = createAgent("broken", [{ error: modelError }]);
    const evidence = captureEvidence();

    let thrown: unknown;
    try {
      await ContractNetManager.executeDetailed({
        specialists: [specialist.agent],
        task: "collect a bid",
        invocationObserver: evidence.observer,
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OrchestrationError);
    expect(evidence.outcomes).toEqual([
      {
        agentId: "broken",
        phase: "bid",
        attempt: 0,
        invocationIndex: 0,
        success: false,
        durationMs: expect.any(Number),
        failureKind: "model_error",
        error: modelError.message,
      },
    ]);
  });

  it("classifies invalid bid output without retaining the raw response", async () => {
    const rawInvalid = "private-invalid-bid-body-must-not-be-retained";
    const specialist = createAgent("invalid", [{ content: rawInvalid }]);
    const evidence = captureEvidence();

    await expect(
      ContractNetManager.executeDetailed({
        specialists: [specialist.agent],
        task: "collect a bid",
        invocationObserver: evidence.observer,
      })
    ).rejects.toThrow("No bids received");

    expect(evidence.outcomes[0]).toEqual({
      agentId: "invalid",
      phase: "bid",
      attempt: 0,
      invocationIndex: 0,
      success: false,
      durationMs: expect.any(Number),
      failureKind: "invalid_bid",
      error: "Invalid bid response",
    });
    expect(JSON.stringify(evidence.outcomes)).not.toContain(rawInvalid);
  });

  it("terminalizes a bid deadline once and ignores late model settlement", async () => {
    vi.useFakeTimers();
    let resolveLate!: (message: AIMessage) => void;
    const late = new Promise<AIMessage>((resolve) => {
      resolveLate = resolve;
    });
    const specialist = createAgent("slow", [{ pending: late }]);
    const evidence = captureEvidence();
    const execution = ContractNetManager.executeDetailed({
      specialists: [specialist.agent],
      task: "deadline work",
      bidDeadlineMs: 10,
      invocationObserver: evidence.observer,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(specialist.invoke).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(11);
    const thrown = await execution;

    expect(thrown).toBeInstanceOf(OrchestrationError);
    expect(evidence.outcomes).toEqual([
      expect.objectContaining({
        agentId: "slow",
        success: false,
        failureKind: "deadline",
        error: "Bid deadline exceeded",
      }),
    ]);

    resolveLate(
      new AIMessage({ content: bid({ cost: 1 }), response_metadata: {} })
    );
    await vi.advanceTimersByTimeAsync(0);
    await flushInvocationStart();
    expect(evidence.outcomes).toHaveLength(1);
  });

  it("distinguishes external bid cancellation from the deadline", async () => {
    let resolveLate!: (message: AIMessage) => void;
    const late = new Promise<AIMessage>((resolve) => {
      resolveLate = resolve;
    });
    const specialist = createAgent("cancelled", [{ pending: late }]);
    const controller = new AbortController();
    const evidence = captureEvidence();
    const execution = ContractNetManager.executeDetailed({
      specialists: [specialist.agent],
      task: "cancel work",
      signal: controller.signal,
      invocationObserver: evidence.observer,
    }).catch((error: unknown) => error);

    await flushInvocationStart();
    controller.abort(new Error("caller cancelled"));
    const thrown = await execution;

    expect(thrown).toBeInstanceOf(OrchestrationError);
    expect(evidence.outcomes).toEqual([
      expect.objectContaining({
        agentId: "cancelled",
        success: false,
        failureKind: "cancelled",
        error: "Bid cancelled",
      }),
    ]);

    resolveLate(new AIMessage({ content: bid(), response_metadata: {} }));
  });

  it("records retry bids as distinct attempts for the same agent", async () => {
    const validRetry = bid({ approach: "retry approach" });
    const specialist = createAgent("retry", [
      { content: "invalid first bid" },
      { content: validRetry },
      { content: "retry execution" },
    ]);

    const detailed = await ContractNetManager.executeDetailed({
      specialists: [specialist.agent],
      task: "retry work",
      retryOnNoBids: true,
    });

    expect(detailed.invocations).toEqual([
      expect.objectContaining({
        phase: "bid",
        attempt: 0,
        invocationIndex: 0,
        success: false,
        failureKind: "invalid_bid",
      }),
      expect.objectContaining({
        phase: "bid",
        attempt: 1,
        invocationIndex: 1,
        success: true,
        content: validRetry,
      }),
      expect.objectContaining({
        phase: "execute",
        invocationIndex: 2,
        success: true,
        content: "retry execution",
      }),
    ]);
  });

  it("keeps winner execution failure as a normal failed detailed result", async () => {
    const executionError = new Error("winner execution failed");
    const specialist = createAgent("winner", [
      { content: bid() },
      { error: executionError },
    ]);

    const detailed = await ContractNetManager.executeDetailed({
      specialists: [specialist.agent],
      task: "execute work",
    });

    expect(detailed.result).toEqual(
      expect.objectContaining({
        agentId: "winner",
        success: false,
        error: executionError.message,
      })
    );
    expect(detailed.invocations[1]).toEqual(
      expect.objectContaining({
        phase: "execute",
        success: false,
        failureKind: "model_error",
        error: executionError.message,
      })
    );
  });

  it("does not let a synchronous completion observer replace the outer error", async () => {
    const observerError = new Error("observer must stay evidence-only");
    const specialist = createAgent("invalid", [{ content: "not json" }]);

    let thrown: unknown;
    try {
      await ContractNetManager.executeDetailed({
        specialists: [specialist.agent],
        task: "observer isolation",
        invocationObserver: {
          onComplete: () => {
            throw observerError;
          },
        },
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OrchestrationError);
    expect(thrown).not.toBe(observerError);
    expect((thrown as Error).message).toContain("No bids received");
  });

  it("swallows asynchronous observer rejection without changing success", async () => {
    const specialist = createAgent("winner", [
      { content: bid() },
      { content: "done" },
    ]);

    const detailed = await ContractNetManager.executeDetailed({
      specialists: [specialist.agent],
      task: "async observer isolation",
      invocationObserver: {
        onStart: () => Promise.reject(new Error("start observer rejected")),
        onComplete: () =>
          Promise.reject(new Error("completion observer rejected")),
      },
    });
    await flushInvocationStart();

    expect(detailed.result.success).toBe(true);
    expect(detailed.invocations).toHaveLength(2);
  });

  it("routes legacy execute through the detailed execution path", async () => {
    const legacyResult = {
      cfpId: "cfp-legacy",
      agentId: "specialist",
      success: true,
      result: "legacy result",
      actualDurationMs: 4,
    };
    const detailed = vi
      .spyOn(ContractNetManager, "executeDetailed")
      .mockResolvedValue({ result: legacyResult, invocations: [] });
    const specialist = createAgent("specialist", []);
    const config: ContractNetConfig = {
      specialists: [specialist.agent],
      task: "legacy work",
    };

    const result = await ContractNetManager.execute(config);

    expect(result).toBe(legacyResult);
    expect(detailed).toHaveBeenCalledOnce();
    expect(detailed).toHaveBeenCalledWith(config);
  });

  it("emits no invocation evidence for a pre-aborted run", async () => {
    const specialist = createAgent("never-started", [{ content: bid() }]);
    const controller = new AbortController();
    controller.abort();
    const evidence = captureEvidence();

    await expect(
      ContractNetManager.executeDetailed({
        specialists: [specialist.agent],
        task: "pre-aborted work",
        signal: controller.signal,
        invocationObserver: evidence.observer,
      })
    ).rejects.toThrow("aborted before execution");

    expect(specialist.invoke).not.toHaveBeenCalled();
    expect(evidence.starts).toEqual([]);
    expect(evidence.outcomes).toEqual([]);
  });
});
