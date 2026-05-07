/**
 * OrchestrationPatterns — extracted from OrchestratorFacade.
 *
 * Hosts the multi-provider pattern entrypoints (supervisor, parallel, race,
 * mapReduce, bid). Each method instantiates its concrete orchestrator on
 * demand because the patterns are stateless and short-lived.
 */

import type { DzupEventBus } from '@dzupagent/core/events'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
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
  AgentInput,
  TaskDescriptor,
} from '../types.js'

export interface FacadeSupervisorOptions extends Omit<BaseSupervisorOptions, never> {
  decomposer?: TaskDecomposer | undefined
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

export class OrchestrationPatterns {
  constructor(
    private readonly _registry: ProviderAdapterRegistry,
    private readonly _eventBus: DzupEventBus,
  ) {}

  async supervisor(goal: string, options?: FacadeSupervisorOptions): Promise<SupervisorResult> {
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

  async parallel(prompt: string, options?: ParallelOptions): Promise<ParallelExecutionResult> {
    const executor = new ParallelExecutor({ registry: this._registry, eventBus: this._eventBus })
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

  async race(
    prompt: string,
    providers?: AdapterProviderId[],
    signal?: AbortSignal,
  ): Promise<ProviderResult> {
    const executor = new ParallelExecutor({ registry: this._registry, eventBus: this._eventBus })
    const resolvedProviders = providers ?? this._registry.listAdapters()
    const input: AgentInput = { prompt }
    return executor.race(input, resolvedProviders, signal)
  }

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

  async bid(prompt: string, options?: ContractNetFacadeOptions): Promise<ContractNetResult> {
    const orchestrator = new ContractNetOrchestrator({
      registry: this._registry,
      eventBus: this._eventBus,
      bidStrategy: options?.bidStrategy,
      bidTimeoutMs: options?.bidTimeoutMs,
    })
    const task: TaskDescriptor = { prompt, tags: [] }
    const input: AgentInput = { prompt }
    return orchestrator.execute(task, input, {
      selectionCriteria: options?.selectionCriteria,
      signal: options?.signal,
    })
  }
}
