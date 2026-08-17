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
import {
  ModelCancellationError,
  ModelTimeoutError,
  isModelCancellationError,
} from './model-timeout-error.js'
import {
  awaitRateLimit,
  CostCeilingExceededError,
  type RateLimitCoordinatorDeps,
} from './rate-limit-coordinator.js'

/**
 * A {@link BaseChatModel} known to expose a native `stream()` method. Used
 * to narrow the resolved run-state model before the streaming fast path.
 */
export type StreamableModel = BaseChatModel & {
  stream: (
    msgs: BaseMessage[],
    options?: { signal?: AbortSignal },
  ) => Promise<AsyncIterable<AIMessage>>
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
  modelGates: RateLimitCoordinatorDeps
  registry?: ModelRegistry | undefined
}

interface ModelStreamBoundary {
  signal: AbortSignal
  race<T>(work: Promise<T>): Promise<T>
  dispose(): void
}

function boundaryError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new ModelCancellationError()
}

/**
 * Create one model-call boundary that remains live from stream open until the
 * async iterable finishes. This is deliberately longer-lived than a normal
 * promise timeout: a provider can open successfully and then stall forever on
 * `next()`, which must be governed by the same per-call and run-scoped clocks.
 */
function createModelStreamBoundary(
  modelTimeoutMs: number | undefined,
  parentSignal: AbortSignal | undefined,
): ModelStreamBoundary {
  if (parentSignal?.aborted) throw new ModelCancellationError()

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let parentAbortHandler: (() => void) | undefined

  const abort = (error: Error): void => {
    if (!controller.signal.aborted) controller.abort(error)
  }

  if (modelTimeoutMs !== undefined && modelTimeoutMs > 0) {
    timer = setTimeout(
      () => abort(new ModelTimeoutError(modelTimeoutMs)),
      modelTimeoutMs,
    )
  }
  if (parentSignal) {
    parentAbortHandler = () => abort(new ModelCancellationError())
    parentSignal.addEventListener('abort', parentAbortHandler, { once: true })
  }

  return {
    signal: controller.signal,
    async race<T>(work: Promise<T>): Promise<T> {
      if (controller.signal.aborted) throw boundaryError(controller.signal)

      let onAbort: (() => void) | undefined
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(boundaryError(controller.signal))
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })

      try {
        return await Promise.race([
          work.catch((error: unknown) => {
            if (controller.signal.aborted) {
              throw boundaryError(controller.signal)
            }
            throw error
          }),
          aborted,
        ])
      } finally {
        if (onAbort) controller.signal.removeEventListener('abort', onAbort)
      }
    },
    dispose(): void {
      if (timer !== undefined) clearTimeout(timer)
      if (parentSignal && parentAbortHandler) {
        parentSignal.removeEventListener('abort', parentAbortHandler)
      }
    },
  }
}

async function* boundStreamConsumption(
  stream: AsyncIterable<AIMessage>,
  boundary: ModelStreamBoundary,
): AsyncGenerator<AIMessage> {
  const iterator = stream[Symbol.asyncIterator]()
  let exhausted = false
  try {
    while (true) {
      const next = await boundary.race(
        Promise.resolve().then(() => iterator.next()),
      )
      if (next.done) {
        exhausted = true
        return
      }
      yield next.value
    }
  } finally {
    boundary.dispose()
    // A provider that ignored the abort signal may also hang in `return()`.
    // Cleanup is best-effort and must never delay the caller past its bound.
    if (!exhausted && iterator.return) {
      void Promise.resolve()
        .then(() => iterator.return!())
        .catch(() => undefined)
    }
  }
}

/**
 * Open and consume a provider-native stream under the same model timeout and
 * run cancellation shapes used by `invokeModelWithMiddleware`.
 */
export async function openModelStreamBounded(
  model: BaseChatModel,
  messages: BaseMessage[],
  bounds: {
    modelTimeoutMs?: number
    signal?: AbortSignal
  },
): Promise<AsyncIterable<AIMessage>> {
  const modelTimeoutMs = bounds.modelTimeoutMs
  const parentSignal = bounds.signal
  if (
    (modelTimeoutMs === undefined || modelTimeoutMs <= 0)
    && parentSignal === undefined
  ) {
    return (model as StreamableModel).stream(messages)
  }

  const boundary = createModelStreamBoundary(modelTimeoutMs, parentSignal)
  try {
    const stream = await boundary.race(
      Promise.resolve().then(() =>
        (model as StreamableModel).stream(messages, {
          signal: boundary.signal,
        }),
      ),
    )
    return boundStreamConsumption(stream, boundary)
  } catch (error) {
    boundary.dispose()
    throw error
  }
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
  if (
    isModelCancellationError(error)
    || error instanceof CostCeilingExceededError
  ) {
    return false
  }
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
  signal?: AbortSignal,
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
    tenantId: ctx.modelGates.tenantId,
    beforeAttempt: async () => awaitRateLimit(ctx.modelGates),
    isProviderFault: (error) => !isModelCancellationError(error),
    shouldRetry: (err) => shouldRunStreamFailover(ctx.config, err, messages),
    execute: async (candidate, attemptNumber) => {
      const stream = await openModelStreamBounded(candidate.model, messages, {
        ...(ctx.config.guardrails?.modelTimeoutMs !== undefined
          ? { modelTimeoutMs: ctx.config.guardrails.modelTimeoutMs }
          : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
      return {
        stream,
        provider: candidate.provider,
        modelName: candidate.modelName,
        attempt: attemptNumber,
      }
    },
  })
}
