/**
 * Run-lifecycle hook dispatch — proved through REAL runs.
 *
 * `onRunStart` / `onRunComplete` / `onRunError` were declared on `AgentHooks`
 * for a long time without a single production dispatch site. The prior test
 * coverage was vacuous: every spec invoked the hook itself (directly, or by
 * handing it to `runHooks`), which proved only that a function can be called.
 *
 * Every test in this file therefore drives a real `DzupAgent.generate()` /
 * `.stream()` / `.generateStructured()` and asserts the hook fired AS A
 * CONSEQUENCE — call counts, argument identity, and ordering. Deleting the
 * dispatch from the run coordinator must make these fail.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { AgentHooks, HookContext } from "@dzupagent/core/orchestration";
import { DzupAgent } from "../agent/dzip-agent.js";
import type {
  AgentStreamEvent,
  GenerateOptions,
} from "../agent/agent-types.js";
import { makeMockEventBus } from "./test-utils.js";

type MockChatModel = BaseChatModel & {
  invoke: ReturnType<typeof vi.fn>;
  bindTools: ReturnType<typeof vi.fn>;
  stream?: ReturnType<typeof vi.fn>;
};

function createMockModel(
  responses: AIMessage[],
  options?: { stream?: boolean }
): MockChatModel {
  let invokeIndex = 0;
  let streamIndex = 0;

  const model = {
    invoke: vi.fn(async (_messages: BaseMessage[]) => {
      const response =
        responses[invokeIndex] ?? responses.at(-1) ?? new AIMessage("done");
      invokeIndex += 1;
      return response;
    }),
    bindTools: vi.fn().mockReturnThis(),
  };

  if (options?.stream === false) {
    return model as unknown as MockChatModel;
  }

  return {
    ...model,
    stream: vi.fn(async function* (_messages: BaseMessage[]) {
      const response =
        responses[streamIndex] ?? responses.at(-1) ?? new AIMessage("done");
      streamIndex += 1;
      yield response;
    }),
  } as unknown as MockChatModel;
}

/** A model whose every invocation rejects — drives the thrown-error path. */
function createThrowingModel(error: Error): MockChatModel {
  return {
    invoke: vi.fn(async () => {
      throw error;
    }),
    bindTools: vi.fn().mockReturnThis(),
  } as unknown as MockChatModel;
}

/**
 * Recording hook set.
 *
 * The `log` array captures ORDER across all three hooks; the per-hook arrays
 * capture the exact arguments so we can assert identity rather than shape.
 */
function recordingHooks(): {
  hooks: AgentHooks;
  log: string[];
  startCtxs: HookContext[];
  completeArgs: Array<{ ctx: HookContext; result: unknown }>;
  errorArgs: Array<{ ctx: HookContext; error: Error }>;
} {
  const log: string[] = [];
  const startCtxs: HookContext[] = [];
  const completeArgs: Array<{ ctx: HookContext; result: unknown }> = [];
  const errorArgs: Array<{ ctx: HookContext; error: Error }> = [];

  return {
    log,
    startCtxs,
    completeArgs,
    errorArgs,
    hooks: {
      onRunStart: async (ctx) => {
        log.push("start");
        startCtxs.push(ctx);
      },
      onRunComplete: async (ctx, result) => {
        log.push("complete");
        completeArgs.push({ ctx, result });
      },
      onRunError: async (ctx, error) => {
        log.push("error");
        errorArgs.push({ ctx, error });
      },
    },
  };
}

async function collectStream(
  agent: DzupAgent,
  options?: GenerateOptions
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of agent.stream([new HumanMessage("run")], options)) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// generate() — happy path
// ---------------------------------------------------------------------------

