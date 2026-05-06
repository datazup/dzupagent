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
  calculateCostCents,
  defaultTokenizerRegistry,
  extractTokenUsage,
  isTransientError,
  TokenBucket,
  type ModelTier,
  type StructuredOutputModelCapabilities,
  type Tokenizer,
} from '@dzupagent/core'
import { DistributedRateLimiter } from '../guardrails/distributed-rate-limiter.js'
import { DistributedCostLedger } from '../guardrails/distributed-budget.js'
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
import type { AgentInstructionResolverConfig } from './instruction-resolution.js'
import { AgentMemoryContextLoader } from './memory-context-loader.js'
import type {
  AgentMemoryContextLoaderConfig,
  ArrowMemoryRuntime,
} from './memory-context-loader.js'
import { AgentMiddlewareRuntime } from './middleware-runtime.js'
import type { AgentMiddlewareRuntimeConfig } from './middleware-runtime.js'
import {
  executeGenerateRun,
  prepareRunState,
  type ExecuteGenerateRunParams,
  type PrepareRunStateParams,
} from './run-engine.js'
import type { RunHandle, LaunchOptions } from './run-handle-types.js'
import { streamRun } from './streaming-run.js'
import { attemptWithFailover } from './provider-failover.js'
import { launchDaemon } from './daemon-launcher.js'
import { agentAsTool } from '../tools/agent-as-tool.js'
import {
  generateStructured as generateStructuredRun,
  extractJsonFromText,
} from './structured-generate.js'
import { maybeWriteBackMemory as maybeWriteBackMemoryFinalizer } from './agent-finalizers.js'
import { ConsolidationEngine } from '@dzupagent/memory'
import type { ConsolidationStore } from '@dzupagent/memory'
import { omitUndefined } from '../utils/exact-optional.js'

// Re-export for backward compatibility — tests and external consumers
// import `extractJsonFromText` from `dzip-agent.js`.
export { extractJsonFromText }

const MODEL_TIERS: Set<string> = new Set(['chat', 'reasoning', 'codegen', 'embedding'])

interface ProviderAttempt {
  provider: string
  modelName: string
  model: BaseChatModel
}

function resolveStructuredOutputCapabilities(
  model: BaseChatModel,
): StructuredOutputModelCapabilities | undefined {
  return (model as BaseChatModel & {
    structuredOutputCapabilities?: StructuredOutputModelCapabilities
  }).structuredOutputCapabilities
}

function resolveRateLimiter(
  config: DzupAgentConfig['rateLimiter'],
): TokenBucket | undefined {
  if (!config) return undefined
  if (config instanceof TokenBucket) return config
  return new TokenBucket(config)
}

/**
 * Resolve a {@link Tokenizer} for the agent (MC-08).
 *
 * Resolution order:
 * 1. Explicit `config.tokenizer` (caller-provided override)
 * 2. `defaultTokenizerRegistry.resolve(modelId)` keyed off the resolved model
 * 3. Heuristic fallback (built into the registry's `resolve()` contract)
 *
 * Never throws — the registry always returns at least a HeuristicTokenizer.
 */
function resolveTokenizer(
  config: DzupAgentConfig,
  resolvedModel: BaseChatModel,
  resolvedTier: ModelTier | undefined,
): Tokenizer {
  if (config.tokenizer) return config.tokenizer
  // Prefer an explicit string model identifier; otherwise inspect the model
  // instance, then fall back to the resolved tier label so the registry can
  // still match generic patterns (e.g. /gpt-/, /claude/).
  const modelHint =
    typeof config.model === 'string'
      ? config.model
      : (resolvedModel as { model?: string; modelName?: string; _modelType?: () => string }).model
        ?? (resolvedModel as { modelName?: string }).modelName
        ?? resolvedTier
        ?? 'unknown'
  return defaultTokenizerRegistry.resolve(modelHint)
}

/**
 * RF-21 — pre-construction validation of the {@link DzupAgentConfig}.
 *
 * Throws on invalid combinations *before* any heavy resources are
 * allocated, so callers see a clear failure mode instead of obscure
 * downstream errors. Currently checks:
 *
 *   - `config.id` must be a non-empty string (other modules key off it).
 *   - When `config.model` is a string, a `config.registry` is required
 *     (the same constraint enforced in `resolveModel`, hoisted earlier
 *     so it fires before tokenizer / event-bus wiring runs).
 *
 * Designed to be cheap and side-effect-free.
 */
