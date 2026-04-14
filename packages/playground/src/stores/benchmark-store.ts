/**
 * Benchmark store -- manages benchmark run lifecycle, baselines, and comparisons.
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ApiRequestError, useApi } from '../composables/useApi.js'
import type {
  BenchmarkBaselineListResponse,
  BenchmarkBaselineRecord,
  BenchmarkBaselineResponse,
  BenchmarkCompareRecord,
  BenchmarkCompareResponse,
  BenchmarkRunCreateInput,
  BenchmarkRunListQuery,
  BenchmarkRunListResponse,
  BenchmarkRunRecord,
  BenchmarkRunResponse,
} from '../types.js'

const RECENT_RUN_IDS_KEY = 'dzupagent.playground.benchmark.recentRunIds'
const MAX_RECENT_RUN_IDS = 12
const DEFAULT_HISTORY_LIMIT = 25

type HistorySource = 'server' | 'session'

function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404
}

function sortRuns(runs: BenchmarkRunRecord[]): BenchmarkRunRecord[] {
  return [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function mergeRuns(existing: BenchmarkRunRecord[], incoming: BenchmarkRunRecord[]): BenchmarkRunRecord[] {
  const merged = new Map<string, BenchmarkRunRecord>()

  for (const run of existing) {
    merged.set(run.id, run)
  }

  for (const run of incoming) {
    merged.set(run.id, run)
  }

  return sortRuns(Array.from(merged.values()))
}

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null

  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function readRecentRunIds(): string[] {
  const storage = getSessionStorage()
  if (!storage) return []

  try {
    const raw = storage.getItem(RECENT_RUN_IDS_KEY)
    if (!raw) return []

    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []

    return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0)
  } catch {
    return []
  }
}

function writeRecentRunIds(ids: string[]): void {
  const storage = getSessionStorage()
  if (!storage) return

  try {
    storage.setItem(RECENT_RUN_IDS_KEY, JSON.stringify(ids))
  } catch {
    // Ignore storage quota / availability issues.
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let code = 'UNKNOWN_ERROR'
    let message = `Request failed with status ${response.status}`

    try {
      const body = await response.json() as { error?: { code?: string; message?: string } }
      if (body.error) {
        code = body.error.code ?? code
        message = body.error.message ?? message
      }
    } catch {
      // Fall back to defaults when the response is not JSON.
    }

    throw new ApiRequestError(response.status, code, message)
  }

  return response.json() as Promise<T>
}

export const useBenchmarkStore = defineStore('benchmarks', () => {
  const { get, post, buildUrl } = useApi()

  const runCache = ref<Record<string, BenchmarkRunRecord>>({})
  const serverRuns = ref<BenchmarkRunRecord[]>([])
  const recentRunIds = ref<string[]>(readRecentRunIds())
  const baselines = ref<BenchmarkBaselineRecord[]>([])
  const selectedRun = ref<BenchmarkRunRecord | null>(null)
  const comparison = ref<BenchmarkCompareRecord | null>(null)
  const isLoading = ref(false)
  const isLoadingHistory = ref(false)
  const isLoadingHistoryMore = ref(false)
  const isLoadingDetail = ref(false)
  const isLoadingBaselines = ref(false)
  const isSubmitting = ref(false)
  const isSettingBaseline = ref(false)
  const isComparing = ref(false)
  const error = ref<string | null>(null)
  const historySource = ref<HistorySource | null>(null)
  const historyNextCursor = ref<string | null>(null)
  const historyHasMore = ref(false)
  const historyQuery = ref<BenchmarkRunListQuery | null>(null)
  let activeDetailRequestId = 0

  const recentRuns = computed(() => {
    return recentRunIds.value
      .map((runId) => runCache.value[runId])
      .filter((run): run is BenchmarkRunRecord => Boolean(run))
  })

  const isSessionFallback = computed(() => historySource.value === 'session')

  const historyRuns = computed(() => {
    return historySource.value === 'server' ? serverRuns.value : recentRuns.value
  })

  const baselineCount = computed(() => baselines.value.length)

  function normalizeHistoryQuery(filter?: BenchmarkRunListQuery): BenchmarkRunListQuery {
    return {
      ...(filter?.suiteId ? { suiteId: filter.suiteId } : {}),
      ...(filter?.targetId ? { targetId: filter.targetId } : {}),
      limit: filter?.limit ?? DEFAULT_HISTORY_LIMIT,
      ...(filter?.cursor ? { cursor: filter.cursor } : {}),
    }
  }

  function buildHistoryQuery(filter?: BenchmarkRunListQuery): string {
    const params = new URLSearchParams()
    if (filter?.suiteId) params.set('suiteId', filter.suiteId)
    if (filter?.targetId) params.set('targetId', filter.targetId)
    params.set('limit', String(filter?.limit ?? DEFAULT_HISTORY_LIMIT))
    if (filter?.cursor) params.set('cursor', filter.cursor)
    return params.toString()
  }

  function rememberRunId(runId: string): void {
    const next = [runId, ...recentRunIds.value.filter((id) => id !== runId)].slice(0, MAX_RECENT_RUN_IDS)
    recentRunIds.value = next
    writeRecentRunIds(next)
  }

  function upsertRun(run: BenchmarkRunRecord, remember = true): void {
    runCache.value = {
      ...runCache.value,
      [run.id]: run,
    }
    if (remember) {
      rememberRunId(run.id)
    }
  }

  function upsertBaseline(baseline: BenchmarkBaselineRecord): void {
    const idx = baselines.value.findIndex(
      (current) => current.suiteId === baseline.suiteId && current.targetId === baseline.targetId,
    )
    if (idx >= 0) {
      baselines.value[idx] = baseline
      return
    }

    baselines.value = [baseline, ...baselines.value]
  }

  function updateServerHistory(
    runs: BenchmarkRunRecord[],
    meta: { hasMore?: boolean; nextCursor?: string | null },
    append = false,
  ): BenchmarkRunRecord[] {
    const nextRuns = append ? mergeRuns(serverRuns.value, runs) : sortRuns(runs)
    serverRuns.value = nextRuns
    historySource.value = 'server'
    historyNextCursor.value = meta.nextCursor ?? null
    historyHasMore.value = meta.hasMore ?? Boolean(meta.nextCursor)
    runs.forEach((run) => upsertRun(run, false))
    return nextRuns
  }

  function extractPaginationMeta(meta: BenchmarkRunListResponse['meta']): { hasMore?: boolean; nextCursor?: string | null } {
    if (meta.pagination) {
      return {
        hasMore: meta.pagination.hasMore,
        nextCursor: meta.pagination.nextCursor,
      }
    }

    return {
      hasMore: meta.hasMore,
      nextCursor: meta.nextCursor,
    }
  }

  async function fetchRunRecord(runId: string): Promise<BenchmarkRunRecord | null> {
    try {
      const result = await get<BenchmarkRunResponse>(`/api/benchmarks/runs/${runId}`)
      return result.data
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        return null
      }
      throw err
    }
  }

  async function fetchRuns(
    filter?: BenchmarkRunListQuery,
    options?: { append?: boolean },
  ): Promise<BenchmarkRunRecord[]> {
    const append = options?.append === true
    const query = normalizeHistoryQuery(filter)
    const params = buildHistoryQuery(query)

    isLoading.value = true
    if (append) {
      isLoadingHistoryMore.value = true
    } else {
      isLoadingHistory.value = true
    }
    error.value = null
    try {
      const result = await get<BenchmarkRunListResponse>(
        `/api/benchmarks/runs${params ? `?${params}` : ''}`,
      )
      const runs = updateServerHistory(result.data, extractPaginationMeta(result.meta), append)
      if (!append) {
        historyQuery.value = query
      }
      return runs
    } catch (err: unknown) {
      if (!append) {
        serverRuns.value = []
        historySource.value = null
        historyNextCursor.value = null
        historyHasMore.value = false
        historyQuery.value = query
      }
      if (!isNotFoundError(err)) {
        error.value = err instanceof Error ? err.message : 'Failed to load benchmark runs'
      }
      return []
    } finally {
      if (append) {
        isLoadingHistoryMore.value = false
      } else {
        isLoadingHistory.value = false
      }
      isLoading.value = false
    }
  }

  async function loadHistory(filter?: BenchmarkRunListQuery): Promise<BenchmarkRunRecord[]> {
    const serverHistory = await fetchRuns(filter)
    if (historySource.value === 'server') {
      return serverHistory
    }

    historySource.value = 'session'
    historyNextCursor.value = null
    historyHasMore.value = false
    await loadRecentRuns({ asFallback: true })
    return recentRuns.value
  }

  async function loadMoreHistory(): Promise<BenchmarkRunRecord[]> {
    if (historySource.value !== 'server' || !historyHasMore.value || !historyNextCursor.value) {
      return historyRuns.value
    }

    const query = historyQuery.value ?? normalizeHistoryQuery()
    return fetchRuns({
      ...query,
      cursor: historyNextCursor.value,
    }, {
      append: true,
    })
  }

  async function loadRecentRuns(options?: { asFallback?: boolean }): Promise<void> {
    isLoading.value = true
    try {
      if (options?.asFallback) {
        historySource.value = 'session'
      }

      const storedIds = readRecentRunIds()
      recentRunIds.value = storedIds

      const resolvedIds: string[] = []
      for (const runId of storedIds) {
        const cached = runCache.value[runId]
        if (cached) {
          resolvedIds.push(runId)
          continue
        }

        const run = await fetchRunRecord(runId)
        if (run) {
          upsertRun(run, false)
          resolvedIds.push(runId)
        }
      }

      recentRunIds.value = resolvedIds
      writeRecentRunIds(resolvedIds)
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to load benchmark runs'
    } finally {
      isLoading.value = false
    }
  }

  async function fetchRun(runId: string): Promise<BenchmarkRunRecord | null> {
    const requestId = ++activeDetailRequestId
    isLoadingDetail.value = true
    error.value = null
    try {
      const run = await fetchRunRecord(runId)
      if (!run) {
        if (requestId === activeDetailRequestId) {
          selectedRun.value = null
        }
        return null
      }

      upsertRun(run)
      if (requestId === activeDetailRequestId) {
        selectedRun.value = run
      }
      return run
    } catch (err: unknown) {
      if (requestId === activeDetailRequestId) {
        error.value = err instanceof Error ? err.message : 'Failed to fetch benchmark run'
        selectedRun.value = null
      }
      return null
    } finally {
      if (requestId === activeDetailRequestId) {
        isLoadingDetail.value = false
      }
    }
  }

  async function createRun(input: BenchmarkRunCreateInput): Promise<BenchmarkRunRecord | null> {
    isSubmitting.value = true
    error.value = null
    try {
      const result = await post<BenchmarkRunResponse>('/api/benchmarks/runs', input)
      upsertRun(result.data)
      selectedRun.value = result.data
      comparison.value = null
      return result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to create benchmark run'
      return null
    } finally {
      isSubmitting.value = false
    }
  }

  async function compareRun(currentRunId: string, previousRunId?: string): Promise<BenchmarkCompareRecord | null> {
    isComparing.value = true
    error.value = null
    try {
      const payload = previousRunId
        ? { currentRunId, previousRunId }
        : { currentRunId }
      const result = await post<BenchmarkCompareResponse>('/api/benchmarks/compare', payload)
      upsertRun(result.data.previousRun, false)
      upsertRun(result.data.currentRun)
      comparison.value = result.data
      return result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to compare benchmark runs'
      return null
    } finally {
      isComparing.value = false
    }
  }

  async function fetchBaselines(filter?: { suiteId?: string; targetId?: string }): Promise<void> {
    isLoadingBaselines.value = true
    error.value = null
    try {
      const params = new URLSearchParams()
      if (filter?.suiteId) params.set('suiteId', filter.suiteId)
      if (filter?.targetId) params.set('targetId', filter.targetId)

      const result = await get<BenchmarkBaselineListResponse>(
        `/api/benchmarks/baselines${params.toString() ? `?${params.toString()}` : ''}`,
      )
      baselines.value = result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch benchmark baselines'
      baselines.value = []
    } finally {
      isLoadingBaselines.value = false
    }
  }

  async function setBaseline(input: { suiteId: string; targetId: string; runId: string }): Promise<BenchmarkBaselineRecord | null> {
    if (isSettingBaseline.value) {
      return null
    }

    isSettingBaseline.value = true
    error.value = null
    try {
      const response = await fetch(buildUrl(`/api/benchmarks/baselines/${encodeURIComponent(input.suiteId)}`), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          targetId: input.targetId,
          runId: input.runId,
        }),
      })
      const result = await parseJsonResponse<BenchmarkBaselineResponse>(response)
      upsertBaseline(result.data)
      return result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to save benchmark baseline'
      return null
    } finally {
      isSettingBaseline.value = false
    }
  }

  function clearSelection(): void {
    selectedRun.value = null
  }

  function clearComparison(): void {
    comparison.value = null
  }

  function clearError(): void {
    error.value = null
  }

  function findBaseline(suiteId: string, targetId: string): BenchmarkBaselineRecord | null {
    return baselines.value.find((baseline) => baseline.suiteId === suiteId && baseline.targetId === targetId) ?? null
  }

  return {
    recentRunIds,
    recentRuns,
    historyRuns,
    historySource,
    isSessionFallback,
    isLoadingHistory,
    isLoadingHistoryMore,
    historyHasMore,
    historyNextCursor,
    baselines,
    baselineCount,
    selectedRun,
    comparison,
    isLoading,
    isLoadingDetail,
    isLoadingBaselines,
    isSubmitting,
    isSettingBaseline,
    isComparing,
    error,
    fetchRuns,
    loadHistory,
    loadMoreHistory,
    loadRecentRuns,
    fetchRun,
    createRun,
    compareRun,
    fetchBaselines,
    setBaseline,
    clearSelection,
    clearComparison,
    clearError,
    findBaseline,
  }
})
