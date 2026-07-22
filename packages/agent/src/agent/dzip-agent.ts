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
 *   - `dzip-agent-run-coordinator.ts` — generate / stream / structured / model-invoke deps
 *   - `dzip-agent-message-context.ts` — prepareMessages / maybeUpdateSummary binders
 *   - `dzip-agent-resolvers.ts` — tool + memory-run resolution
 *   - `streaming-run.ts`       — streaming ReAct loop
 *   - `structured-generate.ts` — `generateStructured` + `extractJsonFromText`
 *   - `daemon-launcher.ts`     — background launch + RunHandle wiring
 *   - `../tools/agent-as-tool.ts` — wrap an agent as a LangChain tool
 *
 * ## Provider fallback semantics (applies to {@link DzupAgent.generate} and
 * {@link DzupAgent.stream})
 *
 * When constructed with a tier-based model (e.g. `model: 'codegen'`), the
 * agent resolves a provider once via `ModelRegistry.getModelWithFallback`;
 * open-circuit providers are skipped at that selection step. The chosen
 * provider is then fixed for the run: per-call success/failure (including
 * native-stream outcomes) is recorded against the same circuit breaker, so
 * breaker state stays consistent across `generate` and `stream` and
 * subsequent constructions skip a degraded provider. Same-run provider
 * retry/failover is a separate opt-in wrapper controlled by
 * `providerFailover`; it retries only per that policy and blocks retry after
 * tool results (and, for streaming, after the first yielded chunk) unless the
 * host declares that phase retry-safe.
 */