function validateConfig(config: DzupAgentConfig): void {
  if (typeof config.id !== 'string' || config.id.length === 0) {
    throw new Error('DzupAgent: config.id must be a non-empty string')
  }
  if (typeof config.model === 'string' && !config.registry) {
    throw new Error(
      `DzupAgent "${config.id}": model is a string ("${config.model}") but no registry was provided`,
    )
  }
}

/**
 * RF-21 — wiring bundle returned by {@link installEventBus}.
 *
 * Each field is `readonly` so the constructor's `readonly` invariants
 * are preserved when assigned: the constructor binds these one-for-one
 * to its private fields. The optional fields (`mailbox`, distributed
 * guardrails) are `undefined` when the corresponding feature was not
 * configured, matching the pre-RF-21 surface exactly.
 */
interface AgentEventBusWiring {
  mailbox: AgentMailbox | undefined
  mailboxTools: StructuredToolInterface[]
  distributedRateLimiter: DistributedRateLimiter | undefined
  distributedCostLedger: DistributedCostLedger | undefined
  instructionResolver: AgentInstructionResolver
  memoryContextLoader: AgentMemoryContextLoader
  middlewareRuntime: AgentMiddlewareRuntime
}

/**
 * RF-21 — wires every event-bus-aware subsystem (mailbox, distributed
 * guardrails MC-07, instruction resolver, memory context loader,
 * middleware runtime) for a freshly-constructed agent.
 *
 * Returns a bundle that the {@link DzupAgent} constructor binds to its
 * private fields. Splitting this out keeps the constructor body under
 * 40 LOC while preserving the original observable wiring (event bus
 * `agent:context_fallback` emissions, structured fallback details,
 * mailbox tool registration order).
 */
