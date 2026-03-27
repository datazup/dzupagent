/**
 * Factory that wraps a SleepConsolidator into the ConsolidationTask interface,
 * allowing it to plug into the ConsolidationScheduler.
 *
 * Uses dynamic imports so that @dzipagent/memory remains an optional dependency.
 */

import type { ConsolidationTask, ConsolidationReport } from './consolidation-scheduler.js'

/**
 * Minimal interface extracted from SleepConsolidator so we can accept it
 * without importing @dzipagent/memory at the type level.
 */
export interface SleepConsolidatorLike {
  run(
    store: unknown,
    namespaces: string[][],
  ): Promise<SleepConsolidationReportLike>
}

/** Minimal shape of SleepConsolidationReport we need for the mapping. */
export interface SleepConsolidationReportLike {
  namespaces: Array<{
    namespace: string[]
    deduplicated: number
    pruned: number
    contradictionsFound: number
    healed: number
    lessonsDeduplicated: number
    conventionsExtracted: number
    stalenessPruned: number
  }>
  totalLLMCalls: number
  durationMs: number
  phasesRun: string[]
}

export interface SleepConsolidationTaskConfig {
  /** A SleepConsolidator instance (from @dzipagent/memory) */
  consolidator: SleepConsolidatorLike
  /** A BaseStore instance (from @langchain/langgraph) */
  store: unknown
  /** Namespaces to consolidate */
  namespaces: string[][]
}

/**
 * Create a ConsolidationTask that delegates to a SleepConsolidator.
 *
 * The returned task maps the rich SleepConsolidationReport into the simpler
 * ConsolidationReport expected by ConsolidationScheduler, summing per-namespace
 * metrics into aggregate totals.
 */
export function createSleepConsolidationTask(
  config: SleepConsolidationTaskConfig,
): ConsolidationTask {
  const { consolidator, store, namespaces } = config

  return {
    async run(signal: AbortSignal): Promise<ConsolidationReport> {
      // Pre-flight abort check
      if (signal.aborted) {
        throw new DOMException('Consolidation aborted before start', 'AbortError')
      }

      const report = await consolidator.run(store, namespaces)

      // Post-consolidation abort check — discard result if cancelled mid-flight
      if (signal.aborted) {
        throw new DOMException('Consolidation aborted after completion', 'AbortError')
      }

      // Map the per-namespace report into the flat ConsolidationReport
      let recordsProcessed = 0
      let pruned = 0
      let merged = 0

      for (const ns of report.namespaces) {
        // "recordsProcessed" is the sum of all actions taken per namespace
        const nsTotal =
          ns.deduplicated +
          ns.pruned +
          ns.healed +
          ns.lessonsDeduplicated +
          ns.conventionsExtracted +
          ns.stalenessPruned +
          ns.contradictionsFound

        recordsProcessed += nsTotal

        // "pruned" aggregates all removal-type operations
        pruned += ns.pruned + ns.stalenessPruned

        // "merged" aggregates all deduplication/merge-type operations
        merged += ns.deduplicated + ns.lessonsDeduplicated
      }

      return {
        recordsProcessed,
        pruned,
        merged,
        durationMs: report.durationMs,
      }
    },
  }
}
