import type { AgentResult, MergedResult, OrchestrationMergeStrategy } from '../orchestration-merge-strategy-types.js'

/** FirstWins: returns the first successful result */
export class FirstWinsMergeStrategy<T = unknown> implements OrchestrationMergeStrategy<T> {
  merge(results: AgentResult<T>[]): MergedResult<T> {
    const successCount = results.filter((r) => r.status === 'success').length
    const timeoutCount = results.filter((r) => r.status === 'timeout').length
    const errorCount = results.filter((r) => r.status === 'error').length
    const first = results.find((r) => r.status === 'success')

    if (!first) {
      return {
        status: timeoutCount === results.length ? 'all_timeout' : 'all_failed',
        agentResults: results,
        successCount,
        timeoutCount,
        errorCount,
      }
    }

    return {
      status: 'success',
      output: first.output,
      agentResults: results,
      successCount,
      timeoutCount,
      errorCount,
    }
  }
}
