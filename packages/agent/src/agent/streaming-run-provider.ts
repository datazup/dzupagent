/**
 * Provider failover utilities for the streaming run loop.
 *
 * Extracted from `streaming-run.ts` (MC-026b-1) so the multi-provider
 * stream-open path, transient-error policy, and event emissions live in
 * their own module. Behaviour is unchanged: this module owns the same
 * observable event ordering as the pre-MC-026b-1 implementation.
 */

import type { AIMessage, BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { isTransientError } from '@dzupagent/core/llm'
import type { DzupAgentConfig } from './agent-types.js'
import { attemptWithFailover } from './provider-failover.js'
import type { ModelRegistry } from '@dzupagent/core/llm'

/**
 * A {@link BaseChatModel} known to expose a native `stream()` method. Used
 * to narrow the resolved run-state model before the streaming fast path.
 */
export type StreamableModel = BaseChatModel & {
  stream: (msgs: BaseMessage[]) => Promise<AsyncIterable<AIMessage>>
}

/**
 * A single provider candidate considered by the multi-provider streaming
 * fast path. Mirrors the shape produced by the agent's
 * `getProviderAttempts` callback.
 */
export interface ProviderAttempt {
  provider: string
  modelName: string
  model: BaseChatModel
}

/**
 * Subset of {@link import('./streaming-run.js').StreamRunContext} needed
 * by the failover utilities. Keeping this surface narrow lets the
 * coordinator pass a small slice without leaking unrelated state into
 * this module.
 */
export interface StreamProviderContext {
  agentId: string
  config: DzupAgentConfig
  registry?: ModelRegistry | undefined
}

export function hasToolResults(messages: BaseMessage[]): boolean {
  return messages.some(message => message._getType() === 'tool')
}

/**
 * Decide whether a stream-open failure is eligible for provider failover.
 * Honours the agent's `providerFailover` policy and falls back to the
 * shared transient-error heuristic when no custom predicate is supplied.
 */
export function shouldRunStreamFailover(
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

/**
 * Emit a provider:* lifecycle event on the agent's event bus. Mirrors
 * the helper previously inlined in `streaming-run.ts`. Safe to call when
 * no event bus is configured: emits nothing in that case.
 */
export function emitProviderRunEvent(
  ctx: StreamProviderContext,
  event: {
    type: 'provider:run_attempt' | 'provider:run_failure' | 'provider:run_selected'
    attempt: number
    maxAttempts?: number
    provider: string
    model: string
    phase: 'stream'
    reason?: string
    retrying?: boolean
  },
): void {
  const bus = ctx.config.eventBus
  if (!bus) return
  const base = {
    agentId: ctx.agentId,
    attempt: event.attempt,
    provider: event.provider,
    model: event.model,
    phase: event.phase,
  } as const
  if (event.type === 'provider:run_failure') {
    bus.emit({
      type: 'provider:run_failure',
      ...base,
      reason: event.reason ?? '',
      retrying: event.retrying ?? false,
    })
  } else if (event.type === 'provider:run_attempt') {
    bus.emit({
      type: 'provider:run_attempt',
      ...base,
      maxAttempts: event.maxAttempts ?? 1,
    })
  } else {
    bus.emit({ type: 'provider:run_selected', ...base })
  }
}

/**
 * Open a stream against the first viable provider in the supplied
 * `attempts` list. Routes through {@link attemptWithFailover} so the
 * lifecycle events and circuit-breaker recording match the non-streaming
 * path exactly.
 */
export async function openStreamWithProviderFailover(
  ctx: StreamProviderContext,
  attempts: ProviderAttempt[],
  messages: BaseMessage[],
): Promise<{
  stream: AsyncIterable<AIMessage>
  provider: string
  modelName: string
  attempt: number
}> {
  return attemptWithFailover<{
    stream: AsyncIterable<AIMessage>
    provider: string
    modelName: string
    attempt: number
  }>({
    attempts,
    phase: 'stream',
    agentId: ctx.agentId,
    eventBus: ctx.config.eventBus,
    registry: ctx.registry,
    shouldRetry: (err) => shouldRunStreamFailover(ctx.config, err, messages),
    execute: async (candidate, attemptNumber) => {
      const streamable = candidate.model as StreamableModel
      const stream = await streamable.stream(messages)
      return {
        stream,
        provider: candidate.provider,
        modelName: candidate.modelName,
        attempt: attemptNumber,
      }
    },
  })
}
