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
import {
  attachStructuredOutputCapabilities,
  isTransientError,
  type FallbackRequirements,
  type ModelTier,
} from '@dzupagent/core/llm'
import { typedEmit } from '@dzupagent/core/events'
import type { ModelCapability } from '@dzupagent/core/llm'
import type { DzupAgentConfig } from './agent-types.js'
import type { ModelFallbackCandidate } from '@dzupagent/core/llm'
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
  /**
   * The provider the run is currently pinned to (from `resolveModel`). Used as
   * the "home vendor" for the cross-vendor allowlist gate: a hop to any other
   * vendor must be explicitly approved. Falls back to the first candidate in
   * the chain when not supplied.
   */
  resolvedProvider?: string | undefined
  /** Optional correlation ids forwarded on `provider:fallback_blocked`. */
  runId?: string | undefined
  tenantId?: string | undefined
}

/**
 * Derive the capability / context-window requirements a failover candidate
 * must satisfy for THIS run (`DZUPAGENT-AGENT-C-06`).
 *
 * Derived automatically:
 *  - `tool_use` whenever the run has bound tools, or when the configured
 *    structured-output strategy is tool-based (`anthropic-tool-use`). A model
 *    that cannot call tools would silently answer in prose instead.
 *  - `minContextWindow` from `messageConfig.maxMessageTokens`, which is the
 *    budget the agent will actually fill.
 *
 * Merged on top of the host's explicit `capabilityRequirements` (which is the
 * only way to express `vision`, since the chain is built before the run's
 * messages are known — see the deferred note in TASK.md).
 *
 * Returns `undefined` when the guard is disabled or nothing is required, in
 * which case the registry keeps its pre-C-06 unfiltered behaviour.
 */
export function deriveFallbackRequirements(
  config: DzupAgentConfig,
  tools: StructuredToolInterface[],
): FallbackRequirements | undefined {
  const policy = config.providerFailover
  const guard = policy?.capabilityGuard ?? 'declared'
  if (guard === 'off') return undefined

  const explicit = policy?.capabilityRequirements
  const required = new Set<ModelCapability>(explicit?.requiredCapabilities ?? [])

  if (tools.length > 0) required.add('tool_use')
  if (config.structuredOutputCapabilities?.preferredStrategy === 'anthropic-tool-use') {
    required.add('tool_use')
  }

  const minContextWindow =
    explicit?.minContextWindow ?? config.messageConfig?.maxMessageTokens

  if (required.size === 0 && minContextWindow === undefined) return undefined

  return {
    ...(required.size > 0 ? { requiredCapabilities: [...required] } : {}),
    ...(minContextWindow !== undefined ? { minContextWindow } : {}),
    undeclaredCapabilityPolicy: guard === 'strict' ? 'skip' : 'allow',
  }
}

/**
 * Apply the cross-vendor allowlist to an already capability-filtered chain.
 *
 * Deny-by-default *within* `'allowlist'` mode, mirroring the adapter layer's
 * `approvedFallbackProviders` contract: the home provider is always kept, and
 * every other vendor must be named explicitly. Each drop emits a
 * `provider:fallback_blocked` event so the decision is auditable.
 *
 * In the default `'allow-all'` mode the chain is returned untouched.
 */
function applyVendorAllowlist(
  params: GetProviderAttemptsParams,
  candidates: ModelFallbackCandidate[],
): ModelFallbackCandidate[] {
  const { config, resolvedProvider, runId, tenantId } = params
  const policy = config.providerFailover
  const mode =
    policy?.crossVendorFallback
    ?? (policy?.approvedFallbackProviders !== undefined ? 'allowlist' : 'allow-all')
  if (mode !== 'allowlist') return candidates

  const home = resolvedProvider ?? candidates[0]?.provider
  const approved = new Set(policy?.approvedFallbackProviders ?? [])
  const kept: ModelFallbackCandidate[] = []

  for (const candidate of candidates) {
    if (candidate.provider === home || approved.has(candidate.provider)) {
      kept.push(candidate)
      continue
    }
    if (config.eventBus) {
      typedEmit(config.eventBus, {
        type: 'provider:fallback_blocked',
        agentId: config.id,
        provider: candidate.provider,
        model: candidate.modelName,
        reason: 'vendor-not-approved',
        detail: `provider "${candidate.provider}" is not in approvedFallbackProviders`,
        ...(runId !== undefined && { runId }),
        ...(tenantId !== undefined && { tenantId }),
      })
    }
  }

  return kept
}

/**
 * Tier-fallback candidate list for same-run failover. Returns `[]`
 * when failover is disabled or the agent is not tier-resolved.
 *
 * Each candidate is bound to the supplied tools eagerly so the failover
 * loop only needs to invoke the model.
 *
 * Two gates run before the chain is returned (`DZUPAGENT-AGENT-C-06`):
 *  1. the registry's capability / context-window guard, driven by
 *     {@link deriveFallbackRequirements}. When no candidate can satisfy the
 *     run's needs the registry throws `NO_CAPABLE_FALLBACK` and it propagates
 *     — a loud failure is the point; silently degrading was the defect.
 *  2. the cross-vendor allowlist, which drops unapproved vendors and emits
 *     `provider:fallback_blocked` for each.
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
  const requirements = deriveFallbackRequirements(config, tools)
  const candidates = config.registry.getModelFallbackCandidates(
    resolvedTier,
    undefined,
    requirements,
  )

  return applyVendorAllowlist(params, candidates)
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
