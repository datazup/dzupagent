/**
 * Composable for fetching memory analytics data from the DzupAgent server.
 *
 * Provides reactive state for each analytics view with configurable
 * auto-polling and error handling.
 *
 * @example
 * ```ts
 * const { decayTrends, namespaceStat, refresh, isLoading, error } = useMemoryAnalytics()
 * ```
 */
import { ref, onUnmounted, type Ref } from 'vue'
import { useApi } from './useApi.js'

// ---------------------------------------------------------------------------
// Result types (mirror server-side AnalyticsJsonResult shape)
// ---------------------------------------------------------------------------

export interface AnalyticsJsonResult<T = Record<string, unknown>> {
  rows: T[]
  rowCount: number
  executionMs: number
}

export interface DecayTrendPoint {
  namespace: string
  bucket: string
  avg_strength: number
  min_strength: number
  max_strength: number
  count: number
}

export interface NamespaceStatsRow {
  namespace: string
  total_memories: number
  active_memories: number
  avg_strength: number
  avg_importance: number
  oldest_created: number
  newest_created: number
}

export interface ExpiringMemoryRow {
  id: string
  namespace: string
  decay_strength: number
  expires_in_ms: number
}

export interface AgentPerformanceRow {
  agent_id: string
  total_memories: number
  avg_importance: number
  categories: string[]
  active_ratio: number
}

export interface UsagePatternBucket {
  bucket_start: number
  access_count: number
  unique_memories: number
}

export interface DuplicateCandidateRow {
  id_a: string
  id_b: string
  text_a: string
  text_b: string
  namespace: string
}

// ---------------------------------------------------------------------------
// API response wrappers
// ---------------------------------------------------------------------------

