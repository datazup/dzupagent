import type { BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentMiddleware } from "@dzupagent/core/llm";

export interface AgentMiddlewareRuntimeConfig {
  agentId: string;
  middleware?: AgentMiddleware[];
}

export class AgentMiddlewareRuntime {
  constructor(private readonly config: AgentMiddlewareRuntimeConfig) {}

  resolveTools(
    tools: StructuredToolInterface[] = []
  ): StructuredToolInterface[] {
    const resolvedTools = [...tools];

    for (const middleware of this.config.middleware ?? []) {
      if (middleware.tools) {
        resolvedTools.push(...middleware.tools);
      }
    }

    return resolvedTools;
  }

  /**
   * Run every middleware's `beforeAgent` hook, threading run state through the
   * chain.
   *
   * `AgentMiddleware.beforeAgent` is documented as "run before agent starts —
   * can modify initial state", and is typed
   * `(state) => Promise<Partial<Record<string, unknown>>>`. Both halves of that
   * contract used to be unreachable: this method passed a literal `{}` (no
   * state in) and discarded the returned partial (no state out).
   *
   * Now:
   *  - each hook receives the ACCUMULATED state — the caller's `initialState`
   *    plus every patch merged so far, so a later middleware observes what an
   *    earlier one contributed;
   *  - a returned object is shallow-merged over the accumulated state (later
   *    keys win) and the final state is returned to the caller;
   *  - a hook returning a non-object (or nothing) is a documented no-op patch;
   *  - a THROWING hook stays non-fatal and contributes no patch — the state
   *    accumulated so far is preserved and the chain continues.
   *
   * The state object is passed by reference, so in-place mutation works too;
   * the spread merge picks it up either way.
   */
  async runBeforeAgentHooks(
    initialState: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    let state: Record<string, unknown> = { ...initialState };

    for (const middleware of this.config.middleware ?? []) {
      if (!middleware.beforeAgent) {
        continue;
      }

      try {
        const patch = await middleware.beforeAgent(state);
        if (patch !== null && typeof patch === "object") {
          state = { ...state, ...patch };
        }
      } catch {
        // Middleware failures are non-fatal; the accumulated state survives.
      }
    }

    return state;
  }

  /**
   * @param options.signal Run/deadline cancellation (ORCH-DSL-L1-C-01). Passed
   *   through to `model.invoke` so providers that honour it stop work at the
   *   source. Optional so existing callers are unaffected.
   */
  async invokeModel(
    model: BaseChatModel,
    messages: BaseMessage[],
    options: { signal?: AbortSignal } = {}
  ): Promise<BaseMessage> {
    const wrapper = (this.config.middleware ?? []).find(
      (middleware) => typeof middleware.wrapModelCall === "function"
    );

    if (wrapper?.wrapModelCall) {
      return wrapper.wrapModelCall(model, messages, {
        agentId: this.config.agentId,
      });
    }

    return options.signal
      ? model.invoke(messages, { signal: options.signal })
      : model.invoke(messages);
  }

  async transformToolResult(
    toolName: string,
    input: Record<string, unknown>,
    result: string
  ): Promise<string> {
    let current = result;

    for (const middleware of this.config.middleware ?? []) {
      if (!middleware.wrapToolCall) {
        continue;
      }

      try {
        current = await middleware.wrapToolCall(toolName, input, current);
      } catch {
        // Middleware failures are non-fatal.
      }
    }

    return current;
  }
}