function installEventBus(
  agentId: string,
  config: DzupAgentConfig,
  rateLimiter: TokenBucket | undefined,
  estimateConversationTokens: (messages: BaseMessage[]) => number,
): AgentEventBusWiring {
  // --- Distributed guardrails (MC-07) ---
  // Optional Redis-backed rate limit and cost ledger so multi-instance
  // fleets share a single budget. Both are gated on explicit
  // `guardrails.distributed.*` config so the default surface is unchanged.
  const distributed = config.guardrails?.distributed
  const distributedRateLimiter = distributed?.rateLimiter
    ? new DistributedRateLimiter(
        omitUndefined({
          client: distributed.rateLimiter.client,
          windowMs: distributed.rateLimiter.windowMs,
          maxRequests: distributed.rateLimiter.maxRequests,
          keyPrefix: distributed.rateLimiter.keyPrefix,
          fallbackToLocal: distributed.rateLimiter.fallbackToLocal,
        }),
        rateLimiter,
      )
    : undefined
  const distributedCostLedger = distributed?.costLedger
    ? new DistributedCostLedger(
        omitUndefined({
          client: distributed.costLedger.client,
          maxCostUsd: distributed.costLedger.maxCostUsd,
          ttlMs: distributed.costLedger.ttlMs,
          keyPrefix: distributed.costLedger.keyPrefix,
          fallbackToLocal: distributed.costLedger.fallbackToLocal,
        }),
      )
    : undefined

  // --- Mailbox (when configured) ---
  let mailbox: AgentMailbox | undefined
  let mailboxTools: StructuredToolInterface[] = []
  if (config.mailbox) {
    const store = config.mailbox.store ?? new InMemoryMailboxStore()
    const eventBus = config.mailbox.eventBus ?? config.eventBus
    const mailboxImpl = new AgentMailboxImpl(agentId, store, eventBus)
    mailbox = mailboxImpl
    mailboxTools = [
      createSendMailTool({ mailbox: mailboxImpl }),
      createCheckMailTool({ mailbox: mailboxImpl }),
    ]
  }

  // --- Instruction resolver ---
  const instructionResolver = new AgentInstructionResolver(omitUndefined<AgentInstructionResolverConfig>({
    agentId,
    instructions: config.instructions,
    instructionsMode: config.instructionsMode,
    agentsDir: config.agentsDir,
  }))

  // --- Memory context loader (the bulk of event-bus wiring) ---
  // Bridges `onFallback`, `onFallbackDetail`, and the underlying event bus
  // so listeners receive a consistent `agent:context_fallback` event with
  // structured detail (provider, namespace, before/after) regardless of
  // which callback the caller registered.
  const memoryContextLoader = new AgentMemoryContextLoader(omitUndefined<AgentMemoryContextLoaderConfig>({
    instructions: config.instructions,
    memory: config.memory,
    memoryNamespace: config.memoryNamespace,
    memoryScope: config.memoryScope,
    memoryReadContext: config.toolExecution?.runId
      ? { runId: config.toolExecution.runId }
      : undefined,
    arrowMemory: config.arrowMemory,
    memoryProfile: config.memoryProfile,
    frozenSnapshot: config.frozenSnapshot,
    // Inject the Arrow runtime loader (ADR-0005). The dynamic import in
    // memory-context-loader.ts was removed; callers using arrowMemory must
    // pass a loader so the dependency is visible at the call site.
    loadArrowRuntime: config.loadArrowRuntime
      ? config.loadArrowRuntime as () => Promise<ArrowMemoryRuntime>
      : undefined,
    estimateConversationTokens,
    onFallback: config.onFallback
      ? (reason, before, after) => {
          config.onFallback!(reason, before, after)
          config.eventBus?.emit(omitUndefined({
            type: 'agent:context_fallback',
            agentId,
            reason,
            before,
            after,
            provider: 'arrow',
            namespace: config.memoryNamespace,
          }))
        }
      : config.eventBus
        ? (reason, before, after) => {
            config.eventBus!.emit(omitUndefined({
              type: 'agent:context_fallback',
              agentId,
              reason,
              before,
              after,
              provider: 'arrow',
              namespace: config.memoryNamespace,
            }))
          }
        : undefined,
    // Bridge structured detail into eventBus so listeners receive the
    // richer fields (provider, namespace, detail) on the same event type.
    onFallbackDetail: (event) => {
      config.onFallbackDetail?.(event)
      config.eventBus?.emit(omitUndefined({
        type: 'agent:context_fallback',
        agentId,
        reason: event.reason,
        before: event.tokensBefore ?? 0,
        after: event.tokensAfter ?? 0,
        provider: event.provider,
        namespace: event.namespace,
        detail: event.detail,
      }))
    },
  }))

  // --- Middleware runtime ---
  const middlewareRuntime = new AgentMiddlewareRuntime(omitUndefined<AgentMiddlewareRuntimeConfig>({
    agentId,
    middleware: config.middleware,
  }))

  return {
    mailbox,
    mailboxTools,
    distributedRateLimiter,
    distributedCostLedger,
    instructionResolver,
    memoryContextLoader,
    middlewareRuntime,
  }
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
  private readonly resolvedTier: ModelTier | undefined
  private readonly instructionResolver: AgentInstructionResolver
  private readonly memoryContextLoader: AgentMemoryContextLoader
  private readonly middlewareRuntime: AgentMiddlewareRuntime
  private readonly mailboxTools: StructuredToolInterface[]
  private readonly rateLimiter: TokenBucket | undefined
  private readonly distributedRateLimiter: DistributedRateLimiter | undefined
  private readonly distributedCostLedger: DistributedCostLedger | undefined
  private readonly tenantId: string
  private readonly tokenizer: Tokenizer
  private conversationSummary: string | null = null

  constructor(config: DzupAgentConfig) {
    // RF-21 (CODE-09) — guard early so any invalid combination throws before
    // we allocate model / tokenizer / event-bus runtimes.
    validateConfig(config)

    this.id = config.id
    this.name = config.name ?? config.id
    this.description = config.description ?? `Agent: ${this.name}`
    this.config = config
    const resolved = this.resolveModel(config)
    this.resolvedModel = resolved.model
    this.resolvedProvider = resolved.provider
    this.resolvedTier = resolved.tier
    this.rateLimiter = resolveRateLimiter(config.rateLimiter)
    this.tenantId = config.memoryScope?.['tenantId'] ?? 'default'
    this.tokenizer = resolveTokenizer(config, resolved.model, resolved.tier)

    // RF-21 — wire every event-bus-aware subsystem (mailbox, distributed
    // guardrails, instruction resolver, memory context loader, middleware
    // runtime) in one helper, then bind the resulting bundle to private
    // fields so the constructor body stays under 40 LOC.
    const wiring = installEventBus(
      this.id,
      config,
      this.rateLimiter,
      (messages) => this.estimateConversationTokens(messages),
    )
    if (wiring.mailbox) this.mailbox = wiring.mailbox
    this.mailboxTools = wiring.mailboxTools
    this.distributedRateLimiter = wiring.distributedRateLimiter
    this.distributedCostLedger = wiring.distributedCostLedger
    this.instructionResolver = wiring.instructionResolver
    this.memoryContextLoader = wiring.memoryContextLoader
    this.middlewareRuntime = wiring.middlewareRuntime
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
   * ## Provider fallback semantics
   *
   * When constructed with a tier-based model (e.g. `model: 'codegen'`),
   * the agent resolves a provider once via
   * `ModelRegistry.getModelWithFallback`. Open-circuit providers are
   * skipped at that selection step. After that, the chosen provider is
   * fixed for the default path: per-call success/failure is recorded
   * against the same circuit breaker so subsequent agent constructions
   * skip a degraded provider.
   *
   * Same-run provider retry/failover is a separate opt-in wrapper
   * controlled by `providerFailover`. It retries only according to that
   * explicit policy, and it blocks retry after tool results unless the
   * host declares that phase retry-safe.
   *
   * The same model applies to {@link stream}: native streaming records
   * outcomes against the same circuit breaker as `generate`, keeping
   * breaker state consistent across modes.
   */
  async generate(
    messages: BaseMessage[],
    options?: GenerateOptions,
  ): Promise<GenerateResult> {
    const runState = await prepareRunState(omitUndefined<PrepareRunStateParams>({
      config: this.config,
      resolvedModel: this.resolvedModel,
      messages,
      options,
      prepareMessages: (inputMessages) =>
        this.prepareMessages(inputMessages, this.resolveMemoryReadContext(options)),
      getTools: () => this.getTools(),
      bindTools: (model, tools) => this.bindTools(model, tools),
      runBeforeAgentHooks: () => this.runBeforeAgentHooks(),
    }))

    const result = await executeGenerateRun(omitUndefined<ExecuteGenerateRunParams>({
      agentId: this.id,
      config: this.config,
      options,
      runState,
      invokeModel: (model, preparedMessages) =>
        this.invokeModelWithMiddleware(model, preparedMessages, runState.tools),
      transformToolResult: (toolName, input, result) =>
        this.transformToolResultWithMiddleware(toolName, input, result),
      maybeUpdateSummary: (allMessages, memoryFrame) =>
        this.maybeUpdateSummary(allMessages, memoryFrame),
    }))

    if ((result.stopReason as string) !== 'failed') {
      await this.maybeWriteBackMemory(result.content, this.resolveMemoryRunId(options))
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
        prepareMessages: (inputMessages) =>
          this.prepareMessages(inputMessages, this.resolveMemoryReadContext(options)),
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
   * ## Provider fallback semantics
   *
   * Mirrors {@link generate}: the provider is fixed at agent construction
   * via `ModelRegistry.getModelWithFallback` (open-circuit providers are
   * skipped at that selection step). Native streaming success/failure is
   * recorded against the **same** circuit breaker the non-streaming path
   * uses, so breaker state stays consistent between `generate` and
   * `stream`. Same-run stream retry/failover is only attempted when
   * `providerFailover` is enabled, before any stream chunk has been
   * yielded, and before tool results unless the host declares the phase
   * retry-safe.
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
        resolvedTier: this.resolvedTier,
        registry: this.config.registry,
        getProviderAttempts: (tools) => this.getProviderAttempts(tools),
        prepareMessages: (inputMessages) =>
          this.prepareMessages(inputMessages, this.resolveMemoryReadContext(options)),
        getTools: () => this.getTools(),
        bindTools: (model, tools) => this.bindTools(model, tools),
        runBeforeAgentHooks: () => this.runBeforeAgentHooks(),
        invokeModelWithMiddleware: (model, preparedMessages) =>
          this.invokeModelWithMiddleware(model, preparedMessages),
        transformToolResultWithMiddleware: (toolName, input, result) =>
          this.transformToolResultWithMiddleware(toolName, input, result),
        maybeUpdateSummary: (allMessages, memoryFrame) =>
          this.maybeUpdateSummary(allMessages, memoryFrame),
        maybeWriteBackMemory: (content, runId) => this.maybeWriteBackMemory(content, runId),
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
  ): { model: BaseChatModel; provider: string | undefined; tier: ModelTier | undefined } {
    const attachCapabilities = (model: BaseChatModel): BaseChatModel =>
      attachStructuredOutputCapabilities(model, config.structuredOutputCapabilities)

    if (typeof config.model !== 'string') {
      return { model: attachCapabilities(config.model), provider: undefined, tier: undefined }
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
      return { model: attachCapabilities(model), provider, tier: config.model as ModelTier }
    }

    return {
      model: attachCapabilities(config.registry.getModelByName(config.model)),
      provider: undefined,
      tier: undefined,
    }
  }

  private getProviderAttempts(
    tools: StructuredToolInterface[],
  ): ProviderAttempt[] {
    if (
      !this.config.providerFailover?.enabled
      || !this.config.registry
      || !this.resolvedTier
    ) {
      return []
    }

    const maxAttempts = Math.max(1, this.config.providerFailover.maxAttempts ?? 2)
    return this.config.registry
      .getModelFallbackCandidates(this.resolvedTier)
      .slice(0, maxAttempts)
      .map((candidate): ProviderAttempt => ({
        provider: candidate.provider,
        modelName: candidate.modelName,
        model: this.bindTools(
          attachStructuredOutputCapabilities(
            candidate.model,
            this.config.structuredOutputCapabilities,
          ),
          tools,
        ),
      }))
  }

  private hasToolResults(messages: BaseMessage[]): boolean {
    return messages.some(message => message._getType() === 'tool')
  }

  private shouldRunFailover(error: Error, messages: BaseMessage[]): boolean {
    const policy = this.config.providerFailover
    if (!policy?.enabled) return false
    if (this.hasToolResults(messages) && !policy.allowRetryAfterToolResults) {
      return false
    }
    return policy.shouldRetry?.(error) ?? isTransientError(error)
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
    memoryReadContext?: { runId: string },
  ): Promise<{ messages: BaseMessage[]; memoryFrame?: unknown }> {
    const baseInstructions = await this.resolveInstructions()
    const windowedMessages = await this.applyPhaseWindow(messages)

    let memoryContext: string | null = null
    let memoryFrame: unknown = undefined
    if (this.config.memory && this.config.memoryScope && this.config.memoryNamespace) {
      try {
        const result = await this.memoryContextLoader.load(windowedMessages, memoryReadContext)
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

  private resolveMemoryReadContext(options?: GenerateOptions): { runId: string } | undefined {
    const runId = this.resolveMemoryRunId(options)
    return runId ? { runId } : undefined
  }

  private resolveMemoryRunId(options?: GenerateOptions): string | undefined {
    return options?.runId ?? this.config.toolExecution?.runId
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
    return estimateConversationTokensForMessages(messages, this.tokenizer)
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
        omitUndefined({
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
        }),
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

  private async awaitRateLimit(): Promise<void> {
    // Distributed first: when configured, the fleet-wide ceiling owns
    // the gate. A `false` return means the shared window is exhausted;
    // we surface that as a structured event and throw so callers see
    // the same shape as the local TokenBucket failure.
    if (this.distributedRateLimiter) {
      let allowed = true
      try {
        allowed = await this.distributedRateLimiter.tryConsume(this.tenantId, this.id)
      } catch (err) {
        // The limiter handles its own fallback; an exception here only
        // happens when both Redis and the local limiter throw. Treat
        // as fail-open per the distributed-rate-limiter contract.
        this.config.eventBus?.emit({
          type: 'agent:rate_limited',
          agentId: this.id,
          reason: err instanceof Error ? err.message : String(err),
        })
        return
      }
      if (!allowed) {
        const reason = `Distributed rate limit exceeded for ${this.tenantId}:${this.id}`
        this.config.eventBus?.emit({
          type: 'agent:rate_limited',
          agentId: this.id,
          reason,
        })
        throw new Error(reason)
      }
      return
    }

    if (!this.rateLimiter) return
    try {
      await this.rateLimiter.waitUntilAvailable(1)
    } catch (err) {
      // Surface a structured event before propagating so operators can
      // distinguish client-side throttling from provider-side failures.
      this.config.eventBus?.emit({
        type: 'agent:rate_limited',
        agentId: this.id,
        reason: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  /**
   * Record the cost of a successful LLM invocation against the
   * distributed cost ledger (MC-07). Best-effort: failures emit a
   * structured event but never propagate so the agent run continues.
   */
  private async recordDistributedCost(message: BaseMessage): Promise<void> {
    if (!this.distributedCostLedger) return
    try {
      const usage = extractTokenUsage(message)
      const costCents = calculateCostCents(usage)
      const costUsd = costCents / 100
      const result = await this.distributedCostLedger.record(this.tenantId, this.id, costUsd)
      if (!result.allowed) {
        this.config.eventBus?.emit({
          type: 'agent:rate_limited',
          agentId: this.id,
          reason: `Distributed cost ceiling reached for ${this.tenantId}:${this.id} (totalUsd=${result.totalCostUsd})`,
        })
      }
    } catch {
      // Cost recording is observational; never fail the run.
    }
  }

  private async invokeModelWithMiddleware(
    model: BaseChatModel,
    messages: BaseMessage[],
    tools: StructuredToolInterface[] = [],
  ): Promise<BaseMessage> {
    const attempts = this.getProviderAttempts(tools)
    if (attempts.length > 1) {
      return this.invokeModelWithProviderFailover(attempts, messages)
    }

    await this.awaitRateLimit()
    try {
      const result = await this.middlewareRuntime.invokeModel(model, messages)
      // Feed the provider's circuit breaker a success signal. No-op when
      // the agent was constructed with an explicit model (no fallback
      // chain in play).
      if (this.resolvedProvider && this.config.registry) {
        this.config.registry.recordProviderSuccess(this.resolvedProvider)
      }
      await this.recordDistributedCost(result)
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

  private async invokeModelWithProviderFailover(
    attempts: ProviderAttempt[],
    messages: BaseMessage[],
  ): Promise<BaseMessage> {
    return attemptWithFailover<BaseMessage>({
      attempts,
      phase: 'invoke',
      agentId: this.id,
      eventBus: this.config.eventBus,
      registry: this.config.registry,
      shouldRetry: (err) => this.shouldRunFailover(err, messages),
      execute: async (attempt) => {
        await this.awaitRateLimit()
        const result = await this.middlewareRuntime.invokeModel(attempt.model, messages)
        await this.recordDistributedCost(result)
        return result
      },
    })
  }

  private async transformToolResultWithMiddleware(
    toolName: string,
    input: Record<string, unknown>,
    result: string,
  ): Promise<string> {
    return this.middlewareRuntime.transformToolResult(toolName, input, result)
  }

  private async maybeWriteBackMemory(content: string, runId?: string): Promise<void> {
    await maybeWriteBackMemoryFinalizer({
      agentId: this.id,
      ...(runId !== undefined ? { runId } : {}),
      config: this.config,
      content,
    })
  }

  /**
   * Manually trigger a consolidation sweep on this agent's memory namespace.
   *
   * Clusters semantically related entries and summarises each cluster into
   * a single record with low-strength children (pruned on the next decay
   * sweep). Safe to call from any async context; returns a summary of what
   * was consolidated.
   *
   * Requires `config.memory` to expose a `getStore()` method (all
   * {@link MemoryService}-backed instances do). Returns `{ summarized: 0 }`
   * silently when the store is unavailable.
   */
  async consolidate(): Promise<{ summarized: number; summaries: string[] }> {
    const memory = this.config.memory
    const namespace = this.config.memoryNamespace
    const scope = this.config.memoryScope
    if (!memory || !namespace || !scope) return { summarized: 0, summaries: [] }

    const getStore = (memory as { getStore?: () => unknown }).getStore
    if (typeof getStore !== 'function') return { summarized: 0, summaries: [] }

    let store: unknown
    try {
      store = getStore.call(memory)
    } catch {
      return { summarized: 0, summaries: [] }
    }

    const engine = new ConsolidationEngine({
      minClusterSize: this.config.memoryPolicy?.consolidateMinCluster ?? 3,
    })

    try {
      const result = await engine.consolidate(this.id, namespace, store as ConsolidationStore)
      return { summarized: result.summarized, summaries: result.summaries }
    } catch {
      return { summarized: 0, summaries: [] }
    }
  }
}
