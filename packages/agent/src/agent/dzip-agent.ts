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
 *
 * Non-core concerns live in dedicated modules so this class stays small:
 *   - `streaming-run.ts`       — streaming ReAct loop
 *   - `structured-generate.ts` — `generateStructured` + `extractJsonFromText`
 *   - `daemon-launcher.ts`     — background launch + RunHandle wiring
 *   - `../tools/agent-as-tool.ts` — wrap an agent as a LangChain tool
 */
import type { ZodType } from 'zod'
import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import {
  attachStructuredOutputCapabilities,
  type ModelTier,
  type StructuredOutputModelCapabilities,
} from '@dzupagent/core'
import { shouldSummarize, summarizeAndTrim } from '@dzupagent/context'
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
  executeGenerateRun,
  prepareRunState,
} from './run-engine.js'
import type { RunHandle, LaunchOptions } from './run-handle-types.js'
import { streamRun } from './streaming-run.js'
import { launchDaemon } from './daemon-launcher.js'
import { agentAsTool } from '../tools/agent-as-tool.js'
import {
  generateStructured as generateStructuredRun,
  extractJsonFromText,
} from './structured-generate.js'

// Re-export for backward compatibility — tests and external consumers
// import `extractJsonFromText` from `dzip-agent.js`.
export { extractJsonFromText }

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
  /** Provider name returned by the registry when tier-based fallback was
   *  used. `undefined` when the caller supplied a concrete model or when
   *  a model was resolved by name (no fallback chain in play). */
  private readonly resolvedProvider: string | undefined
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
    const resolved = this.resolveModel(config)
    this.resolvedModel = resolved.model
    this.resolvedProvider = resolved.provider

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
              provider: 'arrow',
              namespace: config.memoryNamespace,
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
                provider: 'arrow',
                namespace: config.memoryNamespace,
              })
            }
          : undefined,
      // Bridge structured detail into eventBus so listeners receive the
      // richer fields (provider, namespace, detail) on the same event type.
      onFallbackDetail: (event) => {
        config.onFallbackDetail?.(event)
        config.eventBus?.emit({
          type: 'agent:context_fallback',
          agentId: this.id,
          reason: event.reason,
          before: event.tokensBefore ?? 0,
          after: event.tokensAfter ?? 0,
          provider: event.provider,
          namespace: event.namespace,
          detail: event.detail,
        })
      },
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
   *
   * ## Provider fallback semantics — selection-time only
   *
   * When constructed with a tier-based model (e.g. `model: 'codegen'`),
   * the agent resolves a provider once via
   * `ModelRegistry.getModelWithFallback`. Open-circuit providers are
   * skipped at that selection step. After that, the chosen provider is
   * fixed for the lifetime of the agent: per-call success/failure is
   * recorded against the same circuit breaker (so subsequent agent
   * constructions skip a degraded provider), but **the agent does not
   * switch providers mid-run on a transient failure**. Same-run failover
   * is intentionally out of scope; if your application needs it, build a
   * higher-level retry/orchestration layer that constructs a fresh agent
   * after a failure.
   *
   * The same model applies to {@link stream}: native streaming records
   * outcomes against the same circuit breaker as `generate`, keeping
   * breaker state consistent across modes.
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
   * Thin wrapper over {@link generateStructuredRun} — see
   * `structured-generate.ts`.
   */
  async generateStructured<T>(
    messages: BaseMessage[],
    schema: ZodType<T>,
    options?: GenerateOptions,
  ): Promise<{ data: T; usage: GenerateResult['usage'] }> {
    return generateStructuredRun(
      {
        agentId: this.id,
        config: this.config,
        resolvedModel: this.resolvedModel,
        prepareMessages: (inputMessages) => this.prepareMessages(inputMessages),
        generate: (msgs, opts) => this.generate(msgs, opts),
        resolveStructuredOutputCapabilities,
      },
      messages,
      schema,
      options,
    )
  }

  /**
   * Stream agent events as an async iterator.
   *
   * Yields text chunks, tool calls/results, budget warnings, and done/error events.
   *
   * ## Provider fallback semantics — selection-time only
   *
   * Mirrors {@link generate}: the provider is fixed at agent construction
   * via `ModelRegistry.getModelWithFallback` (open-circuit providers are
   * skipped at that selection step). Native streaming success/failure is
   * recorded against the **same** circuit breaker the non-streaming path
   * uses, so breaker state stays consistent between `generate` and
   * `stream`. There is no same-run provider failover — a transient
   * stream failure surfaces to the caller; it does not transparently
   * retry against another provider.
   *
   * Thin wrapper over {@link streamRun} — see `streaming-run.ts`.
   */
  stream(
    messages: BaseMessage[],
    options?: GenerateOptions,
  ): AsyncGenerator<AgentStreamEvent> {
    return streamRun(
      {
        agentId: this.id,
        config: this.config,
        resolvedModel: this.resolvedModel,
        resolvedProvider: this.resolvedProvider,
        registry: this.config.registry,
        prepareMessages: (inputMessages) => this.prepareMessages(inputMessages),
        getTools: () => this.getTools(),
        bindTools: (model, tools) => this.bindTools(model, tools),
        runBeforeAgentHooks: () => this.runBeforeAgentHooks(),
        invokeModelWithMiddleware: (model, preparedMessages) =>
          this.invokeModelWithMiddleware(model, preparedMessages),
        transformToolResultWithMiddleware: (toolName, input, result) =>
          this.transformToolResultWithMiddleware(toolName, input, result),
        maybeUpdateSummary: (allMessages, memoryFrame) =>
          this.maybeUpdateSummary(allMessages, memoryFrame),
        maybeWriteBackMemory: (content) => this.maybeWriteBackMemory(content),
      },
      messages,
      options,
    )
  }

  /**
   * Wrap this agent as a LangChain StructuredTool so it can be used
   * as a tool by a parent agent.
   *
   * Thin wrapper over {@link agentAsTool} — see `tools/agent-as-tool.ts`.
   */
  async asTool(): Promise<StructuredToolInterface> {
    return agentAsTool({
      id: this.id,
      description: this.description,
      generate: (messages, options) => this.generate(messages, options),
    })
  }

  /**
   * Launch an agent run in the background and return a RunHandle immediately.
   *
   * Thin wrapper over {@link launchDaemon} — see `daemon-launcher.ts`.
   */
  async launch(
    messages: BaseMessage[],
    options?: LaunchOptions & { generateOptions?: GenerateOptions },
  ): Promise<RunHandle> {
    return launchDaemon(
      {
        agentId: this.id,
        generate: (msgs, opts) => this.generate(msgs, opts),
      },
      messages,
      options,
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

  /**
   * Resolve the model for this agent. For tier-based lookups this uses
   * `registry.getModelWithFallback()` so providers with open circuits are
   * skipped; returns the chosen provider alongside the model so the
   * invocation path can feed success/failure signals back to the breaker.
   *
   * Returns `{ model, provider: undefined }` when an explicit model instance
   * or a model-by-name is used (no fallback chain applies).
   */
  private resolveModel(
    config: DzupAgentConfig,
  ): { model: BaseChatModel; provider: string | undefined } {
    const attachCapabilities = (model: BaseChatModel): BaseChatModel =>
      attachStructuredOutputCapabilities(model, config.structuredOutputCapabilities)

    if (typeof config.model !== 'string') {
      return { model: attachCapabilities(config.model), provider: undefined }
    }

    if (!config.registry) {
      throw new Error(
        `DzupAgent "${config.id}": model is a string ("${config.model}") but no registry was provided`,
      )
    }

    if (MODEL_TIERS.has(config.model)) {
      const { model, provider } = config.registry.getModelWithFallback(
        config.model as ModelTier,
      )
      return { model: attachCapabilities(model), provider }
    }

    return {
      model: attachCapabilities(config.registry.getModelByName(config.model)),
      provider: undefined,
    }
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
    const baseInstructions = await this.resolveInstructions()
    const windowedMessages = await this.applyPhaseWindow(messages)

    let memoryContext: string | null = null
    let memoryFrame: unknown = undefined
    if (this.config.memory && this.config.memoryScope && this.config.memoryNamespace) {
      try {
        const result = await this.memoryContextLoader.load(windowedMessages)
        memoryContext = result.context
        if (this.config.arrowMemory || this.config.memoryProfile) {
          memoryFrame = result.frame ?? null
        }
      } catch (err) {
        // Memory failures are non-fatal; emit structured event so operators can
        // distinguish "no memory configured" from "memory unavailable".
        const detail = err instanceof Error ? err.message : String(err)
        const tokensBefore = this.estimateConversationTokens(windowedMessages)
        const provider = this.describeMemoryProvider()
        const namespace = this.config.memoryNamespace ?? 'unknown'
        this.config.onFallback?.('memory_load_failure', tokensBefore, 0)
        this.config.onFallbackDetail?.({
          reason: 'memory_load_failure',
          detail,
          namespace,
          provider,
          tokensBefore,
          tokensAfter: 0,
        })
        this.config.eventBus?.emit({
          type: 'agent:context_fallback',
          agentId: this.id,
          reason: 'memory_load_failure',
          before: tokensBefore,
          after: 0,
          provider,
          namespace,
          detail,
        })
      }
    }

    const preparedMessages = buildPreparedMessages({
      baseInstructions,
      memoryContext,
      conversationSummary: this.conversationSummary,
      messages: windowedMessages,
    })

    return { messages: preparedMessages, memoryFrame }
  }

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
      return messages
    }
  }

  private async resolveInstructions(): Promise<string> {
    return this.instructionResolver.resolve()
  }

  private estimateConversationTokens(messages: BaseMessage[]): number {
    return estimateConversationTokensForMessages(messages)
  }

  private async maybeUpdateSummary(
    messages: BaseMessage[],
    memoryFrame?: unknown,
  ): Promise<void> {
    if (!shouldSummarize(messages, this.config.messageConfig)) return

    try {
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
    } catch (err) {
      // Summarization failures are non-fatal; emit event so operators can
      // distinguish absence from failure.
      const detail = err instanceof Error ? err.message : String(err)
      const tokensBefore = this.estimateConversationTokens(messages)
      const namespace = this.config.memoryNamespace ?? 'unknown'
      this.config.onFallback?.('summary_failure', tokensBefore, tokensBefore)
      this.config.onFallbackDetail?.({
        reason: 'summary_failure',
        detail,
        namespace,
        provider: 'summary',
        tokensBefore,
        tokensAfter: tokensBefore,
      })
      this.config.eventBus?.emit({
        type: 'agent:context_fallback',
        agentId: this.id,
        reason: 'summary_failure',
        before: tokensBefore,
        after: tokensBefore,
        provider: 'summary',
        namespace,
        detail,
      })
    }
  }

  /**
   * Return a non-leaking provider label for memory telemetry.
   *
   * Uses the memory service's constructor name when available so operators
   * can distinguish between e.g. `MemoryService`, `ScopedMemoryService`, and
   * custom providers without exposing the underlying instance.
   */
  private describeMemoryProvider(): string {
    const memory = this.config.memory
    if (!memory) return 'none'
    const ctor = (memory as { constructor?: { name?: string } }).constructor
    return ctor?.name && ctor.name !== 'Object' ? ctor.name : 'standard'
  }

  private async runBeforeAgentHooks(): Promise<void> {
    await this.middlewareRuntime.runBeforeAgentHooks()
  }

  private async invokeModelWithMiddleware(
    model: BaseChatModel,
    messages: BaseMessage[],
  ): Promise<BaseMessage> {
    try {
      const result = await this.middlewareRuntime.invokeModel(model, messages)
      // Feed the provider's circuit breaker a success signal. No-op when
      // the agent was constructed with an explicit model (no fallback
      // chain in play).
      if (this.resolvedProvider && this.config.registry) {
        this.config.registry.recordProviderSuccess(this.resolvedProvider)
      }
      return result
    } catch (err) {
      if (this.resolvedProvider && this.config.registry) {
        const asError = err instanceof Error ? err : new Error(String(err))
        // Registry filters to transient errors internally, so unconditional
        // is safe.
        this.config.registry.recordProviderFailure(this.resolvedProvider, asError)
      }
      throw err
    }
  }

  private async transformToolResultWithMiddleware(
    toolName: string,
    input: Record<string, unknown>,
    result: string,
  ): Promise<string> {
    return this.middlewareRuntime.transformToolResult(toolName, input, result)
  }

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
