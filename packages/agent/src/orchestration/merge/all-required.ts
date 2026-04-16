import type { AgentResult, MergedResult, OrchestrationMergeStrategy } from '../orchestration-merge-strategy-types.js'

/** AllRequired: fails if any agent fails or times out */
export class AllRequiredMergeStrategy<T = unknown> implements OrchestrationMergeStrategy<T> {
  merge(results: AgentResult<T>[]): MergedResult<T> {
    const successCount = results.filter((r) => r.status === 'success').length
    const timeoutCount = results.filter((r) => r.status === 'timeout').length
    const errorCount = results.filter((r) => r.status === 'error').length

    if (timeoutCount > 0 || errorCount > 0) {
      return {
        status: timeoutCount === results.length ? 'all_timeout' : 'all_failed',
        agentResults: results,
        successCount,
        timeoutCount,
        errorCount,
      }
    }

    // All succeeded -- merge outputs into an array
    const outputs = results.map((r) => r.output)
    return {
      status: 'success',
      output: outputs as unknown as T,
      agentResults: results,
      successCount,
      timeoutCount,
      errorCount,
    }
  }
}
