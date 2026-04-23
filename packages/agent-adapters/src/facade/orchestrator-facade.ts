/**
 * OrchestratorFacade -- high-level builder-pattern API that simplifies
 * using all orchestration patterns with a single entrypoint.
 *
 * Internally wires up ProviderAdapterRegistry, EventBusBridge, CostTrackingMiddleware,
 * and SessionRegistry, then delegates to the appropriate orchestrator for
 * each pattern (supervisor, parallel, map-reduce, contract-net).
 *
 * @example
 * ```ts
 * const orchestrator = createOrchestrator({
 *   adapters: [new ClaudeAgentAdapter(), new CodexAdapter(), new GeminiCLIAdapter()],
 * })
 *
 * // Simple run with automatic routing
 * const result = await orchestrator.run('Fix the failing test')
 *
 * // Supervisor pattern
 * const supervised = await orchestrator.supervisor('Review PR #42 for security and correctness')
 *
 * // Parallel race
 * const fastest = await orchestrator.race('Fix the failing test', ['claude', 'codex'])
 * ```
 */

import { createEventBus, ForgeError } from '@dzupagent/core'
import type { CircuitBreakerConfig, DzupEvent, DzupEventBus } from '@dzupagent/core'

import { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import { EventBusBridge } from '../registry/event-bus-bridge.js'
import {
  CostTrackingMiddleware,
  type CostTrackingConfig,
  type CostReport,
} from '../middleware/cost-tracking.js'
import {
  SessionRegistry,
  type MultiTurnOptions,
} from '../session/session-registry.js'
import {
  SupervisorOrchestrator,
  type SupervisorOptions as BaseSupervisorOptions,
  type SupervisorResult,
  type TaskDecomposer,
} from '../orchestration/supervisor.js'
import {
  ParallelExecutor,
  type ParallelExecutionOptions,
  type ParallelExecutionResult,
  type ProviderResult,
  type MergeStrategy,
} from '../orchestration/parallel-executor.js'
import {
  MapReduceOrchestrator,
  type MapReduceOptions,
  type MapReduceResult,
} from '../orchestration/map-reduce.js'
import {
  ContractNetOrchestrator,
  type ContractNetResult,
  type BidStrategy,
  type BidSelectionCriteria,
} from '../orchestration/contract-net.js'
import { withMemoryEnrichment } from '../middleware/memory-enrichment.js'
import type { MemoryEnrichmentOptions } from '../middleware/memory-enrichment.js'
import { compilePolicyForProvider } from '../policy/policy-compiler.js'
import type { AdapterPolicy, CompiledPolicyOverrides } from '../policy/policy-compiler.js'
import { PolicyConformanceChecker } from '../policy/policy-conformance.js'
import type { AdapterApprovalGate, ApprovalContext } from '../approval/adapter-approval.js'
import type { AdapterGuardrails } from '../guardrails/adapter-guardrails.js'
import { WorkspaceResolver } from '../dzupagent/workspace-resolver.js'
import { loadDzupAgentConfig } from '../dzupagent/config.js'
import { EnrichmentPipeline } from '../enrichment/enrichment-pipeline.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentCompletedEvent,
  AgentEvent,
  AgentStreamEvent,
  AgentInput,
  DzupAgentPaths,
  TaskDescriptor,
  TaskRoutingStrategy,
  TokenUsage,
} from '../types.js'
import { resolveFallbackProviderId } from '../utils/provider-helpers.js'

function resolveRunFallbackProviderId(
  registry: { listAdapters(): AdapterProviderId[] },
  preferredProvider?: AdapterProviderId,
  lastFailureProviderId?: AdapterProviderId,
): AdapterProviderId {
  return lastFailureProviderId
    ?? preferredProvider
    ?? resolveFallbackProviderId(registry.listAdapters())
    ?? ('unknown' as AdapterProviderId)
}

