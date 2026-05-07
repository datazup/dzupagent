/**
 * Pre-construction helpers for {@link DzupAgent}.
 *
 * Three small utilities the agent constructor calls in order:
 *
 *   - {@link validateConfig} — RF-21 cheap config sanity check that
 *     fires before any heavy resource allocation.
 *   - {@link resolveRateLimiter} — instantiate a {@link TokenBucket}
 *     from either an existing instance or its config.
 *   - {@link resolveTokenizer} — pick a {@link Tokenizer} from the
 *     caller override, registry resolution, or heuristic fallback.
 *
 * Extracted from `dzip-agent.ts` (MC-004).
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import {
  defaultTokenizerRegistry,
  TokenBucket,
  type ModelTier,
  type PermissionTier,
  type Tokenizer,
} from '@dzupagent/core'
import { filterToolsByTier } from '../tools/tool-tier-registry.js'
import type { DzupAgentConfig } from './agent-types.js'

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
  const allowed = filterToolsByTier(resolved, permissionTier)
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
  })
}
