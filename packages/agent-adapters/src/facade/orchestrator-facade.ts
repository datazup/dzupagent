/**
 * OrchestratorFacade -- high-level builder-pattern API that simplifies
 * using all orchestration patterns with a single entrypoint.
 *
 * Internally wires up ProviderAdapterRegistry, EventBusBridge, CostTrackingMiddleware,
 * SessionRegistry, and an AdapterPipeline (policy + approval + guardrails + UCL),
 * then delegates to the appropriate orchestrator for each pattern
 * (supervisor, parallel, map-reduce, contract-net).
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

import { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import { EventBusBridge } from '../registry/event-bus-bridge.js'
import {
  CostTrackingMiddleware,
  type CostReport,
} from '../middleware/cost-tracking.js'
import {
  SessionRegistry,
  type MultiTurnOptions,
} from '../session/session-registry.js'
import type { SupervisorResult } from '../orchestration/supervisor.js'
import type {
  ParallelExecutionResult,
  ProviderResult,
} from '../orchestration/parallel-executor.js'
import type {
  MapReduceOptions,
  MapReduceResult,
} from '../orchestration/map-reduce.js'
import type { ContractNetResult } from '../orchestration/contract-net.js'
import {
  OrchestrationPatterns,
  type ContractNetFacadeOptions,
  type FacadeSupervisorOptions,
  type ParallelOptions,
} from './orchestration-patterns.js'
import { withMemoryEnrichment } from '../middleware/memory-enrichment.js'
import type { AdapterPolicy } from '../policy/policy-compiler.js'
import {
  AdapterPipeline,
  ApprovalPipelineStep,
  GuardrailsPipelineStep,
  PolicyEnforcementPipeline,
  UCLEnrichmentStep,
} from '../pipeline/index.js'
import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentStreamEvent,
} from '../types.js'
import { mergeAbortSignals } from '../utils/abort-signal-helpers.js'
import type {
  ChatOptions,
  InteractionResponseOptions,
  OrchestratorConfig,
  RunOptions,
  RunResult,
} from './orchestrator-facade-types.js'
import {
  buildChatInput,
  buildRunInput,
  buildRunTask,
  handleRunError,
} from './run-executor-helpers.js'

function isProviderRawStreamEvent(
  event: AgentStreamEvent,
): event is Extract<AgentStreamEvent, { type: 'adapter:provider_raw' }> {
  return event.type === 'adapter:provider_raw'
}

// ---------------------------------------------------------------------------
// Public option/result types are defined in `orchestrator-facade-types.ts`
// and re-exported from this module to keep the public surface stable.
// ---------------------------------------------------------------------------

export type {
  ChatOptions,
  InteractionResponseOptions,
  OrchestratorConfig,
  RunOptions,
  RunResult,
} from './orchestrator-facade-types.js'
export type {
  FacadeSupervisorOptions,
  ParallelOptions,
  ContractNetFacadeOptions,
} from './orchestration-patterns.js'

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
  /** Default timeout for run() — 3 minutes. Adapters should have their own shorter timeouts. */
  private static readonly RUN_TIMEOUT_MS = 180_000

  private readonly _bridge: EventBusBridge
  private readonly _costTracking: CostTrackingMiddleware | undefined
  private readonly _defaultPolicy: AdapterPolicy | undefined
  private _isShutdown = false

  constructor(
    private readonly _registry: ProviderAdapterRegistry,
    private readonly _pipeline: AdapterPipeline,
    private readonly _patterns: OrchestrationPatterns,
    private readonly _sessions: SessionRegistry,
    options: {
      bridge: EventBusBridge
      costTracking?: CostTrackingMiddleware | undefined
      defaultPolicy?: AdapterPolicy | undefined
    },
  ) {
    this._bridge = options.bridge
    this._costTracking = options.costTracking
    this._defaultPolicy = options.defaultPolicy
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

  /** Access the underlying composable pipeline (mostly for testing) */
  get pipeline(): AdapterPipeline {
    return this._pipeline
  }

  // -------------------------------------------------------------------------
  // run() — simplest API
  // -------------------------------------------------------------------------

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
    const timeoutMs = OrchestratorFacade.RUN_TIMEOUT_MS
    const timeoutController = new AbortController()
    const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs)
    const merged = mergeAbortSignals(options?.signal, timeoutController.signal)

    const input = buildRunInput(prompt, options, merged.signal)
    await this._pipeline.prepare({
      input,
      preferredProvider: options?.preferredProvider,
      policy: options?.policy ?? this._defaultPolicy,
    })
    const task = buildRunTask(prompt, options)

    let eventStream: AsyncGenerator<AgentEvent, void, undefined> =
      this._registry.executeWithFallback(input, task)
    eventStream = this._bridge.bridge(eventStream)
    eventStream = this._pipeline.wrapStream(eventStream, {
      prompt,
      providerId: options?.preferredProvider,
      approvalRunId: options?.approvalRunId,
      tags: options?.tags,
      requireApproval: options?.requireApproval,
    })

    let completion: AgentCompletedEvent | undefined
    let lastFailure: Extract<AgentEvent, { type: 'adapter:failed' }> | undefined

    try {
      for await (const event of eventStream) {
        if (event.type === 'adapter:completed') completion = event
        else if (event.type === 'adapter:failed') lastFailure = event
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
      return handleRunError(err, {
        registry: this._registry,
        startMs,
        timeoutMs,
        timeoutAborted: timeoutController.signal.aborted,
        task,
        lastFailure,
        completion,
      })
    } finally {
      clearTimeout(timeoutHandle)
      merged.cleanup?.()
    }
  }

  // -------------------------------------------------------------------------
  // Orchestration patterns (delegated to OrchestrationPatterns)
  // -------------------------------------------------------------------------

  /** Supervisor pattern -- decompose goal and delegate to specialists. */
  async supervisor(goal: string, options?: FacadeSupervisorOptions): Promise<SupervisorResult> {
    this.assertNotShutdown('supervisor')
    return this._patterns.supervisor(goal, options)
  }

  /** Parallel execution -- run on multiple providers. */
  async parallel(prompt: string, options?: ParallelOptions): Promise<ParallelExecutionResult> {
    this.assertNotShutdown('parallel')
    return this._patterns.parallel(prompt, options)
  }

  /** Race -- first-wins across providers. */
  async race(
    prompt: string,
    providers?: AdapterProviderId[],
    signal?: AbortSignal,
  ): Promise<ProviderResult> {
    this.assertNotShutdown('race')
    return this._patterns.race(prompt, providers, signal)
  }

  /** Map-reduce -- split, distribute, merge. */
  async mapReduce<TChunk, TMapResult, TReduceResult>(
    input: string,
    options: MapReduceOptions<TChunk, TMapResult, TReduceResult>,
  ): Promise<MapReduceResult<TReduceResult>> {
    this.assertNotShutdown('mapReduce')
    return this._patterns.mapReduce(input, options)
  }

  /** Contract-net bidding -- agents bid, best wins. */
  async bid(prompt: string, options?: ContractNetFacadeOptions): Promise<ContractNetResult> {
    this.assertNotShutdown('bid')
    return this._patterns.bid(prompt, options)
  }

  // -------------------------------------------------------------------------
  // chat() — multi-turn conversation
  // -------------------------------------------------------------------------

  /** Multi-turn conversation with session tracking. */
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
    const workflowId = this.resolveOrCreateWorkflow(options?.workflowId)
    const input = buildChatInput(prompt, options)

    await this._pipeline.prepare({
      input,
      preferredProvider: options?.provider,
      policy: options?.policy ?? this._defaultPolicy,
    })

    const multiTurnOptions: MultiTurnOptions = {
      workflowId,
      provider: options?.provider,
      includeHistory: options?.includeHistory ?? true,
    }

    let eventStream = this._sessions.executeMultiTurnWithRaw(input, multiTurnOptions, this._registry)
    eventStream = this._bridge.bridgeWithRaw(eventStream, workflowId)
    eventStream = this._pipeline.wrapStream(eventStream, {
      prompt,
      providerId: options?.provider,
      approvalRunId: options?.approvalRunId,
      requireApproval: options?.requireApproval,
    })

    yield* eventStream
  }

  private resolveOrCreateWorkflow(workflowId: string | undefined): string {
    if (!workflowId) return this._sessions.createWorkflow()
    if (!this._sessions.getWorkflow(workflowId)) {
      this._sessions.createWorkflow(undefined, workflowId)
    }
    return workflowId
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
   * Idempotent — safe to call multiple times.
   */
  async shutdown(): Promise<void> {
    this._isShutdown = true
    this._costTracking?.reset()
  }

  /** Check if the orchestrator is ready to accept requests */
  isReady(): boolean {
    return !this._isShutdown
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
 * Composes the AdapterPipeline (policy + approval + guardrails + UCL) and
 * injects it into a new OrchestratorFacade alongside the registry, sessions,
 * event bus, and bridge.
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
  const eventBus = config.eventBus ?? createEventBus()

  const registry = new ProviderAdapterRegistry(
    config.circuitBreakerConfig
      ? { circuitBreaker: config.circuitBreakerConfig }
      : undefined,
  )
  registry.setEventBus(eventBus)

  if (config.router) {
    registry.setRouter(config.router)
  }

  const adaptersToRegister = config.memoryEnrichment
    ? config.adapters.map(a => withMemoryEnrichment(a, config.memoryEnrichment!))
    : config.adapters

  for (const adapter of adaptersToRegister) {
    registry.register(adapter)
  }

  const bridge = new EventBusBridge(eventBus)

  const enableCost = config.enableCostTracking ?? true
  const costTracking = enableCost
    ? new CostTrackingMiddleware({
        eventBus,
        ...config.costTrackingConfig,
      })
    : undefined

  const sessions = new SessionRegistry({ eventBus })

  const pipeline = new AdapterPipeline(
    new PolicyEnforcementPipeline(registry),
    new ApprovalPipelineStep(config.approvalGate),
    new GuardrailsPipelineStep(costTracking, config.guardrails),
    new UCLEnrichmentStep(registry, eventBus, config.dzupagent),
  )
  const patterns = new OrchestrationPatterns(registry, eventBus)

  return new OrchestratorFacade(registry, pipeline, patterns, sessions, {
    bridge,
    costTracking,
    defaultPolicy: config.defaultPolicy,
  })
}