function isProviderRawStreamEvent(
  event: AgentStreamEvent,
): event is Extract<AgentStreamEvent, { type: 'adapter:provider_raw' }> {
  return event.type === 'adapter:provider_raw'
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  /** Adapters to register */
  adapters: AgentCLIAdapter[]
  /** Event bus (optional, creates one if not provided) */
  eventBus?: DzupEventBus | undefined
  /** Routing strategy. Default: TagBasedRouter */
  router?: TaskRoutingStrategy | undefined
  /** Enable cost tracking. Default true */
  enableCostTracking?: boolean | undefined
  /** Cost tracking config */
  costTrackingConfig?: CostTrackingConfig | undefined
  /** Circuit breaker config */
  circuitBreakerConfig?: Partial<CircuitBreakerConfig> | undefined
  /** Optional approval gate for human-in-the-loop approval before execution. */
  approvalGate?: AdapterApprovalGate | undefined
  /** Optional guardrails for budget/stuck/tool enforcement on event streams. */
  guardrails?: AdapterGuardrails | undefined
  /** Default policy applied to all runs unless overridden per-run. */
  defaultPolicy?: AdapterPolicy | undefined
  /** When provided, all adapters are auto-wrapped with withMemoryEnrichment */
  memoryEnrichment?: MemoryEnrichmentOptions | undefined
  /**
   * Unified Capability Layer — when provided, skills and memory from the
   * `.dzupagent/` directory tree are automatically loaded and injected into
   * every `run()` call.
   */
  dzupagent?: {
    /** Project root for .dzupagent/ resolution. Defaults to process.cwd() */
    projectRoot?: string | undefined
    /** Skip memory injection entirely */
    skipMemory?: boolean | undefined
    /** Skip skill injection entirely */
    skipSkills?: boolean | undefined
  } | undefined
}

// ---------------------------------------------------------------------------
// Simplified options interfaces
// ---------------------------------------------------------------------------

export interface RunOptions {
  tags?: string[] | undefined
  preferredProvider?: AdapterProviderId | undefined
  signal?: AbortSignal | undefined
  workingDirectory?: string | undefined
  systemPrompt?: string | undefined
  maxTurns?: number | undefined
  /** When true and an approvalGate is configured, requires approval before execution. */
  requireApproval?: boolean | undefined
  /** Approval context metadata forwarded to the approval gate. */
  approvalRunId?: string | undefined
  /** Per-run policy (overrides default policy if set). */
  policy?: AdapterPolicy | undefined
  /**
   * Persona ID to apply to this run. Resolved by the caller (app layer)
   * into a system prompt before invocation. Stored for observability.
   */
  personaId?: string | undefined
  /**
   * Parent run ID for hierarchical orchestration tracking.
   * Set by sub-orchestrators spawned from a parent run.
   */
  parentRunId?: string | undefined
  /**
   * Branch identifier within a parallel/conditional execution tree.
   */
  branchId?: string | undefined
  /**
   * Current depth in the orchestration hierarchy. Root = 0.
   * Used to enforce max-depth limits in sub-orchestrators.
   */
  depth?: number | undefined
}

export interface RunResult {
  result: string
  providerId: AdapterProviderId
  durationMs: number
  usage?: TokenUsage | undefined
  cancelled?: true | undefined
  error?: string | undefined
}

export interface FacadeSupervisorOptions extends Omit<BaseSupervisorOptions, never> {
  /** Custom task decomposer */
  decomposer?: TaskDecomposer | undefined
  /** Maximum concurrent delegations */
  maxConcurrentDelegations?: number | undefined
}

export interface ParallelOptions extends Omit<ParallelExecutionOptions, 'providers'> {
  providers?: AdapterProviderId[] | undefined
}

export interface ContractNetFacadeOptions {
  selectionCriteria?: BidSelectionCriteria | undefined
  signal?: AbortSignal | undefined
  bidStrategy?: BidStrategy | undefined
  bidTimeoutMs?: number | undefined
}

export interface ChatOptions {
  /** Resume existing workflow or create new */
  workflowId?: string | undefined
  provider?: AdapterProviderId | undefined
  /** Default true */
  includeHistory?: boolean | undefined
  workingDirectory?: string | undefined
  systemPrompt?: string | undefined
  /** Maximum turns / iterations */
  maxTurns?: number | undefined
  /** Sampling temperature (0-1) */
  temperature?: number | undefined
  /** Maximum output tokens */
  maxTokens?: number | undefined
  /** Top-p nucleus sampling */
  topP?: number | undefined
  /** Per-turn adapter timeout override (milliseconds) */
  timeoutMs?: number | undefined
  /** When true and an approvalGate is configured, requires approval before execution. */
  requireApproval?: boolean | undefined
  /** Approval context metadata forwarded to the approval gate. */
  approvalRunId?: string | undefined
  /** Per-turn policy (overrides default policy if set). */
  policy?: AdapterPolicy | undefined
}

