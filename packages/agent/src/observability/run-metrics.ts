/**
 * Run-level observability analytics.
 *
 * Aggregates per-run metrics (duration, cost, tokens, tool calls, status)
 * into both per-run summaries and cross-run aggregates suitable for
 * dashboards (success rate, avg duration, cost per provider).
 *
 * Designed to be fed by the DzupEventBus (see {@link
 * ./event-bus-bridge.js}), but the API is also usable directly for
 * synthetic tests and bespoke ingestion paths.
 */

/** Token usage breakdown for a run. */
export interface RunTokenUsage {
  input: number
  output: number
  cached: number
}

/** Per-run metrics row maintained by the aggregator. */
export interface RunSummaryMetrics {
  runId: string
  providerId: string
  /** Unix epoch milliseconds of run start. */
  startedAt: number
  /** Unix epoch milliseconds of run termination, or null while running. */
  completedAt: number | null
  /** Wall-clock duration in milliseconds, or null while running. */
  durationMs: number | null
  status: 'running' | 'completed' | 'failed' | 'paused'
  tokenUsage: RunTokenUsage
  /** Total cost in millionths of a dollar (1_000_000 micros = $1). */
  costMicros: number
  toolCallCount: number
  errorCount: number
}

/** Per-provider rollup contained in {@link AggregatedMetrics}. */
export interface ProviderRollup {
  runs: number
  successRate: number
  avgCostMicros: number
}

/** Cross-run aggregate metrics. */
export interface AggregatedMetrics {
  totalRuns: number
  completedRuns: number
  failedRuns: number
  /** Completed / (completed + failed). 0 if neither is present. */
  successRate: number
  avgDurationMs: number | null
  totalCostMicros: number
  avgCostMicros: number | null
  totalTokens: number
  byProvider: Record<string, ProviderRollup>
}

/** Default retention window: 24 hours in ms. */
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000

function emptyTokenUsage(): RunTokenUsage {
  return { input: 0, output: 0, cached: 0 }
}

/**
 * In-memory aggregator for run-level observability metrics.
 *
 * Not thread-safe across processes — each aggregator owns a Map and is
 * intended to back a single dashboard/process. For multi-process
 * deployments, run one aggregator per node and merge results upstream.
 */
export class RunMetricsAggregator {
  private runs = new Map<string, RunSummaryMetrics>()
  private readonly clock: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.clock = opts.now ?? (() => Date.now())
  }

  /** Record a run start. Idempotent — repeated calls reset the row. */
  recordStart(runId: string, providerId: string): void {
    const startedAt = this.clock()
    this.runs.set(runId, {
      runId,
      providerId,
      startedAt,
      completedAt: null,
      durationMs: null,
      status: 'running',
      tokenUsage: emptyTokenUsage(),
      costMicros: 0,
      toolCallCount: 0,
      errorCount: 0,
    })
  }

  /** Record successful completion. No-op if the run was never started. */
  recordComplete(
    runId: string,
    tokenUsage: RunTokenUsage,
    costMicros: number,
  ): void {
    const row = this.runs.get(runId)
    if (!row) return
    const completedAt = this.clock()
    row.completedAt = completedAt
    row.durationMs = Math.max(0, completedAt - row.startedAt)
    row.status = 'completed'
    row.tokenUsage = {
      input: tokenUsage.input,
      output: tokenUsage.output,
      cached: tokenUsage.cached,
    }
    row.costMicros = costMicros
  }

  /** Record a failure. No-op if the run was never started. */
  recordFailure(runId: string, errorCount = 1): void {
    const row = this.runs.get(runId)
    if (!row) return
    const completedAt = this.clock()
    row.completedAt = completedAt
    row.durationMs = Math.max(0, completedAt - row.startedAt)
    row.status = 'failed'
    row.errorCount += errorCount
  }

  /** Increment the tool-call counter for a run. No-op if unknown. */
  recordToolCall(runId: string): void {
    const row = this.runs.get(runId)
    if (!row) return
    row.toolCallCount += 1
  }

  /** Mark a run as paused (e.g. awaiting human approval). */
  recordPause(runId: string): void {
    const row = this.runs.get(runId)
    if (!row) return
    row.status = 'paused'
  }

  /** Get the metrics row for a single run. */
  getRunMetrics(runId: string): RunSummaryMetrics | undefined {
    const row = this.runs.get(runId)
    if (!row) return undefined
    // Return a defensive shallow clone so external callers cannot mutate
    // internal state. tokenUsage is the only nested object.
    return { ...row, tokenUsage: { ...row.tokenUsage } }
  }

  /** Aggregate across all retained runs, optionally filtered. */
  getAggregated(filter: { providerId?: string; since?: number } = {}): AggregatedMetrics {
    const rows: RunSummaryMetrics[] = []
    for (const row of this.runs.values()) {
      if (filter.providerId && row.providerId !== filter.providerId) continue
      if (filter.since !== undefined && row.startedAt < filter.since) continue
      rows.push(row)
    }

    const totalRuns = rows.length
    let completedRuns = 0
    let failedRuns = 0
    let totalCostMicros = 0
    let totalTokens = 0
    let durationSum = 0
    let durationCount = 0

    const byProviderTmp = new Map<
      string,
      { runs: number; successes: number; failures: number; costSum: number }
    >()

    for (const row of rows) {
      if (row.status === 'completed') completedRuns += 1
      if (row.status === 'failed') failedRuns += 1

      totalCostMicros += row.costMicros
      totalTokens += row.tokenUsage.input + row.tokenUsage.output + row.tokenUsage.cached

      if (row.durationMs !== null) {
        durationSum += row.durationMs
        durationCount += 1
      }

      let bucket = byProviderTmp.get(row.providerId)
      if (!bucket) {
        bucket = { runs: 0, successes: 0, failures: 0, costSum: 0 }
        byProviderTmp.set(row.providerId, bucket)
      }
      bucket.runs += 1
      if (row.status === 'completed') bucket.successes += 1
      if (row.status === 'failed') bucket.failures += 1
      bucket.costSum += row.costMicros
    }

    const terminalCount = completedRuns + failedRuns
    const successRate = terminalCount === 0 ? 0 : completedRuns / terminalCount
    const avgDurationMs = durationCount === 0 ? null : durationSum / durationCount
    const avgCostMicros = totalRuns === 0 ? null : totalCostMicros / totalRuns

    const byProvider: Record<string, ProviderRollup> = {}
    for (const [pid, b] of byProviderTmp.entries()) {
      const terminals = b.successes + b.failures
      byProvider[pid] = {
        runs: b.runs,
        successRate: terminals === 0 ? 0 : b.successes / terminals,
        avgCostMicros: b.runs === 0 ? 0 : b.costSum / b.runs,
      }
    }

    return {
      totalRuns,
      completedRuns,
      failedRuns,
      successRate,
      avgDurationMs,
      totalCostMicros,
      avgCostMicros,
      totalTokens,
      byProvider,
    }
  }

  /**
   * Drop runs whose `startedAt` is older than the retention window.
   * Returns the number of evicted rows.
   */
  evict(retentionMs: number = DEFAULT_RETENTION_MS): number {
    const cutoff = this.clock() - retentionMs
    let removed = 0
    for (const [runId, row] of this.runs.entries()) {
      if (row.startedAt < cutoff) {
        this.runs.delete(runId)
        removed += 1
      }
    }
    return removed
  }

  /** Number of retained run rows (mostly for diagnostics/tests). */
  size(): number {
    return this.runs.size
  }

  /** Drop all rows. Mainly for tests and manual reset. */
  clear(): void {
    this.runs.clear()
  }
}
