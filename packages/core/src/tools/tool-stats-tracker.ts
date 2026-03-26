/**
 * ToolStatsTracker — tracks per-tool success rates and latency
 * for adaptive tool ranking.
 *
 * Pure in-memory, no persistence. Callers can serialize/persist if needed.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  toolName: string
  intent?: string
  success: boolean
  durationMs: number
  timestamp: number
  errorType?: string
}

export interface ToolStats {
  toolName: string
  totalCalls: number
  successCount: number
  failureCount: number
  successRate: number
  avgDurationMs: number
  p95DurationMs: number
  lastUsed: number
  /** Common error types sorted by frequency descending */
  topErrors: Array<{ type: string; count: number }>
}

export interface ToolRanking {
  toolName: string
  /** Combined score 0-1 (higher = better) */
  score: number
  successRate: number
  avgLatencyMs: number
  callCount: number
}

export interface ToolStatsTrackerConfig {
  /** Max records per tool (sliding window, default: 200) */
  windowSize?: number
  /** Weight of success rate in the combined score (default: 0.7) */
  successWeight?: number
  /** Weight of normalized speed in the combined score (default: 0.3) */
  latencyWeight?: number
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_SIZE = 200
const DEFAULT_SUCCESS_WEIGHT = 0.7
const DEFAULT_LATENCY_WEIGHT = 0.3

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ToolStatsTracker {
  private readonly records = new Map<string, ToolCallRecord[]>()
  private readonly windowSize: number
  private readonly successWeight: number
  private readonly latencyWeight: number

  constructor(config?: ToolStatsTrackerConfig) {
    this.windowSize = config?.windowSize ?? DEFAULT_WINDOW_SIZE
    this.successWeight = config?.successWeight ?? DEFAULT_SUCCESS_WEIGHT
    this.latencyWeight = config?.latencyWeight ?? DEFAULT_LATENCY_WEIGHT
  }

  /** Record a tool call outcome. */
  recordCall(record: ToolCallRecord): void {
    const { toolName } = record
    let list = this.records.get(toolName)
    if (!list) {
      list = []
      this.records.set(toolName, list)
    }
    list.push(record)
    // Sliding window eviction
    if (list.length > this.windowSize) {
      // Remove oldest entries that exceed the window
      const excess = list.length - this.windowSize
      list.splice(0, excess)
    }
  }

  /** Get stats for a specific tool. Returns null if no records exist. */
  getStats(toolName: string): ToolStats | null {
    const list = this.records.get(toolName)
    if (!list || list.length === 0) return null
    return this.computeStats(toolName, list)
  }

  /**
   * Get top-ranked tools, optionally filtered by intent.
   * Returns tools sorted by combined score descending.
   */
  getTopTools(limit?: number, intent?: string): ToolRanking[] {
    const rankings: ToolRanking[] = []

    // Compute per-tool avg duration for normalization
    const avgDurations = new Map<string, number>()
    let maxAvgDuration = 0

    for (const [toolName, allRecords] of this.records) {
      const records = intent
        ? allRecords.filter((r) => r.intent === intent)
        : allRecords
      if (records.length === 0) continue

      const avgDur =
        records.reduce((sum, r) => sum + r.durationMs, 0) / records.length
      avgDurations.set(toolName, avgDur)
      if (avgDur > maxAvgDuration) maxAvgDuration = avgDur
    }

    for (const [toolName, allRecords] of this.records) {
      const records = intent
        ? allRecords.filter((r) => r.intent === intent)
        : allRecords
      if (records.length === 0) continue

      const successCount = records.filter((r) => r.success).length
      const successRate = successCount / records.length
      const avgLatencyMs = avgDurations.get(toolName) ?? 0

      // normalizedSpeed: 1 means fastest, 0 means slowest
      const normalizedSpeed =
        maxAvgDuration > 0
          ? Math.max(0, Math.min(1, 1 - avgLatencyMs / maxAvgDuration))
          : 1

      const score =
        successRate * this.successWeight + normalizedSpeed * this.latencyWeight

      rankings.push({
        toolName,
        score,
        successRate,
        avgLatencyMs,
        callCount: records.length,
      })
    }

    rankings.sort((a, b) => b.score - a.score)

    return limit !== undefined ? rankings.slice(0, limit) : rankings
  }

  /** Get all tracked tool names. */
  getTrackedTools(): string[] {
    return Array.from(this.records.keys())
  }

  /** Format top tools as a system prompt hint string. */
  formatAsPromptHint(limit?: number, intent?: string): string {
    const top = this.getTopTools(limit ?? 5, intent)
    if (top.length === 0) return ''

    const lines = top.map(
      (t, i) =>
        `${i + 1}. ${t.toolName} (${Math.round(t.successRate * 100)}% success)`,
    )
    return `Preferred tools for this task:\n${lines.join('\n')}`
  }

  /** Reset all tracked stats. */
  reset(): void {
    this.records.clear()
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private computeStats(toolName: string, records: ToolCallRecord[]): ToolStats {
    const totalCalls = records.length
    const successCount = records.filter((r) => r.success).length
    const failureCount = totalCalls - successCount
    const successRate = totalCalls > 0 ? successCount / totalCalls : 0

    const durations = records.map((r) => r.durationMs)
    const avgDurationMs =
      durations.reduce((sum, d) => sum + d, 0) / durations.length

    // p95: sort ascending, pick 95th percentile index
    const sorted = [...durations].sort((a, b) => a - b)
    const p95Index = Math.ceil(sorted.length * 0.95) - 1
    const p95DurationMs = sorted[Math.max(0, p95Index)] ?? 0

    const lastUsed = Math.max(...records.map((r) => r.timestamp))

    // Top errors: group by errorType, count, sort descending
    const errorCounts = new Map<string, number>()
    for (const r of records) {
      if (!r.success && r.errorType) {
        errorCounts.set(r.errorType, (errorCounts.get(r.errorType) ?? 0) + 1)
      }
    }
    const topErrors = Array.from(errorCounts.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)

    return {
      toolName,
      totalCalls,
      successCount,
      failureCount,
      successRate,
      avgDurationMs,
      p95DurationMs,
      lastUsed,
      topErrors,
    }
  }
}