export interface InteractionResponseOptions {
  workflowId: string
  provider?: AdapterProviderId | undefined
}

// ---------------------------------------------------------------------------
// OrchestratorFacade
// ---------------------------------------------------------------------------

/**
 * High-level orchestration facade.
 *
 * Provides a single entrypoint for all orchestration patterns with
 * automatic wiring of registry, event bus, cost tracking, and session management.
 */
export class OrchestratorFacade {
  private readonly _registry: ProviderAdapterRegistry
  private readonly _eventBus: DzupEventBus
  private readonly _bridge: EventBusBridge
  private readonly _costTracking: CostTrackingMiddleware | undefined
  private readonly _approvalGate: AdapterApprovalGate | undefined
  private readonly _guardrails: AdapterGuardrails | undefined
  private readonly _conformanceChecker: PolicyConformanceChecker
  private readonly _defaultPolicy: AdapterPolicy | undefined
  private readonly _sessions: SessionRegistry
  private readonly _dzupagentConfig: NonNullable<OrchestratorConfig['dzupagent']> | undefined
  /** Cached resolved paths — lazily populated on first run() when dzupagent is configured. */
  private _resolvedPaths: DzupAgentPaths | undefined
  private _isShutdown = false

  constructor(config: OrchestratorConfig) {
    const eventBus = config.eventBus ?? createEventBus()
    this._eventBus = eventBus

    // Build registry with circuit breaker config and event bus
    this._registry = new ProviderAdapterRegistry(
      config.circuitBreakerConfig
        ? { circuitBreaker: config.circuitBreakerConfig }
        : undefined,
    )
    this._registry.setEventBus(eventBus)

    if (config.router) {
      this._registry.setRouter(config.router)
    }

    // Optionally wrap adapters with memory enrichment
    const adaptersToRegister = config.memoryEnrichment
      ? config.adapters.map(a => withMemoryEnrichment(a, config.memoryEnrichment!))
      : config.adapters

    // Register all adapters
    for (const adapter of adaptersToRegister) {
      this._registry.register(adapter)
    }

    // Event bus bridge for translating adapter events
    this._bridge = new EventBusBridge(eventBus)

    // Cost tracking (enabled by default)
    const enableCost = config.enableCostTracking ?? true
    if (enableCost) {
      this._costTracking = new CostTrackingMiddleware({
        eventBus,
        ...config.costTrackingConfig,
      })
    }

    // Approval gate (optional)
    this._approvalGate = config.approvalGate

    // Guardrails (optional)
    this._guardrails = config.guardrails

    // Policy conformance checker
    this._conformanceChecker = new PolicyConformanceChecker()
    this._defaultPolicy = config.defaultPolicy

    // Session registry
    this._sessions = new SessionRegistry({ eventBus })

    // Unified Capability Layer config (optional)
    this._dzupagentConfig = config.dzupagent ?? undefined
  }

  // -------------------------------------------------------------------------
  // Public accessors
  // -------------------------------------------------------------------------

  /** Access the underlying adapter registry */
  get registry(): ProviderAdapterRegistry {
    return this._registry
  }

  /** Access cost tracking (if enabled) */
  get costTracking(): CostTrackingMiddleware | undefined {
    return this._costTracking
  }

  /** Access session registry */
  get sessions(): SessionRegistry {
    return this._sessions
  }

  private applyPostStreamWrappers<T extends AgentStreamEvent>(
    eventStream: AsyncGenerator<T, void, undefined>,
  ): AsyncGenerator<T, void, undefined> {
    let wrapped = eventStream

    if (this._costTracking) {
      wrapped = this._costTracking.wrap(wrapped) as AsyncGenerator<T, void, undefined>
    }

    if (this._guardrails) {
      wrapped = this._guardrails.wrap(wrapped) as AsyncGenerator<T, void, undefined>
    }

    return wrapped
  }

