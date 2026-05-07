/**
 * OrchestratorFacade -- high-level builder-pattern API that simplifies
 * using all orchestration patterns with a single entrypoint.
 *
 * Internally wires up ProviderAdapterRegistry, EventBusBridge,
 * CostTrackingMiddleware, SessionRegistry, and an AdapterPipeline
 * (policy + approval + guardrails + UCL), then delegates to the appropriate
 * orchestrator for each pattern (supervisor, parallel, map-reduce, contract-net).
 *
 * Run/chat dispatch wiring lives in `facade-run-coordinator.ts`; the factory
 * + composition root lives in `facade-factory.ts`.
 */

import { ForgeError } from '@dzupagent/core'

import type { CostReport, CostTrackingMiddleware } from '../middleware/cost-tracking.js'
import type { ContractNetResult } from '../orchestration/contract-net.js'
import type {
  MapReduceOptions,
  MapReduceResult,
} from '../orchestration/map-reduce.js'
import type {
  ParallelExecutionResult,
  ProviderResult,
} from '../orchestration/parallel-executor.js'
import type { SupervisorResult } from '../orchestration/supervisor.js'
import type { AdapterPipeline } from '../pipeline/index.js'
import type { AdapterPolicy } from '../policy/policy-compiler.js'
import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type { EventBusBridge } from '../registry/event-bus-bridge.js'
import type { SessionRegistry } from '../session/session-registry.js'
import type {
  AdapterProviderId,
  AgentEvent,
  AgentStreamEvent,
} from '../types.js'

import {
  executeChatWithRaw,
  executeRun,
  isProviderRawStreamEvent,
} from './facade-run-coordinator.js'
import {
  OrchestrationPatterns,
  type ContractNetFacadeOptions,
  type FacadeSupervisorOptions,
  type ParallelOptions,
} from './orchestration-patterns.js'
import type {
  ChatOptions,
  InteractionResponseOptions,
  RunOptions,
  RunResult,
} from './orchestrator-facade-types.js'

// Public option/result types live in `orchestrator-facade-types.ts`; re-export
// them here so the facade module stays the canonical import path.
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

/**
 * High-level orchestration facade. Provides a single entrypoint for all
 * orchestration patterns with automatic wiring of registry, event bus,
 * cost tracking, and session management.
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

  // -- Public accessors -----------------------------------------------------

  /** Access the underlying adapter registry */
  get registry(): ProviderAdapterRegistry { return this._registry }

  /** Access cost tracking (if enabled) */
  get costTracking(): CostTrackingMiddleware | undefined { return this._costTracking }

  /** Access session registry */
  get sessions(): SessionRegistry { return this._sessions }

  /** Access the underlying composable pipeline (mostly for testing) */
  get pipeline(): AdapterPipeline { return this._pipeline }

  // -- run() ---------------------------------------------------------------

  /**
   * Run a task with automatic routing and fallback. Enforces a hard timeout
   * (RUN_TIMEOUT_MS) so the call never hangs even if the underlying adapter
   * stream stalls.
   */
  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    this.assertNotShutdown('run')
    return executeRun(prompt, options, {
      registry: this._registry,
      pipeline: this._pipeline,
      bridge: this._bridge,
      defaultPolicy: this._defaultPolicy,
      timeoutMs: OrchestratorFacade.RUN_TIMEOUT_MS,
    })
  }

  // -- Orchestration patterns (delegated to OrchestrationPatterns) --------

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

  // -- chat() --------------------------------------------------------------

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
    yield* executeChatWithRaw(prompt, options, {
      registry: this._registry,
      pipeline: this._pipeline,
      bridge: this._bridge,
      sessions: this._sessions,
      defaultPolicy: this._defaultPolicy,
    })
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

  // -- shutdown / lifecycle ------------------------------------------------

  /**
   * Gracefully shut down all orchestrator components. Idempotent — safe to
   * call multiple times.
   */
  async shutdown(): Promise<void> {
    this._isShutdown = true
    this._costTracking?.reset()
  }

  /** Check if the orchestrator is ready to accept requests */
  isReady(): boolean { return !this._isShutdown }

  /** Get cost report across all providers */
  getCostReport(): CostReport | undefined { return this._costTracking?.getUsage() }

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
}

// Re-export factory from its own module so existing imports of
// `createOrchestrator` from this path continue to work unchanged.
export { createOrchestrator } from './facade-factory.js'
