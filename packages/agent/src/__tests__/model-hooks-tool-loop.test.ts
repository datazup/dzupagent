/**
 * WS3 Task 3.2 — model-lifecycle hooks on the generate tool-loop call path
 * (`run-engine-generate-tool-loop.ts`).
 *
 * `beforeModelCall` is wired at the compression re-injection seam: when the
 * token-lifecycle plugin rebuilds the transcript it runs BEFORE prompt-cache
 * injection, so the hook-injected marker is visible to the model on the next
 * turn. `afterModelCall` / `onModelError` fire at the model-invocation seam.
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
import type { AgentLoopPlugin } from "../token-lifecycle-wiring.js";

const MARKER = "TOOL_LOOP_BEFORE_MODEL_CALL_MARKER";

function hasMarker(messages: BaseMessage[]): boolean {
  return messages.some(
    (m) => typeof m.content === "string" && m.content.includes(MARKER)
  );
}

/** AIMessage carrying a single tool call. */
function aiWithToolCall(name: string): AIMessage {
  const msg = new AIMessage({ content: "" });
  (msg as AIMessage & { tool_calls: unknown[] }).tool_calls = [
    { id: "call_0", name, args: {} },
  ];
  return msg;
}

/** Mock tool returning a fixed string. */
function mockTool(name: string) {
  return {
    name,
    description: `Mock ${name}`,
    schema: { type: "object", properties: {} } as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => "tool-result"),
  } as never;
}

/**
 * Token-lifecycle plugin that compresses exactly once (on the first turn),
 * collapsing history to a single SystemMessage carrying the MARKER. Later
 * turns are no-ops.
 */
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

/** Invoke-only model that records each transcript it receives. */
function makeRecordingModel(responses: AIMessage[]) {
  const received: BaseMessage[][] = [];
  let idx = 0;
  const model = {
    invoke: vi.fn(async (msgs: BaseMessage[]) => {
      received.push(msgs);
      const r = responses[idx] ?? new AIMessage("final");
      idx++;
      return r;
    }),
    bindTools: vi.fn().mockReturnThis(),
    model: "test-model",
  } as unknown as BaseChatModel;
  return { model, received };
}

describe("generate tool-loop — model-lifecycle hooks", () => {
  it("beforeModelCall marker (injected at compression) is visible to the next model turn", async () => {
    const { model, received } = makeRecordingModel([
      aiWithToolCall("echo"), // turn 1 → triggers a tool call, then compression
      new AIMessage("final"), // turn 2 → after compression
    ]);
    const hooks: AgentHooks = {
      beforeModelCall: async (messages: BaseMessage[]) => [
        ...messages,
        new SystemMessage(MARKER),
      ],
    };
    const agent = new DzupAgent({
      id: "tool-loop-hooks",
      instructions: "x",
      model,
      tools: [mockTool("echo")],
      tokenLifecyclePlugin: makeCompressingPlugin(),
      hooks,
    });

    await agent.generate([new HumanMessage("go")]);

    // The second model turn (post-compression) must see the hook marker.
    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(hasMarker(received[1]!)).toBe(true);
    // The first turn (pre-compression) already ran beforeModelCall via
    // prepareRunState, so it too carries the marker.
    expect(hasMarker(received[0]!)).toBe(true);
  });

  it("afterModelCall fires per successful model turn", async () => {
    const { model } = makeRecordingModel([
      aiWithToolCall("echo"),
      new AIMessage("final"),
    ]);
    const afterModelCall = vi.fn(async () => {});
    const agent = new DzupAgent({
      id: "tool-loop-after",
      instructions: "x",
      model,
      tools: [mockTool("echo")],
      tokenLifecyclePlugin: makeCompressingPlugin(),
      hooks: { afterModelCall },
    });

    await agent.generate([new HumanMessage("go")]);
    // Two LLM turns → afterModelCall twice.
    expect(afterModelCall).toHaveBeenCalledTimes(2);
  });

  it("onModelError fires when a model turn throws", async () => {
    const model = {
      invoke: vi.fn(async () => {
        throw new Error("model turn boom");
      }),
      bindTools: vi.fn().mockReturnThis(),
      model: "test-model",
    } as unknown as BaseChatModel;
    const onModelError = vi.fn(async () => {});
    const agent = new DzupAgent({
      id: "tool-loop-error",
      instructions: "x",
      model,
      hooks: { onModelError },
    });

    await expect(agent.generate([new HumanMessage("go")])).rejects.toThrow(
      "model turn boom"
    );
    expect(onModelError).toHaveBeenCalledTimes(1);
    expect((onModelError.mock.calls[0]![0] as Error).message).toContain(
      "model turn boom"
    );
  });
});
