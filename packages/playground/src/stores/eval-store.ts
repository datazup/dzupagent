/**
 * Eval store -- manages eval run lifecycle, list/detail refresh, and actions.
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  EvalHealth,
  EvalHealthResponse,
  EvalQueueStats,
  EvalQueueStatsResponse,
  EvalRunListResponse,
  EvalRunRecord,
  EvalRunResponse,
  EvalRunStatus,
} from '../types.js'
import { ApiRequestError, useApi } from '../composables/useApi.js'

const DEFAULT_LIMIT = 25
const DEFAULT_STATUS_FILTER: EvalRunStatus | 'all' = 'all'

function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404
}

function sortRuns(runs: EvalRunRecord[]): EvalRunRecord[] {
  return [...runs].sort((a, b) => {
    const queuedOrder = b.queuedAt.localeCompare(a.queuedAt)
    if (queuedOrder !== 0) return queuedOrder

    const createdOrder = b.createdAt.localeCompare(a.createdAt)
    if (createdOrder !== 0) return createdOrder

    return b.id.localeCompare(a.id)
  })
}

export const useEvalStore = defineStore('evals', () => {
  const { get, post } = useApi()

  const health = ref<EvalHealth | null>(null)
  const queueStats = ref<EvalQueueStats | null>(null)
  const runs = ref<EvalRunRecord[]>([])
  const selectedRun = ref<EvalRunRecord | null>(null)
  const isLoading = ref(false)
  const isLoadingDetail = ref(false)
  const isSubmitting = ref(false)
  const activeActionRunId = ref<string | null>(null)
  const error = ref<string | null>(null)
  const statusFilter = ref<EvalRunStatus | 'all'>(DEFAULT_STATUS_FILTER)
  const suiteIdFilter = ref('')
  const limit = ref(DEFAULT_LIMIT)

  const writable = computed(() => health.value?.writable ?? false)
  const mode = computed(() => health.value?.mode ?? 'read-only')
  const endpoints = computed(() => health.value?.endpoints ?? [])
  const filteredCounts = computed(() => {
    const counts: Record<EvalRunStatus, number> = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    }

    for (const run of runs.value) {
      counts[run.status] += 1
    }

    return counts
  })
  const runCount = computed(() => runs.value.length)
  const queueStatsAvailable = computed(() => endpoints.value.includes('/api/evals/queue/stats'))

  async function fetchHealth(): Promise<void> {
    try {
      const result = await get<EvalHealthResponse>('/api/evals/health')
      health.value = result.data
      if (queueStatsAvailable.value) {
        await fetchQueueStats()
      } else {
        queueStats.value = null
      }
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch eval health'
      health.value = null
    }
  }

  async function fetchQueueStats(): Promise<void> {
    try {
      const result = await get<EvalQueueStatsResponse>('/api/evals/queue/stats')
      queueStats.value = result.data.queue
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        queueStats.value = null
        return
      }
      queueStats.value = null
    }
  }

  async function fetchRuns(options?: {
    suiteId?: string
    status?: EvalRunStatus | 'all'
    limit?: number
  }): Promise<void> {
    isLoading.value = true
    error.value = null
    try {
      const params = new URLSearchParams()
      const suiteId = options?.suiteId ?? suiteIdFilter.value
      const status = options?.status ?? statusFilter.value
      const currentLimit = options?.limit ?? limit.value
      if (suiteId.trim()) params.set('suiteId', suiteId.trim())
      if (status !== 'all') params.set('status', status)
      params.set('limit', String(currentLimit))

      const result = await get<EvalRunListResponse>(`/api/evals/runs?${params.toString()}`)
      runs.value = sortRuns(result.data)
      limit.value = result.meta.filters.limit
      suiteIdFilter.value = result.meta.filters.suiteId ?? ''
      statusFilter.value = result.meta.filters.status ?? DEFAULT_STATUS_FILTER
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch eval runs'
    } finally {
      isLoading.value = false
    }
  }

  async function fetchRun(runId: string): Promise<EvalRunRecord | null> {
    isLoadingDetail.value = true
    error.value = null
    try {
      const result = await get<EvalRunResponse>(`/api/evals/runs/${runId}`)
      selectedRun.value = result.data
      return selectedRun.value
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch eval run'
      selectedRun.value = null
      return null
    } finally {
      isLoadingDetail.value = false
    }
  }

  async function createRun(suiteId: string, metadata?: Record<string, unknown>): Promise<EvalRunRecord | null> {
    isSubmitting.value = true
    error.value = null
    try {
      const result = await post<EvalRunResponse>('/api/evals/runs', { suiteId, metadata })
      upsertRun(result.data)
      selectedRun.value = result.data
      return result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to create eval run'
      return null
    } finally {
      isSubmitting.value = false
    }
  }

  async function cancelRun(runId: string): Promise<EvalRunRecord | null> {
    activeActionRunId.value = runId
    error.value = null
    try {
      const result = await post<EvalRunResponse>(`/api/evals/runs/${runId}/cancel`, {})
      upsertRun(result.data)
      if (selectedRun.value?.id === runId) {
        selectedRun.value = result.data
      }
      return result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to cancel eval run'
      return null
    } finally {
      activeActionRunId.value = null
    }
  }

  async function retryRun(runId: string): Promise<EvalRunRecord | null> {
    activeActionRunId.value = runId
    error.value = null
    try {
      const result = await post<EvalRunResponse>(`/api/evals/runs/${runId}/retry`, {})
      upsertRun(result.data)
      if (selectedRun.value?.id === runId) {
        selectedRun.value = result.data
      }
      return result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to retry eval run'
      return null
    } finally {
      activeActionRunId.value = null
    }
  }

  function setStatusFilter(status: EvalRunStatus | 'all'): void {
    statusFilter.value = status
  }

  function setSuiteIdFilter(value: string): void {
    suiteIdFilter.value = value
  }

  function setLimit(value: number): void {
    limit.value = Math.max(1, Math.min(250, Math.floor(value)))
  }

  function clearSelection(): void {
    selectedRun.value = null
  }

  function clearError(): void {
    error.value = null
  }

  function upsertRun(run: EvalRunRecord): void {
    const idx = runs.value.findIndex((current) => current.id === run.id)
    if (idx >= 0) {
      runs.value[idx] = run
    } else {
      runs.value = sortRuns([run, ...runs.value])
    }
  }

  return {
    health,
    queueStats,
    runs,
    selectedRun,
    isLoading,
    isLoadingDetail,
    isSubmitting,
    activeActionRunId,
    error,
    statusFilter,
    suiteIdFilter,
    limit,
    writable,
    mode,
    endpoints,
    filteredCounts,
    runCount,
    queueStatsAvailable,
    fetchHealth,
    fetchQueueStats,
    fetchRuns,
    fetchRun,
    createRun,
    cancelRun,
    retryRun,
    setStatusFilter,
    setSuiteIdFilter,
    setLimit,
    clearSelection,
    clearError,
  }
})
