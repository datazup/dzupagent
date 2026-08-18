/**
 * Admission coverage for truthful debate invocation evidence.
 *
 * The main cases use real DzupAgent model doubles. Narrow generate() spies are
 * reserved for cancellation and exact controlled-settlement seams.
 */
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DzupAgent } from "../../agent/dzip-agent.js";
import {
  AgentOrchestrator,
  type DebateInvocationOutcome,
  type DebateInvocationStart,
  type DebateOptions,
  type DebateResult,
} from "../orchestrator.js";
import type { OrchestrationError } from "../orchestration-error.js";

type ModelStep =
  | { readonly content: string }
  | { readonly error: unknown }
  | { readonly run: () => Promise<string> };

interface AgentHarness {
  readonly agent: DzupAgent;
  readonly invoke: ReturnType<typeof vi.fn>;
}

function createAgent(id: string, steps: readonly ModelStep[]): AgentHarness {
  let index = 0;
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    const step = steps[index] ?? steps[steps.length - 1]!;
    index += 1;
    if ("error" in step) throw step.error;
    const content = "run" in step ? await step.run() : step.content;
    return new AIMessage({ content, response_metadata: {} });
  });
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
      description: `${id} agent`,
      instructions: `You are ${id}.`,
      model,
      guardrails: { maxIterations: 5 },
    }),
    invoke,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function drainMacrotasks(turns = 3): Promise<void> {
  for (let index = 0; index < turns; index++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function debateDetailed(
  proposers: DzupAgent[],
  judge: DzupAgent,
  task: string,
  options?: DebateOptions
): Promise<DebateResult> {
  return AgentOrchestrator.debateDetailed(proposers, judge, task, options);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentOrchestrator.debateDetailed invocation evidence", () => {
  it("returns the judge content, executed rounds, duration, and every invocation", async () => {
    const proposerA = createAgent("proposer-a", [
      { content: "a-one" },
      { content: "a-two" },
    ]).agent;
    const proposerB = createAgent("proposer-b", [
      { content: "b-one" },
      { content: "b-two" },
    ]).agent;
    const judge = createAgent("judge", [{ content: "final verdict" }]).agent;

    const result = await debateDetailed(
      [proposerA, proposerB],
      judge,
      "choose",
      { rounds: 2 }
    );

    expect(result.content).toBe("final verdict");
    expect(result.roundsExecuted).toBe(2);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.durationMs)).toBe(true);
    expect(result.invocations).toHaveLength(5);
    expect(
      result.invocations.filter(
        (item) => item.durationMs >= 0 && Number.isFinite(item.durationMs)
      )
    ).toHaveLength(5);
    expect(
      result.invocations.map(({ agentId, role, invocationIndex, round }) => ({
        agentId,
        role,
        invocationIndex,
        round,
      }))
    ).toEqual([
      { agentId: "proposer-a", role: "proposer", invocationIndex: 0, round: 0 },
      { agentId: "proposer-b", role: "proposer", invocationIndex: 1, round: 0 },
      { agentId: "proposer-a", role: "proposer", invocationIndex: 2, round: 1 },
      { agentId: "proposer-b", role: "proposer", invocationIndex: 3, round: 1 },
      { agentId: "judge", role: "judge", invocationIndex: 4, round: undefined },
    ]);
  });

  it("emits start immediately before generate and completion immediately after", async () => {
    const order: string[] = [];
    const proposer = createAgent("proposer", [{ content: "proposal" }]).agent;
    const judge = createAgent("judge", [{ content: "verdict" }]).agent;
    const generateProposal = proposer.generate.bind(proposer);
    const generateVerdict = judge.generate.bind(judge);
    vi.spyOn(proposer, "generate").mockImplementation((messages, options) => {
      order.push("generate:proposer");
      return generateProposal(messages, options);
    });
    vi.spyOn(judge, "generate").mockImplementation((messages, options) => {
      order.push("generate:judge");
      return generateVerdict(messages, options);
    });

    await debateDetailed([proposer], judge, "task", {
      invocationObserver: {
        onStart: (item) => order.push(`start:${item.role}`),
        onComplete: (item) => order.push(`complete:${item.role}`),
      },
    });

    expect(order).toEqual([
      "start:proposer",
      "generate:proposer",
      "complete:proposer",
      "start:judge",
      "generate:judge",
      "complete:judge",
    ]);
  });

  it("exposes exact minimal keys and keeps successful content only on outcomes", async () => {
    const starts: DebateInvocationStart[] = [];
    const proposer = createAgent("minimal-proposer", [
      { content: "proposal secret is permitted output" },
    ]).agent;
    const judge = createAgent("minimal-judge", [{ content: "verdict" }]).agent;

    const result = await debateDetailed([proposer], judge, "sensitive prompt", {
      invocationObserver: { onStart: (item) => starts.push(item) },
    });

    expect(Object.keys(starts[0]!).sort()).toEqual([
      "agentId",
      "invocationIndex",
      "role",
      "round",
    ]);
    expect(Object.keys(starts[1]!).sort()).toEqual([
      "agentId",
      "invocationIndex",
      "role",
    ]);
    expect(Object.keys(result.invocations[0]!).sort()).toEqual([
      "agentId",
      "content",
      "durationMs",
      "invocationIndex",
      "role",
      "round",
      "success",
    ]);
    expect(Object.keys(result.invocations[1]!).sort()).toEqual([
      "agentId",
      "content",
      "durationMs",
      "invocationIndex",
      "role",
      "success",
    ]);
    expect("error" in result.invocations[0]!).toBe(false);
    expect(result.invocations.map((item) => item.content)).toEqual([
      "proposal secret is permitted output",
      "verdict",
    ]);
    expect(JSON.stringify(result.invocations)).not.toContain("sensitive prompt");
  });

  it("sorts successful results by invocation start even when completion reverses", async () => {
    const slowGate = deferred<string>();
    const fastCompleted = deferred<void>();
    const completionOrder: string[] = [];
    const slow = createAgent("slow", [{ run: () => slowGate.promise }]).agent;
    const fast = createAgent("fast", [{ content: "fast proposal" }]).agent;
    const judge = createAgent("judge", [{ content: "verdict" }]);

    const run = debateDetailed([slow, fast], judge.agent, "task", {
      maxConcurrency: 2,
      invocationObserver: {
        onComplete: (item) => {
          completionOrder.push(item.agentId);
          if (item.agentId === "fast") fastCompleted.resolve(undefined);
        },
      },
    });
    await fastCompleted.promise;
    slowGate.resolve("slow proposal");
    const result = await run;

    expect(completionOrder).toEqual(["fast", "slow", "judge"]);
    expect(result.invocations.map((item) => item.agentId)).toEqual([
      "slow",
      "fast",
      "judge",
    ]);
    expect(result.invocations.map((item) => item.invocationIndex)).toEqual([
      0, 1, 2,
    ]);
    const judgeMessages = judge.invoke.mock.calls[0]![0] as BaseMessage[];
    const judgeText = judgeMessages
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content)
      )
      .join("\n");
    expect(judgeText.indexOf("slow proposal")).toBeLessThan(
      judgeText.indexOf("fast proposal")
    );
  });

  it("keeps repeated agent IDs as distinct monotonically indexed invocations", async () => {
    const first = createAgent("repeat", [{ content: "first" }]).agent;
    const second = createAgent("repeat", [{ content: "second" }]).agent;
    const judge = createAgent("repeat", [{ content: "verdict" }]).agent;

    const result = await debateDetailed([first, second], judge, "task");

    expect(
      result.invocations.map((item) => [
        item.agentId,
        item.role,
        item.invocationIndex,
      ])
    ).toEqual([
      ["repeat", "proposer", 0],
      ["repeat", "proposer", 1],
      ["repeat", "judge", 2],
    ]);
  });

  it("records a bounded first failure without inventing never-started work", async () => {
    const failure = new Error("first proposer failed");
    const first = createAgent("first", [{ error: failure }]).agent;
    const neverStarted = createAgent("never-started", [
      { content: "must not run" },
    ]);
    const judge = createAgent("judge", [{ content: "must not judge" }]);
    const starts: DebateInvocationStart[] = [];
    const outcomes: DebateInvocationOutcome[] = [];

    const run = debateDetailed([first, neverStarted.agent], judge.agent, "task", {
      maxConcurrency: 1,
      invocationObserver: {
        onStart: (item) => starts.push(item),
        onComplete: (item) => outcomes.push(item),
      },
    });

    await expect(run).rejects.toBe(failure);
    expect(starts.map((item) => item.agentId)).toEqual(["first"]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toEqual(
      expect.objectContaining({
        agentId: "first",
        role: "proposer",
        invocationIndex: 0,
        round: 0,
        success: false,
        error: "first proposer failed",
      })
    );
    expect(Object.keys(outcomes[0]!).sort()).toEqual([
      "agentId",
      "durationMs",
      "error",
      "invocationIndex",
      "role",
      "round",
      "success",
    ]);
    expect("content" in outcomes[0]!).toBe(false);
    expect(neverStarted.invoke).not.toHaveBeenCalled();
    expect(judge.invoke).not.toHaveBeenCalled();
  });

  it("exposes already-settled outcomes at rejection without fabricating pending completion", async () => {
    const failGate = deferred<void>();
    const goodCompleted = deferred<void>();
    const failure = new Error("later failure");
    const good = createAgent("good", [{ content: "settled" }]).agent;
    const failing = createAgent("failing", [
      {
        run: async () => {
          await failGate.promise;
          throw failure;
        },
      },
    ]).agent;
    const pending = createAgent("pending", [
      { run: () => new Promise<string>(() => {}) },
    ]).agent;
    const judge = createAgent("judge", [{ content: "must not judge" }]);
    const starts: DebateInvocationStart[] = [];
    const outcomes: DebateInvocationOutcome[] = [];

    const run = debateDetailed([good, failing, pending], judge.agent, "task", {
      maxConcurrency: 3,
      invocationObserver: {
        onStart: (item) => starts.push(item),
        onComplete: (item) => {
          outcomes.push(item);
          if (item.agentId === "good") goodCompleted.resolve(undefined);
        },
      },
    });
    await goodCompleted.promise;
    failGate.resolve(undefined);

    await expect(run).rejects.toBe(failure);
    expect(starts.map((item) => item.agentId)).toEqual([
      "good",
      "failing",
      "pending",
    ]);
    expect(outcomes.map((item) => [item.agentId, item.success])).toEqual([
      ["good", true],
      ["failing", false],
    ]);
    expect(judge.invoke).not.toHaveBeenCalled();
  });

  it("rethrows a later-round proposer failure by identity and never starts the judge", async () => {
    const failure = new Error("round two failed");
    const proposer = createAgent("two-round", [
      { content: "round one" },
      { error: failure },
    ]).agent;
    const judge = createAgent("judge", [{ content: "must not judge" }]);
    const outcomes: DebateInvocationOutcome[] = [];

    const run = debateDetailed([proposer], judge.agent, "task", {
      rounds: 2,
      invocationObserver: { onComplete: (item) => outcomes.push(item) },
    });

    await expect(run).rejects.toBe(failure);
    expect(outcomes.map((item) => [item.round, item.success])).toEqual([
      [0, true],
      [1, false],
    ]);
    expect(judge.invoke).not.toHaveBeenCalled();
  });

  it("rethrows a judge failure by identity after recording its failure", async () => {
    const failure = new Error("judge failed");
    const proposer = createAgent("proposer", [{ content: "proposal" }]).agent;
    const judge = createAgent("judge", [{ error: failure }]).agent;
    const outcomes: DebateInvocationOutcome[] = [];

    const run = debateDetailed([proposer], judge, "task", {
      invocationObserver: { onComplete: (item) => outcomes.push(item) },
    });

    await expect(run).rejects.toBe(failure);
    expect(outcomes.map((item) => [item.role, item.success])).toEqual([
      ["proposer", true],
      ["judge", false],
    ]);
    expect(outcomes[1]?.error).toBe("judge failed");
    expect("content" in outcomes[1]!).toBe(false);
  });

  it("preserves the pre-abort OrchestrationError and emits no evidence", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already aborted"));
    const proposer = createAgent("proposer", [{ content: "never" }]);
    const judge = createAgent("judge", [{ content: "never" }]);
    const onStart = vi.fn();
    const onComplete = vi.fn();

    const run = debateDetailed([proposer.agent], judge.agent, "task", {
      signal: controller.signal,
      invocationObserver: { onStart, onComplete },
    });

    await expect(run).rejects.toEqual(
      expect.objectContaining<Partial<OrchestrationError>>({
        message: "debate() aborted before execution",
        pattern: "debate",
      })
    );
    expect(onStart).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(proposer.invoke).not.toHaveBeenCalled();
    expect(judge.invoke).not.toHaveBeenCalled();
  });

  it("records an empty-proposer debate as one judge invocation", async () => {
    const judge = createAgent("judge-only", [{ content: "no proposals" }]).agent;

    const result = await debateDetailed([], judge, "task");

    expect(result.content).toBe("no proposals");
    expect(result.roundsExecuted).toBe(1);
    expect(result.invocations).toEqual([
      expect.objectContaining({
        agentId: "judge-only",
        role: "judge",
        invocationIndex: 0,
        success: true,
        content: "no proposals",
      }),
    ]);
  });

  it("treats rounds zero as a judge-only debate with zero rounds executed", async () => {
    const proposer = createAgent("unused", [{ content: "never" }]);
    const judge = createAgent("judge-only", [{ content: "zero-round verdict" }]);

    const result = await debateDetailed(
      [proposer.agent],
      judge.agent,
      "task",
      { rounds: 0 }
    );

    expect(result.roundsExecuted).toBe(0);
    expect(result.invocations.map((item) => item.role)).toEqual(["judge"]);
    expect(proposer.invoke).not.toHaveBeenCalled();
  });

  it("isolates synchronous observer failures from execution and retained evidence", async () => {
    const proposer = createAgent("proposer", [{ content: "proposal" }]).agent;
    const judge = createAgent("judge", [{ content: "verdict" }]).agent;
    const onStart = vi.fn(() => {
      throw new Error("start observer failed");
    });
    const onComplete = vi.fn(() => {
      throw new Error("completion observer failed");
    });

    const result = await debateDetailed([proposer], judge, "task", {
      invocationObserver: { onStart, onComplete },
    });
    const originalFailure = new Error("real failure");
    const failing = createAgent("failing", [{ error: originalFailure }]).agent;

    expect(result.content).toBe("verdict");
    expect(result.invocations).toHaveLength(2);
    await expect(
      debateDetailed([failing], judge, "task", {
        invocationObserver: { onStart, onComplete },
      })
    ).rejects.toBe(originalFailure);
    expect(onStart).toHaveBeenCalledTimes(3);
    expect(onComplete).toHaveBeenCalledTimes(3);
  });

  it("swallows asynchronous observer rejection without an unhandled rejection", async () => {
    const proposer = createAgent("proposer", [{ content: "proposal" }]).agent;
    const judge = createAgent("judge", [{ content: "verdict" }]).agent;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    const observerFailure = deferred<void>();
    const rejectObserver = vi.fn(() => observerFailure.promise);
    const catchSpy = vi.spyOn(Promise.prototype, "catch");
    process.on("unhandledRejection", onUnhandled);

    try {
      const result = await debateDetailed([proposer], judge, "task", {
        invocationObserver: {
          onStart: rejectObserver,
          onComplete: rejectObserver,
        },
      });
      const observerCatchCount = catchSpy.mock.instances.filter(
        (instance) => instance === observerFailure.promise
      ).length;
      const handledFailure = observerFailure.promise.catch(() => {});
      observerFailure.reject(new Error("observer rejected"));
      await drainMacrotasks();
      await handledFailure;

      expect(result.content).toBe("verdict");
      expect(rejectObserver).toHaveBeenCalledTimes(4);
      expect(observerCatchCount).toBe(4);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("preserves caller cancellation identity and records only the started terminal call", async () => {
    const controller = new AbortController();
    const cancellation = new Error("caller cancelled");
    const proposer = createAgent("cancelled", [{ content: "unused" }]).agent;
    const judge = createAgent("judge", [{ content: "must not judge" }]);
    const outcomes: DebateInvocationOutcome[] = [];
    vi.spyOn(proposer, "generate").mockImplementation(
      async (_messages, options) =>
        await new Promise<never>((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) return;
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        })
    );

    const run = debateDetailed([proposer], judge.agent, "task", {
      signal: controller.signal,
      invocationObserver: { onComplete: (item) => outcomes.push(item) },
    });
    controller.abort(cancellation);

    await expect(run).rejects.toBe(cancellation);
    expect(outcomes).toEqual([
      expect.objectContaining({
        agentId: "cancelled",
        success: false,
        error: "caller cancelled",
      }),
    ]);
    expect(judge.invoke).not.toHaveBeenCalled();
  });

  it("routes legacy debate through the same observable execution", async () => {
    const proposer = createAgent("legacy-proposer", [
      { content: "proposal" },
    ]).agent;
    const judge = createAgent("legacy-judge", [{ content: "legacy verdict" }])
      .agent;
    const starts: DebateInvocationStart[] = [];
    const outcomes: DebateInvocationOutcome[] = [];

    const result = await AgentOrchestrator.debate(
      [proposer],
      judge,
      "task",
      {
        invocationObserver: {
          onStart: (item: DebateInvocationStart) => starts.push(item),
          onComplete: (item: DebateInvocationOutcome) => outcomes.push(item),
        },
      }
    );

    expect(result).toBe("legacy verdict");
    expect(starts.map((item) => item.role)).toEqual(["proposer", "judge"]);
    expect(outcomes.map((item) => item.role)).toEqual(["proposer", "judge"]);
  });

  it("keeps the legacy positional call returning only the judge string", async () => {
    const proposer = createAgent("legacy", [{ content: "proposal" }]).agent;
    const judge = createAgent("judge", [{ content: "judge string" }]).agent;

    const result = await AgentOrchestrator.debate([proposer], judge, "task");

    expect(result).toBe("judge string");
    expect(typeof result).toBe("string");
  });

  it("keeps legacy rounds-zero judge-only behavior", async () => {
    const proposer = createAgent("unused", [{ content: "never" }]);
    const judge = createAgent("judge", [{ content: "legacy zero" }]).agent;

    const result = await AgentOrchestrator.debate(
      [proposer.agent],
      judge,
      "task",
      { rounds: 0 }
    );

    expect(result).toBe("legacy zero");
    expect(proposer.invoke).not.toHaveBeenCalled();
  });
});
