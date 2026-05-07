/**
 * Model invocation coordinators for {@link DzupAgent}.
 *
 * Wraps `AgentMiddlewareRuntime.invokeModel` with the cross-cutting
 * concerns that every dispatch path needs:
 *
 *   - rate-limit gate ({@link awaitRateLimit})
 *   - circuit-breaker accounting (`registry.recordProviderSuccess` /
 *     `recordProviderFailure`)
 *   - distributed cost ledger ({@link recordDistributedCost})
 *   - optional same-run provider failover (`attemptWithFailover`)
 *
 * Two entry points:
 *
 *   - {@link invokeModelWithMiddleware} — picks the failover path when
 *     the agent has more than one tier candidate, otherwise dispatches
 *     directly with breaker accounting.
 *   - {@link transformToolResultWithMiddleware} — thin helper for the
 *     post-tool middleware hook; lifted alongside invocation so all
 *     middleware-wrapped surfaces live in one module.
 *
 * Extracted from `dzip-agent.ts` (MC-004). Re-exports `ProviderAttempt`
 * from `provider-failover.js` so callers have a single import site.
 */
import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ModelRegistry } from '@dzupagent/core'
import type { AgentMiddlewareRuntime } from './middleware-runtime.js'
import {
  attemptWithFailover,
  type ProviderAttempt,
} from './provider-failover.js'
import {
  awaitRateLimit,
  recordDistributedCost,
  type RateLimitCoordinatorDeps,
} from './rate-limit-coordinator.js'

export type { ProviderAttempt } from './provider-failover.js'

/**
 * Dependency bundle for {@link invokeModelWithMiddleware} and
 * {@link invokeModelWithProviderFailover}. Mirrors the agent-private
 * fields one-for-one so the call sites in `DzupAgent` can pass `this`
 * slices directly.
 */
export interface ModelInvocationDeps extends RateLimitCoordinatorDeps {
  middlewareRuntime: AgentMiddlewareRuntime
  registry: ModelRegistry | undefined
  resolvedProvider: string | undefined
  /**
   * Resolves the tier-fallback candidates for the *current* tool set.
   * Identical contract to the agent's private `getProviderAttempts`:
   * empty array means "no failover" (single-provider path).
   */
  getProviderAttempts: () => ProviderAttempt[]
  /**
   * Same-run failover policy. Receives the original (non-bound) tool-message
   * list so the caller can implement tool-result-aware retry rules.
   */
  shouldRunFailover: (err: Error, messages: BaseMessage[]) => boolean
}

/**
 * Dispatch through the middleware runtime, applying the rate-limit
 * gate, breaker accounting, and distributed cost accounting.
 *
 * Picks the failover path when {@link ModelInvocationDeps.getProviderAttempts}
 * yields more than one candidate.
 */
export async function invokeModelWithMiddleware(
  deps: ModelInvocationDeps,
  model: BaseChatModel,
  messages: BaseMessage[],
): Promise<BaseMessage> {
  const attempts = deps.getProviderAttempts()
  if (attempts.length > 1) {
    return invokeModelWithProviderFailover(deps, attempts, messages)
  }

  await awaitRateLimit(deps)
  try {
    const result = await deps.middlewareRuntime.invokeModel(model, messages)
    // Feed the provider's circuit breaker a success signal. No-op when
    // the agent was constructed with an explicit model (no fallback
    // chain in play).
    if (deps.resolvedProvider && deps.registry) {
      deps.registry.recordProviderSuccess(deps.resolvedProvider)
    }
    await recordDistributedCost(deps, result)
    return result
  } catch (err) {
    if (deps.resolvedProvider && deps.registry) {
      const asError = err instanceof Error ? err : new Error(String(err))
      // Registry filters to transient errors internally, so unconditional
      // is safe.
      deps.registry.recordProviderFailure(deps.resolvedProvider, asError)
    }
    throw err
  }
}

/**
 * Multi-attempt variant: walks the tier-fallback chain via
 * {@link attemptWithFailover}, emitting `provider:*` lifecycle events
 * and recording success/failure on the same circuit breaker.
 */
export async function invokeModelWithProviderFailover(
  deps: ModelInvocationDeps,
  attempts: ProviderAttempt[],
  messages: BaseMessage[],
): Promise<BaseMessage> {
  return attemptWithFailover<BaseMessage>({
    attempts,
    phase: 'invoke',
    agentId: deps.agentId,
    eventBus: deps.eventBus,
    registry: deps.registry,
    shouldRetry: (err) => deps.shouldRunFailover(err, messages),
    execute: async (attempt) => {
      await awaitRateLimit(deps)
      const result = await deps.middlewareRuntime.invokeModel(
        attempt.model,
        messages,
      )
      await recordDistributedCost(deps, result)
      return result
    },
  })
}

/**
 * Thin wrapper over `AgentMiddlewareRuntime.transformToolResult` —
 * kept here so every middleware-wrapped surface lives in one module.
 */
export async function transformToolResultWithMiddleware(
  middlewareRuntime: AgentMiddlewareRuntime,
  toolName: string,
  input: Record<string, unknown>,
  result: string,
): Promise<string> {
  return middlewareRuntime.transformToolResult(toolName, input, result)
}
