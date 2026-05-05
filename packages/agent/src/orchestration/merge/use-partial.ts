import type { AgentResult, MergedResult, OrchestrationMergeStrategy } from '../orchestration-merge-strategy-types.js'

/** UsePartial: succeeds with whatever results are available */
export class UsePartialMergeStrategy<T = unknown> implements OrchestrationMergeStrategy<T> {
  merge(results: AgentResult<T>[]): MergedResult<T> {
    const successCount = results.filter((r) => r.status === 'success').length
    const timeoutCount = results.filter((r) => r.status === 'timeout').length
    const errorCount = results.filter((r) => r.status === 'error').length

    if (successCount === 0) {
      return {
        status: timeoutCount === results.length ? 'all_timeout' : 'all_failed',
        agentResults: results,
        successCount,
        timeoutCount,
        errorCount,
      }
    }

    // See AllRequiredMergeStrategy for the rationale: callers parameterise
    // `T` to the array type they expect, so a single direct cast preserves
    // type safety.
    const outputs = results
      .filter((r) => r.status === 'success')
      .map((r) => r.output as T)

    return {
      status: 'partial',
      output: outputs as T,
      agentResults: results,
      successCount,
      timeoutCount,
      errorCount,
    }
  }
}
