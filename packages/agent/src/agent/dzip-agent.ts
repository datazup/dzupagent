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
import { randomUUID } from 'node:crypto'
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
  InMemoryRunJournal,
  toOpenAISafeSchema,
} from '@dzupagent/core'
import { extractTokenUsage, estimateTokens, type TokenUsage } from '@dzupagent/core'
import type {
  DzupAgentConfig,
  GenerateOptions,
  GenerateResult,
  AgentStreamEvent,
} from './agent-types.js'
import type { AgentMailbox } from '../mailbox/types.js'
import { AgentMailboxImpl } from '../mailbox/agent-mailbox.js'
import { InMemoryMailboxStore } from '../mailbox/in-memory-mailbox-store.js'
import { createSendMailTool, createCheckMailTool } from '../mailbox/mail-tools.js'
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
import type { RunHandle, LaunchOptions } from './run-handle-types.js'
import { ConcreteRunHandle } from './run-handle.js'

const MODEL_TIERS: Set<string> = new Set(['chat', 'reasoning', 'codegen', 'embedding'])

export class DzupAgent {
  readonly id: string
  readonly name: string
  readonly description: string
  /** Per-agent mailbox for inter-agent messaging. Only set when `config.mailbox` is provided. */
  readonly mailbox?: AgentMailbox
  private readonly config: DzupAgentConfig
  private readonly resolvedModel: BaseChatModel
  private readonly instructionResolver: AgentInstructionResolver
  private readonly memoryContextLoader: AgentMemoryContextLoader
  private readonly middlewareRuntime: AgentMiddlewareRuntime
  private readonly mailboxTools: StructuredToolInterface[] = []
  private conversationSummary: string | null = null

  constructor(config: DzupAgentConfig) {
    this.id = config.id
    this.name = config.name ?? config.id
    this.description = config.description ?? `Agent: ${this.name}`
    this.config = config
    this.resolvedModel = this.resolveModel(config)

    // Initialize mailbox when configured
    if (config.mailbox) {
      const store = config.mailbox.store ?? new InMemoryMailboxStore()
      const eventBus = config.mailbox.eventBus ?? config.eventBus
      const mailboxImpl = new AgentMailboxImpl(this.id, store, eventBus)
      this.mailbox = mailboxImpl
      this.mailboxTools = [
        createSendMailTool({ mailbox: mailboxImpl }),
        createCheckMailTool({ mailbox: mailboxImpl }),
      ]
    }
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
    // Strip unsupported constraints (minLength, maxLength, minItems, maxItems, etc.)
    // before passing to withStructuredOutput — OpenAI strict mode rejects them.
    const safeSchema = toOpenAISafeSchema(schema)

    // Try withStructuredOutput first (Anthropic/OpenAI support this natively)
    const model = this.resolvedModel
    if ('withStructuredOutput' in model && typeof model.withStructuredOutput === 'function') {
      const structuredModel = (model as BaseChatModel & {
        withStructuredOutput: (s: ZodType<T>) => BaseChatModel
      }).withStructuredOutput(safeSchema as ZodType<T>)

      const prepared = await this.prepareMessages(messages)
      const response = await structuredModel.invoke(prepared)

      // Validate the response against the original schema (with constraints)
      const parsed = schema.parse(response)

      return {
        data: parsed,
        usage: { totalInputTokens: 0, totalOutputTokens: 0, llmCalls: 1 },
      }
    }

    // Fallback: generate text, extract JSON from anywhere in the response
    const result = await this.generate(messages, options)
    const jsonStr = extractJsonFromText(result.content)
    const parsed = schema.parse(JSON.parse(jsonStr))
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
   * Launch an agent run in the background and return a RunHandle immediately.
   *
   * The returned handle provides cooperative pause/resume, cancellation,
   * and result awaiting. The actual agent execution happens asynchronously.
   *
   * @param messages — input messages to generate from
   * @param options — optional launch configuration (runId, metadata, etc.)
   * @returns a RunHandle that resolves within milliseconds, before the run completes
   *
   * @example
   * ```ts
   * const handle = await agent.launch([new HumanMessage('Build the feature')])
   * console.log(handle.runId) // available immediately
   * const result = await handle.result() // awaits completion
   * ```
   */
  async launch(
    messages: BaseMessage[],
    options?: LaunchOptions & { generateOptions?: GenerateOptions },
  ): Promise<RunHandle> {
    const runId = options?.runId ?? randomUUID()
    const journal = new InMemoryRunJournal()
    const handle = new ConcreteRunHandle(runId, 'running', journal, options)

    // Write run_started entry
    void journal.append(runId, {
      type: 'run_started',
      data: { input: null, agentId: this.id, metadata: options?.metadata },
    })

    // Start execution asynchronously — do NOT await
    this.runInBackground(messages, handle, options?.generateOptions).catch(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        handle._fail(message)
      },
    )

    return handle
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

  /**
   * Execute the agent generate loop in the background, completing the handle
   * when done. This method is called by `launch()` without awaiting.
   */
  private async runInBackground(
    messages: BaseMessage[],
    handle: ConcreteRunHandle,
    generateOptions?: GenerateOptions,
  ): Promise<void> {
    const result = await this.generate(messages, generateOptions)
    handle._complete(result.content, {
      durationMs: undefined,
      totalTokens: result.usage.totalInputTokens + result.usage.totalOutputTokens,
    })
  }

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
    const configTools = this.config.tools ?? []
    const allTools = [...configTools, ...this.mailboxTools]
    return this.middlewareRuntime.resolveTools(allTools)
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

/**
 * Extract the first valid JSON value from an LLM text response.
 * Handles code-fenced JSON blocks, bare JSON objects, and bare JSON arrays.
 * Throws SyntaxError if no valid JSON is found.
 */
export function extractJsonFromText(text: string): string {
  const trimmed = text.trim()

  // 1. Try fenced block: ```json ... ``` or ``` ... ```
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) {
    return fenced[1].trim()
  }

  // 2. Try to find the first { or [ and extract a balanced JSON value
  const firstBrace = trimmed.indexOf('{')
  const firstBracket = trimmed.indexOf('[')
  const start =
    firstBrace === -1 ? firstBracket
    : firstBracket === -1 ? firstBrace
    : Math.min(firstBrace, firstBracket)

  if (start !== -1) {
    // Walk forward to find the matching close, trying progressively longer slices
    const slice = trimmed.slice(start)
    // Try the full slice first (common case: response is pure JSON after preamble)
    try {
      JSON.parse(slice)
      return slice
    } catch {
      // Find the last } or ] and try that boundary
      const lastClose = Math.max(slice.lastIndexOf('}'), slice.lastIndexOf(']'))
      if (lastClose > 0) {
        const candidate = slice.slice(0, lastClose + 1)
        JSON.parse(candidate) // let it throw if still invalid
        return candidate
      }
    }
  }

  // 3. Last resort — return the trimmed text and let JSON.parse throw
  return trimmed
}