describe("run-lifecycle hooks — generate()", () => {
  it("fires onRunStart then onRunComplete exactly once, in that order", async () => {
    const rec = recordingHooks();
    const agent = new DzupAgent({
      id: "run-hooks-generate",
      instructions: "test",
      model: createMockModel([new AIMessage("hello")], { stream: false }),
      hooks: rec.hooks,
    });

    await agent.generate([new HumanMessage("hi")], { runId: "run-777" });

    // Order + counts. A missing dispatch collapses this array.
    expect(rec.log).toEqual(["start", "complete"]);
    expect(rec.startCtxs).toHaveLength(1);
    expect(rec.completeArgs).toHaveLength(1);
    expect(rec.errorArgs).toHaveLength(0);
  });

  it("passes a context carrying the real agent id and run id", async () => {
    // The fixture DISAGREES with the defaults on purpose: a stubbed-out
    // dispatch that handed over `{ agentId: '', runId: '' }` would fail here.
    const rec = recordingHooks();
    const agent = new DzupAgent({
      id: "run-hooks-ctx",
      instructions: "test",
      model: createMockModel([new AIMessage("hello")], { stream: false }),
      hooks: rec.hooks,
    });

    await agent.generate([new HumanMessage("hi")], { runId: "run-abc-123" });

    const ctx = rec.startCtxs[0]!;
    expect(ctx.agentId).toBe("run-hooks-ctx");
    expect(ctx.runId).toBe("run-abc-123");
    expect(ctx.metadata).toEqual({});
  });

  it("hands onRunComplete the very GenerateResult the caller receives", async () => {
    const rec = recordingHooks();
    const agent = new DzupAgent({
      id: "run-hooks-result",
      instructions: "test",
      model: createMockModel([new AIMessage("payload-content")], {
        stream: false,
      }),
      hooks: rec.hooks,
    });

    const result = await agent.generate([new HumanMessage("hi")]);

    // Identity, not shape: the hook must observe the same object, not a copy.
    expect(rec.completeArgs[0]!.result).toBe(result);
    expect(
      (rec.completeArgs[0]!.result as { content: string }).content
    ).toBe("payload-content");
  });

  it("gives onRunStart and onRunComplete the SAME context object", async () => {
    // Contract: a hook may stash per-run state on ctx.metadata at start and
    // read it back at completion.
    const seen: unknown[] = [];
    const agent = new DzupAgent({
      id: "run-hooks-identity",
      instructions: "test",
      model: createMockModel([new AIMessage("ok")], { stream: false }),
      hooks: {
        onRunStart: async (ctx) => {
          ctx.metadata["stashed"] = "from-start";
        },
        onRunComplete: async (ctx) => {
          seen.push(ctx.metadata["stashed"]);
        },
      },
    });

    await agent.generate([new HumanMessage("hi")]);

    expect(seen).toEqual(["from-start"]);
  });

  it("gives separate runs separate contexts (metadata does not leak)", async () => {
    const metadataSnapshots: Array<Record<string, unknown>> = [];
    const agent = new DzupAgent({
      id: "run-hooks-isolation",
      instructions: "test",
      model: createMockModel([new AIMessage("ok")], { stream: false }),
      hooks: {
        onRunStart: async (ctx) => {
          metadataSnapshots.push({ ...ctx.metadata });
          ctx.metadata["marker"] = "set";
        },
      },
    });

    await agent.generate([new HumanMessage("one")]);
    await agent.generate([new HumanMessage("two")]);

    expect(metadataSnapshots).toEqual([{}, {}]);
  });

  it("fires onRunStart before the model is ever invoked", async () => {
    const order: string[] = [];
    const model = createMockModel([new AIMessage("ok")], { stream: false });
    model.invoke.mockImplementation(async () => {
      order.push("model");
      return new AIMessage("ok");
    });

    const agent = new DzupAgent({
      id: "run-hooks-before-model",
      instructions: "test",
      model,
      hooks: {
        onRunStart: async () => {
          order.push("start");
        },
      },
    });

    await agent.generate([new HumanMessage("hi")]);

    expect(order).toEqual(["start", "model"]);
  });
});

// ---------------------------------------------------------------------------
// generate() — unhappy terminations
// ---------------------------------------------------------------------------

