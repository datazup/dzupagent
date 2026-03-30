/**
 * OrchestratorFacade -- high-level builder-pattern API that simplifies
 * using all orchestration patterns with a single entrypoint.
 *
 * Internally wires up AdapterRegistry, EventBusBridge, CostTrackingMiddleware,
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

import { createEventBus, ForgeError } from '@dzipagent/core'
import type { CircuitBreakerConfig, DzipEventBus } from '@dzipagent/core'

import { AdapterRegistry } from '../registry/adapter-registry.js'
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
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentCompletedEvent,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
  TaskRoutingStrategy,
  TokenUsage,
} from '../types.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  /** Adapters to register */
  adapters: AgentCLIAdapter[]
  /** Event bus (optional, creates one if not provided) */
  eventBus?: DzipEventBus
  /** Routing strategy. Default: TagBasedRouter */
  router?: TaskRoutingStrategy
  /** Enable cost tracking. Default true */
  enableCostTracking?: boolean
  /** Cost tracking config */
  costTrackingConfig?: CostTrackingConfig
  /** Circuit breaker config */
  circuitBreakerConfig?: Partial<CircuitBreakerConfig>
}

// ---------------------------------------------------------------------------
// Simplified options interfaces
// ---------------------------------------------------------------------------

export interface RunOptions {
  tags?: string[]
  preferredProvider?: AdapterProviderId
  signal?: AbortSignal
  workingDirectory?: string
  systemPrompt?: string
  maxTurns?: number
}

export interface RunResult {
  result: string
  providerId: AdapterProviderId
  durationMs: number
  usage?: TokenUsage
}

export interface FacadeSupervisorOptions extends Omit<BaseSupervisorOptions, never> {
  /** Custom task decomposer */
  decomposer?: TaskDecomposer
  /** Maximum concurrent delegations */
  maxConcurrentDelegations?: number
}

export interface ParallelOptions extends Omit<ParallelExecutionOptions, 'providers'> {
  providers?: AdapterProviderId[]
}

export interface ContractNetFacadeOptions {
  selectionCriteria?: BidSelectionCriteria
  signal?: AbortSignal
  bidStrategy?: BidStrategy
  bidTimeoutMs?: number
}

export interface ChatOptions {
  /** Resume existing workflow or create new */
  workflowId?: string
  provider?: AdapterProviderId
  /** Default true */
  includeHistory?: boolean
  workingDirectory?: string
  systemPrompt?: string
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
  private readonly _registry: AdapterRegistry
  private readonly _eventBus: DzipEventBus
  private readonly _bridge: EventBusBridge
  private readonly _costTracking: CostTrackingMiddleware | undefined
  private readonly _sessions: SessionRegistry

  constructor(config: OrchestratorConfig) {
    const eventBus = config.eventBus ?? createEventBus()
    this._eventBus = eventBus

    // Build registry with circuit breaker config and event bus
    this._registry = new AdapterRegistry(
      config.circuitBreakerConfig
        ? { circuitBreaker: config.circuitBreakerConfig }
        : undefined,
    )
    this._registry.setEventBus(eventBus)

    if (config.router) {
      this._registry.setRouter(config.router)
    }

    // Register all adapters
    for (const adapter of config.adapters) {
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

    // Session registry
    this._sessions = new SessionRegistry({ eventBus })
  }

  // -------------------------------------------------------------------------
  // Public accessors
  // -------------------------------------------------------------------------

  /** Access the underlying adapter registry */
  get registry(): AdapterRegistry {
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

  // -------------------------------------------------------------------------
  // run() — simplest API
  // -------------------------------------------------------------------------

  /**
   * Run a task with automatic routing and fallback.
   * Simplest API -- just provide a prompt.
   */
  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const startMs = Date.now()

    const input: AgentInput = {
      prompt,
      workingDirectory: options?.workingDirectory,
      systemPrompt: options?.systemPrompt,
      maxTurns: options?.maxTurns,
      signal: options?.signal,
    }

    const task: TaskDescriptor = {
      prompt,
      tags: options?.tags ?? [],
      preferredProvider: options?.preferredProvider,
      workingDirectory: options?.workingDirectory,
    }

    // Execute with fallback through the registry
    let eventStream: AsyncGenerator<AgentEvent, void, undefined> =
      this._registry.executeWithFallback(input, task)

    // Bridge events to the event bus
    eventStream = this._bridge.bridge(eventStream)

    // Wrap with cost tracking if enabled
    if (this._costTracking) {
      eventStream = this._costTracking.wrap(eventStream)
    }

    // Consume the stream and extract the result
    let completion: AgentCompletedEvent | undefined
    let lastFailure: Extract<AgentEvent, { type: 'adapter:failed' }> | undefined

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
  }

  // -------------------------------------------------------------------------
  // supervisor()
  // -------------------------------------------------------------------------

  /**
   * Supervisor pattern -- decompose goal and delegate to specialists.
   */
  async supervisor(goal: string, options?: FacadeSupervisorOptions): Promise<SupervisorResult> {
    const orchestrator = new SupervisorOrchestrator({
      registry: this._registry,
      eventBus: this._eventBus,
      decomposer: options?.decomposer,
      maxConcurrentDelegations: options?.maxConcurrentDelegations,
    })

    return orchestrator.execute(goal, {
      signal: options?.signal,
      workingDirectory: options?.workingDirectory,
      context: options?.context,
      budgetConstraint: options?.budgetConstraint,
    })
  }

  // -------------------------------------------------------------------------
  // parallel()
  // -------------------------------------------------------------------------

  /**
   * Parallel execution -- run on multiple providers.
   */
  async parallel(prompt: string, options?: ParallelOptions): Promise<ParallelExecutionResult> {
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
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
      scorer: options?.scorer,
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
    // Resolve or create workflow
    const workflowId = options?.workflowId ?? this._sessions.createWorkflow()

    const input: AgentInput = {
      prompt,
      workingDirectory: options?.workingDirectory,
      systemPrompt: options?.systemPrompt,
    }

    const multiTurnOptions: MultiTurnOptions = {
      workflowId,
      provider: options?.provider,
      includeHistory: options?.includeHistory ?? true,
    }

    let eventStream: AsyncGenerator<AgentEvent, void, undefined> =
      this._sessions.executeMultiTurn(input, multiTurnOptions, this._registry)

    // Bridge events to the event bus
    eventStream = this._bridge.bridge(eventStream, workflowId)

    // Wrap with cost tracking if enabled
    if (this._costTracking) {
      eventStream = this._costTracking.wrap(eventStream)
    }

    yield* eventStream
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
