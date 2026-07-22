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
import type { ZodType } from "zod";
import type { BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
  TokenBucket,
  ModelTier,
  StructuredOutputModelCapabilities,
  Tokenizer,
} from "@dzupagent/core/llm";
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
import {
  prepareMessages as prepareMessagesCoord,
  maybeUpdateSummary as maybeUpdateSummaryCoord,
  type ConversationSummaryAccessor,
} from "./message-preparation.js";
import {
  executeGenerateRun,
  prepareRunState,
  type ExecuteGenerateRunParams,
  type PrepareRunStateParams,
} from "./run-engine.js";
import type { RunHandle, LaunchOptions } from "./run-handle-types.js";
import { streamRun } from "./streaming-run.js";
import { launchDaemon } from "./daemon-launcher.js";
import { agentAsTool } from "../tools/agent-as-tool.js";
import { filterToolsByTier } from "../tools/tool-tier-registry.js";
import {
  generateStructured as generateStructuredRun,
  extractJsonFromText,
} from "./structured-generate.js";
import { maybeWriteBackMemory as maybeWriteBackMemoryFinalizer } from "./agent-finalizers.js";
import {
  invokeModelWithMiddleware as invokeModelWithMiddlewareCoord,
  transformToolResultWithMiddleware as transformToolResultWithMiddlewareCoord,
  type ModelInvocationDeps,
} from "./model-invocation.js";
import { runConsolidation } from "./consolidation-coordinator.js";
import { omitUndefined } from "../utils/exact-optional.js";
import {
  emitToolFilterAudit,
  resolveTokenizer,
  resolveRateLimiter,
  validateConfig,
} from "./agent-construction.js";
import {
  resolveModel,
  bindTools as bindToolsHelper,
  getProviderAttempts as getProviderAttemptsHelper,
  shouldRunFailover as shouldRunFailoverHelper,
} from "./provider-selection.js";

// Re-export for backward compatibility — tests and external consumers
// import `extractJsonFromText` from `dzip-agent.js`.
export { extractJsonFromText };

function resolveStructuredOutputCapabilities(
  model: BaseChatModel
): StructuredOutputModelCapabilities | undefined {
  return (
    model as BaseChatModel & {
      structuredOutputCapabilities?: StructuredOutputModelCapabilities;
    }
  ).structuredOutputCapabilities;
}

export class DzupAgent {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Per-agent mailbox for inter-agent messaging. Only set when `config.mailbox` is provided. */
  readonly mailbox?: AgentMailbox;
  private readonly config: DzupAgentConfig;
  private readonly resolvedModel: BaseChatModel;
  /** Provider name returned by the registry when tier-based fallback was
   *  used. `undefined` when the caller supplied a concrete model or when
   *  a model was resolved by name (no fallback chain in play). */
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
  /**
   * Effective permission tier for this agent (MC-AGT-05). Resolved from
   * `config.permissionTier` with a `'read-only'` default. Tools tagged
   * with a more permissive tier are filtered out before being passed to
   * the model — see {@link filterToolsByTier}.
   */
  private readonly permissionTier: PermissionTier;
  private conversationSummary: string | null = null;
  /**
   * Live cross-agent `asTool` recursion depth for the current run
   * (AGENT-M-14). Set by {@link generate} from `options._agentToolDepth` and
   * read by the tool produced by {@link asTool} so nested `asTool`
   * invocations (including direct self-reference) accumulate depth and are
   * bounded by the configured ceiling rather than recursing unbounded.
   */
  private currentAgentToolDepth = 0;
  /**
   * Mutable accessor wrapping {@link conversationSummary} so the
   * `message-preparation` coordinators can read / update it without
   * exposing the underlying field. Bound once in the constructor.
   */
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

