/**
 * Pure result-shaping helpers for ParallelExecutor.
 *
 * These functions are stateless: they build, select, and aggregate
 * `ProviderResult` values. They live outside the executor class so they
 * can be unit-tested in isolation and reused without instantiating
 * the orchestrator.
 */

import type {
  AdapterProviderId,
  AgentEvent,
  TokenUsage,
} from '../types.js'
import { resolveFallbackProviderId as resolveFallbackProviderIdFromSource } from '../utils/provider-helpers.js'

import type {
  MergeStrategy,
  ParallelExecutionResult,
  ProviderResult,
} from './parallel-executor-types.js'

// ---------------------------------------------------------------------------
// Default scorer
// ---------------------------------------------------------------------------

/**
 * Default scorer: prefer successful results; among successes, prefer shorter
 * duration. Returns a value where higher is better.
 */
export function defaultScorer(result: ProviderResult): number {
  if (!result.success || result.cancelled) return -1
  // Invert duration so shorter = higher score. Add 1 to avoid division by zero.
  return 1_000_000 / (result.durationMs + 1)
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

/** Build a synthetic failure result with no events and zero duration. */
export function buildFailureResult(
  providerId: AdapterProviderId,
  error: string,
): ProviderResult {
  return {
    providerId,
    result: '',
    success: false,
    durationMs: 0,
    error,
    events: [],
  }
}

/** Build a cancelled provider result, preserving any partial events/usage. */
export function buildCancelledResult(
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

/**
 * Build a fully-cancelled execution result for a parallel run that aborted
 * before any provider had a chance to complete.
 */
export function buildCancelledExecutionResult(
  providers: AdapterProviderId[],
  strategy: MergeStrategy,
  totalDurationMs: number,
  error: string,
): ParallelExecutionResult {
  const allResults = providers.map((providerId) =>
    buildCancelledResult(providerId, totalDurationMs, error, []),
  )

  return {
    selectedResult: allResults[0] ?? buildCancelledResult(
      resolveFallbackProviderId(providers),
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

// ---------------------------------------------------------------------------
// Result selectors
// ---------------------------------------------------------------------------

/** Pick the result with the highest score. Falls back to the first result. */
export function selectBest(
  results: ProviderResult[],
  scorer: (r: ProviderResult) => number,
  providers: AdapterProviderId[],
): ProviderResult {
  let best: ProviderResult | undefined
  let bestScore = -Infinity

  for (const r of results) {
    if (!r.success || r.cancelled) continue
    const score = scorer(r)
    if (score > bestScore) {
      bestScore = score
      best = r
    }
  }

  return best
    ?? results[0]
    ?? buildFailureResult(resolveFallbackProviderId(providers), 'No results')
}

/** Pick the first successful result, or the first result if none succeeded. */
export function selectFirstSuccessful(
  results: ProviderResult[],
  providers: AdapterProviderId[],
): ProviderResult {
  const successful = results.find((r) => r.success)
  return successful
    ?? results[0]
    ?? buildFailureResult(resolveFallbackProviderId(providers), 'No results')
}

// ---------------------------------------------------------------------------
// Result aggregation
// ---------------------------------------------------------------------------

/** Collect provider results in input order, dropping providers that never settled. */
export function collectCompletedResults(
  providers: AdapterProviderId[],
  resultMap: Map<AdapterProviderId, ProviderResult>,
): ProviderResult[] {
  return providers
    .map((providerId) => resultMap.get(providerId))
    .filter((result): result is ProviderResult => result !== undefined)
}

/**
 * Collect provider results, filling in synthetic cancelled results for any
 * provider that did not finish before cancellation.
 */
export function collectCancelledResults(
  providers: AdapterProviderId[],
  resultMap: Map<AdapterProviderId, ProviderResult>,
  totalDurationMs: number,
  cancellationMessage: string,
): ProviderResult[] {
  return providers.map((providerId) => {
    const result = resultMap.get(providerId)
    if (result) return result
    return buildCancelledResult(providerId, totalDurationMs, cancellationMessage, [])
  })
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/**
 * Resolve a fallback provider id when constructing synthetic results in error
 * paths. Returns the literal `'unknown'` cast as `AdapterProviderId` if the
 * provider list is empty.
 */
export function resolveFallbackProviderId(
  providers: AdapterProviderId[],
): AdapterProviderId {
  return resolveFallbackProviderIdFromSource(providers) ?? ('unknown' as AdapterProviderId)
}