  private applyPolicyOverrides(
    input: AgentInput,
    preferredProvider: AdapterProviderId | undefined,
    activePolicy: AdapterPolicy | undefined,
  ): void {
    if (!activePolicy) return

    const targetProvider = preferredProvider ?? this._registry.listAdapters()[0]
    if (!targetProvider) return

    const compiled = this.compilePolicyWithConformance(targetProvider, activePolicy)
    const adapter = this._registry.get(targetProvider)
    if (adapter) {
      adapter.configure(compiled.config)
    }
    if (Object.keys(compiled.inputOptions).length > 0) {
      input.options = { ...input.options, ...compiled.inputOptions }
    }
    if (compiled.guardrails.maxIterations !== undefined && input.maxTurns === undefined) {
      input.maxTurns = compiled.guardrails.maxIterations
    }
  }

  private buildApprovalContext(
    prompt: string,
    providerId: AdapterProviderId | undefined,
    approvalRunId: string | undefined,
    tags?: string[] | undefined,
  ): ApprovalContext {
    return {
      runId: approvalRunId ?? crypto.randomUUID(),
      description: prompt.slice(0, 200),
      providerId: providerId ?? ('auto' as AdapterProviderId),
      tags,
    }
  }

  // -------------------------------------------------------------------------
  // run() — simplest API
  // -------------------------------------------------------------------------

  /** Default timeout for run() — 3 minutes. Adapters should have their own shorter timeouts. */
  private static readonly RUN_TIMEOUT_MS = 180_000

  /**
   * Run a task with automatic routing and fallback.
   * Simplest API -- just provide a prompt.
   *
   * Enforces a hard timeout (RUN_TIMEOUT_MS) so the call never hangs
   * even if the underlying adapter stream stalls.
   */
  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    this.assertNotShutdown('run')
    const startMs = Date.now()

