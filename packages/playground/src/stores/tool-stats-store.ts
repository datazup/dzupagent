/**
 * Tool stats store -- manages tool performance analytics data
 * for the playground inspector ToolStats tab.
 *
 * Accepts tool stats from run metadata and aggregates across
 * multiple runs for a comprehensive performance overview.
 *
 * @module tool-stats-store
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Single tool performance entry shown in the inspector. */
export interface ToolStatEntry {
  toolName: string
  totalCalls: number
  successRate: number
  avgDurationMs: number
  p95DurationMs: number
  /** Combined ranking score (0-1, higher = better) */
  score: number
  topErrors: Array<{ type: string; count: number }>
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useToolStatsStore = defineStore('toolStats', () => {
  // ── State ─────────────────────────────────────────
  const stats = ref<ToolStatEntry[]>([])
  const isLoading = ref(false)

  // ── Getters ───────────────────────────────────────

  /** Stats sorted by score descending. */
  const sortedStats = computed(() =>
    [...stats.value].sort((a, b) => b.score - a.score),
  )

  /** Total number of distinct tools tracked. */
  const toolCount = computed(() => stats.value.length)

  /** Average success rate across all tools (0-1). */
  const avgSuccessRate = computed(() => {
    if (stats.value.length === 0) return 0
    const sum = stats.value.reduce((acc, s) => acc + s.successRate, 0)
    return sum / stats.value.length
  })

  /** The tool with the lowest average latency, or null if empty. */
  const fastestTool = computed<ToolStatEntry | null>(() => {
    if (stats.value.length === 0) return null
    return stats.value.reduce((best, curr) =>
      curr.avgDurationMs < best.avgDurationMs ? curr : best,
    )
  })

  /** All errors across all tools, aggregated and sorted descending. */
  const aggregatedErrors = computed<Array<{ type: string; count: number }>>(() => {
    const errorMap = new Map<string, number>()
    for (const entry of stats.value) {
      for (const err of entry.topErrors) {
        errorMap.set(err.type, (errorMap.get(err.type) ?? 0) + err.count)
      }
    }
    return Array.from(errorMap.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
  })

  // ── Actions ───────────────────────────────────────

  /**
   * Replace stats from a single run's metadata payload.
   * Expects `metadata.toolStats` to be an array of ToolStatEntry-shaped objects.
   */
  function updateFromRunMetadata(metadata: Record<string, unknown>): void {
    if (metadata['toolStats'] && Array.isArray(metadata['toolStats'])) {
      stats.value = (metadata['toolStats'] as ToolStatEntry[]).map((entry) => ({
        toolName: String(entry.toolName ?? ''),
        totalCalls: Number(entry.totalCalls ?? 0),
        successRate: Number(entry.successRate ?? 0),
        avgDurationMs: Number(entry.avgDurationMs ?? 0),
        p95DurationMs: Number(entry.p95DurationMs ?? 0),
        score: Number(entry.score ?? 0),
        topErrors: Array.isArray(entry.topErrors)
          ? entry.topErrors.map((e) => ({
              type: String(e.type ?? ''),
              count: Number(e.count ?? 0),
            }))
          : [],
      }))
    }
  }

  /**
   * Aggregate tool stats across multiple run objects.
   * Merges stats for the same tool name using weighted averages.
   */
  function aggregateFromRuns(
    runs: Array<{ metadata?: Record<string, unknown> }>,
  ): void {
    const toolMap = new Map<string, {
      totalCalls: number
      successWeighted: number
      durationWeighted: number
      p95Max: number
      scoreWeighted: number
      errors: Map<string, number>
    }>()

    for (const run of runs) {
      if (!run.metadata?.['toolStats'] || !Array.isArray(run.metadata['toolStats'])) {
        continue
      }

      for (const raw of run.metadata['toolStats'] as ToolStatEntry[]) {
        const name = String(raw.toolName ?? '')
        const existing = toolMap.get(name)
        const calls = Number(raw.totalCalls ?? 0)

        if (existing) {
          existing.successWeighted += Number(raw.successRate ?? 0) * calls
          existing.durationWeighted += Number(raw.avgDurationMs ?? 0) * calls
          existing.p95Max = Math.max(existing.p95Max, Number(raw.p95DurationMs ?? 0))
          existing.scoreWeighted += Number(raw.score ?? 0) * calls
          existing.totalCalls += calls

          if (Array.isArray(raw.topErrors)) {
            for (const e of raw.topErrors) {
              const key = String(e.type ?? '')
              existing.errors.set(key, (existing.errors.get(key) ?? 0) + Number(e.count ?? 0))
            }
          }
        } else {
          const errors = new Map<string, number>()
          if (Array.isArray(raw.topErrors)) {
            for (const e of raw.topErrors) {
              errors.set(String(e.type ?? ''), Number(e.count ?? 0))
            }
          }
          toolMap.set(name, {
            totalCalls: calls,
            successWeighted: Number(raw.successRate ?? 0) * calls,
            durationWeighted: Number(raw.avgDurationMs ?? 0) * calls,
            p95Max: Number(raw.p95DurationMs ?? 0),
            scoreWeighted: Number(raw.score ?? 0) * calls,
            errors,
          })
        }
      }
    }

    stats.value = Array.from(toolMap.entries()).map(([toolName, data]) => ({
      toolName,
      totalCalls: data.totalCalls,
      successRate: data.totalCalls > 0 ? data.successWeighted / data.totalCalls : 0,
      avgDurationMs: data.totalCalls > 0 ? data.durationWeighted / data.totalCalls : 0,
      p95DurationMs: data.p95Max,
      score: data.totalCalls > 0 ? data.scoreWeighted / data.totalCalls : 0,
      topErrors: Array.from(data.errors.entries())
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count),
    }))
  }

  /** Clear all stats. */
  function clear(): void {
    stats.value = []
  }

  return {
    // State
    stats,
    isLoading,

    // Getters
    sortedStats,
    toolCount,
    avgSuccessRate,
    fastestTool,
    aggregatedErrors,

    // Actions
    updateFromRunMetadata,
    aggregateFromRuns,
    clear,
  }
})
