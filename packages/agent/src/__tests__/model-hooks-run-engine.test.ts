/**
 * WS3 Task 3.2 — model-lifecycle hooks on the run-engine `prepareRunState`
 * call path (the initial-transcript LLM entry point shared by generate() and
 * stream()).
 *
 * Asserts:
 *  - a registered `beforeModelCall` that appends a marker message is visible
 *    in the messages the model will receive (`runState.preparedMessages`);
 *  - ORDERING (load-bearing): a `beforeModelCall` that returns messages long
 *    enough to cross the ~1024-token prompt-cache threshold yields cache
 *    markers computed on the HOOK-MODIFIED array — proving hooks run before
 *    prompt-cache injection.
 */
import { describe, it, expect, vi } from "vitest";
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentHooks } from "@dzupagent/core";
import type { DzupAgentConfig, GenerateOptions } from "../agent/agent-types.js";
import { prepareRunState } from "../agent/run-engine.js";
import { makeMockModel, makeMockTool } from "./test-utils.js";

function baseParams(
  configOverrides: Partial<DzupAgentConfig> = {},
  overrides: Partial<Parameters<typeof prepareRunState>[0]> = {}
) {
  const tools: StructuredToolInterface[] = [makeMockTool("read_file")];
  const model = makeMockModel("done");
  return {
    config: {
      id: "test-agent",
      instructions: "You are a test agent.",
      model: "gpt-4" as const,
      ...configOverrides,
    } as DzupAgentConfig,
    resolvedModel: model,
    messages: [new HumanMessage("hello")] as BaseMessage[],
    options: undefined as GenerateOptions | undefined,
    prepareMessages: vi.fn(async (msgs: BaseMessage[]) => ({ messages: msgs })),
    getTools: vi.fn(() => tools),
    bindTools: vi.fn(
      (_m: BaseChatModel, _t: StructuredToolInterface[]) => model
    ),
    runBeforeAgentHooks: vi.fn(async () => {}),
    ...overrides,
  };
}

const MARKER = "BEFORE_MODEL_CALL_MARKER";

function hasMarker(messages: BaseMessage[]): boolean {
  return messages.some(
    (m) => typeof m.content === "string" && m.content.includes(MARKER)
  );
}

function hasCacheControl(messages: BaseMessage[]): boolean {
  return messages.some(
    (m) =>
      (m.additional_kwargs as { cache_control?: unknown } | undefined)
        ?.cache_control !== undefined
  );
}

describe("run-engine prepareRunState — beforeModelCall", () => {
  it("appends a hook-injected marker into the transcript the model receives", async () => {
    const hooks: AgentHooks = {
      beforeModelCall: vi.fn(async (messages: BaseMessage[]) => [
        ...messages,
        new SystemMessage(MARKER),
      ]),
    };
    const runState = await prepareRunState(baseParams({ hooks }));

    expect(hasMarker(runState.preparedMessages)).toBe(true);
    expect(hooks.beforeModelCall).toHaveBeenCalledTimes(1);
  });

  it("passes model id + hook context to beforeModelCall", async () => {
    const beforeModelCall = vi.fn(async () => undefined);
    await prepareRunState(
      baseParams({ hooks: { beforeModelCall }, id: "agent-x" })
    );

    const call = beforeModelCall.mock.calls[0]!;
    expect(call[1]).toBe("gpt-4"); // resolved model id (string config.model)
    expect((call[2] as { agentId: string }).agentId).toBe("agent-x");
  });

  it("ORDERING: cache markers are computed on the hook-modified array", async () => {
    // Base transcript is tiny (well under the 1024-token cache threshold), so
    // without the hook no cache markers would be injected. The hook appends a
    // large system message pushing the total over the threshold — cache
    // markers must appear, which is only possible if injection ran AFTER the
    // hook rewrote the array.
    const bigText = "x ".repeat(3000); // ~1500+ estimated tokens
    const hooks: AgentHooks = {
      beforeModelCall: async (messages: BaseMessage[]) => [
        new SystemMessage(bigText),
        ...messages,
      ],
    };
    // Claude model id so prompt-cache injection is active.
    const runState = await prepareRunState(
      baseParams({
        hooks,
        model: "claude-3-5-sonnet" as unknown as DzupAgentConfig["model"],
      })
    );

    expect(hasCacheControl(runState.preparedMessages)).toBe(true);
  });

  it("a hook returning void passes the transcript through unchanged", async () => {
    const runState = await prepareRunState(
      baseParams({ hooks: { beforeModelCall: async () => undefined } })
    );
    // Only the original human message survives (plus no marker).
    expect(hasMarker(runState.preparedMessages)).toBe(false);
    expect(runState.preparedMessages).toHaveLength(1);
  });

  it("a throwing hook is swallowed; the transcript passes through", async () => {
    const runState = await prepareRunState(
      baseParams({
        hooks: {
          beforeModelCall: async () => {
            throw new Error("hook boom");
          },
        },
      })
    );
    expect(runState.preparedMessages).toHaveLength(1);
  });
});
