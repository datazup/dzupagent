/**
 * Pre-construction helpers for {@link DzupAgent}.
 *
 * Three small utilities the agent constructor calls in order:
 *
 *   - {@link validateConfig} — RF-21 cheap config sanity check that
 *     fires before any heavy resource allocation.
 *   - {@link applyPluginRegistry} — fold `config.pluginRegistry`'s
 *     contributions into `hooks` / `middleware` before anything reads them.
 *   - {@link resolveRateLimiter} — instantiate a {@link TokenBucket}
 *     from either an existing instance or its config.
 *   - {@link resolveTokenizer} — pick a {@link Tokenizer} from the
 *     caller override, registry resolution, or heuristic fallback.
 *
 * Extracted from `dzip-agent.ts` (MC-004).
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { defaultTokenizerRegistry, TokenBucket, type ModelTier, type Tokenizer } from '@dzupagent/core/llm'
import type { PermissionTier } from '@dzupagent/core/tools'
import {
  filterToolsByTier,
  hasExplicitToolTier,
} from '../tools/tool-tier-registry.js'
import type { DzupAgentConfig } from './agent-types.js'
import { validateHardBudgetReservation } from './runtime-hard-budget.js'

/**
 * RF-21 — pre-construction validation of the {@link DzupAgentConfig}.
 *
 * Throws on invalid combinations *before* any heavy resources are
 * allocated, so callers see a clear failure mode instead of obscure
 * downstream errors. Currently checks:
 *
 *   - `config.id` must be a non-empty string (other modules key off it).
 *   - When `config.model` is a string, a `config.registry` is required
 *     (the same constraint enforced in `resolveModel`, hoisted earlier
 *     so it fires before tokenizer / event-bus wiring runs).
 *
 * Designed to be cheap and side-effect-free.
 */
export function validateConfig(config: DzupAgentConfig): void {
  if (typeof config.id !== 'string' || config.id.length === 0) {
    throw new Error('DzupAgent: config.id must be a non-empty string')
  }
  if (typeof config.model === 'string' && !config.registry) {
    throw new Error(
      `DzupAgent "${config.id}": model is a string ("${config.model}") but no registry was provided`,
    )
  }
  if (config.hardBudget) {
    validateHardBudgetReservation(config.hardBudget)
  }
}

/**
 * Fold `config.pluginRegistry`'s contributions into the config the agent will
 * actually run on.
 *
 * ## Why this exists
 *
 * `PluginRegistry.getHooks()` and `getMiddleware()` had NO production consumer.
 * A plugin could be registered, its `hooks` / `middleware` aggregated, and
 * nothing anywhere handed them to an agent — so a plugin's `onRunStart`,
 * `beforeModelCall` or `beforeAgent` was *declared but never dispatched*.
 * `PluginRegistry.toAgentHooks()` supplied the missing collapse from
 * `Partial<AgentHooks>[]` to the single `AgentHooks` object the config
 * declares, but only as an opt-in helper the caller had to remember to call.
 * This function is what makes registering a plugin actually change an agent's
 * behaviour, with no extra step at the call site.
 *
 * ## Precedence — plugins first, the config's own contributions LAST
 *
 * Hooks: `toAgentHooks(config.hooks)` composes
 * `[...registry.getHooks(), config.hooks]`, so contributors run in
 * registration order with the application's own hook last. That is not an
 * arbitrary pick — it is the ordering `composeAgentHooks` already documents
 * and enforces, and for the three MODIFIER hooks (`beforeToolCall`,
 * `afterToolCall`, `beforeModelCall`) the last contributor decides the value
 * that escapes. Running the app's hook last therefore means an ambient plugin
 * can never silently overrule the app author.
 *
 * Middleware: `[...registry.getMiddleware(), ...config.middleware]` — the same
 * shape, for the same reason. `AgentMiddlewareRuntime` iterates the array in
 * order for three of its four seams, all of them last-wins:
 * `runBeforeAgentHooks` shallow-merges each patch over the accumulated state,
 * `transformToolResult` threads each `wrapToolCall` over the previous result,
 * and `resolveTools` simply appends. Putting config middleware last gives the
 * app the final say in all three.
 *
 * ⚠️ The fourth seam INVERTS and is pinned by a test rather than assumed:
 * `invokeModel` uses `.find(m => typeof m.wrapModelCall === 'function')`, which
 * is FIRST-wins, so a plugin-supplied `wrapModelCall` pre-empts one supplied on
 * the config. That asymmetry is pre-existing behaviour of the middleware
 * runtime — reordering the merge to paper over it would break the other three
 * seams — so it is documented and locked, not silently inherited.
 *
 * ## Timing — construction, not per-run
 *
 * The merge runs ONCE. Plugins registered after `new DzupAgent(...)` are
 * invisible to that agent. Two pieces of evidence for construction-time over
 * per-run: `AgentMiddlewareRuntime` is itself built once in the constructor
 * (via `installEventBus`) and holds its `middleware` array for the agent's
 * lifetime, so a per-run middleware merge would have to rebuild it inside the
 * run coordinator; and `config.hooks` is read from `this.config` by ~8 distinct
 * modules on the generate, streaming, structured-output and compression paths,
 * so a per-run hook merge would need a second config object threaded through
 * every one of them. Normalising `this.config` once reaches all of them with no
 * further wiring.
 *
 * ## Bus ownership
 *
 * `toAgentHooks` reports a throwing hook as `hook:error` on the registry's own
 * bus by default. An agent may legitimately run on a DIFFERENT bus, and a hook
 * error raised inside that agent's run belongs on the bus that agent's
 * telemetry goes to — so `config.eventBus` is passed through and wins when
 * present. When the agent has no bus of its own, `toAgentHooks` falls back to
 * the registry's bus, so hook errors are never silently dropped. The registry
 * is never given a bus, never mutated, and stays shareable across agents.
 *
 * ## Idempotence
 *
 * `pluginRegistry` is STRIPPED from the returned config. `DzupAgent.agentConfig`
 * exposes this effective config for the documented
 * `new DzupAgent({ ...agent.agentConfig, tools: [...] })` derivation; leaving
 * the registry on it would compose every plugin hook a second time in the
 * derived agent, and a third time in one derived from that.
 *
 * With no registry the input object is returned BY IDENTITY — no clone, no
 * composition, no allocation. The overwhelmingly common no-plugin path is
 * therefore not merely equivalent to today's behaviour, it is the same object.
 */
