/**
 * Per-iteration helpers for the streaming run loop (MC-026b-1).
 *
 * Hosts the stream-open dispatch (single-provider success/failure
 * recording vs. multi-provider failover), the chunk-consumer
 * generator, and the token-usage / compression plumbing executed
 * after each completed stream. Keeps `streaming-run.ts` thin.
 */

import type { AIMessage, BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  estimateTokens,
  extractTokenUsage,
  type TokenUsage,
} from '@dzupagent/core/llm'
import { injectPromptCacheMarkersForModel } from '@dzupagent/context'
import {
  runBeforeModelCall,
  runAfterModelCall,
  runOnModelError,
} from '@dzupagent/core'
import type {
  AgentStreamEvent,
  GenerateOptions,
} from './agent-types.js'
import type { PreparedRunState, ToolStatTracker } from './run-engine.js'
import { emitStopReasonTelemetry } from './run-engine.js'
import {
  buildModelHookContext,
  resolveModelIdForHooks,
} from './model-hooks.js'
import {
  emitProviderRunEvent,
  openStreamWithProviderFailover,
  type StreamableModel,
} from './streaming-run-provider.js'
import type { StreamRunContext } from './streaming-run-types.js'

export type StreamStopReason =
  | 'complete'
  | 'iteration_limit'
  | 'budget_exceeded'
  | 'aborted'
  | 'stuck'
  | 'approval_pending'
  | 'token_exhausted'

/**
 * Build the run-finalizer for the streaming coordinator. Captures the
 * mutable accumulators (`allMessages`, `toolStats`, `llmCalls` ref) so
 * the coordinator can call it from any termination branch without
 * threading the same arguments each time.
 */
export function createStreamRunFinalizer(args: {
  ctx: StreamRunContext
  options: GenerateOptions | undefined
  runState: PreparedRunState
  allMessages: BaseMessage[]
  toolStats: ToolStatTracker
  getLlmCalls: () => number
}): (stopReason: StreamStopReason, content?: string) => Promise<void> {
  const { ctx, options, runState, allMessages, toolStats, getLlmCalls } = args
  return async (stopReason, content) => {
    if (stopReason === 'token_exhausted') {
      ctx.config.eventBus?.emit({
        type: 'run:halted:token-exhausted',
        agentId: ctx.agentId,
        iterations: getLlmCalls(),
        reason: 'token_exhausted',
      })
    }
    emitStopReasonTelemetry(ctx.config, ctx.agentId, {
      stopReason,
      llmCalls: getLlmCalls(),
      toolStats: toolStats.toArray(),
    })
    await ctx.maybeUpdateSummary(allMessages, runState.memoryFrame)
    if (stopReason === 'complete') {
      const runId = options?.runId ?? ctx.config.toolExecution?.runId
      await ctx.maybeWriteBackMemory(content ?? '', runId)
    }
  }
}

/**
 * Outcome of {@link openIterationStream}: the live async iterable plus
 * the resolved provider / model identity used for circuit-breaker
 * recording and downstream telemetry.
 */
export interface OpenedStream {
  stream: AsyncIterable<AIMessage>
  activeProvider: string | undefined
  activeModelName: string
  activeAttempt: number
}

/**
 * Open a stream for the current iteration, dispatching to the
 * multi-provider failover path when the agent supplied an attempt list,
 * otherwise opening directly against the resolved model and recording
 * the single-provider open outcome against the circuit breaker.
 */
export async function openIterationStream(
  ctx: StreamRunContext,
  runState: PreparedRunState,
  allMessages: BaseMessage[],
): Promise<OpenedStream> {
  const streamModel = runState.model as StreamableModel
  let activeProvider = ctx.resolvedProvider
  let activeModelName =
    (runState.model as BaseChatModel & { model?: string }).model
    ?? ctx.resolvedProvider
    ?? 'unknown'
  let activeAttempt = 1

  const attempts = ctx.getProviderAttempts?.(runState.tools) ?? []
  if (attempts.length > 1) {
    const opened = await openStreamWithProviderFailover(ctx, attempts, allMessages)
    return {
      stream: opened.stream,
      activeProvider: opened.provider,
      activeModelName: opened.modelName,
      activeAttempt: opened.attempt,
    }
  }

  let stream: AsyncIterable<AIMessage>
  try {
    stream = await streamModel.stream(allMessages)
    // Single-provider path: record success-on-open against the
    // selection-time provider so the circuit breaker sees the same
    // signal `attemptWithFailover` produces for the multi-provider
    // path. A subsequent failure during stream consumption is recorded
    // as a failure below — both signals are valid breaker input for an
    // opened-then-broken stream (e.g. a transient mid-stream disconnect).
    if (ctx.resolvedProvider && ctx.registry) {
      ctx.registry.recordProviderSuccess(ctx.resolvedProvider)
    }
  } catch (err) {
    if (ctx.resolvedProvider && ctx.registry) {
      const asError = err instanceof Error ? err : new Error(String(err))
      ctx.registry.recordProviderFailure(ctx.resolvedProvider, asError)
    }
    throw err
  }

  return { stream, activeProvider, activeModelName, activeAttempt }
}

