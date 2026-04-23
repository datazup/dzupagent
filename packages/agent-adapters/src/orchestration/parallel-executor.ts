/**
 * ParallelExecutor — runs the same prompt across multiple adapters concurrently
 * with configurable result merging strategies.
 *
 * Strategies:
 * - `first-wins`: returns as soon as the first provider completes, aborts others
 * - `all`: waits for every provider, returns combined results
 * - `best-of-n`: waits for all, uses a scorer function to pick the best result
 */

import type { DzupEventBus } from '@dzupagent/core'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentInput,
  AgentProgressEvent,
  TokenUsage,
} from '../types.js'
import { resolveFallbackProviderId as resolveFallbackProviderIdFromSource } from '../utils/provider-helpers.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MergeStrategy = 'first-wins' | 'all' | 'best-of-n'

export interface ParallelExecutorConfig {
  registry: ProviderAdapterRegistry
  eventBus?: DzupEventBus | undefined
}

export interface ParallelExecutionOptions {
  /** Which providers to run on */
  providers: AdapterProviderId[]
  /** How to pick the winning result */
  mergeStrategy: MergeStrategy
  /** Abort signal for external cancellation */
  signal?: AbortSignal | undefined
  /** Maximum time (ms) to wait for all providers */
  timeoutMs?: number | undefined
  /** Scoring function for 'best-of-n' — higher is better */
  scorer?: (result: ProviderResult) => number
}

export interface ProviderResult {
  providerId: AdapterProviderId
  result: string
  success: boolean
  durationMs: number
  usage?: TokenUsage | undefined
  error?: string | undefined
  cancelled?: true | undefined
  events: AgentEvent[]
}

export interface ParallelExecutionResult {
  /** The winning result based on the merge strategy */
  selectedResult: ProviderResult
  /** All provider results (including failures) */
  allResults: ProviderResult[]
  /** Which strategy was used */
  strategy: MergeStrategy
  /** Wall-clock duration for the entire parallel execution */
  totalDurationMs: number
  cancelled?: true | undefined
}

// ---------------------------------------------------------------------------
// Default scorer
// ---------------------------------------------------------------------------

/**
 * Default scorer: prefer successful results; among successes, prefer shorter duration.
 * Returns a value where higher is better.
 */
function defaultScorer(result: ProviderResult): number {
  if (!result.success || result.cancelled) return -1
  // Invert duration so shorter = higher score. Add 1 to avoid division by zero.
  return 1_000_000 / (result.durationMs + 1)
}

type ParallelAbortReason = 'external' | 'timeout' | 'first-wins'

function getAbortReason(signal: AbortSignal): ParallelAbortReason | undefined {
  if (!signal.aborted) return undefined
  return (
    signal.reason === 'external' ||
    signal.reason === 'timeout' ||
    signal.reason === 'first-wins'
  )
    ? signal.reason
    : 'external'
}

function isUserCancellationReason(reason: ParallelAbortReason | undefined): boolean {
  return reason === 'external' || reason === 'timeout'
}