    // MC-AGT-05 — resolve the effective permission tier and emit the
    // one-shot `agent:tools-filtered` event so operators can audit which
    // tools the model will (or will not) see for this agent. Filtering
    // itself happens lazily inside `getTools()` so middleware-resolved
    // tools are also constrained.
    this.permissionTier = config.permissionTier ?? "read-only";
    emitToolFilterAudit({
      agentId: this.id,
      config,
      permissionTier: this.permissionTier,
      resolved: this.resolveAvailableTools(),
    });
  }

  /**
   * Expose the agent configuration (read-only copy) so orchestrators
   * can derive new agents with modified settings (e.g., additional tools).
   */
  get agentConfig(): Readonly<DzupAgentConfig> {
    return this.config;
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
      return await this.runGenerate(messages, options);
    } finally {
      this.currentAgentToolDepth = previousAgentToolDepth;
    }
  }

  private async runGenerate(
    messages: BaseMessage[],
    options?: GenerateOptions
  ): Promise<GenerateResult> {
    const runState = await prepareRunState(
      omitUndefined<PrepareRunStateParams>({
        config: this.config,
        resolvedModel: this.resolvedModel,
        messages,
        options,
        prepareMessages: (inputMessages) =>
          this.prepareMessages(
            inputMessages,
            this.resolveMemoryReadContext(options)
          ),
        getTools: () => this.getTools(),
        bindTools: bindToolsHelper,
        runBeforeAgentHooks: () => this.middlewareRuntime.runBeforeAgentHooks(),
      })
    );

    const result = await executeGenerateRun(
      omitUndefined<ExecuteGenerateRunParams>({
        agentId: this.id,
        config: this.config,
        options,
        runState,
        invokeModel: (model, preparedMessages) =>
          this.invokeModelWithMiddleware(
            model,
            preparedMessages,
            runState.tools
          ),
        transformToolResult: (toolName, input, result) =>
          transformToolResultWithMiddlewareCoord(
            this.middlewareRuntime,
            toolName,
            input,
            result
          ),
        maybeUpdateSummary: (allMessages, memoryFrame) =>
          this.maybeUpdateSummary(allMessages, memoryFrame),
      })
    );

    if ((result.stopReason as string) !== "failed") {
      await maybeWriteBackMemoryFinalizer({
        agentId: this.id,
        ...(this.resolveMemoryRunId(options) !== undefined
          ? { runId: this.resolveMemoryRunId(options)! }
          : {}),
        config: this.config,
        content: result.content,
      });
    }

    return result;
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
    return generateStructuredRun(
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
        resolveStructuredOutputCapabilities,
      },
      messages,
      schema,
      options
    );
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
    options?: GenerateOptions
  ): AsyncGenerator<AgentStreamEvent> {
    return streamRun(
      {
        agentId: this.id,
        config: this.config,
        resolvedModel: this.resolvedModel,
        resolvedProvider: this.resolvedProvider,
        resolvedTier: this.resolvedTier,
        registry: this.config.registry,
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
        bindTools: bindToolsHelper,
        runBeforeAgentHooks: () => this.middlewareRuntime.runBeforeAgentHooks(),
        invokeModelWithMiddleware: (model, preparedMessages) =>
          this.invokeModelWithMiddleware(model, preparedMessages),
        transformToolResultWithMiddleware: (toolName, input, result) =>
          transformToolResultWithMiddlewareCoord(
            this.middlewareRuntime,
            toolName,
            input,
            result
          ),
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
   * Wrap this agent as a LangChain StructuredTool so it can be used
   * as a tool by a parent agent.
   *
   * Thin wrapper over {@link agentAsTool} — see `tools/agent-as-tool.ts`.
   *
   * AGENT-M-14 — threads a live cross-agent `asTool` depth supplier (reading
   * {@link currentAgentToolDepth}, set by {@link generate} from
   * `options._agentToolDepth`) so that nested `asTool` invocations — including
   * an agent exposed as a tool of itself, or a mutually-referential A↔B pair —
   * accumulate depth and are rejected once `maxAgentToolDepth` is reached
   * instead of recursing without bound. This bounds the in-process `asTool`
   * path, which the subagent-runtime `maxSpawnDepth` guard does not cover.
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

  private getTools(): StructuredToolInterface[] {
    // MC-AGT-05 — apply the permission-tier filter on every read so
    // middleware-resolved tools (added dynamically) are also gated.
    return filterToolsByTier(this.resolveAvailableTools(), this.permissionTier);
  }

  private resolveAvailableTools(): StructuredToolInterface[] {
    const configTools = this.config.tools ?? [];
    return this.middlewareRuntime.resolveTools([
      ...configTools,
      ...this.mailboxTools,
    ]);
  }

  private async prepareMessages(
    messages: BaseMessage[],
    memoryReadContext?: { runId: string }
  ): Promise<{ messages: BaseMessage[]; memoryFrame?: unknown }> {
    return prepareMessagesCoord(
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
    const runId = this.resolveMemoryRunId(options);
    return runId ? { runId } : undefined;
  }

  private resolveMemoryRunId(options?: GenerateOptions): string | undefined {
    return options?.runId ?? this.config.toolExecution?.runId;
  }

  private async maybeUpdateSummary(
    messages: BaseMessage[],
    memoryFrame?: unknown
  ): Promise<void> {
    return maybeUpdateSummaryCoord(
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
   * Dispatch a model call through the middleware runtime, applying
   * rate-limit gating, breaker accounting, distributed cost recording,
   * and same-run provider failover (when enabled). The dependency
   * bundle is recomputed per-call so failover policy closes over the
   * current tool-message list and candidate set.
   */
  private async invokeModelWithMiddleware(
    model: BaseChatModel,
    messages: BaseMessage[],
    tools: StructuredToolInterface[] = []
  ): Promise<BaseMessage> {
    const deps: ModelInvocationDeps = {
      agentId: this.id,
      tenantId: this.tenantId,
      rateLimiter: this.rateLimiter,
      distributedRateLimiter: this.distributedRateLimiter,
      distributedCostLedger: this.distributedCostLedger,
      eventBus: this.config.eventBus,
      middlewareRuntime: this.middlewareRuntime,
      registry: this.config.registry,
      resolvedProvider: this.resolvedProvider,
      getProviderAttempts: () =>
        getProviderAttemptsHelper({
          config: this.config,
          resolvedTier: this.resolvedTier,
          tools,
        }),
      shouldRunFailover: (err) =>
        shouldRunFailoverHelper(this.config, err, messages),
    };
    return invokeModelWithMiddlewareCoord(deps, model, messages);
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
    return runConsolidation({ agentId: this.id, config: this.config });
  }
}
