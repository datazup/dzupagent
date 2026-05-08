/**
 * ParallelExecutor — runs the same prompt across multiple adapters concurrently
 * with configurable result merging strategies.
 *
 * Strategies:
 * - `first-wins`: returns as soon as the first provider completes, aborts others
 * - `all`: waits for every provider, returns combined results
 * - `best-of-n`: waits for all, uses a scorer function to pick the best result
 *
 * Implementation is split across sibling files for clarity:
 * - `parallel-executor-types.ts`      — public types
 * - `parallel-executor-abort.ts`      — abort/cancellation helpers
 * - `parallel-executor-results.ts`    — result builders/selectors/aggregators
 * - `parallel-executor-runner.ts`     — single-provider event consumption
 * - `parallel-executor-strategies.ts` — per-strategy execution logic
 * - `parallel-executor-events.ts`     — event-bus emission helpers
 */

import type { DzupEventBus } from '@dzupagent/core/events'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentInput,
} from '../types.js'

import {
  type ParallelAbortReason,
  getAbortReason,
  getCancellationMessage,
  isUserCancellationReason,
} from './parallel-executor-abort.js'
import {
  emitPipelineEvent,
  emitProviderProgress,
  type PipelineEvent,
  recordProviderFailure,
  recordProviderSuccess,
} from './parallel-executor-events.js'
import {
  buildCancelledExecutionResult,
  defaultScorer,
  selectBest,
  selectFirstSuccessful,
} from './parallel-executor-results.js'
import { runSingleProvider } from './parallel-executor-runner.js'
import { executeAll, executeFirstWins } from './parallel-executor-strategies.js'
import type {
  ParallelExecutionOptions,
  ParallelExecutionResult,
  ParallelExecutorConfig,
  ProviderResult,
} from './parallel-executor-types.js'

// Re-export public types so existing import paths keep working.
export type {
  MergeStrategy,
  ParallelExecutionOptions,
  ParallelExecutionResult,
  ParallelExecutorConfig,
  ProviderResult,
} from './parallel-executor-types.js'

const PIPELINE_ID = 'parallel-executor'

export class ParallelExecutor {
  private readonly registry: ProviderAdapterRegistry
  private readonly eventBus: DzupEventBus | undefined

  constructor(config: ParallelExecutorConfig) {
    this.registry = config.registry
    this.eventBus = config.eventBus
  }

  /**
   * Execute the same input on multiple providers in parallel.
   *
   * Each provider runs independently, collecting its own events. The merge
   * strategy determines how the final result is selected.
   */
  async execute(
    input: AgentInput,
    options: ParallelExecutionOptions,
  ): Promise<ParallelExecutionResult> {
    const { providers, mergeStrategy, timeoutMs, signal } = options
    const scorer = options.scorer ?? defaultScorer
    const executionStart = Date.now()
    const runId = `parallel-${executionStart}`

    this.emit({ type: 'pipeline:run_started', pipelineId: PIPELINE_ID, runId })

    // Linked AbortController so we can cancel remaining providers on first-wins,
    // while still respecting an external signal.
    const controller = new AbortController()
    const abortAll = (reason: ParallelAbortReason): void => {
      if (!controller.signal.aborted) controller.abort(reason)
    }
    const onExternalAbort = (): void => { abortAll('external') }
    if (signal?.aborted) abortAll('external')
    else signal?.addEventListener('abort', onExternalAbort, { once: true })

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined

    try {
      if (controller.signal.aborted) {
        const totalDurationMs = Date.now() - executionStart
        const reason = getCancellationMessage(controller.signal)
        const result = buildCancelledExecutionResult(providers, mergeStrategy, totalDurationMs, reason)
        this.emit({ type: 'pipeline:run_cancelled', pipelineId: PIPELINE_ID, runId, reason })
        return result
      }

      if (timeoutMs !== undefined && timeoutMs > 0) {
        timeoutHandle = setTimeout(() => { abortAll('timeout') }, timeoutMs)
      }

      const runner = this.bindRunner()
      const onCancelled = (reason: string): void => {
        this.emit({ type: 'pipeline:run_cancelled', pipelineId: PIPELINE_ID, runId, reason })
      }
      const onCompleted = (durationMs: number): void => {
        this.emit({ type: 'pipeline:run_completed', pipelineId: PIPELINE_ID, runId, durationMs })
      }

      if (mergeStrategy === 'first-wins') {
        return await executeFirstWins(input, providers, runner, controller, executionStart, { onCancelled, onCompleted })
      }

      // 'all' and 'best-of-n' both need every provider to finish.
      const allResults = await executeAll(input, providers, runner, controller.signal, {
        onProviderSettled: (id, current, total) => { emitProviderProgress(this.eventBus, id, current, total) },
      })
      const totalDurationMs = Date.now() - executionStart

      const selectedResult = mergeStrategy === 'best-of-n'
        ? selectBest(allResults, scorer, providers)
        : selectFirstSuccessful(allResults, providers)
      const cancelled = isUserCancellationReason(getAbortReason(controller.signal))

      if (cancelled) onCancelled(getCancellationMessage(controller.signal))
      else onCompleted(totalDurationMs)

      return {
        selectedResult,
        allResults,
        strategy: mergeStrategy,
        totalDurationMs,
        cancelled: cancelled ? true : undefined,
      }
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  /**
   * Convenience method — race multiple providers and return the first successful result.
   */
  async race(
    input: AgentInput,
    providers: AdapterProviderId[],
    signal?: AbortSignal | undefined,
  ): Promise<ProviderResult> {
    const result = await this.execute(input, {
      providers,
      mergeStrategy: 'first-wins',
      ...(signal !== undefined ? { signal } : {}),
    })
    return result.selectedResult
  }

  // ---------------------------------------------------------------------------
  // Private — wiring
  // ---------------------------------------------------------------------------

  /** Bind the standalone runner with this executor's deps. */
  private bindRunner() {
    return (input: AgentInput, providerId: AdapterProviderId, signal: AbortSignal): Promise<ProviderResult> =>
      runSingleProvider(input, providerId, signal, {
        registry: this.registry,
        eventBus: this.eventBus,
        emit: (event) => this.emit(event),
        recordSuccess: (id) => recordProviderSuccess(this.registry, id),
        recordFailure: (id, error) => recordProviderFailure(this.registry, id, error),
      })
  }

  private emit(event: PipelineEvent): void {
    emitPipelineEvent(this.eventBus, event)
  }
}