import type { ZodType } from "zod";
import type { BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { TokenBucket, ModelTier, Tokenizer } from "@dzupagent/core/llm";
import type { PermissionTier } from "@dzupagent/core/tools";
import type { DistributedRateLimiter } from "../guardrails/distributed-rate-limiter.js";
import type { DistributedCostLedger } from "../guardrails/distributed-budget.js";
import type {
  DzupAgentConfig,
  GenerateOptions,
  GenerateResult,
  AgentStreamEvent,
} from "./agent-types.js";
import type { AgentMailbox } from "../mailbox/types.js";
import { IterationBudget } from "../guardrails/iteration-budget.js";
import { estimateConversationTokensForMessages } from "./message-utils.js";
import type { AgentInstructionResolver } from "./instruction-resolution.js";
import type { AgentMemoryContextLoader } from "./memory-context-loader.js";
import type { AgentMiddlewareRuntime } from "./middleware-runtime.js";
import { installEventBus } from "./event-bus-installer.js";
import type { ConversationSummaryAccessor } from "./message-preparation.js";
import {
  prepareMessages as prepareMessagesRun,
  maybeUpdateSummary as maybeUpdateSummaryRun,
} from "./dzip-agent-message-context.js";
import type { RunHandle, LaunchOptions } from "./run-handle-types.js";
import { launchDaemon } from "./daemon-launcher.js";
import { agentAsTool } from "../tools/agent-as-tool.js";
import { extractJsonFromText } from "./structured-generate.js";
import {
  getTools as getToolsResolver,
  resolveAvailableTools as resolveAvailableToolsResolver,
  resolveMemoryReadContext as resolveMemoryReadContextResolver,
  resolveMemoryRunId as resolveMemoryRunIdResolver,
  type ToolResolutionInput,
} from "./dzip-agent-resolvers.js";
import { maybeWriteBackMemory as maybeWriteBackMemoryFinalizer } from "./agent-finalizers.js";
import { runConsolidation } from "./consolidation-coordinator.js";
import {
  runGenerate as runGenerateRun,
  runStream as runStreamRun,
  runGenerateStructured as runGenerateStructuredRun,
  invokeModelWithMiddleware as invokeModelWithMiddlewareRun,
  type RunGenerateDeps,
} from "./dzip-agent-run-coordinator.js";
import {
  emitToolFilterAudit,
  resolveTokenizer,
  resolveRateLimiter,
  validateConfig,
} from "./agent-construction.js";
import {
  resolveModel,
  getProviderAttempts as getProviderAttemptsHelper,
  shouldRunFailover as shouldRunFailoverHelper,
} from "./provider-selection.js";

// Re-export for backward compatibility — tests and external consumers
// import `extractJsonFromText` from `dzip-agent.js`.
export { extractJsonFromText };

export class DzupAgent {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Per-agent mailbox for inter-agent messaging. Only set when `config.mailbox` is provided. */
  readonly mailbox?: AgentMailbox;
  private readonly config: DzupAgentConfig;
  private readonly resolvedModel: BaseChatModel;
  /** Provider from the registry when tier-based fallback was used; `undefined`
   *  for a concrete model or a model resolved by name (no fallback chain). */
  private readonly resolvedProvider: string | undefined;
  private readonly resolvedTier: ModelTier | undefined;
  private readonly instructionResolver: AgentInstructionResolver;
  private readonly memoryContextLoader: AgentMemoryContextLoader;
  private readonly middlewareRuntime: AgentMiddlewareRuntime;
  private readonly mailboxTools: StructuredToolInterface[];
  private readonly rateLimiter: TokenBucket | undefined;
  private readonly distributedRateLimiter: DistributedRateLimiter | undefined;
  private readonly distributedCostLedger: DistributedCostLedger | undefined;
  private readonly tenantId: string;
  private readonly tokenizer: Tokenizer;
  /** Effective permission tier (MC-AGT-05); `'read-only'` default. Tools of a
   *  more permissive tier are filtered out — see `dzip-agent-resolvers.ts`. */
  private readonly permissionTier: PermissionTier;
  private conversationSummary: string | null = null;
  /** Live cross-agent `asTool` recursion depth for the current run
   *  (AGENT-M-14). Set by {@link generate}, read by {@link asTool}, so nested
   *  `asTool` invocations accumulate depth and are bounded by the ceiling. */
  private currentAgentToolDepth = 0;
  /** Mutable accessor over {@link conversationSummary} for the
   *  `message-preparation` coordinators. Bound once in the constructor. */
  private readonly summaryAccessor: ConversationSummaryAccessor = {
    get: () => this.conversationSummary,
    set: (value) => {
      this.conversationSummary = value;
    },
  };

  constructor(config: DzupAgentConfig) {
    // RF-21 (CODE-09) — guard early so any invalid combination throws before
    // we allocate model / tokenizer / event-bus runtimes.
    validateConfig(config);

    this.id = config.id;
    this.name = config.name ?? config.id;
    this.description = config.description ?? `Agent: ${this.name}`;
    this.config = config;
    const resolved = resolveModel(config);
    this.resolvedModel = resolved.model;
    this.resolvedProvider = resolved.provider;
    this.resolvedTier = resolved.tier;
    this.rateLimiter = resolveRateLimiter(config.rateLimiter);
    this.tenantId = config.memoryScope?.["tenantId"] ?? "default";
    this.tokenizer = resolveTokenizer(config, resolved.model, resolved.tier);

    // RF-21 — wire every event-bus-aware subsystem (mailbox, distributed
    // guardrails, instruction resolver, memory context loader, middleware
    // runtime) in one helper, then bind the resulting bundle to private
    // fields so the constructor body stays under 40 LOC.
    const wiring = installEventBus(
      this.id,
      config,
      this.rateLimiter,
      (messages) =>
        estimateConversationTokensForMessages(messages, this.tokenizer)
    );
    if (wiring.mailbox) this.mailbox = wiring.mailbox;
    this.mailboxTools = wiring.mailboxTools;
    this.distributedRateLimiter = wiring.distributedRateLimiter;
    this.distributedCostLedger = wiring.distributedCostLedger;
    this.instructionResolver = wiring.instructionResolver;
    this.memoryContextLoader = wiring.memoryContextLoader;
    this.middlewareRuntime = wiring.middlewareRuntime;

    // MC-AGT-05 — resolve the effective permission tier and emit the one-shot
    // `agent:tools-filtered` audit event. Filtering itself happens lazily in
    // `getTools()` so middleware-resolved tools are also constrained.
    this.permissionTier = config.permissionTier ?? "read-only";
    emitToolFilterAudit({
      agentId: this.id,
      config,
      permissionTier: this.permissionTier,
      resolved: this.resolveAvailableTools(),
    });
  }

  /**
   * Expose the agent configuration (read-only) so orchestrators can derive
   * new agents with modified settings (e.g. additional tools).
   */
  get agentConfig(): Readonly<DzupAgentConfig> {
    return this.config;
  }

  /**
   * Generate a response from the agent.
   *
   * Runs the full ReAct tool-calling loop with guardrails, context
   * compression, and middleware hooks. See the module header for provider
   * fallback semantics (shared with {@link stream}).
   */
  async generate(
    messages: BaseMessage[],
    options?: GenerateOptions
  ): Promise<GenerateResult> {
    // AGENT-M-14 — record the cross-agent `asTool` depth for this run so the
    // tool produced by `asTool()` can accumulate depth across nested
    // invocations and reject once the ceiling is reached. `generate` calls are
    // strictly nested (await), so we snapshot the enclosing run's depth and
    // restore it once this run completes; that keeps `current()` reflecting the
    // depth of whichever run is presently invoking the wrapped tool.
    const previousAgentToolDepth = this.currentAgentToolDepth;
    this.currentAgentToolDepth = options?._agentToolDepth ?? 0;
    try {
      return await runGenerateRun(
        this.runGenerateDeps(options),
        messages,
        options
      );
    } finally {
      this.currentAgentToolDepth = previousAgentToolDepth;
    }
  }

  private runGenerateDeps(options?: GenerateOptions): RunGenerateDeps {
    return {
      agentId: this.id,
      config: this.config,
      resolvedModel: this.resolvedModel,
      middlewareRuntime: this.middlewareRuntime,
      prepareMessages: (inputMessages) =>
        this.prepareMessages(
          inputMessages,
          this.resolveMemoryReadContext(options)
        ),
      getTools: () => this.getTools(),
      invokeModel: (model, preparedMessages, tools) =>
        this.invokeModelWithMiddleware(model, preparedMessages, tools),
      maybeUpdateSummary: (allMessages, memoryFrame) =>
        this.maybeUpdateSummary(allMessages, memoryFrame),
      resolveMemoryRunId: () => this.resolveMemoryRunId(options),
    };
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
    options?: GenerateOptions
  ): Promise<{ data: T; usage: GenerateResult["usage"] }> {
    return runGenerateStructuredRun(
      {
        agentId: this.id,
        config: this.config,
        resolvedModel: this.resolvedModel,
        prepareMessages: (inputMessages) =>
          this.prepareMessages(
            inputMessages,
            this.resolveMemoryReadContext(options)
          ),
        generate: (msgs, opts) => this.generate(msgs, opts),
      },
      messages,
      schema,
      options
    );
  }

  /**
   * Stream agent events as an async iterator.
   *
   * Yields text chunks, tool calls/results, budget warnings, and done/error
   * events. See the module header for provider fallback semantics (shared with
   * {@link generate}). Thin wrapper over `streaming-run.ts`.
   */
  stream(
    messages: BaseMessage[],
    options?: GenerateOptions
  ): AsyncGenerator<AgentStreamEvent> {
    return runStreamRun(
      {
        agentId: this.id,
        config: this.config,
        resolvedModel: this.resolvedModel,
        resolvedProvider: this.resolvedProvider,
        resolvedTier: this.resolvedTier,
        middlewareRuntime: this.middlewareRuntime,
        getProviderAttempts: (tools) =>
          getProviderAttemptsHelper({
            config: this.config,
            resolvedTier: this.resolvedTier,
            tools,
          }),
        prepareMessages: (inputMessages) =>
          this.prepareMessages(
            inputMessages,
            this.resolveMemoryReadContext(options)
          ),
        getTools: () => this.getTools(),
        invokeModel: (model, preparedMessages) =>
          this.invokeModelWithMiddleware(model, preparedMessages),
        maybeUpdateSummary: (allMessages, memoryFrame) =>
          this.maybeUpdateSummary(allMessages, memoryFrame),
        maybeWriteBackMemory: (content, runId) =>
          maybeWriteBackMemoryFinalizer({
            agentId: this.id,
            ...(runId !== undefined ? { runId } : {}),
            config: this.config,
            content,
          }),
      },
      messages,
      options
    );
  }

  /**
   * Wrap this agent as a LangChain StructuredTool so it can be used as a tool
   * by a parent agent. Thin wrapper over {@link agentAsTool}.
   *
   * AGENT-M-14 — threads a live cross-agent `asTool` depth supplier (reading
   * {@link currentAgentToolDepth}, set by {@link generate}) so nested `asTool`
   * invocations — including self- or mutually-referential pairs — accumulate
   * depth and are rejected once `maxAgentToolDepth` is reached instead of
   * recursing without bound (the subagent `maxSpawnDepth` guard does not cover
   * this in-process path).
   */
  async asTool(options?: {
    maxAgentToolDepth?: number;
  }): Promise<StructuredToolInterface> {
    return agentAsTool({
      id: this.id,
      description: this.description,
      generate: (messages, genOptions) => this.generate(messages, genOptions),
      depth: {
        ...(options?.maxAgentToolDepth !== undefined
          ? { maxAgentToolDepth: options.maxAgentToolDepth }
          : {}),
        current: () => this.currentAgentToolDepth,
      },
    });
  }

  /**
   * Launch an agent run in the background and return a RunHandle immediately.
   *
   * Thin wrapper over {@link launchDaemon} — see `daemon-launcher.ts`.
   */
  async launch(
    messages: BaseMessage[],
    options?: LaunchOptions & { generateOptions?: GenerateOptions }
  ): Promise<RunHandle> {
    return launchDaemon(
      {
        agentId: this.id,
        generate: (msgs, opts) => this.generate(msgs, opts),
      },
      messages,
      options
    );
  }

  /**
   * Fork this agent's budget for a child agent (shared state).
   */
  createChildBudget(): IterationBudget | undefined {
    if (!this.config.guardrails) return undefined;
    const budget = new IterationBudget(this.config.guardrails);
    return budget.fork();
  }

  // ---------- Internal helpers --------------------------------------------------

  private get toolResolutionInput(): ToolResolutionInput {
    return {
      config: this.config,
      middlewareRuntime: this.middlewareRuntime,
      mailboxTools: this.mailboxTools,
      permissionTier: this.permissionTier,
    };
  }

  private getTools(): StructuredToolInterface[] {
    return getToolsResolver(this.toolResolutionInput);
  }

  private resolveAvailableTools(): StructuredToolInterface[] {
    return resolveAvailableToolsResolver(this.toolResolutionInput);
  }

  private async prepareMessages(
    messages: BaseMessage[],
    memoryReadContext?: { runId: string }
  ): Promise<{ messages: BaseMessage[]; memoryFrame?: unknown }> {
    return prepareMessagesRun(
      {
        agentId: this.id,
        config: this.config,
        tokenizer: this.tokenizer,
        instructionResolver: this.instructionResolver,
        memoryContextLoader: this.memoryContextLoader,
        summary: this.summaryAccessor,
      },
      messages,
      memoryReadContext
    );
  }

  private resolveMemoryReadContext(
    options?: GenerateOptions
  ): { runId: string } | undefined {
    return resolveMemoryReadContextResolver(this.config, options);
  }

  private resolveMemoryRunId(options?: GenerateOptions): string | undefined {
    return resolveMemoryRunIdResolver(this.config, options);
  }

  private async maybeUpdateSummary(
    messages: BaseMessage[],
    memoryFrame?: unknown
  ): Promise<void> {
    return maybeUpdateSummaryRun(
      {
        agentId: this.id,
        config: this.config,
        resolvedModel: this.resolvedModel,
        tokenizer: this.tokenizer,
        summary: this.summaryAccessor,
      },
      messages,
      memoryFrame
    );
  }

  /**
   * Dispatch a model call through the middleware runtime (rate-limit gating,
   * breaker accounting, distributed cost recording, and same-run provider
   * failover when enabled). The deps bundle is recomputed per-call so failover
   * policy closes over the current tool-message list and candidate set.
   */
  private async invokeModelWithMiddleware(
    model: BaseChatModel,
    messages: BaseMessage[],
    tools: StructuredToolInterface[] = []
  ): Promise<BaseMessage> {
    return invokeModelWithMiddlewareRun(
      {
        agentId: this.id,
        tenantId: this.tenantId,
        config: this.config,
        resolvedProvider: this.resolvedProvider,
        rateLimiter: this.rateLimiter,
        distributedRateLimiter: this.distributedRateLimiter,
        distributedCostLedger: this.distributedCostLedger,
        middlewareRuntime: this.middlewareRuntime,
        getProviderAttempts: (attemptTools) =>
          getProviderAttemptsHelper({
            config: this.config,
            resolvedTier: this.resolvedTier,
            tools: attemptTools,
          }),
        shouldRunFailover: (err, failoverMessages) =>
          shouldRunFailoverHelper(this.config, err, failoverMessages),
      },
      model,
      messages,
      tools
    );
  }

  /**
   * Manually trigger a consolidation sweep on this agent's memory namespace.
   * Clusters semantically related entries and summarises each cluster into a
   * single record with low-strength children (pruned on the next decay sweep).
   * Safe from any async context. Requires `config.memory` to expose
   * `getStore()`; returns `{ summarized: 0 }` silently when unavailable.
   */
  async consolidate(): Promise<{ summarized: number; summaries: string[] }> {
    return runConsolidation({ agentId: this.id, config: this.config });
  }
}
