/**
 * DzupAgent — top-level agent abstraction.
 *
 * Unifies ModelRegistry, tools, memory, middleware, guardrails,
 * context compression, and streaming into a single composable class.
 *
 * Usage:
 * ```ts
 * const agent = new DzupAgent({
 *   id: 'code-reviewer',
 *   instructions: 'You review code for quality...',
 *   model: 'codegen', // ModelTier or BaseChatModel
 *   registry,
 *   tools: [writeFileTool, editFileTool],
 *   guardrails: { maxTokens: 100_000, maxCostCents: 50 },
 * })
 *
 * const result = await agent.generate([new HumanMessage('Review this PR')])
 * ```
 */
import type { ZodType } from 'zod'
import type {
  AIMessage,
  BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import {
  type ModelTier,
  shouldSummarize,
  summarizeAndTrim,
} from '@dzupagent/core'
import { extractTokenUsage, estimateTokens, type TokenUsage } from '@dzupagent/core'
import type {
  DzupAgentConfig,
  GenerateOptions,
  GenerateResult,
  AgentStreamEvent,
} from './agent-types.js'
import { IterationBudget } from '../guardrails/iteration-budget.js'
import {
  buildPreparedMessages,
  estimateConversationTokensForMessages,
} from './message-utils.js'
import { AgentInstructionResolver } from './instruction-resolution.js'
import { AgentMemoryContextLoader } from './memory-context-loader.js'
import { AgentMiddlewareRuntime } from './middleware-runtime.js'
import {
  createToolStatTracker,
  emitStopReasonTelemetry,
  executeGenerateRun,
  executeStreamingToolCall,
  prepareRunState,
} from './run-engine.js'

const MODEL_TIERS: Set<string> = new Set(['chat', 'reasoning', 'codegen', 'embedding'])

export class DzupAgent {
  readonly id: string
  readonly name: string
  readonly description: string
  private readonly config: DzupAgentConfig
  private readonly resolvedModel: BaseChatModel
  private readonly instructionResolver: AgentInstructionResolver
  private readonly memoryContextLoader: AgentMemoryContextLoader
  private readonly middlewareRuntime: AgentMiddlewareRuntime
  private conversationSummary: string | null = null

  constructor(config: DzupAgentConfig) {
    this.id = config.id
    this.name = config.name ?? config.id
    this.description = config.description ?? `Agent: ${this.name}`
    this.config = config
    this.resolvedModel = this.resolveModel(config)
    this.instructionResolver = new AgentInstructionResolver({
      agentId: this.id,
      instructions: config.instructions,
      instructionsMode: config.instructionsMode,
      agentsDir: config.agentsDir,
    })
    this.memoryContextLoader = new AgentMemoryContextLoader({
      instructions: config.instructions,
      memory: config.memory,
      memoryNamespace: config.memoryNamespace,
      memoryScope: config.memoryScope,
      arrowMemory: config.arrowMemory,
      memoryProfile: config.memoryProfile,
      estimateConversationTokens: (messages) => this.estimateConversationTokens(messages),
    })
    this.middlewareRuntime = new AgentMiddlewareRuntime({
      agentId: this.id,
      middleware: config.middleware,
    })
  }

  /**
   * Expose the agent configuration (read-only copy) so orchestrators
   * can derive new agents with modified settings (e.g., additional tools).
   */
  get agentConfig(): Readonly<DzupAgentConfig> {
    return this.config
  }

  /**
   * Generate a response from the agent.
   *
   * Runs the full ReAct tool-calling loop with guardrails, context
   * compression, and middleware hooks.
   */
  async generate(
    messages: BaseMessage[],
    options?: GenerateOptions,
  ): Promise<GenerateResult> {
    const runState = await prepareRunState({
      config: this.config,
      resolvedModel: this.resolvedModel,
      messages,
      options,
      prepareMessages: (inputMessages) => this.prepareMessages(inputMessages),
      getTools: () => this.getTools(),
      bindTools: (model, tools) => this.bindTools(model, tools),
      runBeforeAgentHooks: () => this.runBeforeAgentHooks(),
    })

    return executeGenerateRun({
      agentId: this.id,
      config: this.config,
      options,
      runState,
      invokeModel: (model, preparedMessages) =>
        this.invokeModelWithMiddleware(model, preparedMessages),
      transformToolResult: (toolName, input, result) =>
        this.transformToolResultWithMiddleware(toolName, input, result),
      maybeUpdateSummary: (allMessages) => this.maybeUpdateSummary(allMessages),
    })
  }

  /**
   * Generate a response with structured output validated against a Zod schema.
   *
   * Uses LangChain's withStructuredOutput when the model supports it,
   * otherwise parses the LLM text response as JSON and validates.
   */
  async generateStructured<T>(
    messages: BaseMessage[],
    schema: ZodType<T>,
    options?: GenerateOptions,
  ): Promise<{ data: T; usage: GenerateResult['usage'] }> {
    // Try withStructuredOutput first (Anthropic/OpenAI support this natively)
    const model = this.resolvedModel
    if ('withStructuredOutput' in model && typeof model.withStructuredOutput === 'function') {
      const structuredModel = (model as BaseChatModel & {
        withStructuredOutput: (s: ZodType<T>) => BaseChatModel
      }).withStructuredOutput(schema)

      const prepared = await this.prepareMessages(messages)
      const response = await structuredModel.invoke(prepared)

      // The response content is the structured data when using withStructuredOutput
      const parsed = schema.parse(response)

      return {
        data: parsed,
        usage: { totalInputTokens: 0, totalOutputTokens: 0, llmCalls: 1 },
      }
    }

    // Fallback: generate text and parse as JSON
    const result = await this.generate(messages, options)
    const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/)
    const jsonStr = jsonMatch ? jsonMatch[1]! : result.content

    const parsed = schema.parse(JSON.parse(jsonStr.trim()))
    return { data: parsed, usage: result.usage }
  }

  /**
   * Stream agent events as an async iterator.
   *
   * Yields text chunks, tool calls/results, budget warnings, and done/error events.
   */
  async *stream(
    messages: BaseMessage[],
    options?: GenerateOptions,
  ): AsyncGenerator<AgentStreamEvent> {
    const runState = await prepareRunState({
      config: this.config,
      resolvedModel: this.resolvedModel,
      messages,
      options,
      prepareMessages: (inputMessages) => this.prepareMessages(inputMessages),
      getTools: () => this.getTools(),
      bindTools: (model, tools) => this.bindTools(model, tools),
      runBeforeAgentHooks: () => this.runBeforeAgentHooks(),
    })
    const usesModelWrapper = this.config.middleware?.some(
      middleware => typeof middleware.wrapModelCall === 'function',
    ) ?? false

    if (!('stream' in runState.model) || typeof runState.model.stream !== 'function' || usesModelWrapper) {
      const result = await executeGenerateRun({
        agentId: this.id,
        config: this.config,
        options,
        runState,
        invokeModel: (model, preparedMessages) =>
          this.invokeModelWithMiddleware(model, preparedMessages),
        transformToolResult: (toolName, input, result) =>
          this.transformToolResultWithMiddleware(toolName, input, result),
        maybeUpdateSummary: (allMessages) => this.maybeUpdateSummary(allMessages),
      })

      if (result.content) {
        yield { type: 'text', data: { content: result.content } }
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

    const finalizeRun = async (stopReason: 'complete' | 'iteration_limit' | 'budget_exceeded' | 'aborted' | 'stuck') => {
      emitStopReasonTelemetry(this.config, this.id, {
        stopReason,
        llmCalls,
        toolStats: toolStats.toArray(),
      })
      await this.maybeUpdateSummary(allMessages)
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
      const stream = await streamModel.stream(allMessages)
      llmCalls += 1

      let fullResponse: AIMessage | null = null
      for await (const chunk of stream) {
        fullResponse = chunk
        const content = typeof chunk.content === 'string' ? chunk.content : ''
        if (content) {
          chunks.push(content)
          yield { type: 'text', data: { content } }
        }
      }

      if (!fullResponse) {
        continue
      }

      allMessages.push(fullResponse)

      if (runState.budget) {
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
        const warnings = runState.budget.recordUsage(usage)
        for (const warning of warnings) {
          yield { type: 'budget_warning', data: { message: warning.message } }
        }
      }

      const toolCalls = fullResponse.tool_calls as Array<{
        id?: string
        name: string
        args: Record<string, unknown>
      }> | undefined

      if (!toolCalls || toolCalls.length === 0) {
        await finalizeRun('complete')
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
            this.transformToolResultWithMiddleware(toolName, input, result),
          onToolLatency: (name, durationMs, error) => {
            this.config.eventBus?.emit({
              type: 'tool:latency',
              toolName: name,
              durationMs,
              ...(error !== undefined ? { error } : {}),
            })
          },
          statTracker: toolStats,
        })

        allMessages.push(execution.message)
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
          this.config.eventBus?.emit({
            type: 'agent:stuck_detected',
            agentId: this.id,
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
          this.config.eventBus?.emit({
            type: 'agent:stuck_detected',
            agentId: this.id,
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

  /**
   * Wrap this agent as a LangChain StructuredTool so it can be used
   * as a tool by a parent agent.
   */
  async asTool(): Promise<StructuredToolInterface> {
    const { z } = await import('zod')
    const { tool } = await import('@langchain/core/tools')
    const { HumanMessage } = await import('@langchain/core/messages')
    const agent = this

    return tool(
      async ({ task, context }: { task: string; context?: string }) => {
        const msgs = [new HumanMessage(context ? `${task}\n\nContext:\n${context}` : task)]
        const result = await agent.generate(msgs)
        return result.content
      },
      {
        name: `agent-${this.id}`,
        description: this.description,
        schema: z.object({
          task: z.string().describe('The task for this agent to complete'),
          context: z.string().optional().describe('Additional context for the agent'),
        }),
      },
    )
  }

  /**
   * Fork this agent's budget for a child agent (shared state).
   */
  createChildBudget(): IterationBudget | undefined {
    if (!this.config.guardrails) return undefined
    const budget = new IterationBudget(this.config.guardrails)
    return budget.fork()
  }

  // ---------- Internal helpers --------------------------------------------------

  private resolveModel(config: DzupAgentConfig): BaseChatModel {
    if (typeof config.model !== 'string') {
      return config.model
    }

    if (!config.registry) {
      throw new Error(
        `DzupAgent "${config.id}": model is a string ("${config.model}") but no registry was provided`,
      )
    }

    if (MODEL_TIERS.has(config.model)) {
      return config.registry.getModel(config.model as ModelTier)
    }

    return config.registry.getModelByName(config.model)
  }

  private getTools(): StructuredToolInterface[] {
    return this.middlewareRuntime.resolveTools(this.config.tools ?? [])
  }

  private bindTools(
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

  private async prepareMessages(messages: BaseMessage[]): Promise<BaseMessage[]> {
    // Resolve instructions: static or merged with AGENTS.md
    const baseInstructions = await this.resolveInstructions()

    // Load memory context (Arrow-budgeted or standard)
    let memoryContext: string | null = null
    if (this.config.memory && this.config.memoryScope && this.config.memoryNamespace) {
      try {
        memoryContext = await this.memoryContextLoader.load(messages)
      } catch {
        // Memory failures are non-fatal
      }
    }

    // Context compression is handled by maybeUpdateSummary after generation.
    // summarizeAndTrim internally runs prune + repair + split + summarize.
    return buildPreparedMessages({
      baseInstructions,
      memoryContext,
      conversationSummary: this.conversationSummary,
      messages,
    })
  }

  /**
   * Resolve the effective instructions string.
   *
   * In `'static+agents'` mode, loads AGENTS.md files and merges them with
   * the static instructions. The result is cached so file I/O only happens
   * once per agent instance.
   */
  private async resolveInstructions(): Promise<string> {
    return this.instructionResolver.resolve()
  }

  /** Estimate total tokens consumed by conversation messages. */
  private estimateConversationTokens(messages: BaseMessage[]): number {
    return estimateConversationTokensForMessages(messages)
  }

  private async maybeUpdateSummary(messages: BaseMessage[]): Promise<void> {
    if (!shouldSummarize(messages, this.config.messageConfig)) return

    try {
      // Use a cheaper model for summarization if available
      const summaryModel = this.config.registry
        ? this.config.registry.getModel('chat')
        : this.resolvedModel

      const { summary } = await summarizeAndTrim(
        messages,
        this.conversationSummary,
        summaryModel,
        this.config.messageConfig,
      )
      this.conversationSummary = summary
    } catch {
      // Summarization failures are non-fatal
    }
  }

  private async runBeforeAgentHooks(): Promise<void> {
    await this.middlewareRuntime.runBeforeAgentHooks()
  }

  /**
   * Invoke model with middleware overrides.
   *
   * Contract: first middleware with wrapModelCall takes control of invocation.
   * If none exists, falls back to model.invoke(messages).
   */
  private async invokeModelWithMiddleware(
    model: BaseChatModel,
    messages: BaseMessage[],
  ): Promise<BaseMessage> {
    return this.middlewareRuntime.invokeModel(model, messages)
  }

  /**
   * Run tool result through middleware wrappers in registration order.
   */
  private async transformToolResultWithMiddleware(
    toolName: string,
    input: Record<string, unknown>,
    result: string,
  ): Promise<string> {
    return this.middlewareRuntime.transformToolResult(toolName, input, result)
  }
}
