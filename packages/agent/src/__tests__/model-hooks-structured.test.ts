/**
 * WS3 Task 3.2 — model-lifecycle hooks on the structured-generate native
 * call path (`withStructuredOutput().invoke`).
 *
 * Asserts:
 *  - `beforeModelCall` appends a marker visible in the messages the native
 *    structured model receives;
 *  - `afterModelCall` fires once on success;
 *  - `onModelError` fires when the native invocation throws.
 */
import { describe, it, expect, vi } from "vitest";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";
import type { AgentHooks } from "@dzupagent/core";
import type { DzupAgentConfig, GenerateResult } from "../agent/agent-types.js";
import {
  generateStructured,
  type StructuredGenerateContext,
} from "../agent/structured-generate.js";

const MARKER = "STRUCTURED_BEFORE_MODEL_CALL_MARKER";

const Schema = z.object({ name: z.string() });

function hasMarker(messages: BaseMessage[]): boolean {
  return messages.some(
    (m) => typeof m.content === "string" && m.content.includes(MARKER)
  );
}

/**
 * Build a model whose `withStructuredOutput(...).invoke(msgs)` records the
 * messages it received and returns `{ raw, parsed }`. When `fail` is set the
 * inner invoke throws to exercise the error seam.
 */
function makeNativeStructuredModel(opts: { fail?: boolean } = {}) {
  const received: BaseMessage[][] = [];
  const model = {
    model: "claude-3-5-sonnet",
    // capability probe: mark native structured output support
    withStructuredOutput: vi.fn(() => ({
      invoke: vi.fn(async (msgs: BaseMessage[]) => {
        received.push(msgs);
        if (opts.fail) throw new Error("native structured boom");
        return {
          raw: new AIMessage('{"name":"ok"}'),
          parsed: { name: "ok" },
        };
      }),
    })),
  } as unknown as BaseChatModel;
  return { model, received };
}

function makeCtx(
  model: BaseChatModel,
  hooks: AgentHooks | undefined,
  generateSpy?: StructuredGenerateContext["generate"]
): StructuredGenerateContext {
  const config = {
    id: "test-agent",
    instructions: "x",
    model: "claude-3-5-sonnet",
    ...(hooks ? { hooks } : {}),
  } as DzupAgentConfig;
  return {
    agentId: "test-agent",
    config,
    resolvedModel: model,
    prepareMessages: async (msgs: BaseMessage[]) => ({ messages: msgs }),
    generate:
      generateSpy ??
      (async () => {
        // fallback path (only hit if native fails) — return valid JSON
        return {
          content: '{"name":"ok"}',
          messages: [],
          usage: { totalInputTokens: 0, totalOutputTokens: 0, llmCalls: 1 },
          hitIterationLimit: false,
          stopReason: "complete",
          toolStats: [],
        } as GenerateResult;
      }),
    // Return undefined capabilities so the native path is attempted whenever
    // the model exposes `withStructuredOutput` (see
    // shouldAttemptNativeStructuredOutput).
    resolveStructuredOutputCapabilities: () => undefined,
  };
}

describe("structured-generate — model-lifecycle hooks", () => {
  it("beforeModelCall marker is visible to the native structured model", async () => {
    const { model, received } = makeNativeStructuredModel();
    const hooks: AgentHooks = {
      beforeModelCall: async (messages: BaseMessage[]) => [
        ...messages,
        new SystemMessage(MARKER),
      ],
    };
    await generateStructured(
      makeCtx(model, hooks),
      [new HumanMessage("hi")],
      Schema
    );

    expect(received).toHaveLength(1);
    expect(hasMarker(received[0]!)).toBe(true);
  });

  it("afterModelCall fires once on a successful native invocation", async () => {
    const { model } = makeNativeStructuredModel();
    const afterModelCall = vi.fn(async () => {});
    await generateStructured(
      makeCtx(model, { afterModelCall }),
      [new HumanMessage("hi")],
      Schema
    );
    expect(afterModelCall).toHaveBeenCalledTimes(1);
    // signature: (messages, response, modelId, ctx)
    const call = afterModelCall.mock.calls[0]!;
    expect(call[2]).toBe("claude-3-5-sonnet");
  });

  it("onModelError fires when the native invocation throws", async () => {
    const { model } = makeNativeStructuredModel({ fail: true });
    const onModelError = vi.fn(async () => {});
    // Native fails → falls back to text path (generate stub returns valid JSON).
    await generateStructured(
      makeCtx(model, { onModelError }),
      [new HumanMessage("hi")],
      Schema
    );
    expect(onModelError).toHaveBeenCalledTimes(1);
    const call = onModelError.mock.calls[0]!;
    expect((call[0] as Error).message).toContain("native structured boom");
    expect(call[1]).toBe("claude-3-5-sonnet");
  });
});
