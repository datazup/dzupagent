/**
 * Model + provider selection helpers for {@link DzupAgent}.
 *
 * Wraps the registry / circuit-breaker contract in pure functions so
 * the agent class can stay a thin coordinator:
 *
 *   - {@link resolveModel} — single-call selection at construction
 *     time. Honours `getModelWithFallback` for tier inputs so open-circuit
 *     providers are skipped, and falls through to `getModelByName` for
 *     literal model identifiers. Always attaches structured-output
 *     capabilities so downstream callers see a consistent shape.
 *   - {@link getProviderAttempts} — tier-fallback candidate list for
 *     same-run failover. Returns `[]` when failover is disabled or the
 *     agent is not tier-resolved, matching the agent's prior contract.
 *   - {@link shouldRunFailover} — policy predicate consulted by the
 *     model-invocation coordinator. Filters tool-result-aware retries
 *     and delegates to `policy.shouldRetry` (or `isTransientError` when
 *     no override is supplied).
 *   - {@link bindTools} — capability-detected `bindTools` wrapper that
 *     no-ops on models without the method.
 *   - {@link hasToolResults} — single-pass predicate re-used by the
 *     failover gate.
 *
 * Extracted from `dzip-agent.ts` (MC-004).
 */
import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { attachStructuredOutputCapabilities, isTransientError, type ModelTier } from '@dzupagent/core/llm'
import type { DzupAgentConfig } from './agent-types.js'
import type { ProviderAttempt } from './provider-failover.js'

const MODEL_TIERS: Set<string> = new Set([
  'chat',
  'reasoning',
  'codegen',
  'embedding',
])

/**
 * Resolve the model for an agent. For tier-based lookups this uses
 * `registry.getModelWithFallback()` so providers with open circuits are
 * skipped; returns the chosen provider alongside the model so the
 * invocation path can feed success/failure signals back to the breaker.
 *
 * Returns `{ model, provider: undefined }` when an explicit model instance
 * or a model-by-name is used (no fallback chain applies).
 */
export function resolveModel(
  config: DzupAgentConfig,
): { model: BaseChatModel; provider: string | undefined; tier: ModelTier | undefined } {
  const attachCapabilities = (model: BaseChatModel): BaseChatModel =>
    attachStructuredOutputCapabilities(model, config.structuredOutputCapabilities)

  if (typeof config.model !== 'string') {
    return { model: attachCapabilities(config.model), provider: undefined, tier: undefined }
  }

  if (!config.registry) {
    throw new Error(
      `DzupAgent "${config.id}": model is a string ("${config.model}") but no registry was provided`,
    )
  }

  if (MODEL_TIERS.has(config.model)) {
    const { model, provider } = config.registry.getModelWithFallback(
      config.model as ModelTier,
    )
    return { model: attachCapabilities(model), provider, tier: config.model as ModelTier }
  }

  return {
    model: attachCapabilities(config.registry.getModelByName(config.model)),
    provider: undefined,
    tier: undefined,
  }
}

/**
 * Capability-detected `bindTools` wrapper. Returns the model unchanged
 * when there are no tools or the model does not implement `bindTools`.
 */
export function bindTools(
  model: BaseChatModel,
  tools: StructuredToolInterface[],
): BaseChatModel {
  if (tools.length === 0) return model

  if ('bindTools' in model && typeof model.bindTools === 'function') {
    return (model as BaseChatModel & {
      bindTools: (tools: StructuredToolInterface[]) => BaseChatModel
    }).bindTools(tools) as BaseChatModel
  }

  return model
}

export interface GetProviderAttemptsParams {
  config: DzupAgentConfig
  resolvedTier: ModelTier | undefined
  tools: StructuredToolInterface[]
}

/**
 * Tier-fallback candidate list for same-run failover. Returns `[]`
 * when failover is disabled or the agent is not tier-resolved.
 *
 * Each candidate is bound to the supplied tools eagerly so the failover
 * loop only needs to invoke the model.
 */
export function getProviderAttempts(
  params: GetProviderAttemptsParams,
): ProviderAttempt[] {
  const { config, resolvedTier, tools } = params
  if (
    !config.providerFailover?.enabled
    || !config.registry
    || !resolvedTier
  ) {
    return []
  }

  const maxAttempts = Math.max(1, config.providerFailover.maxAttempts ?? 2)
  return config.registry
    .getModelFallbackCandidates(resolvedTier)
    .slice(0, maxAttempts)
    .map((candidate): ProviderAttempt => ({
      provider: candidate.provider,
      modelName: candidate.modelName,
      model: bindTools(
        attachStructuredOutputCapabilities(
          candidate.model,
          config.structuredOutputCapabilities,
        ),
        tools,
      ),
    }))
}

export function hasToolResults(messages: BaseMessage[]): boolean {
  return messages.some((message) => message._getType() === 'tool')
}

/**
 * Policy predicate consulted by the model-invocation coordinator.
 *
 * Disabled outright when `providerFailover.enabled !== true`. When the
 * conversation already contains tool results, retries are blocked
 * unless the host opts in via `allowRetryAfterToolResults`. Otherwise,
 * delegates to `policy.shouldRetry` (or `isTransientError` when no
 * override is supplied).
 */
export function shouldRunFailover(
  config: DzupAgentConfig,
  error: Error,
  messages: BaseMessage[],
): boolean {
  const policy = config.providerFailover
  if (!policy?.enabled) return false
  if (hasToolResults(messages) && !policy.allowRetryAfterToolResults) {
    return false
  }
  return policy.shouldRetry?.(error) ?? isTransientError(error)
}
