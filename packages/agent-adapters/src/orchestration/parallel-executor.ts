/**
 * ParallelExecutor — runs the same prompt across multiple adapters concurrently
 * with configurable result merging strategies.
 *
 * Strategies:
 * - `first-wins`: returns as soon as the first provider completes, aborts others
 * - `all`: waits for every provider, returns combined results
 * - `best-of-n`: waits for all, uses a scorer function to pick the best result
 */

import type { DzipEventBus } from '@dzipagent/core'

import type { AdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentInput,
  TokenUsage,
} from '../types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MergeStrategy = 'first-wins' | 'all' | 'best-of-n'

export interface ParallelExecutorConfig {
  registry: AdapterRegistry
  eventBus?: DzipEventBus
}

export interface ParallelExecutionOptions {
  /** Which providers to run on */
  providers: AdapterProviderId[]
  /** How to pick the winning result */
  mergeStrategy: MergeStrategy
  /** Abort signal for external cancellation */
  signal?: AbortSignal
  /** Maximum time (ms) to wait for all providers */
  timeoutMs?: number
  /** Scoring function for 'best-of-n' — higher is better */
  scorer?: (result: ProviderResult) => number
}

export interface ProviderResult {
  providerId: AdapterProviderId
  result: string
  success: boolean
  durationMs: number
  usage?: TokenUsage
  error?: string
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
}

// ---------------------------------------------------------------------------
// Default scorer
// ---------------------------------------------------------------------------

/**
 * Default scorer: prefer successful results; among successes, prefer shorter duration.
 * Returns a value where higher is better.
 */
function defaultScorer(result: ProviderResult): number {
  if (!result.success) return -1
  // Invert duration so shorter = higher score. Add 1 to avoid division by zero.
  return 1_000_000 / (result.durationMs + 1)
}

// ---------------------------------------------------------------------------
// ParallelExecutor
// ---------------------------------------------------------------------------

export class ParallelExecutor {
  private readonly registry: AdapterRegistry
  private readonly eventBus: DzipEventBus | undefined

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
    const onExternalAbort = (): void => { controller.abort() }
    signal?.addEventListener('abort', onExternalAbort, { once: true })

    // Timeout handling — abort all providers if the deadline is exceeded.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => { controller.abort() }, timeoutMs)
    }

    try {
      if (mergeStrategy === 'first-wins') {
        return await this.executeFirstWins(input, providers, controller, executionStart)
      }

      // 'all' and 'best-of-n' both need every provider to finish.
      const allResults = await this.executeAll(input, providers, controller)
      const totalDurationMs = Date.now() - executionStart

      const selectedResult = mergeStrategy === 'best-of-n'
        ? this.selectBest(allResults, scorer)
        : this.selectFirstSuccessful(allResults)

      const result: ParallelExecutionResult = {
        selectedResult,
        allResults,
        strategy: mergeStrategy,
        totalDurationMs,
      }

      this.emit({
        type: 'pipeline:run_completed',
        pipelineId: 'parallel-executor',
        runId: `parallel-${executionStart}`,
        durationMs: totalDurationMs,
      })

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
    signal?: AbortSignal,
  ): Promise<ProviderResult> {
    const result = await this.execute(input, {
      providers,
      mergeStrategy: 'first-wins',
      signal,
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
    // Each provider runs as a promise. We race them, but also collect all
    // results so the caller can inspect failures.
    const resultMap = new Map<AdapterProviderId, ProviderResult>()
    const promises: Array<Promise<ProviderResult>> = []

    for (const providerId of providers) {
      promises.push(this.runSingleProvider(input, providerId, controller.signal))
    }

    // Use Promise.any to get the first successful result. If all fail, fall back
    // to Promise.allSettled to build the failure report.
    let selectedResult: ProviderResult | undefined

    try {
      selectedResult = await Promise.any(
        promises.map(async (p) => {
          const result = await p
          resultMap.set(result.providerId, result)
          if (!result.success) {
            throw new Error(`Provider ${result.providerId} failed: ${result.error ?? 'unknown'}`)
          }
          return result
        }),
      )

      // First provider succeeded — abort the rest.
      controller.abort()
    } catch {
      // All providers failed (AggregateError from Promise.any).
      // Collect whatever results we have.
    }

    // Wait a tick so in-flight promises can settle and populate resultMap.
    const settled = await Promise.allSettled(promises)
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        resultMap.set(s.value.providerId, s.value)
      }
    }

    const allResults = providers
      .map((id) => resultMap.get(id))
      .filter((r): r is ProviderResult => r !== undefined)

    if (!selectedResult) {
      // All failed — pick the first one for consistency.
      selectedResult = allResults[0] ?? this.buildFailureResult(providers[0]!, 'All providers failed')
    }

    const totalDurationMs = Date.now() - executionStart

    this.emit({
      type: 'pipeline:run_completed',
      pipelineId: 'parallel-executor',
      runId: `parallel-${executionStart}`,
      durationMs: totalDurationMs,
    })

    return {
      selectedResult,
      allResults,
      strategy: 'first-wins',
      totalDurationMs,
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
    const promises = providers.map((id) =>
      this.runSingleProvider(input, id, controller.signal),
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
      let usage: TokenUsage | undefined

      for await (const event of gen) {
        // If we have been aborted (e.g. first-wins resolved), stop consuming.
        if (signal.aborted) break

        events.push(event)

        // Extract the final result and usage from the completed event.
        if (event.type === 'adapter:completed') {
          const completed = event as AgentCompletedEvent
          finalResult = completed.result
          usage = completed.usage
        }
      }

      const durationMs = Date.now() - startMs

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
        usage,
        events,
      }
    } catch (err) {
      const durationMs = Date.now() - startMs
      const message = err instanceof Error ? err.message : String(err)

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

    return best ?? results[0] ?? this.buildFailureResult('claude' as AdapterProviderId, 'No results')
  }

  /** Pick the first successful result, or the first result if none succeeded. */
  private selectFirstSuccessful(results: ProviderResult[]): ProviderResult {
    const successful = results.find((r) => r.success)
    return successful ?? results[0] ?? this.buildFailureResult('claude' as AdapterProviderId, 'No results')
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

  // ---------------------------------------------------------------------------
  // Private — event bus
  // ---------------------------------------------------------------------------

  private emit(
    event:
      | { type: 'pipeline:run_started'; pipelineId: string; runId: string }
      | { type: 'pipeline:run_completed'; pipelineId: string; runId: string; durationMs: number }
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
