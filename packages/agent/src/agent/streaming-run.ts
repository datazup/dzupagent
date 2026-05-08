/**
 * Streaming run coordinator (MC-026b-1).
 *
 * Drives the ReAct streaming loop (native-stream fast path plus
 * non-stream fallback) so that `DzupAgent.stream()` can remain a thin
 * wrapper. State-free: receives everything it needs via a single
 * {@link StreamRunContext}.
 *
 * Sibling modules:
 *  - `streaming-run-types.ts`        — {@link StreamRunContext}
 *  - `streaming-run-provider.ts`     — multi-provider failover open
 *  - `streaming-run-policy.ts`       — public tool-execution surface
 *  - `streaming-run-iteration.ts`    — per-iteration helpers + finalizer
 *  - `streaming-run-tool-handler.ts` — per-tool-call batch dispatch
 *  - `streaming-run-fallback.ts`     — non-streaming model fallback path
 */

import type { TokenUsage } from '@dzupagent/core/llm'
import type { BaseMessage } from '@langchain/core/messages'
import type {
  GenerateOptions,
  AgentStreamEvent,
} from './agent-types.js'
import {
  applyOutputFilter,
  createToolStatTracker,
  prepareRunState,
  type PrepareRunStateParams,
} from './run-engine.js'
import { omitUndefined } from '../utils/exact-optional.js'
import { buildStreamingToolPolicy } from './streaming-run-policy.js'
import { handleStreamToolCalls } from './streaming-run-tool-handler.js'
import {
  checkBudgetForIteration,
  checkIdleStuck,
  consumeStream,
  createStreamRunFinalizer,
  maybeAdoptCompression,
  openIterationStream,
  recordIterationUsage,
} from './streaming-run-iteration.js'
import { runStreamFallback } from './streaming-run-fallback.js'
import type { StreamRunContext } from './streaming-run-types.js'

export type { StreamRunContext } from './streaming-run-types.js'

/**
 * Run the agent's streaming loop, yielding {@link AgentStreamEvent}s.
 *
 * Equivalent to `DzupAgent.stream()`; the class method is now a thin
 * wrapper that delegates here.
 */
export async function* streamRun(
  ctx: StreamRunContext,
  messages: BaseMessage[],
  options?: GenerateOptions,
): AsyncGenerator<AgentStreamEvent> {
  const runState = await prepareRunState(omitUndefined<PrepareRunStateParams>({
    config: ctx.config,
    resolvedModel: ctx.resolvedModel,
    messages,
    options,
    prepareMessages: (inputMessages) => ctx.prepareMessages(inputMessages),
    getTools: () => ctx.getTools(),
    bindTools: (model, tools) => ctx.bindTools(model, tools),
    runBeforeAgentHooks: () => ctx.runBeforeAgentHooks(),
  }))
  const usesModelWrapper = ctx.config.middleware?.some(
    middleware => typeof middleware.wrapModelCall === 'function',
  ) ?? false

  // When a tokenLifecyclePlugin is configured, wrap options.onUsage so the
  // plugin receives real LLM token counts. Both GenerateOptions.onUsage and
  // AgentLoopPlugin.onUsage share the same `{ model, inputTokens, outputTokens }`
  // shape, so no adapter transformation is needed — we just forward twice.
  const tokenPlugin = ctx.config.tokenLifecyclePlugin
  const userOnUsage = options?.onUsage
  const wrappedOnUsage = tokenPlugin
    ? (usage: TokenUsage) => {
        tokenPlugin.onUsage(usage)
        userOnUsage?.(usage)
      }
    : userOnUsage
  const optionsWithUsage: GenerateOptions | undefined = tokenPlugin
    ? omitUndefined({ ...(options ?? {}), onUsage: wrappedOnUsage })
    : options

  if (
    !('stream' in runState.model)
    || typeof runState.model.stream !== 'function'
    || usesModelWrapper
  ) {
    yield* runStreamFallback(ctx, runState, optionsWithUsage)
    return
  }

  const allMessages = [...runState.preparedMessages]
  const toolStats = createToolStatTracker()
  let llmCalls = 0
  const finalizeRun = createStreamRunFinalizer({
    ctx,
    options,
    runState,
    allMessages,
    toolStats,
    getLlmCalls: () => llmCalls,
  })
  const streamingPolicy = buildStreamingToolPolicy(ctx, options)

  for (let iteration = 0; iteration < runState.maxIterations; iteration++) {
    if (options?.signal?.aborted) {
      await finalizeRun('aborted')
      yield { type: 'done', data: { stopReason: 'aborted' } }
      return
    }

    const budgetStatus = yield* checkBudgetForIteration(runState)
    if (budgetStatus === 'exceeded') {
      await finalizeRun('budget_exceeded')
      yield { type: 'done', data: { stopReason: 'budget_exceeded', hitIterationLimit: true } }
      return
    }

    const chunks: string[] = []
    const opened = await openIterationStream(ctx, runState, allMessages)
    llmCalls += 1

    const fullResponse = yield* consumeStream({
      stream: opened.stream,
      chunks,
      activeProvider: opened.activeProvider,
      activeModelName: opened.activeModelName,
      activeAttempt: opened.activeAttempt,
      ctx,
    })
    if (!fullResponse) continue

    allMessages.push(fullResponse)

    yield* recordIterationUsage(omitUndefined({
      fullResponse,
      allMessages,
      chunks,
      activeModelName: opened.activeModelName,
      runState,
      wrappedOnUsage,
    }))

    // Token lifecycle auto-compression — invoked AFTER usage has been
    // recorded for the full streamed response and BEFORE halt/tool checks.
    // This mirrors the non-streaming tool loop so compressed histories are
    // adopted before any subsequent tool/model turn.
    await maybeAdoptCompression(ctx, allMessages, runState)

    // Token lifecycle halt check — evaluated after compression adoption but
    // before tool execution, matching generate() parity for exhausted tokens.
    if (tokenPlugin?.shouldHalt()) {
      await finalizeRun('token_exhausted')
      yield { type: 'done', data: { stopReason: 'token_exhausted' } }
      return
    }

    const toolCalls = fullResponse.tool_calls as Array<{
      id?: string
      name: string
      args: Record<string, unknown>
    }> | undefined

    if (!toolCalls || toolCalls.length === 0) {
      const content = await applyOutputFilter(ctx.config, chunks.join(''))
      await finalizeRun('complete', content)
      yield { type: 'done', data: { content, stopReason: 'complete' } }
      return
    }

    const outcome = yield* handleStreamToolCalls(ctx, toolCalls, {
      runState,
      allMessages,
      toolStats,
      streamingPolicy,
      options,
    })
    if (outcome.status === 'stop') {
      await finalizeRun(outcome.stopReason)
      yield { type: 'done', data: { stopReason: outcome.stopReason } }
      return
    }

    const idleStatus = yield* checkIdleStuck(ctx, runState, toolCalls.length)
    if (idleStatus === 'stuck') {
      await finalizeRun('stuck')
      yield { type: 'done', data: { stopReason: 'stuck' } }
      return
    }
  }

  await finalizeRun('iteration_limit')
  yield { type: 'done', data: { hitIterationLimit: true, stopReason: 'iteration_limit' } }
}
