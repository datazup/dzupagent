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
   * Run the model call through every `wrapModelCall` middleware, composed as
   * an onion in configured order: the first wrapper is outermost, and each
   * wrapper's `model.invoke(...)` enters the next wrapper, with the innermost
   * reaching the real model. A wrapper that returns without calling
   * `model.invoke` short-circuits the wrappers inside it (DZUPAGENT-AGENT-H-50:
   * previously only the first wrapper ran at all).
   *
   * @param options.signal Run/deadline cancellation (ORCH-DSL-L1-C-01). Passed
   *   through to `model.invoke` so providers that honour it stop work at the
   *   source. It is also exposed on each wrapper's context as `signal`, and is
   *   injected into the real `model.invoke` call even when a wrapper invokes
   *   the model without forwarding options. Optional so existing callers are
   *   unaffected.
   */
  async invokeModel(
    model: BaseChatModel,
    messages: BaseMessage[],
    options: { signal?: AbortSignal } = {}
  ): Promise<BaseMessage> {
    const { signal } = options;
    const wrappers: WrapModelCall[] = [];
    for (const middleware of this.config.middleware ?? []) {
      const wrap = middleware.wrapModelCall;
      if (typeof wrap === "function") {
        // Keep the middleware as `this`, as the former method call did.
        wrappers.push((m, msgs, config) => wrap.call(middleware, m, msgs, config));
      }
    }

    const [outermost, ...innerWrappers] = wrappers;
    if (outermost === undefined) {
      return signal
        ? model.invoke(messages, { signal })
        : model.invoke(messages);
    }

    const context: Record<string, unknown> = {
      agentId: this.config.agentId,
      ...(signal ? { signal } : {}),
    };

    // Innermost model: the real model, or (with a signal) a view of it whose
    // `invoke` always carries the run signal.
    let next: BaseChatModel = signal
      ? withInvoke(model, (msgs, callOptions) =>
          model.invoke(msgs, { ...(callOptions ?? {}), signal })
        )
      : model;

    for (const wrapper of innerWrappers.reverse()) {
      const inner = next;
      next = withInvoke(model, (msgs) => wrapper(inner, msgs, context));
    }

    return outermost(next, messages, context);
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

type WrapModelCall = NonNullable<AgentMiddleware["wrapModelCall"]>;
type InvokeOptions = Parameters<BaseChatModel["invoke"]>[1];

/**
 * A view of `model` whose `invoke` is replaced; every other member resolves on
 * the real model (methods bound to it).
 */
function withInvoke(
  model: BaseChatModel,
  invoke: (
    messages: BaseMessage[],
    options?: InvokeOptions
  ) => Promise<BaseMessage>
): BaseChatModel {
  return new Proxy(model, {
    get(target, prop) {
      if (prop === "invoke") return invoke;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
