import type { BaseMessage } from "@langchain/core/messages";
import type { DzupEventBus } from "../events/event-bus.js";
import type { AgentHooks, HookContext } from "./hook-types.js";

/**
 * Run a list of hook functions sequentially with error isolation.
 *
 * Each hook is called in order. If a hook throws, the error is caught
 * and emitted via the event bus (if provided). Subsequent hooks still run.
 *
 * For hooks that can modify values (beforeToolCall, afterToolCall),
 * use `runModifierHook()` instead.
 */
export async function runHooks(
  hooks: Array<((...args: never[]) => Promise<void>) | undefined> | undefined,
  eventBus: DzupEventBus | undefined,
  hookName: string,
  ...args: unknown[]
): Promise<void> {
  if (!hooks) return;
  for (const hook of hooks) {
    if (!hook) continue;
    try {
      await (hook as (...a: unknown[]) => Promise<void>)(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      eventBus?.emit({ type: "hook:error", hookName, message });
    }
  }
}

/**
 * Run a single modifier hook that can transform a value.
 *
 * If the hook returns a non-undefined value, it replaces the input.
 * If the hook returns undefined/void, the original value passes through.
 * If the hook throws, the original value passes through and the error is logged.
 */
export async function runModifierHook<T>(
  hook: ((...args: never[]) => Promise<T | void>) | undefined,
  eventBus: DzupEventBus | undefined,
  hookName: string,
  currentValue: T,
  ...args: unknown[]
): Promise<T> {
  if (!hook) return currentValue;
  try {
    const result = await (hook as (...a: unknown[]) => Promise<T | void>)(
      ...args
    );
    return result !== undefined ? result : currentValue;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    eventBus?.emit({ type: "hook:error", hookName, message });
    return currentValue;
  }
}

/**
 * Merge multiple AgentHooks objects into one.
 * Each hook key becomes an array; `runHooks` iterates them all.
 */
export function mergeHooks<
  T extends Record<string, ((...args: never[]) => Promise<unknown>) | undefined>
>(
  ...hookSets: (Partial<T> | undefined)[]
): Partial<Record<keyof T, Array<(...args: never[]) => Promise<unknown>>>> {
  const merged: Record<
    string,
    Array<(...args: never[]) => Promise<unknown>>
  > = {};

  for (const hooks of hookSets) {
    if (!hooks) continue;
    for (const [key, fn] of Object.entries(hooks)) {
      if (typeof fn !== "function") continue;
      if (!merged[key]) merged[key] = [];
      merged[key].push(fn as (...args: never[]) => Promise<unknown>);
    }
  }

  return merged as Partial<
    Record<keyof T, Array<(...args: never[]) => Promise<unknown>>>
  >;
}

/**
 * Dispatch `beforeModelCall` hooks sequentially with error isolation.
 *
 * Mirrors the `beforeToolCall` return-replacement contract: each hook receives
 * the running message array; a non-void return replaces it for the next hook
 * (and the final result). A hook that returns void, or throws, passes the
 * current array through unchanged (errors are emitted via the event bus).
 * Returns the last non-void result, or the original `messages` if every hook
 * returned void/threw.
 */
export async function runBeforeModelCall(
  hooks: AgentHooks["beforeModelCall"][] | undefined,
  eventBus: DzupEventBus | undefined,
  messages: BaseMessage[],
  modelId: string,
  ctx: HookContext
): Promise<BaseMessage[]> {
  if (!hooks) return messages;
  let current = messages;
  for (const hook of hooks) {
    if (!hook) continue;
    try {
      const result = await hook(current, modelId, ctx);
      if (result !== undefined) current = result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      eventBus?.emit({
        type: "hook:error",
        hookName: "beforeModelCall",
        message,
      });
    }
  }
  return current;
}

/**
 * Dispatch `afterModelCall` hooks sequentially with error isolation.
 *
 * Runs only for successful LLM invocations. Errors are swallowed and emitted
 * via the event bus; subsequent hooks still run. Return values are ignored.
 */
export async function runAfterModelCall(
  hooks: AgentHooks["afterModelCall"][] | undefined,
  eventBus: DzupEventBus | undefined,
  messages: BaseMessage[],
  response: BaseMessage,
  modelId: string,
  ctx: HookContext
): Promise<void> {
  if (!hooks) return;
  for (const hook of hooks) {
    if (!hook) continue;
    try {
      await hook(messages, response, modelId, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      eventBus?.emit({
        type: "hook:error",
        hookName: "afterModelCall",
        message,
      });
    }
  }
}

/**
 * Dispatch `onModelError` hooks sequentially with error isolation.
 *
 * Runs when an LLM invocation fails. Errors thrown by the hooks themselves are
 * swallowed and emitted via the event bus; subsequent hooks still run.
 */
export async function runOnModelError(
  hooks: AgentHooks["onModelError"][] | undefined,
  eventBus: DzupEventBus | undefined,
  error: Error,
  modelId: string,
  ctx: HookContext
): Promise<void> {
  if (!hooks) return;
  for (const hook of hooks) {
    if (!hook) continue;
    try {
      await hook(error, modelId, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      eventBus?.emit({ type: "hook:error", hookName: "onModelError", message });
    }
  }
}
