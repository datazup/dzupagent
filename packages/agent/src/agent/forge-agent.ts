/**
 * ForgeAgent — top-level agent abstraction.
 *
 * Unifies ModelRegistry, tools, memory, middleware, guardrails,
 * context compression, and streaming into a single composable class.
 *
 * Usage:
 * ```ts
 * const agent = new ForgeAgent({
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
import {
  SystemMessage,
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import {
  type ModelTier,
  shouldSummarize,
  summarizeAndTrim,
  formatSummaryContext,
} from '@forgeagent/core'
import type { TokenUsage } from '@forgeagent/core'
import type {
  ForgeAgentConfig,
  GenerateOptions,
  GenerateResult,
  AgentStreamEvent,
} from './agent-types.js'
import { IterationBudget } from '../guardrails/iteration-budget.js'
import { runToolLoop } from './tool-loop.js'

const MODEL_TIERS: Set<string> = new Set(['chat', 'reasoning', 'codegen', 'embedding'])

export class ForgeAgent {
  readonly id: string
  readonly name: string
  readonly description: string
  private readonly config: ForgeAgentConfig
  private readonly resolvedModel: BaseChatModel
  private conversationSummary: string | null = null

  constructor(config: ForgeAgentConfig) {
    this.id = config.id
    this.name = config.name ?? config.id
    this.description = config.description ?? `Agent: ${this.name}`
    this.config = config
    this.resolvedModel = this.resolveModel(config)
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
    const maxIterations = options?.maxIterations
      ?? this.config.guardrails?.maxIterations
      ?? this.config.maxIterations
      ?? 10

    // Build budget tracker
    const budget = this.config.guardrails
      ? new IterationBudget(this.config.guardrails)
      : undefined

    // Prepare messages with system prompt + memory context + compression
    const prepared = await this.prepareMessages(messages)

    // Bind tools to model if available
    const tools = this.getTools()
    const model = this.bindTools(this.resolvedModel, tools)

    // Run middleware beforeAgent hooks
    await this.runBeforeAgentHooks()

    // Run the tool loop
    const result = await runToolLoop(model, prepared, tools, {
      maxIterations,
      budget,
      signal: options?.signal,
      onUsage: (usage) => {
        options?.onUsage?.(usage)
      },
    })

    // Extract final content
    const lastAI = [...result.messages].reverse().find(m => m._getType() === 'ai')
    let content = ''
    if (lastAI) {
      content = typeof lastAI.content === 'string'
        ? lastAI.content
        : JSON.stringify(lastAI.content)
    }

    // Apply output filter guardrail
    if (this.config.guardrails?.outputFilter && content) {
      const filtered = await this.config.guardrails.outputFilter(content)
      if (filtered !== null) {
        content = filtered
      }
    }

    // Update conversation summary if needed
    await this.maybeUpdateSummary(result.messages)

    return {
      content,
      messages: result.messages,
      usage: {
        totalInputTokens: result.totalInputTokens,
        totalOutputTokens: result.totalOutputTokens,
        llmCalls: result.llmCalls,
      },
      hitIterationLimit: result.hitIterationLimit,
    }
  }

  /**
   * Generate a response with structured output validated against a Zod schema.
   *
   * Uses LangChain's withStructuredOutput when the model supports it,
   * otherwise parses the LLM text response as JSON and validates.
   */
  async generateStructured<T>(
    messages: BaseMessage[],
    schema: import('zod').ZodType<T>,
    options?: GenerateOptions,
  ): Promise<{ data: T; usage: GenerateResult['usage'] }> {
    // Try withStructuredOutput first (Anthropic/OpenAI support this natively)
    const model = this.resolvedModel
    if ('withStructuredOutput' in model && typeof model.withStructuredOutput === 'function') {
      const structuredModel = (model as BaseChatModel & {
        withStructuredOutput: (s: import('zod').ZodType<T>) => BaseChatModel
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
    const maxIterations = options?.maxIterations
      ?? this.config.guardrails?.maxIterations
      ?? this.config.maxIterations
      ?? 10

    const budget = this.config.guardrails
      ? new IterationBudget(this.config.guardrails)
      : undefined

    const prepared = await this.prepareMessages(messages)
    const tools = this.getTools()
    const toolMap = new Map(tools.map(t => [t.name, t]))
    const model = this.bindTools(this.resolvedModel, tools)

    const allMessages = [...prepared]

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (options?.signal?.aborted) break

      if (budget) {
        const check = budget.isExceeded()
        if (check.exceeded) {
          yield { type: 'error', data: { message: check.reason } }
          break
        }
        const warnings = budget.recordIteration()
        for (const w of warnings) {
          yield { type: 'budget_warning', data: { message: w.message } }
        }
      }

      // Stream from LLM
      if ('stream' in model && typeof model.stream === 'function') {
        const chunks: string[] = []
        const stream = await (model as BaseChatModel & {
          stream: (msgs: BaseMessage[]) => Promise<AsyncIterable<AIMessage>>
        }).stream(allMessages)

        let fullResponse: AIMessage | null = null
        for await (const chunk of stream) {
          fullResponse = chunk
          const content = typeof chunk.content === 'string' ? chunk.content : ''
          if (content) {
            chunks.push(content)
            yield { type: 'text', data: { content } }
          }
        }

        if (fullResponse) {
          allMessages.push(fullResponse)

          // Track usage
          if (budget) {
            const modelName = (model as BaseChatModel & { model?: string }).model
            const usage: TokenUsage = {
              model: modelName ?? 'unknown',
              inputTokens: 0,
              outputTokens: chunks.join('').length / 4, // rough estimate for streaming
            }
            const warnings = budget.recordUsage(usage)
            for (const w of warnings) {
              yield { type: 'budget_warning', data: { message: w.message } }
            }
          }

          // Check for tool calls
          const toolCalls = fullResponse.tool_calls as Array<{
            id?: string; name: string; args: Record<string, unknown>
          }> | undefined

          if (!toolCalls || toolCalls.length === 0) {
            yield { type: 'done', data: { content: chunks.join('') } }
            return
          }

          // Execute tools
          for (const tc of toolCalls) {
            const toolCallId = tc.id ?? `call_${Date.now()}`
            yield { type: 'tool_call', data: { name: tc.name, args: tc.args } }

            if (budget?.isToolBlocked(tc.name)) {
              const msg = new ToolMessage({
                content: `[Tool "${tc.name}" is blocked by guardrails]`,
                tool_call_id: toolCallId,
                name: tc.name,
              })
              allMessages.push(msg)
              yield { type: 'tool_result', data: { name: tc.name, result: '[blocked]' } }
              continue
            }

            const tool = toolMap.get(tc.name)
            if (!tool) {
              const msg = new ToolMessage({
                content: `Error: Tool "${tc.name}" not found`,
                tool_call_id: toolCallId,
                name: tc.name,
              })
              allMessages.push(msg)
              yield { type: 'tool_result', data: { name: tc.name, result: '[not found]' } }
              continue
            }

            try {
              const result = await tool.invoke(tc.args)
              const resultStr = typeof result === 'string' ? result : JSON.stringify(result)
              const msg = new ToolMessage({
                content: resultStr,
                tool_call_id: toolCallId,
                name: tc.name,
              })
              allMessages.push(msg)
              yield { type: 'tool_result', data: { name: tc.name, result: resultStr } }
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err)
              const msg = new ToolMessage({
                content: `Error: ${errMsg}`,
                tool_call_id: toolCallId,
                name: tc.name,
              })
              allMessages.push(msg)
              yield { type: 'tool_result', data: { name: tc.name, result: `[error: ${errMsg}]` } }
            }
          }
        }
      } else {
        // Non-streaming fallback
        const result = await this.generate(messages, options)
        yield { type: 'text', data: { content: result.content } }
        yield { type: 'done', data: { content: result.content } }
        return
      }
    }

    yield { type: 'done', data: { hitIterationLimit: true } }
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

  private resolveModel(config: ForgeAgentConfig): BaseChatModel {
    if (typeof config.model !== 'string') {
      return config.model
    }

    if (!config.registry) {
      throw new Error(
        `ForgeAgent "${config.id}": model is a string ("${config.model}") but no registry was provided`,
      )
    }

    if (MODEL_TIERS.has(config.model)) {
      return config.registry.getModel(config.model as ModelTier)
    }

    return config.registry.getModelByName(config.model)
  }

  private getTools(): StructuredToolInterface[] {
    const tools = [...(this.config.tools ?? [])]

    // Add middleware-provided tools
    if (this.config.middleware) {
      for (const mw of this.config.middleware) {
        if (mw.tools) {
          tools.push(...mw.tools)
        }
      }
    }

    return tools
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
    const parts: string[] = [this.config.instructions]

    // Load memory context
    if (this.config.memory && this.config.memoryScope && this.config.memoryNamespace) {
      try {
        const records = await this.config.memory.get(
          this.config.memoryNamespace,
          this.config.memoryScope,
        )
        const formatted = this.config.memory.formatForPrompt(records)
        if (formatted) parts.push(formatted)
      } catch {
        // Memory failures are non-fatal
      }
    }

    // Add conversation summary if available
    const summaryContext = formatSummaryContext(this.conversationSummary)
    if (summaryContext) parts.push(summaryContext)

    const systemMsg = new SystemMessage(parts.join('\n\n'))

    // Context compression is handled by maybeUpdateSummary after generation.
    // summarizeAndTrim internally runs prune + repair + split + summarize.
    return [systemMsg, ...messages]
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
    if (!this.config.middleware) return

    for (const mw of this.config.middleware) {
      if (mw.beforeAgent) {
        try {
          await mw.beforeAgent({})
        } catch {
          // Middleware failures are non-fatal
        }
      }
    }
  }
}