// ---------------------------------------------------------------------------
// ParallelExecutor
// ---------------------------------------------------------------------------

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

    this.emit({
      type: 'pipeline:run_started',
      pipelineId: 'parallel-executor',
      runId: `parallel-${executionStart}`,
    })

    // Create a linked AbortController so we can cancel remaining providers
    // when using first-wins, while still respecting an external signal.
    const controller = new AbortController()

    // If the external signal aborts, propagate to our internal controller.
    const abortAll = (reason: ParallelAbortReason): void => {
      if (!controller.signal.aborted) {
        controller.abort(reason)
      }
    }

    const onExternalAbort = (): void => { abortAll('external') }
    if (signal?.aborted) {
      abortAll('external')
    } else {
      signal?.addEventListener('abort', onExternalAbort, { once: true })
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined

    try {
      if (controller.signal.aborted) {
        const totalDurationMs = Date.now() - executionStart
        const result = this.buildCancelledExecutionResult(
          providers,
          mergeStrategy,
          totalDurationMs,
          controller.signal,
        )

        this.emit({
          type: 'pipeline:run_cancelled',
          pipelineId: 'parallel-executor',
          runId: `parallel-${executionStart}`,
          reason: this.getCancellationMessage(controller.signal),
        })

        return result
      }

      // Timeout handling — abort all providers if the deadline is exceeded.
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timeoutHandle = setTimeout(() => { abortAll('timeout') }, timeoutMs)
      }

      if (mergeStrategy === 'first-wins') {
        return await this.executeFirstWins(input, providers, controller, executionStart)
      }

      // 'all' and 'best-of-n' both need every provider to finish.
      const allResults = await this.executeAll(input, providers, controller)
      const totalDurationMs = Date.now() - executionStart

      const selectedResult = mergeStrategy === 'best-of-n'
        ? this.selectBest(allResults, scorer, providers)
        : this.selectFirstSuccessful(allResults, providers)
      const abortReason = getAbortReason(controller.signal)

      const result: ParallelExecutionResult = {
        selectedResult,
        allResults,
        strategy: mergeStrategy,
        totalDurationMs,
        cancelled: isUserCancellationReason(abortReason) ? true : undefined,
      }

      if (isUserCancellationReason(abortReason)) {
        this.emit({
          type: 'pipeline:run_cancelled',
          pipelineId: 'parallel-executor',
          runId: `parallel-${executionStart}`,
          reason: this.getCancellationMessage(controller.signal),
        })
      } else {
        this.emit({
          type: 'pipeline:run_completed',
          pipelineId: 'parallel-executor',
          runId: `parallel-${executionStart}`,
          durationMs: totalDurationMs,
        })
      }

      return result
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
  // Private — execution strategies
  // ---------------------------------------------------------------------------

  /**
   * First-wins: resolve as soon as one provider succeeds, then abort the rest.
   */
  private async executeFirstWins(
    input: AgentInput,
    providers: AdapterProviderId[],
    controller: AbortController,
    executionStart: number,
  ): Promise<ParallelExecutionResult> {
    // Each provider runs as a promise. We track results as they settle so we can
    // return promptly on the first success while still exposing best-effort
    // completed results.
    const resultMap = new Map<AdapterProviderId, ProviderResult>()
    const promises: Array<Promise<ProviderResult>> = []

    for (const providerId of providers) {
      promises.push(
        this.runSingleProvider(input, providerId, controller.signal).then((result) => {
          resultMap.set(result.providerId, result)
          return result
        }),
      )
    }

    const cancellationPromise = new Promise<void>((resolve) => {
      if (controller.signal.aborted) {
        resolve()
        return
      }
      controller.signal.addEventListener('abort', () => resolve(), { once: true })
    })

    const firstSuccessPromise = Promise.any(
      promises.map(async (p) => {
        const result = await p
        if (!result.success) {
          throw new Error(`Provider ${result.providerId} failed: ${result.error ?? 'unknown'}`)
        }
        return result
      }),
    )

    let selectedResult: ProviderResult | undefined
    try {
      const outcome = await Promise.race([
        firstSuccessPromise.then((result) => ({ kind: 'success' as const, result })),
        cancellationPromise.then(() => ({ kind: 'cancelled' as const })),
      ])

      if (outcome.kind === 'cancelled') {
        const totalDurationMs = Date.now() - executionStart
        const allResults = this.collectCancelledResults(
          providers,
          resultMap,
          totalDurationMs,
          this.getCancellationMessage(controller.signal),
        )

        const result: ParallelExecutionResult = {
          selectedResult: allResults.find((result) => result.cancelled)
            ?? this.selectFirstSuccessful(allResults, providers),
          allResults,
          strategy: 'first-wins',
          totalDurationMs,
          cancelled: true,
        }

        this.emit({
          type: 'pipeline:run_cancelled',
          pipelineId: 'parallel-executor',
          runId: `parallel-${executionStart}`,
          reason: this.getCancellationMessage(controller.signal),
        })

        return result
      }

      selectedResult = outcome.result

      // First provider succeeded — abort the rest.
      if (!controller.signal.aborted) {
        controller.abort('first-wins')
      }
    } catch {
      // All providers failed or were cancelled before any success.
    }

    const totalDurationMs = Date.now() - executionStart
    const abortReason = getAbortReason(controller.signal)
    const cancelled = isUserCancellationReason(abortReason)
    const allResults = cancelled
      ? this.collectCancelledResults(
          providers,
          resultMap,
          totalDurationMs,
          this.getCancellationMessage(controller.signal),
        )
      : this.collectCompletedResults(providers, resultMap)

    if (!selectedResult) {
      // All providers failed — pick the first completed result for consistency.
      selectedResult = cancelled
        ? allResults.find((result) => result.cancelled)
          ?? this.selectFirstSuccessful(allResults, providers)
        : this.selectFirstSuccessful(allResults, providers)
    }

    if (cancelled) {
      this.emit({
        type: 'pipeline:run_cancelled',
        pipelineId: 'parallel-executor',
        runId: `parallel-${executionStart}`,
        reason: this.getCancellationMessage(controller.signal),
      })
    } else {
      this.emit({
        type: 'pipeline:run_completed',
        pipelineId: 'parallel-executor',
        runId: `parallel-${executionStart}`,
        durationMs: totalDurationMs,
      })
    }

    return {
      selectedResult,
      allResults,
      strategy: 'first-wins',
      totalDurationMs,
      ...(cancelled ? { cancelled: true as const } : {}),
    }
  }

  /**
   * Execute all providers and wait for every one to settle.
   */
  private async executeAll(
    input: AgentInput,
    providers: AdapterProviderId[],
    controller: AbortController,
  ): Promise<ProviderResult[]> {
    const total = providers.length
    let completedCount = 0

    const promises = providers.map((id) =>
      this.runSingleProvider(input, id, controller.signal).then((result) => {
        completedCount++
        this.emitProgress(id, completedCount, total)
        return result
      }),
    )
    const settled = await Promise.allSettled(promises)

    return settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value
      // Should not normally happen since runSingleProvider catches internally,
      // but handle it defensively.
      return this.buildFailureResult(
        providers[i]!,
        s.reason instanceof Error ? s.reason.message : String(s.reason),
      )
    })
  }

  /**
   * Run a single provider, collecting all events and producing a ProviderResult.
   */
  private async runSingleProvider(
    input: AgentInput,
    providerId: AdapterProviderId,
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    const adapter = this.registry.getHealthy(providerId)
    if (!adapter) {
      return this.buildFailureResult(providerId, `Adapter "${providerId}" is not healthy or not registered`)
    }

    const events: AgentEvent[] = []
    const startMs = Date.now()
    let usage: TokenUsage | undefined

    this.emit({
      type: 'pipeline:node_started',
      pipelineId: 'parallel-executor',
      runId: `parallel-${startMs}`,
      nodeId: providerId,
      nodeType: 'adapter',
    })

    try {
      // Merge the external signal into the adapter input.
      const mergedInput: AgentInput = { ...input, signal }
      const gen = adapter.execute(mergedInput)
      let finalResult = ''

      for await (const event of gen) {
        // If we have been aborted (e.g. first-wins resolved), stop consuming.
        if (signal.aborted) {
          return this.buildCancelledResult(
            providerId,
            Date.now() - startMs,
            this.getCancellationMessage(signal),
            events,
            usage,
          )
        }

        events.push(event)

        // Extract the final result and usage from the completed event.
        if (event.type === 'adapter:completed') {
          const completed = event as AgentCompletedEvent
          finalResult = completed.result
          usage = completed.usage

          const durationMs = Date.now() - startMs
          if (signal.aborted) {
            return this.buildCancelledResult(
              providerId,
              durationMs,
              this.getCancellationMessage(signal),
              events,
              usage,
            )
          }

          this.emit({
            type: 'pipeline:node_completed',
            pipelineId: 'parallel-executor',
            runId: `parallel-${startMs}`,
            nodeId: providerId,
            durationMs,
          })

          return {
            providerId,
            result: finalResult,
            success: true,
            durationMs,
            ...(usage !== undefined ? { usage } : {}),
            events,
          }
        }
      }

      const durationMs = Date.now() - startMs

      if (signal.aborted) {
        return this.buildCancelledResult(
          providerId,
          durationMs,
          this.getCancellationMessage(signal),
          events,
          usage,
        )
      }

      this.emit({
        type: 'pipeline:node_completed',
        pipelineId: 'parallel-executor',
        runId: `parallel-${startMs}`,
        nodeId: providerId,
        durationMs,
      })

      return {
        providerId,
        result: finalResult,
        success: true,
        durationMs,
        ...(usage !== undefined ? { usage } : {}),
        events,
      }
    } catch (err) {
      const durationMs = Date.now() - startMs
      const message = err instanceof Error ? err.message : String(err)
      const abortReason = getAbortReason(signal)

      if (signal.aborted || isUserCancellationReason(abortReason)) {
        return this.buildCancelledResult(
          providerId,
          durationMs,
          this.getCancellationMessage(signal, message),
          events,
          usage,
        )
      }

      // Do not emit node_failed for aborted providers — that is expected.
      if (!signal.aborted) {
        this.emit({
          type: 'pipeline:node_failed',
          pipelineId: 'parallel-executor',
          runId: `parallel-${startMs}`,
          nodeId: providerId,
          error: message,
        })
      }

      return {
        providerId,
        result: '',
        success: false,
        durationMs,
        error: message,
        events,
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private — result selection helpers
  // ---------------------------------------------------------------------------

  /** Pick the result with the highest score. */
  private selectBest(
    results: ProviderResult[],
    scorer: (r: ProviderResult) => number,
    providers: AdapterProviderId[],
  ): ProviderResult {
    let best: ProviderResult | undefined
    let bestScore = -Infinity

    for (const r of results) {
      const score = scorer(r)
      if (score > bestScore) {
        bestScore = score
        best = r
      }
    }

    return best
      ?? results[0]
      ?? this.buildFailureResult(this.resolveFallbackProviderId(providers), 'No results')
  }

  /** Pick the first successful result, or the first result if none succeeded. */
  private selectFirstSuccessful(
    results: ProviderResult[],
    providers: AdapterProviderId[],
  ): ProviderResult {
    const successful = results.find((r) => r.success)
    return successful
      ?? results[0]
      ?? this.buildFailureResult(this.resolveFallbackProviderId(providers), 'No results')
  }

  /** Build a synthetic failure result. */
  private buildFailureResult(providerId: AdapterProviderId, error: string): ProviderResult {
    return {
      providerId,
      result: '',
      success: false,
      durationMs: 0,
      error,
      events: [],
    }
  }

  private buildCancelledResult(
    providerId: AdapterProviderId,
    durationMs: number,
    error: string,
    events: AgentEvent[],
    usage?: TokenUsage,
  ): ProviderResult {
    return {
      providerId,
      result: '',
      success: false,
      durationMs,
      ...(usage !== undefined ? { usage } : {}),
      error,
      cancelled: true,
      events,
    }
  }

  private buildCancelledExecutionResult(
    providers: AdapterProviderId[],
    strategy: MergeStrategy,
    totalDurationMs: number,
    signal: AbortSignal,
  ): ParallelExecutionResult {
    const error = this.getCancellationMessage(signal)
    const allResults = providers.map((providerId) =>
      this.buildCancelledResult(providerId, totalDurationMs, error, []),
    )

    return {
      selectedResult: allResults[0] ?? this.buildCancelledResult(
        this.resolveFallbackProviderId(providers),
        totalDurationMs,
        error,
        [],
      ),
      allResults,
      strategy,
      totalDurationMs,
      cancelled: true,
    }
  }

  private resolveFallbackProviderId(providers: AdapterProviderId[]): AdapterProviderId {
    return resolveFallbackProviderIdFromSource(providers) ?? ('unknown' as AdapterProviderId)
  }

  private getCancellationMessage(signal: AbortSignal, fallback?: string): string {
    const reason = getAbortReason(signal)
    if (reason === 'timeout') return 'Parallel execution timed out'
    if (reason === 'first-wins') return 'Parallel execution cancelled after first successful provider'
    return fallback ?? 'Parallel execution was cancelled'
  }

  private collectCompletedResults(
    providers: AdapterProviderId[],
    resultMap: Map<AdapterProviderId, ProviderResult>,
  ): ProviderResult[] {
    return providers
      .map((providerId) => resultMap.get(providerId))
      .filter((result): result is ProviderResult => result !== undefined)
  }

  private collectCancelledResults(
    providers: AdapterProviderId[],
    resultMap: Map<AdapterProviderId, ProviderResult>,
    totalDurationMs: number,
    cancellationMessage: string,
  ): ProviderResult[] {
    return providers.map((providerId) => {
      const result = resultMap.get(providerId)
      if (result) return result
      return this.buildCancelledResult(providerId, totalDurationMs, cancellationMessage, [])
    })
  }

  // ---------------------------------------------------------------------------
  // Private — event bus
  // ---------------------------------------------------------------------------

  private emitProgress(
    providerId: AdapterProviderId,
    current: number,
    total: number,
  ): void {
    const percentage = total > 0 ? Math.round((current / total) * 100) : undefined
    const progressEvent: AgentProgressEvent = {
      type: 'adapter:progress',
      providerId,
      timestamp: Date.now(),
      phase: 'executing',
      current,
      total,
      percentage,
      message: `Completed provider ${String(current)}/${String(total)}`,
    }
    if (this.eventBus) {
      this.eventBus.emit(progressEvent as unknown as Parameters<DzupEventBus['emit']>[0])
    }
  }

  private emit(
    event:
      | { type: 'pipeline:run_started'; pipelineId: string; runId: string }
      | { type: 'pipeline:run_completed'; pipelineId: string; runId: string; durationMs: number }
      | { type: 'pipeline:run_cancelled'; pipelineId: string; runId: string; reason?: string }
      | { type: 'pipeline:run_failed'; pipelineId: string; runId: string; error: string }
      | { type: 'pipeline:node_started'; pipelineId: string; runId: string; nodeId: string; nodeType: string }
      | { type: 'pipeline:node_completed'; pipelineId: string; runId: string; nodeId: string; durationMs: number }
      | { type: 'pipeline:node_failed'; pipelineId: string; runId: string; nodeId: string; error: string },
  ): void {
    if (this.eventBus) {
      this.eventBus.emit(event)
    }
  }
}
