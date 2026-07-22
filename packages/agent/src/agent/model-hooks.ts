/**
 * Model-lifecycle hook plumbing for the four LLM call paths (WS3 Task 3.2).
 *
 * The core dispatchers (`runBeforeModelCall` / `runAfterModelCall` /
 * `runOnModelError`) sequence a config's `AgentHooks` with error isolation.
 * These helpers adapt a {@link DzupAgentConfig} into the exact argument shape
 * those dispatchers expect at each call site:
 *
 *   - {@link buildModelHookContext} — assembles the {@link HookContext} from
 *     the agent id, resolved run id, and event bus.
 *   - {@link resolveModelIdForHooks} — resolves the model identifier the same
 *     way each site already derives it for Anthropic prompt-cache injection
 *     (string `config.model` verbatim, otherwise the resolved model's own
 *     `model` / `modelName` / `name` field). Reusing that exact resolution
 *     keeps hook `modelId` and cache-breakpoint decisions in lockstep.
 *
 * `config.hooks` may register `beforeModelCall` (which the sites run BEFORE
 * prompt-cache injection so cache breakpoints are computed on the final,
 * hook-rewritten array — ordering is load-bearing).
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AgentHooks, HookContext } from "@dzupagent/core/orchestration";
import type { DzupEventBus } from "@dzupagent/core/events";

/**
 * Minimal `DzupAgentConfig` shape needed to build hook plumbing. Declared
 * structurally (rather than importing the full config type) so this module
 * stays free of a cyclic import with `agent-types-config.ts`.
 */
export interface ModelHooksConfig {
  hooks?: AgentHooks;
  eventBus?: DzupEventBus;
}

/** Return the registered model-lifecycle hooks (or undefined) on a config. */
export function modelHooksOf(config: ModelHooksConfig): AgentHooks | undefined {
  return config.hooks;
}

/**
 * Build the {@link HookContext} passed to every model-lifecycle hook.
 *
 * `metadata` is always a fresh object so a hook mutating it cannot leak state
 * across calls. `eventBus` is included only when the config carries one.
 */
export function buildModelHookContext(
  config: ModelHooksConfig,
  agentId: string,
  runId: string | undefined
): HookContext {
  const ctx: HookContext = {
    agentId,
    runId: runId ?? "",
    metadata: {},
  };
  if (config.eventBus !== undefined) ctx.eventBus = config.eventBus;
  return ctx;
}

/**
 * Resolve the model id for hooks exactly as each call site derives it for
 * prompt-cache injection: a string `config.model` is used verbatim, otherwise
 * the resolved model's own `model` / `modelName` / `name` field is read
 * (falling back to `'unknown'`).
 */
export function resolveModelIdForHooks(
  configModel: unknown,
  resolvedModel: BaseChatModel
): string {
  if (typeof configModel === "string") return configModel;
  const m = resolvedModel as BaseChatModel & {
    model?: string;
    modelName?: string;
    name?: string;
  };
  return m.model ?? m.modelName ?? m.name ?? "unknown";
}
