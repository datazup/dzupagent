/**
 * DzipAgent — top-level agent abstraction.
 *
 * Unifies ModelRegistry, tools, memory, middleware, guardrails,
 * context compression, and streaming into a single composable class.
 *
 * Usage:
 * ```ts
 * const agent = new DzipAgent({
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
} from '@dzipagent/core'
import { extractTokenUsage, estimateTokens, type TokenUsage } from '@dzipagent/core'
import type {
  DzipAgentConfig,
  GenerateOptions,
  GenerateResult,
  AgentStreamEvent,
} from './agent-types.js'
import { IterationBudget } from '../guardrails/iteration-budget.js'
import { StuckDetector } from '../guardrails/stuck-detector.js'
import { runToolLoop } from './tool-loop.js'
import { resolveArrowMemoryConfig } from './memory-profiles.js'
import { loadAgentsFiles } from '../instructions/instruction-loader.js'
import { mergeInstructions, type MergedInstructions } from '../instructions/instruction-merger.js'
import { createToolLoopLearningHook } from './tool-loop-learning.js'

const MODEL_TIERS: Set<string> = new Set(['chat', 'reasoning', 'codegen', 'embedding'])

export class DzipAgent {
  readonly id: string
  readonly name: string
  readonly description: string
  private readonly config: DzipAgentConfig
  private readonly resolvedModel: BaseChatModel
  private conversationSummary: string | null = null
  private mergedInstructionsCache: MergedInstructions | null = null
  private mergedInstructionsLoading: Promise<MergedInstructions> | null = null

  constructor(config: DzipAgentConfig) {
    this.id = config.id
    this.name = config.name ?? config.id
    this.description = config.description ?? `Agent: ${this.name}`
    this.config = config
    this.resolvedModel = this.resolveModel(config)
  }

  /**
   * Expose the agent configuration (read-only copy) so orchestrators
   * can derive new agents with modified settings (e.g., additional tools).
   */
  get agentConfig(): Readonly<DzipAgentConfig> {
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

    // Create stuck detector for this run, using guardrails config if provided
    const stuckDetector = this.config.guardrails?.stuckDetector === false
      ? undefined
      : new StuckDetector(
          typeof this.config.guardrails?.stuckDetector === 'object'
            ? this.config.guardrails.stuckDetector
            : undefined,
        )

    // Create self-learning hook (undefined when disabled)
    const learningHook = createToolLoopLearningHook(this.config.selfLearning)
    if (learningHook) {
      // Load specialist config before the loop (best-effort, non-blocking)
      await learningHook.loadSpecialistConfig().catch(() => { /* non-fatal */ })
    }

    // Run the tool loop
    const result = await runToolLoop(model, prepared, tools, {
      maxIterations,
      budget,
      signal: options?.signal,
      stuckDetector,
      toolStatsTracker: this.config.toolStatsTracker,
      intent: options?.intent,
      onStuckDetected: (reason, recovery) => {
        this.config.eventBus?.emit({
          type: 'agent:stuck_detected',
          agentId: this.id,
          reason,
          recovery,
          timestamp: Date.now(),
        })
      },
      onStuck: (toolName, stage) => {
        this.config.eventBus?.emit({
          type: 'agent:stuck_detected',
          agentId: this.id,
          reason: `Stuck on tool "${toolName}" (escalation stage ${stage})`,
          recovery: stage >= 3 ? 'Aborting loop' : stage === 2 ? 'Nudge injected' : 'Tool blocked',
          timestamp: Date.now(),
        })
      },
      invokeModel: (m, msgs) => this.invokeModelWithMiddleware(m, msgs),
      transformToolResult: (name, input, output) =>
        this.transformToolResultWithMiddleware(name, input, output),
      onUsage: (usage) => {
        options?.onUsage?.(usage)
      },
      onToolLatency: (name, durationMs, error) => {
        this.config.eventBus?.emit({
          type: 'tool:latency',
          toolName: name,
          durationMs,
          ...(error !== undefined ? { error } : {}),
        })
      },
    })

    // Emit stop-reason telemetry
    this.config.eventBus?.emit({
      type: 'agent:stop_reason',
      agentId: this.id,
      reason: result.stopReason,
      iterations: result.llmCalls,
      toolStats: result.toolStats,
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
      stopReason: result.stopReason,
      toolStats: result.toolStats,
      stuckError: result.stuckError,
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
    const stuckDetector = this.config.guardrails?.stuckDetector === false
      ? undefined
      : new StuckDetector(
          typeof this.config.guardrails?.stuckDetector === 'object'
            ? this.config.guardrails.stuckDetector
            : undefined,
        )

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

          // Track usage — extract real token counts from the final stream chunk,
          // falling back to a rough estimate only when the provider doesn't report usage.
          if (budget) {
            const modelName = (model as BaseChatModel & { model?: string }).model
            const realUsage = extractTokenUsage(fullResponse, modelName ?? undefined)

            // Only fall back to estimation if BOTH input and output are zero
            // (i.e., the provider reported no usage at all).
            const hasRealUsage = realUsage.inputTokens > 0 || realUsage.outputTokens > 0
            const usage: TokenUsage = hasRealUsage
              ? realUsage
              : {
                  model: realUsage.model,
                  inputTokens: estimateTokens(
                    allMessages.map(m =>
                      typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                    ).join(''),
                  ),
                  outputTokens: estimateTokens(chunks.join('')),
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

            let toolError: string | undefined
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
              toolError = err instanceof Error ? err.message : String(err)
              const msg = new ToolMessage({
                content: `Error: ${toolError}`,
                tool_call_id: toolCallId,
                name: tc.name,
              })
              allMessages.push(msg)
              yield { type: 'tool_result', data: { name: tc.name, result: `[error: ${toolError}]` } }
            }

            // Stuck detection in streaming
            if (stuckDetector) {
              const stuckCheck = toolError
                ? stuckDetector.recordError(new Error(toolError))
                : stuckDetector.recordToolCall(tc.name, tc.args)

              if (stuckCheck.stuck) {
                const reason = stuckCheck.reason ?? 'Unknown stuck condition'
                if (toolError) {
                  const recovery = 'Stopping due to repeated errors.'
                  yield { type: 'stuck', data: { reason, recovery, repeatedTool: tc.name } }
                  this.config.eventBus?.emit({
                    type: 'agent:stuck_detected',
                    agentId: this.id,
                    reason,
                    recovery,
                    timestamp: Date.now(),
                    repeatedTool: tc.name,
                    escalationLevel: 3,
                  })
                  yield { type: 'done', data: { stopReason: 'stuck' } }
                  return
                } else {
                  const recovery = `Tool "${tc.name}" has been blocked. Try a different approach.`
                  budget?.blockTool(tc.name)
                  yield { type: 'stuck', data: { reason, recovery, repeatedTool: tc.name } }
                  this.config.eventBus?.emit({
                    type: 'agent:stuck_detected',
                    agentId: this.id,
                    reason,
                    recovery,
                    timestamp: Date.now(),
                    repeatedTool: tc.name,
                    escalationLevel: 1,
                  })
                  allMessages.push(new ToolMessage({
                    content: `[Agent appears stuck: ${reason}. ${recovery}]`,
                    tool_call_id: toolCallId,
                    name: tc.name,
                  }))
                }
              }
            }
          }

          // Idle iteration detection in streaming
          if (stuckDetector) {
            const idleCheck = stuckDetector.recordIteration(toolCalls.length)
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
              yield { type: 'done', data: { stopReason: 'stuck' } }
              return
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

  private resolveModel(config: DzipAgentConfig): BaseChatModel {
    if (typeof config.model !== 'string') {
      return config.model
    }

    if (!config.registry) {
      throw new Error(
        `DzipAgent "${config.id}": model is a string ("${config.model}") but no registry was provided`,
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
    // Resolve instructions: static or merged with AGENTS.md
    const baseInstructions = await this.resolveInstructions()
    const parts: string[] = [baseInstructions]

    // Load memory context (Arrow-budgeted or standard)
    if (this.config.memory && this.config.memoryScope && this.config.memoryNamespace) {
      try {
        const memoryContext = await this.loadMemoryContext(messages)
        if (memoryContext) parts.push(memoryContext)
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

  /**
   * Resolve the effective instructions string.
   *
   * In `'static+agents'` mode, loads AGENTS.md files and merges them with
   * the static instructions. The result is cached so file I/O only happens
   * once per agent instance.
   */
  private async resolveInstructions(): Promise<string> {
    if (this.config.instructionsMode !== 'static+agents') {
      return this.config.instructions
    }

    // Return cached result if available
    if (this.mergedInstructionsCache) {
      return this.mergedInstructionsCache.systemPrompt
    }

    // Deduplicate concurrent calls
    if (!this.mergedInstructionsLoading) {
      this.mergedInstructionsLoading = this.loadAndMergeInstructions()
    }

    const merged = await this.mergedInstructionsLoading
    this.mergedInstructionsCache = merged
    return merged.systemPrompt
  }

  /**
   * Load AGENTS.md files and merge them with static instructions.
   */
  private async loadAndMergeInstructions(): Promise<MergedInstructions> {
    try {
      const dir = this.config.agentsDir ?? process.cwd()
      const files = await loadAgentsFiles(dir)

      if (files.length === 0) {
        return {
          systemPrompt: this.config.instructions,
          agentHierarchy: [],
          sources: [],
        }
      }

      const allSections = files.flatMap(f => f.sections)
      const allSources = files.map(f => f.path)

      return mergeInstructions(
        this.config.instructions,
        allSections,
        this.id,
        allSources,
      )
    } catch {
      // AGENTS.md loading failures are non-fatal — fall back to static
      return {
        systemPrompt: this.config.instructions,
        agentHierarchy: [],
        sources: [],
      }
    }
  }

  /**
   * Load memory context, using Arrow token-budgeted selection when
   * `arrowMemory` config is set, falling back to standard load-all otherwise.
   */
  private async loadMemoryContext(messages: BaseMessage[]): Promise<string | null> {
    const memory = this.config.memory!
    const scope = this.config.memoryScope!
    const namespace = this.config.memoryNamespace!

    // Resolve Arrow memory config from profile + explicit overrides
    const resolvedArrowConfig = resolveArrowMemoryConfig(
      this.config.arrowMemory,
      this.config.memoryProfile,
    )

    // If Arrow memory is configured, attempt token-budgeted selection
    if (resolvedArrowConfig) {
      try {
        return await this.loadArrowMemoryContext(memory, namespace, scope, messages, resolvedArrowConfig)
      } catch {
        // Fall through to standard path if Arrow fails
      }
    }

    // Standard (non-Arrow) path: load all records
    const records = await memory.get(namespace, scope)
    return memory.formatForPrompt(records) || null
  }

  /**
   * Arrow-based token-budgeted memory selection.
   *
   * Dynamically imports `@dzipagent/memory-ipc` so `apache-arrow` is never
   * required at install time. If the import fails, the caller catches and
   * falls back to the standard path.
   */
  private async loadArrowMemoryContext(
    memory: NonNullable<DzipAgentConfig['memory']>,
    namespace: string,
    scope: Record<string, string>,
    messages: BaseMessage[],
    arrowCfg: NonNullable<ReturnType<typeof resolveArrowMemoryConfig>>,
  ): Promise<string | null> {
    // Dynamic import keeps @dzipagent/memory-ipc optional at runtime
    const {
      extendMemoryServiceWithArrow,
      selectMemoriesByBudget,
      phaseWeightedSelection,
      FrameReader,
    } = await import('@dzipagent/memory-ipc')

    // Export memory records into an Arrow Table via the extension wrapper
    const arrowExt = extendMemoryServiceWithArrow(
      memory as import('@dzipagent/memory-ipc').MemoryServiceLike,
    )
    const frame = await arrowExt.exportFrame(namespace, scope)

    if (frame.numRows === 0) return null

    const totalBudget = arrowCfg.totalBudget ?? 128_000
    const maxMemoryFraction = arrowCfg.maxMemoryFraction ?? 0.3
    const minResponseReserve = arrowCfg.minResponseReserve ?? 4_000

    // Estimate tokens already consumed by fixed parts of the prompt
    const systemPromptTokens = estimateTokens(this.config.instructions)
    const conversationTokens = this.estimateConversationTokens(messages)

    // Remaining budget available for memory, capped at max fraction
    const remaining = totalBudget - systemPromptTokens - conversationTokens - minResponseReserve
    const memoryBudget = Math.max(0, Math.min(
      Math.floor(remaining),
      Math.floor(totalBudget * maxMemoryFraction),
    ))

    if (memoryBudget <= 0) return null

    // Select records: phase-weighted when a non-general phase is set,
    // otherwise plain composite-score based selection
    const phase = arrowCfg.currentPhase
    const selected = phase && phase !== 'general'
      ? phaseWeightedSelection(frame, phase, memoryBudget)
      : selectMemoriesByBudget(frame, memoryBudget)

    if (selected.length === 0) return null

    // Reconstruct full records from the frame so we can format text
    const reader = new FrameReader(frame)
    const allRecords = reader.toRecords()

    // Format selected records into a readable context block
    const lines: string[] = ['## Memory Context']
    for (const s of selected) {
      const rec = allRecords[s.rowIndex]
      if (!rec) continue

      const ns = rec.meta.namespace || namespace
      const text = rec.value.text ?? JSON.stringify(rec.value)
      lines.push(`- [${ns}] ${text}`)
    }

    return lines.join('\n')
  }

  /** Estimate total tokens consumed by conversation messages. */
  private estimateConversationTokens(messages: BaseMessage[]): number {
    const fullText = messages
      .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
      .join('')
    return estimateTokens(fullText)
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
    const middlewares = this.config.middleware ?? []
    const wrapper = middlewares.find((mw) => typeof mw.wrapModelCall === 'function')
    if (wrapper?.wrapModelCall) {
      return wrapper.wrapModelCall(model, messages, { agentId: this.id })
    }
    return model.invoke(messages)
  }

  /**
   * Run tool result through middleware wrappers in registration order.
   */
  private async transformToolResultWithMiddleware(
    toolName: string,
    input: Record<string, unknown>,
    result: string,
  ): Promise<string> {
    let current = result
    for (const mw of this.config.middleware ?? []) {
      if (!mw.wrapToolCall) continue
      try {
        current = await mw.wrapToolCall(toolName, input, current)
      } catch {
        // Non-fatal middleware failures
      }
    }
    return current
  }
}