describe("run-lifecycle hooks — error propagation", () => {
  it("fires onRunError with the thrown error and STILL propagates it", async () => {
    const rec = recordingHooks();
    const boom = new Error("model exploded");
    const agent = new DzupAgent({
      id: "run-hooks-error",
      instructions: "test",
      model: createThrowingModel(boom),
      hooks: rec.hooks,
    });

    await expect(agent.generate([new HumanMessage("hi")])).rejects.toThrow(
      "model exploded"
    );

    expect(rec.log).toEqual(["start", "error"]);
    expect(rec.errorArgs).toHaveLength(1);
    // Identity: the hook sees the exact instance that propagates to the caller.
    expect(rec.errorArgs[0]!.error).toBe(boom);
    // onRunComplete must NOT fire for a thrown run.
    expect(rec.completeArgs).toHaveLength(0);
  });

  it("gives onRunStart and onRunError the SAME context object", async () => {
    const rec = recordingHooks();
    const agent = new DzupAgent({
      id: "run-hooks-error-ctx",
      instructions: "test",
      model: createThrowingModel(new Error("nope")),
      hooks: rec.hooks,
    });

    await expect(agent.generate([new HumanMessage("hi")])).rejects.toThrow();

    expect(rec.errorArgs[0]!.ctx).toBe(rec.startCtxs[0]);
  });

  it("fires onRunComplete (not onRunError) for a non-'complete' stopReason", async () => {
    // A run that terminates unhappily but RETURNS a result is a completion:
    // onRunError's contract requires a real Error, and there is none here.
    const rec = recordingHooks();
    const failingTool = tool(
      async () => {
        throw new Error("tool failed");
      },
      {
        name: "echo",
        description: "echo test tool",
        schema: z.object({ text: z.string() }),
      }
    );
    const agent = new DzupAgent({
      id: "run-hooks-stuck",
      instructions: "test",
      model: createMockModel(
        [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "c1", name: "echo", args: { text: "x" } }],
          }),
        ],
        { stream: false }
      ),
      tools: [failingTool],
      hooks: rec.hooks,
      guardrails: {
        stuckDetector: {
          maxRepeatCalls: 10,
          maxErrorsInWindow: 3,
          errorWindowMs: 60_000,
          maxIdleIterations: 10,
        },
      },
    });

    const result = await agent.generate([new HumanMessage("hi")], {
      maxIterations: 5,
    });

    expect(result.stopReason).toBe("stuck");
    expect(rec.log).toEqual(["start", "complete"]);
    expect((rec.completeArgs[0]!.result as { stopReason: string }).stopReason).toBe(
      "stuck"
    );
    expect(rec.errorArgs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Hook error isolation
// ---------------------------------------------------------------------------

describe("run-lifecycle hooks — isolation", () => {
  it("a throwing onRunStart does not break the run", async () => {
    const eventBus = makeMockEventBus();
    const agent = new DzupAgent({
      id: "run-hooks-throwing-start",
      instructions: "test",
      model: createMockModel([new AIMessage("survived")], { stream: false }),
      eventBus,
      hooks: {
        onRunStart: async () => {
          throw new Error("start hook exploded");
        },
      },
    });

    const result = await agent.generate([new HumanMessage("hi")]);

    expect(result.content).toBe("survived");
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "hook:error",
        hookName: "onRunStart",
        message: "start hook exploded",
      })
    );
  });

  it("a throwing onRunComplete does not break the run", async () => {
    const eventBus = makeMockEventBus();
    const agent = new DzupAgent({
      id: "run-hooks-throwing-complete",
      instructions: "test",
      model: createMockModel([new AIMessage("survived")], { stream: false }),
      eventBus,
      hooks: {
        onRunComplete: async () => {
          throw new Error("complete hook exploded");
        },
      },
    });

    const result = await agent.generate([new HumanMessage("hi")]);

    expect(result.content).toBe("survived");
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "hook:error",
        hookName: "onRunComplete",
        message: "complete hook exploded",
      })
    );
  });

  it("a throwing onRunError does not mask the original error", async () => {
    const eventBus = makeMockEventBus();
    const agent = new DzupAgent({
      id: "run-hooks-throwing-error",
      instructions: "test",
      model: createThrowingModel(new Error("original failure")),
      eventBus,
      hooks: {
        onRunError: async () => {
          throw new Error("error hook exploded");
        },
      },
    });

    // The ORIGINAL error must reach the caller, not the hook's.
    await expect(agent.generate([new HumanMessage("hi")])).rejects.toThrow(
      "original failure"
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "hook:error",
        hookName: "onRunError",
        message: "error hook exploded",
      })
    );
  });

  it("omits eventBus from the context when the config carries none", async () => {
    const ctxs: HookContext[] = [];
    const agent = new DzupAgent({
      id: "run-hooks-no-bus",
      instructions: "test",
      model: createMockModel([new AIMessage("ok")], { stream: false }),
      hooks: {
        onRunStart: async (ctx) => {
          ctxs.push(ctx);
        },
      },
    });

    await agent.generate([new HumanMessage("hi")]);

    expect(ctxs).toHaveLength(1);
    expect(ctxs[0]!.eventBus).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------

describe("run-lifecycle hooks — stream()", () => {
  it("fires onRunStart before the first event and onRunComplete after the last", async () => {
    const order: string[] = [];
    const agent = new DzupAgent({
      id: "run-hooks-stream",
      instructions: "test",
      model: createMockModel([new AIMessage("streamed")]),
      hooks: {
        onRunStart: async () => {
          order.push("start");
        },
        onRunComplete: async () => {
          order.push("complete");
        },
      },
    });

    const events: AgentStreamEvent[] = [];
    for await (const event of agent.stream([new HumanMessage("run")])) {
      order.push(`event:${event.type}`);
      events.push(event);
    }

    expect(order[0]).toBe("start");
    expect(order.at(-1)).toBe("complete");
    expect(order.filter((entry) => entry === "start")).toHaveLength(1);
    expect(order.filter((entry) => entry === "complete")).toHaveLength(1);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  it("does not start the run until the stream is actually iterated", async () => {
    const rec = recordingHooks();
    const agent = new DzupAgent({
      id: "run-hooks-stream-lazy",
      instructions: "test",
      model: createMockModel([new AIMessage("streamed")]),
      hooks: rec.hooks,
    });

    const iterator = agent.stream([new HumanMessage("run")]);
    // Merely constructing the generator must dispatch nothing.
    expect(rec.log).toEqual([]);

    await iterator.next();
    expect(rec.log).toEqual(["start"]);

    // Drain so the generator settles.
    for await (const _event of iterator) {
      // no-op
    }
  });

  it("hands onRunComplete the final done-event payload", async () => {
    const rec = recordingHooks();
    const agent = new DzupAgent({
      id: "run-hooks-stream-payload",
      instructions: "test",
      model: createMockModel([new AIMessage("streamed-content")]),
      hooks: rec.hooks,
    });

    const events = await collectStream(agent);
    const doneEvent = events.findLast((event) => event.type === "done");

    expect(rec.completeArgs).toHaveLength(1);
    expect(rec.completeArgs[0]!.result).toEqual(doneEvent?.data);
    expect(
      (rec.completeArgs[0]!.result as { stopReason?: string }).stopReason
    ).toBe("complete");
  });

  it("fires onRunError and propagates when the streaming run throws", async () => {
    const rec = recordingHooks();
    const boom = new Error("stream exploded");
    const model = createMockModel([new AIMessage("x")]);
    model.stream!.mockImplementation(() => {
      throw boom;
    });
    model.invoke.mockImplementation(async () => {
      throw boom;
    });

    const agent = new DzupAgent({
      id: "run-hooks-stream-error",
      instructions: "test",
      model,
      hooks: rec.hooks,
    });

    await expect(collectStream(agent)).rejects.toThrow("stream exploded");

    expect(rec.log).toEqual(["start", "error"]);
    expect(rec.errorArgs[0]!.error).toBe(boom);
    expect(rec.completeArgs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// generateStructured() — no double-fire
// ---------------------------------------------------------------------------

describe("run-lifecycle hooks — generateStructured()", () => {
  it("fires the run lifecycle exactly once when it falls back through generate()", async () => {
    // `runGenerateStructured` deliberately dispatches nothing of its own; the
    // fallback path routes through `generate`, so a second dispatch site would
    // show up here as two starts.
    const rec = recordingHooks();
    const agent = new DzupAgent({
      id: "run-hooks-structured",
      instructions: "test",
      model: createMockModel([new AIMessage('{"answer":"42"}')], {
        stream: false,
      }),
      hooks: rec.hooks,
    });

    const out = await agent.generateStructured(
      [new HumanMessage("hi")],
      z.object({ answer: z.string() })
    );

    expect(out.data).toEqual({ answer: "42" });
    expect(rec.log.filter((entry) => entry === "start")).toHaveLength(1);
    expect(rec.log.filter((entry) => entry === "complete")).toHaveLength(1);
  });
});
