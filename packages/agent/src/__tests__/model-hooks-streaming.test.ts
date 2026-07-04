/**
 * WS3 Task 3.2 — model-lifecycle hooks on the native streaming call path
 * (`streaming-run-iteration.ts` compression seam + stream final-message seam).
 *
 * `beforeModelCall` is wired at the streaming compression re-injection seam:
 * after a stream completes and the token-lifecycle plugin rebuilds the
 * transcript, the hook runs BEFORE prompt-cache injection, so the injected
 * marker is visible to the next stream iteration. `afterModelCall` fires ONCE
 * per completed stream with the fully-accumulated final message.
 */
import { describe, it, expect, vi } from "vitest";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AgentHooks } from "@dzupagent/core";
import { DzupAgent } from "../agent/dzip-agent.js";
import type {
  AgentStreamEvent,
  GenerateOptions,
} from "../agent/agent-types.js";
import type { AgentLoopPlugin } from "../token-lifecycle-wiring.js";

const MARKER = "STREAM_BEFORE_MODEL_CALL_MARKER";

function hasMarker(messages: BaseMessage[]): boolean {
  return messages.some(
    (m) => typeof m.content === "string" && m.content.includes(MARKER)
  );
}

function mockTool(name: string) {
  return {
    name,
    description: `Mock ${name}`,
    schema: { type: "object", properties: {} } as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => "tool-result"),
  } as never;
}

/** Streaming model that records the transcript each `.stream()` call receives. */
function makeRecordingStreamModel() {
  const received: BaseMessage[][] = [];
  let turn = 0;
  const model = {
    // Not used on the native streaming path but present for completeness.
    invoke: vi.fn(async () => new AIMessage("final")),
    stream: vi.fn((msgs: BaseMessage[]) => {
      received.push([...msgs]);
      const isFirst = turn === 0;
      turn++;
      return (async function* () {
        if (isFirst) {
          // Turn 1 — emit a tool call so the loop continues to a 2nd turn.
          const chunk = new AIMessage({ content: "" });
          (chunk as AIMessage & { tool_calls: unknown[] }).tool_calls = [
            { id: "call_0", name: "echo", args: {} },
          ];
          yield chunk;
        } else {
          // Turn 2 — final answer, no tool calls.
          yield new AIMessage("done");
        }
      })();
    }),
    bindTools: vi.fn().mockReturnThis(),
    model: "test-model",
  } as unknown as BaseChatModel;
  return { model, received };
}

/** Plugin that compresses once (turn 1) into a MARKER-carrying SystemMessage. */
function makeCompressingPlugin(): AgentLoopPlugin {
  let invocations = 0;
  return {
    onUsage: vi.fn(),
    trackPhase: vi.fn(),
    maybeCompress: vi.fn(async (messages: BaseMessage[]) => {
      invocations++;
      if (invocations === 1) {
        return {
          messages: [new SystemMessage("compacted")],
          summary: "compacted",
          compressed: true,
        };
      }
      return { messages, summary: null, compressed: false };
    }),
    shouldHalt: vi.fn(() => false),
    status: "ok",
    hooks: null,
    manager: null,
    reset: vi.fn(),
    cleanup: vi.fn(),
  } as unknown as AgentLoopPlugin;
}

async function drain(
  agent: DzupAgent,
  messages: BaseMessage[],
  options?: GenerateOptions
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const e of agent.stream(messages, options)) events.push(e);
  return events;
}

describe("native streaming — model-lifecycle hooks", () => {
  it("beforeModelCall marker (injected at compression) is visible to the next stream turn", async () => {
    const { model, received } = makeRecordingStreamModel();
    const hooks: AgentHooks = {
      beforeModelCall: async (messages: BaseMessage[]) => [
        ...messages,
        new SystemMessage(MARKER),
      ],
    };
    const agent = new DzupAgent({
      id: "stream-hooks",
      instructions: "x",
      model,
      tools: [mockTool("echo")],
      tokenLifecyclePlugin: makeCompressingPlugin(),
      hooks,
    });

    await drain(agent, [new HumanMessage("go")]);

    // The 2nd stream turn (post-compression) must see the hook marker.
    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(hasMarker(received[1]!)).toBe(true);
  });

  it("afterModelCall fires once per completed stream with the final message", async () => {
    const { model } = makeRecordingStreamModel();
    const afterModelCall = vi.fn(async () => {});
    const agent = new DzupAgent({
      id: "stream-after",
      instructions: "x",
      model,
      tools: [mockTool("echo")],
      tokenLifecyclePlugin: makeCompressingPlugin(),
      hooks: { afterModelCall },
    });

    await drain(agent, [new HumanMessage("go")]);
    // Two stream turns → afterModelCall twice, each with an assembled message.
    expect(afterModelCall).toHaveBeenCalledTimes(2);
    const [, response] = afterModelCall.mock.calls[0]!;
    expect(response).toBeInstanceOf(AIMessage);
  });

  it("onModelError fires when the stream throws on open", async () => {
    const model = {
      invoke: vi.fn(async () => new AIMessage("x")),
      stream: vi.fn(() => {
        throw new Error("stream open boom");
      }),
      bindTools: vi.fn().mockReturnThis(),
      model: "test-model",
    } as unknown as BaseChatModel;
    const onModelError = vi.fn(async () => {});
    const agent = new DzupAgent({
      id: "stream-error",
      instructions: "x",
      model,
      hooks: { onModelError },
    });

    await expect(drain(agent, [new HumanMessage("go")])).rejects.toThrow(
      "stream open boom"
    );
    expect(onModelError).toHaveBeenCalledTimes(1);
    expect((onModelError.mock.calls[0]![0] as Error).message).toContain(
      "stream open boom"
    );
  });
});
