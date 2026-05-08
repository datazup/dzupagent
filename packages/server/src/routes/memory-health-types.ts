/** Minimal interface matching AdaptiveRetriever.health() */
export interface HealthProvider {
  health(): Array<{
    source: string
    successCount: number
    failureCount: number
    totalLatencyMs: number
    avgLatencyMs: number
    successRate: number
    lastFailure?: { error: string; timestamp: Date }
  }>
}

export interface MemoryHealthRouteConfig {
  retriever: HealthProvider
}
