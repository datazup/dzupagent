/**
 * Result helpers for `AgentOrchestrator.parallel`.
 *
 * Keeps the settled-result normalization and circuit-breaker bookkeeping out
 * of the orchestration facade while preserving the legacy return semantics.
 */

import type { AgentCircuitBreaker } from './circuit-breaker.js'
import type {
  AgentResult,
  MergedResult,
} from './orchestration-merge-strategy-types.js'
import { isTimeoutError, recordCircuitBreakerFailure } from './circuit-breaker-recorder.js'

export interface ParallelAgentLike {
  id: string
}

export interface ParallelGenerateResultLike {
  content: string
}

export function recordParallelCircuitBreakerOutcomes(
  agents: readonly ParallelAgentLike[],
  settled: readonly PromiseSettledResult<ParallelGenerateResultLike>[],
  circuitBreaker: AgentCircuitBreaker | undefined,
): void {
  if (!circuitBreaker) return

  for (const [index, outcome] of settled.entries()) {
    const agent = agents[index]
    if (!agent) continue

    if (outcome.status === 'fulfilled') {
      circuitBreaker.recordSuccess(agent.id)
    } else {
      recordCircuitBreakerFailure(circuitBreaker, agent.id, outcome.reason)
    }
  }
}

export function toParallelAgentResults(
  agents: readonly ParallelAgentLike[],
  settled: readonly PromiseSettledResult<ParallelGenerateResultLike>[],
): AgentResult<string>[] {
  return settled.map((outcome, index) => {
    const agentId = agents[index]?.id ?? `agent-${index}`
    if (outcome.status === 'fulfilled') {
      return {
        agentId,
        status: 'success' as const,
        output: outcome.value.content,
      }
    }

    const error = outcome.reason instanceof Error
      ? outcome.reason.message
      : String(outcome.reason)
    return {
      agentId,
      status: isTimeoutError(error) ? ('timeout' as const) : ('error' as const),
      error,
    }
  })
}

export function renderMergedParallelOutput(merged: MergedResult<unknown>): string {
  if (merged.output !== undefined) {
    return typeof merged.output === 'string'
      ? merged.output
      : JSON.stringify(merged.output)
  }

  return `Merge status: ${merged.status} (no output)`
}