export function applyPluginRegistry(config: DzupAgentConfig): DzupAgentConfig {
  const registry = config.pluginRegistry
  if (!registry) return config

  // Strip the registry: the result is the EFFECTIVE config and re-deriving an
  // agent from it must not compose the same plugin contributions twice.
  const { pluginRegistry: _consumed, ...rest } = config

  const effective: DzupAgentConfig = {
    ...rest,
    hooks: registry.toAgentHooks(
      config.hooks,
      // Agent bus wins; `toAgentHooks` falls back to the registry's own bus
      // when the agent has none, so `hook:error` is never dropped.
      config.eventBus ? { eventBus: config.eventBus } : {},
    ),
  }

  const middleware = [...registry.getMiddleware(), ...(config.middleware ?? [])]
  if (middleware.length > 0) effective.middleware = middleware

  return effective
}

export function resolveRateLimiter(
  config: DzupAgentConfig['rateLimiter'],
): TokenBucket | undefined {
  if (!config) return undefined
  if (config instanceof TokenBucket) return config
  return new TokenBucket(config)
}

/**
 * Resolve a {@link Tokenizer} for the agent (MC-08).
 *
 * Resolution order:
 * 1. Explicit `config.tokenizer` (caller-provided override)
 * 2. `defaultTokenizerRegistry.resolve(modelId)` keyed off the resolved model
 * 3. Heuristic fallback (built into the registry's `resolve()` contract)
 *
 * Never throws — the registry always returns at least a HeuristicTokenizer.
 */
export function resolveTokenizer(
  config: DzupAgentConfig,
  resolvedModel: BaseChatModel,
  resolvedTier: ModelTier | undefined,
): Tokenizer {
  if (config.tokenizer) return config.tokenizer
  // Prefer an explicit string model identifier; otherwise inspect the model
  // instance, then fall back to the resolved tier label so the registry can
  // still match generic patterns (e.g. /gpt-/, /claude/).
  const modelHint =
    typeof config.model === 'string'
      ? config.model
      : (resolvedModel as { model?: string; modelName?: string; _modelType?: () => string }).model
        ?? (resolvedModel as { modelName?: string }).modelName
        ?? resolvedTier
        ?? 'unknown'
  return defaultTokenizerRegistry.resolve(modelHint)
}

/**
 * Emit the one-shot `agent:tools-filtered` event capturing how many
 * resolved tools survived the permission-tier filter. Called once
 * from the {@link DzupAgent} constructor when an event bus is
 * configured.
 */
export function emitToolFilterAudit(params: {
  agentId: string
  config: DzupAgentConfig
  permissionTier: PermissionTier
  resolved: StructuredToolInterface[]
}): void {
  const { agentId, config, permissionTier, resolved } = params
  if (!config.eventBus) return
  const allowed = filterToolsByTier(
    resolved,
    permissionTier,
    config.unclassifiedToolPolicy,
  )
  const allowedSet = new Set<StructuredToolInterface>(allowed)
  const filtered = resolved
    .filter((tool) => !allowedSet.has(tool))
    .map((tool) => tool.name)
  config.eventBus.emit({
    type: 'agent:tools-filtered',
    agentId,
    effectiveTier: permissionTier,
    totalTools: resolved.length,
    allowedTools: allowed.length,
    filteredTools: filtered,
    unclassifiedTools: resolved
      .filter((tool) => !hasExplicitToolTier(tool))
      .map((tool) => tool.name),
  })
}