    // Ensure run() always has a timeout signal so it never hangs
    const timeoutMs = OrchestratorFacade.RUN_TIMEOUT_MS
    const timeoutController = new AbortController()
    const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs)

    // Merge caller's signal with our timeout signal using AbortSignal.any when available,
    // falling back to manual listener wiring with cleanup.
    let effectiveSignal: AbortSignal
    let cleanupSignalListeners: (() => void) | undefined
    if (options?.signal) {
      if (typeof AbortSignal.any === 'function') {
        effectiveSignal = AbortSignal.any([options.signal, timeoutController.signal])
      } else {
        const combined = new AbortController()
        const onAbort = () => combined.abort()
        options.signal.addEventListener('abort', onAbort, { once: true })
        timeoutController.signal.addEventListener('abort', onAbort, { once: true })
        effectiveSignal = combined.signal
        cleanupSignalListeners = () => {
          options.signal!.removeEventListener('abort', onAbort)
          timeoutController.signal.removeEventListener('abort', onAbort)
        }
      }
    } else {
      effectiveSignal = timeoutController.signal
    }

    const input: AgentInput = {
      prompt,
      workingDirectory: options?.workingDirectory,
      systemPrompt: options?.systemPrompt,
      maxTurns: options?.maxTurns,
      signal: effectiveSignal,
    }

    // Unified Capability Layer: inject skills + memory from .dzupagent/
    if (this._dzupagentConfig) {
      await this.applyDzupAgentEnrichment(input)
    }

    const task: TaskDescriptor = {
      prompt,
      tags: options?.tags ?? [],
      preferredProvider: options?.preferredProvider,
      workingDirectory: options?.workingDirectory,
    }

    // Compile and enforce policy if one is specified
    this.applyPolicyOverrides(input, options?.preferredProvider, options?.policy ?? this._defaultPolicy)

    // Execute with fallback through the registry
    let eventStream: AsyncGenerator<AgentEvent, void, undefined> =
      this._registry.executeWithFallback(input, task)

    // Bridge events to the event bus
    eventStream = this._bridge.bridge(eventStream)

    eventStream = this.applyPostStreamWrappers(eventStream)

    // Wrap with approval gate if configured and requested
    if (this._approvalGate && options?.requireApproval) {
      const approvalContext = this.buildApprovalContext(
        prompt,
        options?.preferredProvider,
        options?.approvalRunId,
        options?.tags,
      )
      eventStream = this._approvalGate.guard(approvalContext, eventStream)
    }

    // Consume the stream and extract the result.
    let completion: AgentCompletedEvent | undefined
    let lastFailure: Extract<AgentEvent, { type: 'adapter:failed' }> | undefined

    try {
      for await (const event of eventStream) {
        if (event.type === 'adapter:completed') {
          completion = event
        } else if (event.type === 'adapter:failed') {
          lastFailure = event
        }
      }

      if (!completion) {
        throw new ForgeError({
          code: 'ADAPTER_EXECUTION_FAILED',
          message: lastFailure?.error ?? 'No adapter:completed event observed for run()',
          recoverable: false,
          context: {
            source: 'OrchestratorFacade.run',
            providerId: lastFailure?.providerId,
            failureCode: lastFailure?.code,
          },
        })
      }

      return {
        result: completion.result,
        providerId: completion.providerId,
        durationMs: Date.now() - startMs,
        usage: completion.usage,
      }
    } catch (err) {
      // Timeout abort — return a clear error instead of crashing
      if (timeoutController.signal.aborted) {
        const elapsed = Date.now() - startMs
        const providerId = resolveRunFallbackProviderId(
          this._registry,
          task.preferredProvider,
          lastFailure?.providerId,
        )
        throw new ForgeError({
          code: 'ADAPTER_EXECUTION_FAILED',
          message: `Adapter timed out after ${elapsed}ms (limit: ${timeoutMs}ms)`,
          recoverable: false,
          context: { source: 'OrchestratorFacade.run', providerId, timeoutMs },
        })
      }
      if (ForgeError.is(err) && err.code === 'AGENT_ABORTED') {
        return {
          result: '',
          providerId: resolveRunFallbackProviderId(
            this._registry,
            task.preferredProvider,
            lastFailure?.providerId,
          ),
          durationMs: Date.now() - startMs,
          usage: completion?.usage,
          cancelled: true,
          error: err.message,
        }
      }
      throw err
    } finally {
      clearTimeout(timeoutHandle)
      cleanupSignalListeners?.()
    }
  }

  // -------------------------------------------------------------------------
  // supervisor()
  // -------------------------------------------------------------------------

  /**
   * Supervisor pattern -- decompose goal and delegate to specialists.
   */
  async supervisor(goal: string, options?: FacadeSupervisorOptions): Promise<SupervisorResult> {
    this.assertNotShutdown('supervisor')
    const orchestrator = new SupervisorOrchestrator({
      registry: this._registry,
      eventBus: this._eventBus,
      decomposer: options?.decomposer,
      maxConcurrentDelegations: options?.maxConcurrentDelegations,
    })

    return orchestrator.execute(goal, {
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(options?.workingDirectory !== undefined ? { workingDirectory: options.workingDirectory } : {}),
      ...(options?.context !== undefined ? { context: options.context } : {}),
      ...(options?.budgetConstraint !== undefined ? { budgetConstraint: options.budgetConstraint } : {}),
    })
  }

  // -------------------------------------------------------------------------
  // parallel()
  // -------------------------------------------------------------------------

  /**
   * Parallel execution -- run on multiple providers.
   */
  async parallel(prompt: string, options?: ParallelOptions): Promise<ParallelExecutionResult> {
    this.assertNotShutdown('parallel')
    const executor = new ParallelExecutor({
      registry: this._registry,
      eventBus: this._eventBus,
    })

    const providers = options?.providers ?? this._registry.listAdapters()
    const mergeStrategy: MergeStrategy = options?.mergeStrategy ?? 'all'

    const input: AgentInput = { prompt }

    return executor.execute(input, {
      providers,
      mergeStrategy,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.scorer !== undefined ? { scorer: options.scorer } : {}),
    })
  }

  // -------------------------------------------------------------------------
  // race()
  // -------------------------------------------------------------------------

  /**
   * Race -- first-wins across providers.
   */
  async race(
    prompt: string,
    providers?: AdapterProviderId[],
    signal?: AbortSignal,
  ): Promise<ProviderResult> {
    this.assertNotShutdown('race')
    const executor = new ParallelExecutor({
      registry: this._registry,
      eventBus: this._eventBus,
    })

    const resolvedProviders = providers ?? this._registry.listAdapters()
    const input: AgentInput = { prompt }

    return executor.race(input, resolvedProviders, signal)
  }

  // -------------------------------------------------------------------------
  // mapReduce()
  // -------------------------------------------------------------------------

  /**
   * Map-reduce -- split, distribute, merge.
   */
  async mapReduce<TChunk, TMapResult, TReduceResult>(
    input: string,
    options: MapReduceOptions<TChunk, TMapResult, TReduceResult>,
  ): Promise<MapReduceResult<TReduceResult>> {
    this.assertNotShutdown('mapReduce')
    const orchestrator = new MapReduceOrchestrator({
      registry: this._registry,
      eventBus: this._eventBus,
    })

    return orchestrator.execute(input, options)
  }

  // -------------------------------------------------------------------------
  // bid()
  // -------------------------------------------------------------------------

  /**
   * Contract-net bidding -- agents bid, best wins.
   */
  async bid(prompt: string, options?: ContractNetFacadeOptions): Promise<ContractNetResult> {
    this.assertNotShutdown('bid')
    const orchestrator = new ContractNetOrchestrator({
      registry: this._registry,
      eventBus: this._eventBus,
      bidStrategy: options?.bidStrategy,
      bidTimeoutMs: options?.bidTimeoutMs,
    })

    const task: TaskDescriptor = {
      prompt,
      tags: [],
    }

    const input: AgentInput = { prompt }

    return orchestrator.execute(task, input, {
      selectionCriteria: options?.selectionCriteria,
      signal: options?.signal,
    })
  }

  // -------------------------------------------------------------------------
  // chat()
  // -------------------------------------------------------------------------

  /**
   * Multi-turn conversation with session tracking.
   */
  async *chat(
    prompt: string,
    options?: ChatOptions,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    for await (const event of this.chatWithRaw(prompt, options)) {
      if (!isProviderRawStreamEvent(event)) {
        yield event
      }
    }
  }

  async *chatWithRaw(
    prompt: string,
    options?: ChatOptions,
  ): AsyncGenerator<AgentStreamEvent, void, undefined> {
    this.assertNotShutdown('chat')
    // Resolve or create workflow — auto-create if an external ID is given but
    // doesn't exist yet in the in-memory session registry (e.g. DB session IDs).
    let workflowId: string
    if (options?.workflowId) {
      if (!this._sessions.getWorkflow(options.workflowId)) {
        this._sessions.createWorkflow(undefined, options.workflowId)
      }
      workflowId = options.workflowId
    } else {
      workflowId = this._sessions.createWorkflow()
    }

    const adapterOptions: Record<string, unknown> = {}
    if (options?.temperature != null) adapterOptions.temperature = options.temperature
    if (options?.maxTokens != null) adapterOptions.maxTokens = options.maxTokens
    if (options?.topP != null) adapterOptions.topP = options.topP
    if (options?.timeoutMs != null) adapterOptions.timeoutMs = options.timeoutMs

    const input: AgentInput = {
      prompt,
      workingDirectory: options?.workingDirectory,
      systemPrompt: options?.systemPrompt,
      maxTurns: options?.maxTurns,
      ...(Object.keys(adapterOptions).length > 0 && { options: adapterOptions }),
    }

    if (this._dzupagentConfig) {
      await this.applyDzupAgentEnrichment(input)
    }

    this.applyPolicyOverrides(input, options?.provider, options?.policy ?? this._defaultPolicy)

    const multiTurnOptions: MultiTurnOptions = {
      workflowId,
      provider: options?.provider,
      includeHistory: options?.includeHistory ?? true,
    }

    let eventStream = this._sessions.executeMultiTurnWithRaw(input, multiTurnOptions, this._registry)
    eventStream = this._bridge.bridgeWithRaw(eventStream, workflowId)
    eventStream = this.applyPostStreamWrappers(eventStream)

    if (this._approvalGate && options?.requireApproval) {
      const approvalContext = this.buildApprovalContext(
        prompt,
        options?.provider,
        options?.approvalRunId,
      )
      eventStream = this._approvalGate.guard(approvalContext, eventStream)
    }

    yield* eventStream
  }

  async respondInteraction(
    interactionId: string,
    answer: string,
    options: InteractionResponseOptions,
  ): Promise<boolean> {
    this.assertNotShutdown('respondInteraction')
    return await this._sessions.respondInteraction(
      options.workflowId,
      interactionId,
      answer,
      this._registry,
      options.provider,
    )
  }

  // -------------------------------------------------------------------------
  // shutdown / lifecycle
  // -------------------------------------------------------------------------

  /**
   * Gracefully shut down all orchestrator components.
   * Call this before process exit to ensure resources are cleaned up.
   *
   * Shutdown order:
   * 1. Stop accepting new requests (set a flag)
   * 2. Dispose cost tracking state
   * 3. Clear session registry
   *
   * This method is idempotent — safe to call multiple times.
   */
  async shutdown(): Promise<void> {
    this._isShutdown = true

    // Reset cost tracking accumulators
    this._costTracking?.reset()
  }

  /** Check if the orchestrator is ready to accept requests */
  isReady(): boolean {
    return !this._isShutdown
  }

  /**
   * @internal Compile policy and run conformance check.
   * Throws if there are error-severity violations.
   */
  private compilePolicyWithConformance(
    provider: AdapterProviderId,
    policy: AdapterPolicy,
  ): CompiledPolicyOverrides {
    const compiled = compilePolicyForProvider(provider, policy)
    const result = this._conformanceChecker.check(provider, policy, compiled)

    if (!result.conformant) {
      const errorViolations = result.violations.filter((v) => v.severity === 'error')
      const details = errorViolations
        .map((v) => `  - ${v.field}: ${v.reason}`)
        .join('\n')
      throw new ForgeError({
        code: 'ADAPTER_EXECUTION_FAILED',
        message: `Policy conformance check failed for provider '${provider}':\n${details}`,
        recoverable: false,
        context: {
          source: 'OrchestratorFacade.compilePolicyWithConformance',
          providerId: provider,
          violationCount: errorViolations.length,
        },
      })
    }

    return compiled
  }

  // -------------------------------------------------------------------------
  // Unified Capability Layer — .dzupagent/ enrichment
  // -------------------------------------------------------------------------

  /**
   * @internal Resolve .dzupagent/ paths once and cache.
   */
  private async resolveDzupAgentPaths(): Promise<DzupAgentPaths> {
    if (this._resolvedPaths) return this._resolvedPaths
    const projectRoot = this._dzupagentConfig?.projectRoot ?? process.cwd()
    const resolver = new WorkspaceResolver()
    this._resolvedPaths = await resolver.resolve(projectRoot)
    return this._resolvedPaths
  }

  /**
   * @internal Apply Unified Capability Layer enrichment to an AgentInput.
   * Loads skills and memory from .dzupagent/ and injects them into the
   * system prompt / adapter wrapping. Failures are best-effort: a broken
   * skill file never blocks the run.
   */
  private async applyDzupAgentEnrichment(input: AgentInput): Promise<void> {
    const cfg = this._dzupagentConfig
    if (!cfg) return

    const paths = await this.resolveDzupAgentPaths()
    const dzupConfig = await loadDzupAgentConfig(paths)
    const providerId =
      this._registry.listAdapters()[0] ?? ('claude' as AdapterProviderId)

    await EnrichmentPipeline.apply(input, {
      paths,
      dzupConfig,
      providerId,
      skipSkills: cfg.skipSkills,
      skipMemory: cfg.skipMemory,
      // Adapter-layer events are emitted directly on the bus (not via the
      // bridge). Cast required because these events are not part of the
      // core DzupEvent union.
      emitEvent: (event) => this._eventBus.emit(event as unknown as DzupEvent),
    })
  }

  /** @internal Throws if the orchestrator has been shut down */
  private assertNotShutdown(method: string): void {
    if (this._isShutdown) {
      throw new ForgeError({
        code: 'AGENT_ABORTED',
        message: `Orchestrator has been shut down — ${method}() rejected`,
        recoverable: false,
      })
    }
  }

  // -------------------------------------------------------------------------
  // getCostReport()
  // -------------------------------------------------------------------------

  /** Get cost report across all providers */
  getCostReport(): CostReport | undefined {
    return this._costTracking?.getUsage()
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Factory function -- preferred way to create an orchestrator.
 *
 * @example
 * ```ts
 * const orchestrator = createOrchestrator({
 *   adapters: [new ClaudeAgentAdapter(), new CodexAdapter()],
 *   enableCostTracking: true,
 *   costTrackingConfig: { maxBudgetCents: 500 },
 * })
 *
 * const result = await orchestrator.run('Fix the failing test')
 * ```
 */
export function createOrchestrator(config: OrchestratorConfig): OrchestratorFacade {
  return new OrchestratorFacade(config)
}