interface ApiDataResponse<T> {
  data: AnalyticsJsonResult<T>
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export interface UseMemoryAnalyticsOptions {
  /** Auto-refresh interval in milliseconds. Set to 0 to disable. Default: 30000 (30s). */
  pollIntervalMs?: number
  /** Default namespace for queries. Default: 'lessons'. */
  namespace?: string
  /** Default scope JSON for queries. Default: '{}'. */
  scope?: string
}

export function useMemoryAnalytics(options: UseMemoryAnalyticsOptions = {}) {
  const { get } = useApi()

  const pollIntervalMs = ref(options.pollIntervalMs ?? 30_000)
  const namespace = ref(options.namespace ?? 'lessons')
  const scope = ref(options.scope ?? '{}')

  // Reactive state
  const decayTrends: Ref<AnalyticsJsonResult<DecayTrendPoint> | null> = ref(null)
  const namespaceStats: Ref<AnalyticsJsonResult<NamespaceStatsRow> | null> = ref(null)
  const expiringMemories: Ref<AnalyticsJsonResult<ExpiringMemoryRow> | null> = ref(null)
  const agentPerformance: Ref<AnalyticsJsonResult<AgentPerformanceRow> | null> = ref(null)
  const usagePatterns: Ref<AnalyticsJsonResult<UsagePatternBucket> | null> = ref(null)
  const duplicates: Ref<AnalyticsJsonResult<DuplicateCandidateRow> | null> = ref(null)

  const isLoading = ref(false)
  const error: Ref<string | null> = ref(null)
  const isDuckDBUnavailable = ref(false)

  let pollTimer: ReturnType<typeof setInterval> | null = null

  // Build query string with namespace and scope
  function queryParams(extra: Record<string, string> = {}): string {
    const params = new URLSearchParams({
      namespace: namespace.value,
      scope: scope.value,
      ...extra,
    })
    return params.toString()
  }

  // Individual fetch functions
  async function fetchDecayTrends(window: 'hour' | 'day' | 'week' = 'day'): Promise<void> {
    try {
      const result = await get<ApiDataResponse<DecayTrendPoint>>(
        `/api/memory/analytics/decay-trends?${queryParams({ window })}`,
      )
      decayTrends.value = result.data
    } catch (err: unknown) {
      handleFetchError(err)
    }
  }

  async function fetchNamespaceStats(): Promise<void> {
    try {
      const result = await get<ApiDataResponse<NamespaceStatsRow>>(
        `/api/memory/analytics/namespace-stats?${queryParams()}`,
      )
      namespaceStats.value = result.data
    } catch (err: unknown) {
      handleFetchError(err)
    }
  }

  async function fetchExpiringMemories(horizonMs = 86_400_000): Promise<void> {
    try {
      const result = await get<ApiDataResponse<ExpiringMemoryRow>>(
        `/api/memory/analytics/expiring?${queryParams({ horizonMs: String(horizonMs) })}`,
      )
      expiringMemories.value = result.data
    } catch (err: unknown) {
      handleFetchError(err)
    }
  }

  async function fetchAgentPerformance(): Promise<void> {
    try {
      const result = await get<ApiDataResponse<AgentPerformanceRow>>(
        `/api/memory/analytics/agent-performance?${queryParams()}`,
      )
      agentPerformance.value = result.data
    } catch (err: unknown) {
      handleFetchError(err)
    }
  }

  async function fetchUsagePatterns(bucketMs = 3_600_000): Promise<void> {
    try {
      const result = await get<ApiDataResponse<UsagePatternBucket>>(
        `/api/memory/analytics/usage-patterns?${queryParams({ bucketMs: String(bucketMs) })}`,
      )
      usagePatterns.value = result.data
    } catch (err: unknown) {
      handleFetchError(err)
    }
  }

  async function fetchDuplicates(prefixLength = 50): Promise<void> {
    try {
      const result = await get<ApiDataResponse<DuplicateCandidateRow>>(
        `/api/memory/analytics/duplicates?${queryParams({ prefixLength: String(prefixLength) })}`,
      )
      duplicates.value = result.data
    } catch (err: unknown) {
      handleFetchError(err)
    }
  }

  function handleFetchError(err: unknown): void {
    if (err instanceof Error) {
      // Check for 503 (DuckDB unavailable)
      if ('status' in err && (err as { status: number }).status === 503) {
        isDuckDBUnavailable.value = true
        error.value = 'DuckDB analytics engine is not available. Install @duckdb/duckdb-wasm to enable memory analytics.'
        return
      }
      error.value = err.message
    } else {
      error.value = String(err)
    }
  }

  /** Refresh all analytics views. */
  async function refreshAll(): Promise<void> {
    isLoading.value = true
    error.value = null

    try {
      await Promise.all([
        fetchDecayTrends(),
        fetchNamespaceStats(),
        fetchExpiringMemories(),
        fetchAgentPerformance(),
        fetchUsagePatterns(),
        fetchDuplicates(),
      ])
    } finally {
      isLoading.value = false
    }
  }

  /** Start auto-polling at the configured interval. */
  function startPolling(): void {
    stopPolling()
    if (pollIntervalMs.value <= 0) return
    pollTimer = setInterval(() => {
      void refreshAll()
    }, pollIntervalMs.value)
  }

  /** Stop auto-polling. */
  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  /** Update polling interval. Pass 0 to disable. */
  function setPollInterval(ms: number): void {
    pollIntervalMs.value = ms
    if (ms > 0) {
      startPolling()
    } else {
      stopPolling()
    }
  }

  // Cleanup on unmount
  onUnmounted(() => {
    stopPolling()
  })

  return {
    // State
    decayTrends,
    namespaceStats,
    expiringMemories,
    agentPerformance,
    usagePatterns,
    duplicates,
    isLoading,
    error,
    isDuckDBUnavailable,

    // Config
    namespace,
    scope,
    pollIntervalMs,

    // Actions
    fetchDecayTrends,
    fetchNamespaceStats,
    fetchExpiringMemories,
    fetchAgentPerformance,
    fetchUsagePatterns,
    fetchDuplicates,
    refreshAll,
    startPolling,
    stopPolling,
    setPollInterval,
  }
}