/**
 * Consume an open stream, yielding `text` events for partial content
 * and recording circuit-breaker failure on a consumption-time throw.
 * Returns the final assembled {@link AIMessage}, or `null` if the
 * stream emitted no chunks.
 *
 * RF-04: success-at-open is recorded by {@link openIterationStream}
 * before consumption; this helper only handles consumption-time failure
 * recording so an opened-then-broken stream produces both signals.
 */
export async function* consumeStream(args: {
  stream: AsyncIterable<AIMessage>
  chunks: string[]
  activeProvider: string | undefined
  activeModelName: string
  activeAttempt: number
  ctx: StreamRunContext
}): AsyncGenerator<AgentStreamEvent, AIMessage | null> {
  const { stream, chunks, activeProvider, activeModelName, activeAttempt, ctx } = args
  let fullResponse: AIMessage | null = null
  try {
    for await (const chunk of stream) {
      fullResponse = chunk
      const content = typeof chunk.content === 'string' ? chunk.content : ''
      if (content) {
        chunks.push(content)
        yield { type: 'text', data: { content } }
      }
    }
  } catch (err) {
    if (activeProvider && ctx.registry) {
      const asError = err instanceof Error ? err : new Error(String(err))
      ctx.registry.recordProviderFailure(activeProvider, asError)
      if (ctx.config.providerFailover?.enabled) {
        emitProviderRunEvent(ctx, {
          type: 'provider:run_failure',
          attempt: activeAttempt,
          provider: activeProvider,
          model: activeModelName,
          phase: 'stream',
          reason: asError.message,
          retrying: false,
        })
      }
    }
    throw err
  }
  return fullResponse
}

/**
 * Compute and forward {@link TokenUsage} for a finished stream chunk
 * batch. Falls back to local estimation when the response carries no
 * real usage metadata so budget enforcement and the lifecycle plugin
 * still receive a non-zero signal.
 *
 * Yields `budget_warning` events when the iteration budget reports any.
 */
export function* recordIterationUsage(args: {
  fullResponse: AIMessage
  allMessages: BaseMessage[]
  chunks: string[]
  activeModelName: string
  runState: PreparedRunState
  wrappedOnUsage?: (usage: TokenUsage) => void
}): Generator<AgentStreamEvent> {
  const {
    fullResponse,
    allMessages,
    chunks,
    activeModelName,
    runState,
    wrappedOnUsage,
  } = args
  const realUsage = extractTokenUsage(fullResponse, activeModelName)
  const hasRealUsage = realUsage.inputTokens > 0 || realUsage.outputTokens > 0
  const usage: TokenUsage = hasRealUsage
    ? realUsage
    : {
        model: realUsage.model,
        inputTokens: estimateTokens(
          allMessages
            .map((message) =>
              typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content),
            )
            .join(''),
        ),
        outputTokens: estimateTokens(chunks.join('')),
      }

  // Forward usage to the token lifecycle plugin and user callback so the
  // native streaming path mirrors the non-streaming fallback.
  wrappedOnUsage?.(usage)

  if (runState.budget) {
    const warnings = runState.budget.recordUsage(usage)
    for (const warning of warnings) {
      yield { type: 'budget_warning', data: { message: warning.message } }
    }
  }
}

/**
 * Yield budget-related events for the current iteration. Returns
 * `'exceeded'` when the budget is fully consumed (the coordinator
 * should finalize and stop), or `'continue'` otherwise. Iterates the
 * `recordIteration` warnings so the caller sees them in order.
 */
export function* checkBudgetForIteration(
  runState: PreparedRunState,
): Generator<AgentStreamEvent, 'continue' | 'exceeded'> {
  if (!runState.budget) return 'continue'
  const check = runState.budget.isExceeded()
  if (check.exceeded) {
    yield { type: 'error', data: { message: check.reason } }
    return 'exceeded'
  }
  const warnings = runState.budget.recordIteration()
  for (const warning of warnings) {
    yield { type: 'budget_warning', data: { message: warning.message } }
  }
  return 'continue'
}

/**
 * Run the stuck-detector idle check after a tool batch and yield the
 * matching `stuck` event + `agent:stuck_detected` bus emission when the
 * detector reports no-progress. Returns `'stuck'` so the coordinator
 * can finalize the run, or `'continue'` to keep iterating.
 */
