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
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages'
import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import {
  attachStructuredOutputCapabilities,
  type ModelTier,
  type StructuredOutputModelCapabilities,
  shouldSummarize,
  summarizeAndTrim,
  InMemoryRunJournal,
  attachStructuredOutputErrorContext,
  executeStructuredParseLoop,
  buildStructuredOutputCorrectionPrompt,
  buildStructuredOutputExhaustedError,
  isStructuredOutputExhaustedErrorMessage,
  prepareStructuredOutputSchemaContract,
  resolveStructuredOutputSchemaProvider,
  shouldAttemptNativeStructuredOutput,
  unwrapStructuredEnvelope,
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

function resolveStructuredOutputCapabilities(
  model: BaseChatModel,
): StructuredOutputModelCapabilities | undefined {
  return (model as BaseChatModel & {
    structuredOutputCapabilities?: StructuredOutputModelCapabilities
  }).structuredOutputCapabilities
}

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
      frozenSnapshot: config.frozenSnapshot,
      estimateConversationTokens: (messages) => this.estimateConversationTokens(messages),
      onFallback: config.onFallback
        ? (reason, before, after) => {
            config.onFallback!(reason, before, after)
            config.eventBus?.emit({
              type: 'agent:context_fallback',
              agentId: this.id,
              reason,
              before,
              after,
            })
          }
        : config.eventBus
          ? (reason, before, after) => {
              config.eventBus!.emit({
                type: 'agent:context_fallback',
                agentId: this.id,
                reason,
                before,
                after,
              })
            }
          : undefined,
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

    const result = await executeGenerateRun({
      agentId: this.id,
      config: this.config,
      options,
      runState,
      invokeModel: (model, preparedMessages) =>
        this.invokeModelWithMiddleware(model, preparedMessages),
      transformToolResult: (toolName, input, result) =>
        this.transformToolResultWithMiddleware(toolName, input, result),
      maybeUpdateSummary: (allMessages, memoryFrame) =>
        this.maybeUpdateSummary(allMessages, memoryFrame),
    })

    if ((result.stopReason as string) !== 'failed') {
      await this.maybeWriteBackMemory(result.content)
    }

    return result
  }

  /**
   * Generate a response with structured output validated against a Zod schema.
   *
   * Uses LangChain's withStructuredOutput when the model supports it and the
   * resolved structured-output capability metadata opts into a native strategy;
   * otherwise parses the LLM text response as JSON and validates.
   */
  async generateStructured<T>(
    messages: BaseMessage[],
    schema: ZodType<T>,
    options?: GenerateOptions,
  ): Promise<{ data: T; usage: GenerateResult['usage'] }> {
    const fallbackMaxRetries = 2
    const model = this.resolvedModel
    const structuredOutputCapabilities = resolveStructuredOutputCapabilities(model)
    const schemaProvider = resolveStructuredOutputSchemaProvider(options?.schemaProvider, structuredOutputCapabilities)
    const schemaContract = prepareStructuredOutputSchemaContract(schema, {
      agentId: this.id,
      intent: options?.intent ?? null,
      schemaName: options?.schemaName,
      schemaProvider,
      previewChars: 240,
    })
    const requestMessages = schemaContract.requiresEnvelope
      ? [
          ...messages,
          new SystemMessage('Return the final JSON payload inside the top-level "result" property.'),
        ]
      : messages

    const modelName = (model as BaseChatModel & {
      model?: string
      modelName?: string
      name?: string
    }).model
      ?? (model as BaseChatModel & { modelName?: string }).modelName
      ?? (model as BaseChatModel & { name?: string }).name
      ?? 'unknown'

    this.config.eventBus?.emit({
      type: 'agent:structured_schema_prepared',
      agentId: this.id,
      schemaName: schemaContract.requestSchemaDescriptor.schemaName,
      schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
      provider: schemaContract.requestSchemaDescriptor.provider,
      topLevelType: schemaContract.requestSchemaDescriptor.summary.topLevelType,
      propertyCount: schemaContract.requestSchemaDescriptor.summary.totalProperties,
      requiredCount: schemaContract.requestSchemaDescriptor.summary.totalRequired,
    })

    let nativeStructuredError: Error | null = null

    // Try withStructuredOutput first (Anthropic/OpenAI support this natively)
    if (shouldAttemptNativeStructuredOutput(model, structuredOutputCapabilities)) {
      try {
        const structuredModel = (model as BaseChatModel & {
          withStructuredOutput: (s: ZodType<T>) => BaseChatModel
        }).withStructuredOutput(schemaContract.requestSchema as ZodType<T>)

        const prepared = await this.prepareMessages(requestMessages)
        const response = await structuredModel.invoke(prepared.messages)

        const parsed = schemaContract.responseSchema.parse(response)

        return {
          data: unwrapStructuredEnvelope(parsed, schemaContract.requiresEnvelope),
          usage: { totalInputTokens: 0, totalOutputTokens: 0, llmCalls: 1 },
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        nativeStructuredError = err instanceof Error ? err : new Error(message)

        this.config.eventBus?.emit({
          type: 'agent:structured_native_rejected',
          agentId: this.id,
          schemaName: schemaContract.requestSchemaDescriptor.schemaName,
          schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
          provider: schemaContract.requestSchemaDescriptor.provider,
          model: modelName,
          message,
        })
        this.config.eventBus?.emit({
          type: 'agent:structured_fallback_used',
          agentId: this.id,
          schemaName: schemaContract.requestSchemaDescriptor.schemaName,
          schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
          provider: schemaContract.requestSchemaDescriptor.provider,
          model: modelName,
          from: 'native_provider',
          to: 'text_json',
        })

        console.warn('[DzupAgent.generateStructured] Native structured output failed; falling back to text JSON parsing.', {
          agentId: this.id,
          schemaName: schemaContract.requestSchemaDescriptor.schemaName,
          model: modelName,
          schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
          provider: schemaContract.requestSchemaDescriptor.provider,
          schemaSummary: schemaContract.requestSchemaDescriptor.summary,
          schemaPreview: schemaContract.requestSchemaDescriptor.schemaPreview,
          error: message,
        })

        // Some provider/runtime combinations reject the native structured schema
        // before the model can answer. Fall back to text generation plus local
        // JSON extraction so callers still get a structured result.
      }
    }

    // Fallback: generate text, extract JSON, and retry with a correction prompt.
    try {
      const fallbackResult = await executeStructuredParseLoop({
        initialState: {
          messages: requestMessages,
          usage: emptyGenerateUsage(),
        },
        maxRetries: fallbackMaxRetries,
        invoke: async (state) => {
          const result = await this.generate(state.messages, options)
          return {
            raw: result.content,
            meta: result.usage,
          }
        },
        parse: (raw) => {
          try {
            const jsonStr = extractJsonFromText(raw)
            const parsedJson = JSON.parse(jsonStr) as unknown
            const parsed = schemaContract.responseSchema.safeParse(parsedJson)
            if (parsed.success) {
              return {
                success: true as const,
                data: unwrapStructuredEnvelope(parsed.data, schemaContract.requiresEnvelope),
              }
            }

            const issues = parsed.error.issues
              .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
              .join('; ')

            return {
              success: false as const,
              error: `Schema validation failed: ${issues}`,
            }
          } catch (err) {
            return {
              success: false as const,
              error: err instanceof Error ? err.message : String(err),
            }
          }
        },
        onRetryState: (state, { raw, error, meta }) => ({
          messages: [
            ...state.messages,
            new AIMessage(raw),
            new HumanMessage(buildStructuredOutputCorrectionPrompt({
              schemaName: schemaContract.requestSchemaDescriptor.schemaName,
              schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
              description: 'Respond ONLY with valid JSON.',
            }, error)),
          ],
          usage: mergeGenerateUsage(state.usage, meta),
        }),
      })

      if (!fallbackResult.success) {
        throw new Error(buildStructuredOutputExhaustedError({
          schemaName: schemaContract.requestSchemaDescriptor.schemaName,
          schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
        }, fallbackResult.retries + 1))
      }

      return {
        data: fallbackResult.data as T,
        usage: mergeGenerateUsage(fallbackResult.state.usage, fallbackResult.meta),
      }
    } catch (err) {
      const failureMessage = err instanceof Error ? err.message : String(err)
      const enriched = attachStructuredOutputErrorContext(err, {
        agentId: this.id,
        intent: options?.intent ?? null,
        provider: schemaContract.requestSchemaDescriptor.provider,
        model: modelName,
        failureCategory: isStructuredOutputExhaustedErrorMessage(failureMessage, {
          schemaName: schemaContract.requestSchemaDescriptor.schemaName,
          schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
        })
          ? 'parse_exhausted'
          : 'provider_execution_failed',
        requiresEnvelope: schemaContract.requiresEnvelope,
        messageCount: requestMessages.length,
        requestSchema: schemaContract.requestSchemaDescriptor,
        responseSchema: schemaContract.responseSchemaDescriptor,
      })

      if (nativeStructuredError) {
        Object.assign(enriched, {
          nativeStructuredOutputError: nativeStructuredError.message,
        })
      }

      this.config.eventBus?.emit({
        type: 'agent:structured_validation_failed',
        agentId: this.id,
        schemaName: schemaContract.requestSchemaDescriptor.schemaName,
        schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
        provider: schemaContract.requestSchemaDescriptor.provider,
        model: modelName,
        message: enriched.message,
      })
      throw enriched
    }
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

    // When a tokenLifecyclePlugin is configured, wrap options.onUsage so the
    // plugin receives real LLM token counts. Both GenerateOptions.onUsage and
    // AgentLoopPlugin.onUsage share the same `{ model, inputTokens, outputTokens }`
    // shape, so no adapter transformation is needed — we just forward twice.
    const tokenPlugin = this.config.tokenLifecyclePlugin
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
        agentId: this.id,
        config: this.config,
        options: optionsWithUsage,
        runState,
        invokeModel: (model, preparedMessages) =>
          this.invokeModelWithMiddleware(model, preparedMessages),
        transformToolResult: (toolName, input, result) =>
          this.transformToolResultWithMiddleware(toolName, input, result),
        maybeUpdateSummary: (allMessages, memoryFrame) =>
          this.maybeUpdateSummary(allMessages, memoryFrame),
      })

      if (result.content) {
        yield { type: 'text', data: { content: result.content } }
      }
      if (result.stopReason === 'complete') {
        await this.maybeWriteBackMemory(result.content)
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
      emitStopReasonTelemetry(this.config, this.id, {
        stopReason,
        llmCalls,
        toolStats: toolStats.toArray(),
      })
      await this.maybeUpdateSummary(allMessages, runState.memoryFrame)
      if (stopReason === 'complete') {
        await this.maybeWriteBackMemory(content ?? '')
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
      totalTokens: (result.usage.totalInputTokens ?? 0) + (result.usage.totalOutputTokens ?? 0),
      // Surface the per-run memory frame on the public RunResult so callers
      // can inspect which memory context was attached to this run. Only
      // forward when defined (the field is optional on RunResult).
      ...(result.memoryFrame !== undefined ? { memoryFrame: result.memoryFrame } : {}),
    })
  }

  private resolveModel(config: DzupAgentConfig): BaseChatModel {
    const attachCapabilities = (model: BaseChatModel): BaseChatModel =>
      attachStructuredOutputCapabilities(model, config.structuredOutputCapabilities)

    if (typeof config.model !== 'string') {
      return attachCapabilities(config.model)
    }

    if (!config.registry) {
      throw new Error(
        `DzupAgent "${config.id}": model is a string ("${config.model}") but no registry was provided`,
      )
    }

    if (MODEL_TIERS.has(config.model)) {
      return attachCapabilities(config.registry.getModel(config.model as ModelTier))
    }

    return attachCapabilities(config.registry.getModelByName(config.model))
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

  private async prepareMessages(
    messages: BaseMessage[],
  ): Promise<{ messages: BaseMessage[]; memoryFrame?: unknown }> {
    // Resolve instructions: static or merged with AGENTS.md
    const baseInstructions = await this.resolveInstructions()

    // Apply phase-aware retention windowing when configured.
    // No-op when config.messagePhase is unset.
    const windowedMessages = await this.applyPhaseWindow(messages)

    // Load memory context (Arrow-budgeted or standard)
    let memoryContext: string | null = null
    // Per-run memory frame — threaded explicitly through the run state instead
    // of stored on the agent instance so concurrent generate() calls on the
    // same agent cannot clobber each other's frame reference.
    let memoryFrame: unknown = undefined
    if (this.config.memory && this.config.memoryScope && this.config.memoryNamespace) {
      try {
        const result = await this.memoryContextLoader.load(windowedMessages)
        memoryContext = result.context
        // Gate: only retain frame when Arrow memory is explicitly configured.
        // This keeps the default compression path untouched for non-Arrow agents.
        if (this.config.arrowMemory || this.config.memoryProfile) {
          memoryFrame = result.frame ?? null
        }
      } catch {
        // Memory failures are non-fatal
      }
    }

    // Context compression is handled by maybeUpdateSummary after generation.
    // summarizeAndTrim internally runs prune + repair + split + summarize.
    const preparedMessages = buildPreparedMessages({
      baseInstructions,
      memoryContext,
      conversationSummary: this.conversationSummary,
      messages: windowedMessages,
    })

    return { messages: preparedMessages, memoryFrame }
  }

  /**
   * Apply phase-aware retention windowing to the message list.
   *
   * When `config.messagePhase` is undefined, returns the messages unchanged
   * (zero impact on the default path). Otherwise, uses
   * {@link PhaseAwareWindowManager.findRetentionSplit} to compute a split
   * index and returns only the retained tail portion.
   *
   * The PhaseAwareWindowManager import is dynamic to avoid any circular
   * dependency risk and to keep phase-window code out of the hot path when
   * the feature is disabled.
   */
  private async applyPhaseWindow(messages: BaseMessage[]): Promise<BaseMessage[]> {
    if (!this.config.messagePhase) {
      return messages
    }

    const targetKeep = this.config.messageConfig?.keepRecentMessages ?? 10

    try {
      const { PhaseAwareWindowManager } = await import('@dzupagent/context')
      const manager = new PhaseAwareWindowManager()
      const splitIdx = manager.findRetentionSplit(messages, targetKeep)
      if (splitIdx <= 0) {
        return messages
      }
      return messages.slice(splitIdx)
    } catch {
      // If dynamic import or windowing fails, fall back to the full message list.
      return messages
    }
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

  private async maybeUpdateSummary(
    messages: BaseMessage[],
    memoryFrame?: unknown,
  ): Promise<void> {
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
        {
          ...this.config.messageConfig,
          ...(memoryFrame ? { memoryFrame } : {}),
          onFallback: this.config.onFallback
            ? (reason: string, before: number, after: number) => {
                this.config.onFallback!(reason, before, after)
                this.config.eventBus?.emit({
                  type: 'agent:context_fallback',
                  agentId: this.id,
                  reason,
                  before,
                  after,
                })
              }
            : this.config.eventBus
              ? (reason: string, before: number, after: number) => {
                  this.config.eventBus!.emit({
                    type: 'agent:context_fallback',
                    agentId: this.id,
                    reason,
                    before,
                    after,
                  })
                }
              : undefined,
        },
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

  /**
   * P9 memory write-back. Persists the agent's final response content
   * back to MemoryService after a successful run so memory becomes durable
   * across calls without callers having to do it manually.
   *
   * No-op unless `memory`, `memoryNamespace`, `memoryScope` are all set,
   * `memoryWriteBack !== false`, and `content` is non-empty.  Failures
   * are swallowed — write-back must never throw.
   */
  private async maybeWriteBackMemory(content: string): Promise<void> {
    if (
      this.config.memoryWriteBack === false ||
      !this.config.memory ||
      !this.config.memoryNamespace ||
      !this.config.memoryScope ||
      !content
    ) return
    try {
      const now = Date.now()
      const key = now.toString()
      await this.config.memory.put(
        this.config.memoryNamespace,
        this.config.memoryScope,
        key,
        {
          text: content,
          agentId: this.id,
          timestamp: now,
          ...(this.config.ttlMs !== undefined
            ? { expiresAt: now + this.config.ttlMs }
            : {}),
        },
      )
    } catch {
      // write-back failures are non-fatal
    }
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

function emptyGenerateUsage(): GenerateResult['usage'] {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    llmCalls: 0,
  }
}

function mergeGenerateUsage(
  left: GenerateResult['usage'],
  right: GenerateResult['usage'],
): GenerateResult['usage'] {
  return {
    totalInputTokens: left.totalInputTokens + right.totalInputTokens,
    totalOutputTokens: left.totalOutputTokens + right.totalOutputTokens,
    llmCalls: left.llmCalls + right.llmCalls,
  }
}
