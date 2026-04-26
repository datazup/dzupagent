/**
 * Streaming run execution — extracted from DzupAgent.stream() body.
 *
 * Holds the full ReAct streaming loop (native-stream fast path plus
 * non-stream fallback) so that `DzupAgent.stream()` can remain a thin
 * wrapper that forwards to {@link streamRun}. This module contains no
 * state of its own; it receives everything it needs via a single
 * `StreamRunContext` argument.
 *
 * Keeping the implementation out of `dzip-agent.ts` keeps that class
 * at a manageable size (~400 LOC ceiling) and lets us unit-test the
 * streaming loop in isolation without instantiating a full agent.
 */

import {
  type AIMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import {
  extractTokenUsage,
  estimateTokens,
  type TokenUsage,
  type ModelRegistry,
} from '@dzupagent/core'
import type {
  DzupAgentConfig,
  GenerateOptions,
  AgentStreamEvent,
} from './agent-types.js'
import {
  createToolStatTracker,
  emitStopReasonTelemetry,
  executeGenerateRun,
  executeStreamingToolCall,
  prepareRunState,
} from './run-engine.js'

/**
 * Callbacks and configuration a streaming run needs from its owning agent.
 *
 * The agent supplies closures over its private state (model, tools, memory,
 * middleware, summary cache) without exposing those internals publicly.
 */
export interface StreamRunContext {
  agentId: string
  config: DzupAgentConfig
  resolvedModel: BaseChatModel
  /**
   * Provider name returned by the registry when tier-based fallback was
   * used at agent construction time. Carries the selected provider into the
   * native streaming path so that stream success/failure can be recorded
   * against the same circuit breaker the non-streaming path uses.
   *
   * Selection-time only: this provider is fixed for the lifetime of the
   * run; we do not switch providers mid-stream on transient failure.
   * `undefined` when the agent was constructed with an explicit model
   * instance or a model resolved by name (no fallback chain in play).
   */
  resolvedProvider?: string | undefined
  /**
   * Registry used to resolve {@link resolvedProvider}. Required to thread
   * native-stream outcomes back to the circuit breaker via
   * `recordProviderSuccess` / `recordProviderFailure`. `undefined` when
   * `resolvedProvider` is also `undefined`.
   */
  registry?: ModelRegistry | undefined
  prepareMessages: (messages: BaseMessage[]) => Promise<{ messages: BaseMessage[]; memoryFrame?: unknown }>
  getTools: () => StructuredToolInterface[]
  bindTools: (model: BaseChatModel, tools: StructuredToolInterface[]) => BaseChatModel
  runBeforeAgentHooks: () => Promise<void>
  invokeModelWithMiddleware: (model: BaseChatModel, messages: BaseMessage[]) => Promise<BaseMessage>
  transformToolResultWithMiddleware: (
    toolName: string,
    input: Record<string, unknown>,
    result: string,
  ) => Promise<string>
  maybeUpdateSummary: (messages: BaseMessage[], memoryFrame?: unknown) => Promise<void>
  maybeWriteBackMemory: (content: string) => Promise<void>
}

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
  const runState = await prepareRunState({
    config: ctx.config,
    resolvedModel: ctx.resolvedModel,
    messages,
    options,
    prepareMessages: (inputMessages) => ctx.prepareMessages(inputMessages),
    getTools: () => ctx.getTools(),
    bindTools: (model, tools) => ctx.bindTools(model, tools),
    runBeforeAgentHooks: () => ctx.runBeforeAgentHooks(),
  })
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
    ? { ...(options ?? {}), onUsage: wrappedOnUsage }
    : options

  if (!('stream' in runState.model) || typeof runState.model.stream !== 'function' || usesModelWrapper) {
    const result = await executeGenerateRun({
      agentId: ctx.agentId,
      config: ctx.config,
      options: optionsWithUsage,
      runState,
      invokeModel: (model, preparedMessages) =>
        ctx.invokeModelWithMiddleware(model, preparedMessages),
      transformToolResult: (toolName, input, result) =>
        ctx.transformToolResultWithMiddleware(toolName, input, result),
      maybeUpdateSummary: (allMessages, memoryFrame) =>
        ctx.maybeUpdateSummary(allMessages, memoryFrame),
    })

    if (result.content) {
      yield { type: 'text', data: { content: result.content } }
    }
    if (result.stopReason === 'complete') {
      await ctx.maybeWriteBackMemory(result.content)
    }
    yield {
      type: 'done',
      data: {
        content: result.content,
        stopReason: result.stopReason,
        ...(result.hitIterationLimit ? { hitIterationLimit: true } : {}),
      },
    }
    return
  }

  const streamModel = runState.model as BaseChatModel & {
    stream: (msgs: BaseMessage[]) => Promise<AsyncIterable<AIMessage>>
  }
  const allMessages = [...runState.preparedMessages]
  const toolStats = createToolStatTracker()
  let llmCalls = 0

  const finalizeRun = async (
    stopReason: 'complete' | 'iteration_limit' | 'budget_exceeded' | 'aborted' | 'stuck',
    content?: string,
  ) => {
    emitStopReasonTelemetry(ctx.config, ctx.agentId, {
      stopReason,
      llmCalls,
      toolStats: toolStats.toArray(),
    })
    await ctx.maybeUpdateSummary(allMessages, runState.memoryFrame)
    if (stopReason === 'complete') {
      await ctx.maybeWriteBackMemory(content ?? '')
    }
  }

  for (let iteration = 0; iteration < runState.maxIterations; iteration++) {
    if (options?.signal?.aborted) {
      await finalizeRun('aborted')
      yield { type: 'done', data: { stopReason: 'aborted' } }
      return
    }

    if (runState.budget) {
      const check = runState.budget.isExceeded()
      if (check.exceeded) {
        yield { type: 'error', data: { message: check.reason } }
        await finalizeRun('budget_exceeded')
        yield { type: 'done', data: { stopReason: 'budget_exceeded', hitIterationLimit: true } }
        return
      }

      const warnings = runState.budget.recordIteration()
      for (const warning of warnings) {
        yield { type: 'budget_warning', data: { message: warning.message } }
      }
    }

    const chunks: string[] = []
    // Record native streaming outcomes against the same circuit breaker the
    // non-streaming path feeds via `invokeModelWithMiddleware`. We follow the
    // selection-time-only fallback model: success/failure is recorded for the
    // single provider chosen at construction; we never switch providers
    // mid-run on a transient failure. The breaker state opens the circuit at
    // the next agent construction (or wherever else `getModelWithFallback`
    // is consulted).
    let stream: AsyncIterable<AIMessage>
    try {
      stream = await streamModel.stream(allMessages)
    } catch (err) {
      if (ctx.resolvedProvider && ctx.registry) {
        const asError = err instanceof Error ? err : new Error(String(err))
        ctx.registry.recordProviderFailure(ctx.resolvedProvider, asError)
      }
      throw err
    }
    llmCalls += 1

    let fullResponse: AIMessage | null = null
    let streamThrew = false
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
      streamThrew = true
      if (ctx.resolvedProvider && ctx.registry) {
        const asError = err instanceof Error ? err : new Error(String(err))
        ctx.registry.recordProviderFailure(ctx.resolvedProvider, asError)
      }
      throw err
    } finally {
      if (!streamThrew && ctx.resolvedProvider && ctx.registry) {
        ctx.registry.recordProviderSuccess(ctx.resolvedProvider)
      }
    }

    if (!fullResponse) {
      continue
    }

    allMessages.push(fullResponse)

    {
      const modelName = (runState.model as BaseChatModel & { model?: string }).model
      const realUsage = extractTokenUsage(fullResponse, modelName ?? undefined)
      const hasRealUsage = realUsage.inputTokens > 0 || realUsage.outputTokens > 0
      const usage: TokenUsage = hasRealUsage
        ? realUsage
        : {
            model: realUsage.model,
            inputTokens: estimateTokens(
              allMessages.map(message =>
                typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
              ).join(''),
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

    const toolCalls = fullResponse.tool_calls as Array<{
      id?: string
      name: string
      args: Record<string, unknown>
    }> | undefined

    if (!toolCalls || toolCalls.length === 0) {
      await finalizeRun('complete', chunks.join(''))
      yield {
        type: 'done',
        data: {
          content: chunks.join(''),
          stopReason: 'complete',
        },
      }
      return
    }

    for (const toolCall of toolCalls) {
      yield { type: 'tool_call', data: { name: toolCall.name, args: toolCall.args } }

      const execution = await executeStreamingToolCall({
        toolCall,
        toolMap: runState.toolMap,
        budget: runState.budget,
        stuckDetector: runState.stuckDetector,
        transformToolResult: (toolName, input, result) =>
          ctx.transformToolResultWithMiddleware(toolName, input, result),
        onToolLatency: (name, durationMs, error) => {
          ctx.config.eventBus?.emit({
            type: 'tool:latency',
            toolName: name,
            durationMs,
            ...(error !== undefined ? { error } : {}),
          })
        },
        statTracker: toolStats,
      })

      allMessages.push(execution.message)
      // Charge tool-result bytes against the token lifecycle plugin so
      // the streaming path mirrors the non-streaming executor in its
      // per-phase breakdown contributions.
      if (tokenPlugin && execution.eventResult) {
        tokenPlugin.trackPhase('tool-result', estimateTokens(execution.eventResult))
      }
      yield {
        type: 'tool_result',
        data: { name: toolCall.name, result: execution.eventResult },
      }

      if (execution.stuckReason && execution.stuckRecovery) {
        yield {
          type: 'stuck',
          data: {
            reason: execution.stuckReason,
            recovery: execution.stuckRecovery,
            ...(execution.repeatedTool ? { repeatedTool: execution.repeatedTool } : {}),
          },
        }
        ctx.config.eventBus?.emit({
          type: 'agent:stuck_detected',
          agentId: ctx.agentId,
          reason: execution.stuckReason,
          recovery: execution.stuckRecovery,
          timestamp: Date.now(),
          ...(execution.repeatedTool ? { repeatedTool: execution.repeatedTool } : {}),
          escalationLevel: execution.shouldStop ? 3 : 1,
        })

        if (execution.stuckNudge) {
          allMessages.push(execution.stuckNudge)
        }

        if (execution.shouldStop) {
          await finalizeRun('stuck')
          yield { type: 'done', data: { stopReason: 'stuck' } }
          return
        }
      }
    }

    if (runState.stuckDetector) {
      const idleCheck = runState.stuckDetector.recordIteration(toolCalls.length)
      if (idleCheck.stuck) {
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
        await finalizeRun('stuck')
        yield { type: 'done', data: { stopReason: 'stuck' } }
        return
      }
    }
  }

  await finalizeRun('iteration_limit')
  yield { type: 'done', data: { hitIterationLimit: true, stopReason: 'iteration_limit' } }
}