export function* checkIdleStuck(
  ctx: StreamRunContext,
  runState: PreparedRunState,
  toolCallCount: number,
): Generator<AgentStreamEvent, 'continue' | 'stuck'> {
  if (!runState.stuckDetector) return 'continue'
  const idleCheck = runState.stuckDetector.recordIteration(toolCallCount)
  if (!idleCheck.stuck) return 'continue'
  const reason = idleCheck.reason ?? 'No progress detected'
  const recovery = 'Stopping due to idle iterations.'
  yield { type: 'stuck', data: { reason, recovery } }
  ctx.config.eventBus?.emit({
    type: 'agent:stuck_detected',
    agentId: ctx.agentId,
    reason,
    recovery,
    timestamp: Date.now(),
  })
  return 'stuck'
}

/**
 * Adopt a compressed message history when the token-lifecycle plugin
 * decides compression is required. Best-effort: errors are swallowed
 * so an active stream is never aborted by a compression failure.
 */
export async function maybeAdoptCompression(
  ctx: StreamRunContext,
  allMessages: BaseMessage[],
  runState: PreparedRunState,
): Promise<void> {
  const tokenPlugin = ctx.config.tokenLifecyclePlugin
  if (!tokenPlugin) return
  try {
    const compressResult = await tokenPlugin.maybeCompress(
      allMessages,
      runState.model,
      null,
    )
    if (compressResult.compressed) {
      // WS3 Task 3.2 — model-lifecycle hooks run BEFORE prompt-cache
      // re-injection on the compressed transcript. ORDERING IS LOAD-BEARING:
      // `beforeModelCall` may rewrite the array, and cache breakpoints must be
      // computed on the final array (a hook edit after injection would
      // silently invalidate breakpoint placement). The hooked transcript is
      // adopted for the next stream iteration.
      const hookedMessages = await runBeforeModelCall(
        ctx.config.hooks?.beforeModelCall
          ? [ctx.config.hooks.beforeModelCall]
          : undefined,
        ctx.config.eventBus,
        compressResult.messages,
        resolveModelIdForHooks(ctx.config.model, runState.model),
        buildModelHookContext(
          ctx.config,
          ctx.agentId,
          ctx.config.toolExecution?.runId,
        ),
      )
      // REC-H-10 — re-apply Anthropic prompt-cache markers after the
      // transcript has been replaced; otherwise subsequent stream iterations
      // miss the cache and pay full input price for every turn. Injector is
      // a no-op for non-Claude models and short transcripts.
      const recached = injectPromptCacheMarkersForModel(
        hookedMessages,
        runState.model,
      )
      allMessages.length = 0
      allMessages.push(...recached)
    }
  } catch {
    // Compression is best-effort and must not abort an active stream.
  }
}

/**
 * WS3 Task 3.2 — fire `afterModelCall` once per completed stream iteration
 * with the fully-accumulated final message (NOT per-chunk), matching how the
 * streaming path already post-processes an assembled response. Error-isolated
 * in the core dispatcher.
 */
export async function dispatchStreamAfterModelCall(
  ctx: StreamRunContext,
  runState: PreparedRunState,
  requestMessages: BaseMessage[],
  finalMessage: BaseMessage,
  options: GenerateOptions | undefined,
): Promise<void> {
  await runAfterModelCall(
    ctx.config.hooks?.afterModelCall
      ? [ctx.config.hooks.afterModelCall]
      : undefined,
    ctx.config.eventBus,
    requestMessages,
    finalMessage,
    resolveModelIdForHooks(ctx.config.model, runState.model),
    buildModelHookContext(
      ctx.config,
      ctx.agentId,
      options?.runId ?? ctx.config.toolExecution?.runId,
    ),
  )
}

/**
 * WS3 Task 3.2 — fire `onModelError` when a streaming model invocation throws
 * (stream open or consumption failure). Error-isolated in the core dispatcher.
 */
export async function dispatchStreamOnModelError(
  ctx: StreamRunContext,
  runState: PreparedRunState,
  error: unknown,
  options: GenerateOptions | undefined,
): Promise<void> {
  await runOnModelError(
    ctx.config.hooks?.onModelError
      ? [ctx.config.hooks.onModelError]
      : undefined,
    ctx.config.eventBus,
    error instanceof Error ? error : new Error(String(error)),
    resolveModelIdForHooks(ctx.config.model, runState.model),
    buildModelHookContext(
      ctx.config,
      ctx.agentId,
      options?.runId ?? ctx.config.toolExecution?.runId,
    ),
  )
}
