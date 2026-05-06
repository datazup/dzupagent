/**
 * Parallel-delegation aggregation helper extracted from DelegatingSupervisor.
 *
 * `aggregateSettledResults` consumes the `Promise.allSettled` outcomes for a
 * batch of {@link TaskAssignment}s and produces the final
 * {@link AggregatedDelegationResult}, including:
 *   - `results` map keyed by assignment ID (or specialistId) with `metadata`
 *     enriched with `assignmentId` / `specialistId`.
 *   - `succeeded` / `failed` lists.
 *   - circuit-breaker bookkeeping for rejected outcomes that have not already
 *     been tagged via {@link markCircuitBreakerRecorded}.
 *   - optional merge-strategy invocation that emits
 *     `supervisor:merge_complete`.
 *
 * Depends only on `@dzupagent/core` types and sibling files.
 */

import type { DzupEventBus } from '@dzupagent/core'
import type { AgentCircuitBreaker } from './circuit-breaker.js'
import type { DelegationResult } from './delegation.js'
import type {
  AgentResult,
  OrchestrationMergeStrategy,
} from './orchestration-merge-strategy-types.js'
import { hasCircuitBreakerRecorded, recordCircuitBreakerFailure } from './circuit-breaker-recorder.js'
import { omitUndefined } from '../utils/exact-optional.js'
import type {
  AggregatedDelegationResult,
  TaskAssignment,
} from './delegating-supervisor-types.js'

export interface AggregateSettledResultsOptions {
  startedAt: number
  assignments: readonly TaskAssignment[]
  settled: PromiseSettledResult<DelegationResult>[]
  circuitBreaker?: AgentCircuitBreaker
  mergeStrategy?: OrchestrationMergeStrategy
  eventBus?: DzupEventBus
}

/**
 * Aggregate `Promise.allSettled` outcomes from a parallel batch into a
 * single {@link AggregatedDelegationResult} with consistent metadata, while
 * recording any non-tagged failures into the optional circuit breaker and
 * applying the optional merge strategy.
 */
export function aggregateSettledResults(
  options: AggregateSettledResultsOptions,
): AggregatedDelegationResult {
  const { startedAt, assignments, settled, circuitBreaker, mergeStrategy, eventBus } = options

  const results = new Map<string, DelegationResult>()
  const succeeded: string[] = []
  const failed: string[] = []

  for (const [i, outcome] of settled.entries()) {
    const assignment = assignments[i]!
    const resultKey = assignment.id ?? assignment.specialistId

    if (outcome.status === 'fulfilled') {
      const result: DelegationResult = {
        ...outcome.value,
        metadata: {
          ...outcome.value.metadata,
          durationMs: outcome.value.metadata?.durationMs ?? 0,
          assignmentId: resultKey,
          specialistId: assignment.specialistId,
        },
      }
      results.set(resultKey, result)
      if (outcome.value.success) {
        succeeded.push(resultKey)
      } else {
        failed.push(resultKey)
      }
      continue
    }

    const errorMsg =
      outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
    if (!hasCircuitBreakerRecorded(outcome.reason)) {
      recordCircuitBreakerFailure(circuitBreaker, assignment.specialistId, outcome.reason)
    }
    results.set(resultKey, {
      success: false,
      output: null,
      error: errorMsg,
      metadata: {
        durationMs: 0,
        assignmentId: resultKey,
        specialistId: assignment.specialistId,
      },
    })
    failed.push(resultKey)
  }

  if (mergeStrategy && results.size > 0) {
    const agentResults: AgentResult[] = [...results.entries()].map(([agentId, dr]) =>
      omitUndefined({
        agentId,
        status: dr.success
          ? ('success' as const)
          : dr.error?.toLowerCase().includes('timeout')
            ? ('timeout' as const)
            : ('error' as const),
        output: dr.output,
        error: dr.error,
        durationMs: dr.metadata?.durationMs,
      }),
    )
    const merged = mergeStrategy.merge(agentResults)
    eventBus?.emit({
      type: 'supervisor:merge_complete',
      mergeStatus: merged.status,
      successCount: merged.successCount,
      errorCount: merged.errorCount,
    })
  }

  return {
    results,
    succeeded,
    failed,
    totalDurationMs: Date.now() - startedAt,
  }
}
