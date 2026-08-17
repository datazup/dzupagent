/**
 * `AgentMiddleware.beforeAgent` state flow — proved through REAL runs.
 *
 * The declared contract is
 * `(state: Record<string, unknown>) => Promise<Partial<Record<string, unknown>>>`,
 * documented as "run before agent starts — can modify initial state". Both
 * halves used to be unreachable: the agent runtime passed a literal `{}` (no
 * state in) and threw the returned partial away (no state out).
 *
 * These specs drive `DzupAgent.generate()` / `.stream()` and assert on the
 * ARGUMENT the middleware actually received and on the merged state that
 * reaches `GenerateResult.middlewareState`. A runtime that reverts to `{}` in,
 * or that discards the patch, fails them.
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
import { DzupAgent } from "../agent/dzip-agent.js";
import type { AgentStreamEvent } from "../agent/agent-types.js";

type MockChatModel = BaseChatModel & {
  invoke: ReturnType<typeof vi.fn>;
  bindTools: ReturnType<typeof vi.fn>;
  stream?: ReturnType<typeof vi.fn>;
};

function createMockModel(
  content = "ok",
  options?: { stream?: boolean }
): MockChatModel {
  const model = {
    invoke: vi.fn(async (_messages: BaseMessage[]) => new AIMessage(content)),
    bindTools: vi.fn().mockReturnThis(),
  };

  if (options?.stream === false) {
    return model as unknown as MockChatModel;
  }

  return {
    ...model,
    stream: vi.fn(async function* (_messages: BaseMessage[]) {
      yield new AIMessage(content);
    }),
  } as unknown as MockChatModel;
}

const noopTool = tool(async () => "ok", {
  name: "noop",
  description: "a no-op tool",
  schema: z.object({}),
});

describe("beforeAgent — state IN", () => {
  it("receives the real initial run state, not an empty object", async () => {
    let observed: Record<string, unknown> | undefined;

    const agent = new DzupAgent({
      id: "before-agent-in",
      instructions: "test",
      model: createMockModel("ok", { stream: false }),
      tools: [noopTool],
      middleware: [
        {
          name: "observer",
          beforeAgent: async (state) => {
            observed = { ...state };
            return {};
          },
        },
      ],
    });

    await agent.generate([new HumanMessage("the-user-question")], {
      runId: "run-state-1",
      maxIterations: 4,
    });

    // Each assertion below is a fact a `{}` argument could not carry.
    expect(observed).toBeDefined();
    expect(observed!["agentId"]).toBe("before-agent-in");
    expect(observed!["runId"]).toBe("run-state-1");
    expect(observed!["maxIterations"]).toBe(4);
    expect(observed!["tools"]).toEqual(["noop"]);

    const messages = observed!["messages"] as BaseMessage[];
    expect(Array.isArray(messages)).toBe(true);
    expect(
      messages.some((message) => message.content === "the-user-question")
    ).toBe(true);
  });

  it("omits runId from the state when the run has none", async () => {
    let observed: Record<string, unknown> | undefined;

    const agent = new DzupAgent({
      id: "before-agent-no-run-id",
      instructions: "test",
      model: createMockModel("ok", { stream: false }),
      middleware: [
        {
          name: "observer",
          beforeAgent: async (state) => {
            observed = { ...state };
            return {};
          },
        },
      ],
    });

    await agent.generate([new HumanMessage("hi")]);

    expect(observed).toBeDefined();
    expect("runId" in observed!).toBe(false);
    expect(observed!["agentId"]).toBe("before-agent-no-run-id");
  });

  it("threads the state through the streaming path too", async () => {
    let observed: Record<string, unknown> | undefined;

    const agent = new DzupAgent({
      id: "before-agent-stream-in",
      instructions: "test",
      model: createMockModel("streamed"),
      middleware: [
        {
          name: "observer",
          beforeAgent: async (state) => {
            observed = { ...state };
            return {};
          },
        },
      ],
    });

    const events: AgentStreamEvent[] = [];
    for await (const event of agent.stream([new HumanMessage("stream-q")], {
      runId: "run-state-stream",
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(observed!["agentId"]).toBe("before-agent-stream-in");
    expect(observed!["runId"]).toBe("run-state-stream");
    expect(
      (observed!["messages"] as BaseMessage[]).some(
        (message) => message.content === "stream-q"
      )
    ).toBe(true);
  });
});

describe("beforeAgent — state OUT", () => {
  it("merges the returned patch onto GenerateResult.middlewareState", async () => {
    const agent = new DzupAgent({
      id: "before-agent-out",
      instructions: "test",
      model: createMockModel("ok", { stream: false }),
      middleware: [
        {
          name: "patcher",
          beforeAgent: async () => ({ tenant: "acme", featureFlag: true }),
        },
      ],
    });

    const result = await agent.generate([new HumanMessage("hi")]);

    // The patch survives the run and reaches the caller.
    expect(result.middlewareState).toBeDefined();
    expect(result.middlewareState!["tenant"]).toBe("acme");
    expect(result.middlewareState!["featureFlag"]).toBe(true);
    // …alongside the seeded run facts.
    expect(result.middlewareState!["agentId"]).toBe("before-agent-out");
  });

  it("lets a later middleware read and override an earlier one's patch", async () => {
    const secondSaw: Array<unknown> = [];

    const agent = new DzupAgent({
      id: "before-agent-chain",
      instructions: "test",
      model: createMockModel("ok", { stream: false }),
      middleware: [
        {
          name: "first",
          beforeAgent: async () => ({ step: "a", onlyFirst: 1 }),
        },
        {
          name: "second",
          beforeAgent: async (state) => {
            secondSaw.push(state["step"], state["onlyFirst"]);
            return { step: "b" };
          },
        },
      ],
    });

    const result = await agent.generate([new HumanMessage("hi")]);

    // The chain is a chain: the second hook observed the first hook's patch.
    expect(secondSaw).toEqual(["a", 1]);
    // Later keys win; untouched keys survive.
    expect(result.middlewareState!["step"]).toBe("b");
    expect(result.middlewareState!["onlyFirst"]).toBe(1);
  });

  it("keeps a throwing middleware non-fatal without losing earlier patches", async () => {
    const agent = new DzupAgent({
      id: "before-agent-throwing",
      instructions: "test",
      model: createMockModel("survived", { stream: false }),
      middleware: [
        { name: "first", beforeAgent: async () => ({ kept: "yes" }) },
        {
          name: "exploder",
          beforeAgent: async () => {
            throw new Error("beforeAgent exploded");
          },
        },
        { name: "third", beforeAgent: async () => ({ alsoKept: "yes" }) },
      ],
    });

    const result = await agent.generate([new HumanMessage("hi")]);

    expect(result.content).toBe("survived");
    expect(result.middlewareState!["kept"]).toBe("yes");
    expect(result.middlewareState!["alsoKept"]).toBe("yes");
  });

  it("treats a middleware returning a non-object as contributing no patch", async () => {
    const agent = new DzupAgent({
      id: "before-agent-nonobject",
      instructions: "test",
      model: createMockModel("ok", { stream: false }),
      middleware: [
        { name: "first", beforeAgent: async () => ({ kept: "yes" }) },
        {
          name: "returns-nothing",
          // A middleware written before the contract was reachable may return
          // nothing at all; that must not wipe the accumulated state.
          beforeAgent: (async () => undefined) as unknown as (
            state: Record<string, unknown>
          ) => Promise<Record<string, unknown>>,
        },
      ],
    });

    const result = await agent.generate([new HumanMessage("hi")]);

    expect(result.middlewareState!["kept"]).toBe("yes");
    expect(result.middlewareState!["agentId"]).toBe("before-agent-nonobject");
  });

  it("still reports the seeded state when no middleware is configured", async () => {
    const agent = new DzupAgent({
      id: "before-agent-none",
      instructions: "test",
      model: createMockModel("ok", { stream: false }),
    });

    const result = await agent.generate([new HumanMessage("hi")]);

    expect(result.middlewareState!["agentId"]).toBe("before-agent-none");
    expect(result.middlewareState!["tools"]).toEqual([]);
  });
});
