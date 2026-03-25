/**
 * VEC-017: Vector-specific OTel metrics collector.
 *
 * Records and aggregates vector store operation metrics
 * (search latency, embedding latency, upsert counts) for
 * observability dashboards and alerting.
 */

/**
 * A single vector operation metric snapshot.
 */
export interface VectorMetrics {
  /** Time spent performing the vector search (ms) */
  searchLatencyMs: number
  /** Number of results returned by the search */
  searchResultCount: number
  /** Time spent generating the embedding (ms) */
  embeddingLatencyMs: number
  /** Number of tokens consumed by the embedding model */
  embeddingTokenCount?: number
  /** Estimated cost in cents for the embedding operation */
  embeddingCostCents?: number
  /** Number of vectors upserted in this operation */
  upsertCount: number
  /** Vector store provider name (e.g. 'qdrant', 'pinecone') */
  provider: string
  /** Collection/index name targeted */
  collection: string
}

/**
 * Aggregated report produced by VectorMetricsCollector.
 */
export interface VectorMetricsReport {
  totalSearches: number
  avgSearchLatencyMs: number
  totalEmbeddings: number
  avgEmbedLatencyMs: number
  byProvider: Record<string, number>
  byCollection: Record<string, number>
}

/**
 * Collects and aggregates VectorMetrics for reporting.
 *
 * @example
 * ```ts
 * const collector = new VectorMetricsCollector()
 * collector.record({
 *   searchLatencyMs: 12,
 *   searchResultCount: 5,
 *   embeddingLatencyMs: 45,
 *   upsertCount: 0,
 *   provider: 'qdrant',
 *   collection: 'features',
 * })
 * const report = collector.getReport()
 * console.log(report.avgSearchLatencyMs) // 12
 * ```
 */
export class VectorMetricsCollector {
  private metrics: VectorMetrics[] = []

  /**
   * Record a single vector operation metric.
   */
  record(metric: VectorMetrics): void {
    this.metrics.push(metric)
  }

  /**
   * Produce an aggregated report of all recorded metrics.
   */
  getReport(): VectorMetricsReport {
    const totalSearches = this.metrics.length
    const totalEmbeddings = this.metrics.length

    const avgSearchLatencyMs =
      totalSearches > 0
        ? this.metrics.reduce((sum, m) => sum + m.searchLatencyMs, 0) / totalSearches
        : 0

    const avgEmbedLatencyMs =
      totalEmbeddings > 0
        ? this.metrics.reduce((sum, m) => sum + m.embeddingLatencyMs, 0) / totalEmbeddings
        : 0

    const byProvider: Record<string, number> = {}
    const byCollection: Record<string, number> = {}

    for (const m of this.metrics) {
      byProvider[m.provider] = (byProvider[m.provider] ?? 0) + 1
      byCollection[m.collection] = (byCollection[m.collection] ?? 0) + 1
    }

    return {
      totalSearches,
      avgSearchLatencyMs,
      totalEmbeddings,
      avgEmbedLatencyMs,
      byProvider,
      byCollection,
    }
  }

  /**
   * Clear all recorded metrics.
   */
  reset(): void {
    this.metrics = []
  }
}
