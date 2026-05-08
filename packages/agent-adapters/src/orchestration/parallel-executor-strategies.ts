/**
 * Strategy implementations for ParallelExecutor.
 *
 * Each strategy ('first-wins', 'all', 'best-of-n') is implemented here as a
 * standalone function. They share the same shape — take the parallel input,
 * run providers via an injected runner, and return both the per-provider
 * results and (where relevant) progress callbacks.
 *
 * Pulled out of `parallel-executor.ts` so the orchestrator stays a thin
 * coordinator over abort plumbing + strategy dispatch.
 */

import type {
  AdapterProviderId,
  AgentInput,
} from '../types.js'

import {
  getAbortReason,
  getCancellationMessage,
  isUserCancellationReason,
} from './parallel-executor-abort.js'
import {
  collectCancelledResults,
  collectCompletedResults,
  selectFirstSuccessful,
} from './parallel-executor-results.js'
import type {
  ParallelExecutionResult,
  ProviderResult,
} from './parallel-executor-types.js'

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type ProviderRunner = (
  input: AgentInput,
  providerId: AdapterProviderId,
  signal: AbortSignal,
) => Promise<ProviderResult>

export interface RunCancelledHandler {
  (reason: string): void
}

export interface RunCompletedHandler {
  (durationMs: number): void
}

export interface ExecuteAllOptions {
  onProviderSettled?: (providerId: AdapterProviderId, current: number, total: number) => void
}

// ---------------------------------------------------------------------------
// 'all' / 'best-of-n' — wait for every provider to settle
// ---------------------------------------------------------------------------

export async function executeAll(
  input: AgentInput,
  providers: AdapterProviderId[],
  runner: ProviderRunner,
  signal: AbortSignal,
  options: ExecuteAllOptions = {},
): Promise<ProviderResult[]> {
  const total = providers.length
  let completedCount = 0

  const promises = providers.map((id) =>
    runner(input, id, signal).then((result) => {
      completedCount++
      options.onProviderSettled?.(id, completedCount, total)
      return result
    }),
  )
  const settled = await Promise.allSettled(promises)

  return settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value
    // Should not normally happen since runSingleProvider catches internally,
    // but handle it defensively.
    const message = s.reason instanceof Error ? s.reason.message : String(s.reason)
    return {
      providerId: providers[i]!,
      result: '',
      success: false,
      durationMs: 0,
      error: message,
      events: [],
    }
  })
}

// ---------------------------------------------------------------------------
// 'first-wins' — resolve as soon as one provider succeeds, abort the rest
// ---------------------------------------------------------------------------

export interface ExecuteFirstWinsCallbacks {
  onCancelled: RunCancelledHandler
  onCompleted: RunCompletedHandler
}

export async function executeFirstWins(
  input: AgentInput,
  providers: AdapterProviderId[],
  runner: ProviderRunner,
  controller: AbortController,
  executionStart: number,
  callbacks: ExecuteFirstWinsCallbacks,
): Promise<ParallelExecutionResult> {
  const resultMap = new Map<AdapterProviderId, ProviderResult>()
  const promises: Array<Promise<ProviderResult>> = []

  for (const providerId of providers) {
    promises.push(
      runner(input, providerId, controller.signal).then((result) => {
        resultMap.set(result.providerId, result)
        return result
      }),
    )
  }

  const cancellationPromise = new Promise<void>((resolve) => {
    if (controller.signal.aborted) { resolve(); return }
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
      const allResults = collectCancelledResults(
        providers,
        resultMap,
        totalDurationMs,
        getCancellationMessage(controller.signal),
      )

      callbacks.onCancelled(getCancellationMessage(controller.signal))

      return {
        selectedResult: allResults.find((result) => result.cancelled)
          ?? selectFirstSuccessful(allResults, providers),
        allResults,
        strategy: 'first-wins',
        totalDurationMs,
        cancelled: true,
      }
    }

    selectedResult = outcome.result

    // First provider succeeded — abort the rest.
    if (!controller.signal.aborted) controller.abort('first-wins')
  } catch {
    // All providers failed or were cancelled before any success.
  }

  const totalDurationMs = Date.now() - executionStart
  const abortReason = getAbortReason(controller.signal)
  const cancelled = isUserCancellationReason(abortReason)
  const allResults = cancelled
    ? collectCancelledResults(providers, resultMap, totalDurationMs, getCancellationMessage(controller.signal))
    : collectCompletedResults(providers, resultMap)

  if (!selectedResult) {
    selectedResult = cancelled
      ? allResults.find((result) => result.cancelled) ?? selectFirstSuccessful(allResults, providers)
      : selectFirstSuccessful(allResults, providers)
  }

  if (cancelled) {
    callbacks.onCancelled(getCancellationMessage(controller.signal))
  } else {
    callbacks.onCompleted(totalDurationMs)
  }

  return {
    selectedResult,
    allResults,
    strategy: 'first-wins',
    totalDurationMs,
    ...(cancelled ? { cancelled: true as const } : {}),
  }
}
