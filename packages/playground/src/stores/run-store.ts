/**
 * Run store -- manages run lifecycle: list, detail, logs, trace, cancel, approve/reject.
 *
 * Powers the HistoryTab and RunDetailView with full access to
 * the /api/runs/* endpoints.
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  RunHistoryEntry,
  RunLogEntry,
  RunTrace,
  ApiResponse,
  RunStatus,
} from '../types.js'
import { useApi } from '../composables/useApi.js'

export const useRunStore = defineStore('run', () => {
  const { get, post } = useApi()

  // ── State ─────────────────────────────────────────
  const runs = ref<RunHistoryEntry[]>([])
  const selectedRun = ref<RunHistoryEntry | null>(null)
  const runLogs = ref<RunLogEntry[]>([])
  const runTrace = ref<RunTrace | null>(null)
  const isLoading = ref(false)
  const isLoadingDetail = ref(false)
  const error = ref<string | null>(null)
  const statusFilter = ref<RunStatus | 'all'>('all')
  const totalCount = ref(0)

  // ── Getters ───────────────────────────────────────
  const filteredRuns = computed(() => {
    if (statusFilter.value === 'all') return runs.value
    return runs.value.filter((r) => r.status === statusFilter.value)
  })

  const isAwaitingApproval = computed(() =>
    selectedRun.value?.status === 'awaiting_approval',
  )

  const isCancellable = computed(() => {
    const status = selectedRun.value?.status
    return status === 'pending' || status === 'running'
  })

  const traceUsage = computed(() => runTrace.value?.usage ?? null)

  // ── Actions ───────────────────────────────────────

  async function fetchRuns(options?: {
    agentId?: string
    status?: string
    limit?: number
    offset?: number
  }): Promise<void> {
    isLoading.value = true
    error.value = null
    try {
      const params = new URLSearchParams()
      if (options?.agentId) params.set('agentId', options.agentId)
      if (options?.status) params.set('status', options.status)
      params.set('limit', String(options?.limit ?? 50))
      params.set('offset', String(options?.offset ?? 0))
      const qs = params.toString()

      const result = await get<ApiResponse<RunHistoryEntry[]>>(`/api/runs?${qs}`)
      runs.value = result.data.map((run) => ({
        ...run,
        durationMs: run.completedAt
          ? Math.max(0, new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime())
          : undefined,
      }))
      totalCount.value = result.count ?? result.data.length
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch runs'
    } finally {
      isLoading.value = false
    }
  }

  async function fetchRun(id: string): Promise<RunHistoryEntry | null> {
    isLoadingDetail.value = true
    error.value = null
    try {
      const result = await get<ApiResponse<RunHistoryEntry>>(`/api/runs/${id}`)
      selectedRun.value = {
        ...result.data,
        durationMs: result.data.completedAt
          ? Math.max(0, new Date(result.data.completedAt).getTime() - new Date(result.data.startedAt).getTime())
          : undefined,
      }
      return selectedRun.value
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch run'
      return null
    } finally {
      isLoadingDetail.value = false
    }
  }

  async function fetchLogs(runId: string): Promise<void> {
    error.value = null
    try {
      const result = await get<ApiResponse<RunLogEntry[]>>(`/api/runs/${runId}/logs`)
      runLogs.value = result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch logs'
    }
  }

  async function fetchTrace(runId: string): Promise<void> {
    error.value = null
    try {
      const result = await get<ApiResponse<RunTrace>>(`/api/runs/${runId}/trace`)
      runTrace.value = result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch trace'
    }
  }

  async function cancelRun(runId: string): Promise<boolean> {
    error.value = null
    try {
      await post(`/api/runs/${runId}/cancel`, {})
      if (selectedRun.value?.id === runId) {
        selectedRun.value = { ...selectedRun.value, status: 'cancelled' }
      }
      const idx = runs.value.findIndex((r) => r.id === runId)
      if (idx >= 0) {
        runs.value[idx] = { ...runs.value[idx]!, status: 'cancelled' }
      }
      return true
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to cancel run'
      return false
    }
  }

  async function approveRun(runId: string): Promise<boolean> {
    error.value = null
    try {
      await post(`/api/runs/${runId}/approve`, {})
      if (selectedRun.value?.id === runId) {
        selectedRun.value = { ...selectedRun.value, status: 'running' }
      }
      return true
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to approve run'
      return false
    }
  }

  async function rejectRun(runId: string, reason?: string): Promise<boolean> {
    error.value = null
    try {
      await post(`/api/runs/${runId}/reject`, { reason })
      if (selectedRun.value?.id === runId) {
        selectedRun.value = { ...selectedRun.value, status: 'rejected' }
      }
      return true
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to reject run'
      return false
    }
  }

  async function loadRunDetail(runId: string): Promise<void> {
    await Promise.all([
      fetchRun(runId),
      fetchLogs(runId),
      fetchTrace(runId),
    ])
  }

  function setStatusFilter(status: RunStatus | 'all'): void {
    statusFilter.value = status
  }

  function clearSelection(): void {
    selectedRun.value = null
    runLogs.value = []
    runTrace.value = null
  }

  function clearError(): void {
    error.value = null
  }

  return {
    runs,
    selectedRun,
    runLogs,
    runTrace,
    isLoading,
    isLoadingDetail,
    error,
    statusFilter,
    totalCount,
    filteredRuns,
    isAwaitingApproval,
    isCancellable,
    traceUsage,
    fetchRuns,
    fetchRun,
    fetchLogs,
    fetchTrace,
    cancelRun,
    approveRun,
    rejectRun,
    loadRunDetail,
    setStatusFilter,
    clearSelection,
    clearError,
  }
})
