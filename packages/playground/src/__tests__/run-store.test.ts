/**
 * Tests for the run Pinia store.
 *
 * Covers: fetchRuns, fetchRun, fetchLogs, fetchTrace, cancelRun,
 * approveRun, rejectRun, loadRunDetail, setStatusFilter,
 * clearSelection, clearError, computed getters.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useRunStore } from '../stores/run-store.js'

const getMock = vi.fn()
const postMock = vi.fn()

vi.mock('../composables/useApi.js', () => ({
  useApi: () => ({
    get: getMock,
    post: postMock,
    patch: vi.fn(),
    del: vi.fn(),
    buildUrl: vi.fn((p: string) => p),
  }),
}))

describe('run-store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getMock.mockReset()
    postMock.mockReset()
  })

  it('starts with empty state', () => {
    const store = useRunStore()
    expect(store.runs).toEqual([])
    expect(store.selectedRun).toBeNull()
    expect(store.runLogs).toEqual([])
    expect(store.runTrace).toBeNull()
    expect(store.isLoading).toBe(false)
    expect(store.isLoadingDetail).toBe(false)
    expect(store.error).toBeNull()
    expect(store.statusFilter).toBe('all')
    expect(store.totalCount).toBe(0)
  })

  // ── Getters ─────────────────────────────────────────

  it('filteredRuns returns all runs when filter is all', async () => {
    getMock.mockResolvedValueOnce({
      data: [
        { id: 'r1', status: 'completed', startedAt: '2025-01-01T00:00:00Z' },
        { id: 'r2', status: 'failed', startedAt: '2025-01-01T00:01:00Z' },
      ],
      count: 2,
    })
    const store = useRunStore()
    await store.fetchRuns()
    expect(store.filteredRuns).toHaveLength(2)
  })

  it('filteredRuns filters by status', async () => {
    getMock.mockResolvedValueOnce({
      data: [
        { id: 'r1', status: 'completed', startedAt: '2025-01-01T00:00:00Z' },
        { id: 'r2', status: 'failed', startedAt: '2025-01-01T00:01:00Z' },
      ],
      count: 2,
    })
    const store = useRunStore()
    await store.fetchRuns()
    store.setStatusFilter('completed')
    expect(store.filteredRuns).toHaveLength(1)
    expect(store.filteredRuns[0]?.id).toBe('r1')
  })

  it('isAwaitingApproval is true when selectedRun has awaiting_approval status', () => {
    const store = useRunStore()
    store.selectedRun = { id: 'r1', status: 'awaiting_approval', startedAt: '2025-01-01T00:00:00Z', agentId: 'a1' } as never
    expect(store.isAwaitingApproval).toBe(true)
  })

  it('isAwaitingApproval is false for other statuses', () => {
    const store = useRunStore()
    store.selectedRun = { id: 'r1', status: 'running', startedAt: '2025-01-01T00:00:00Z', agentId: 'a1' } as never
    expect(store.isAwaitingApproval).toBe(false)
  })

  it('isCancellable is true for pending and running', () => {
    const store = useRunStore()
    store.selectedRun = { id: 'r1', status: 'pending', startedAt: '2025-01-01T00:00:00Z', agentId: 'a1' } as never
    expect(store.isCancellable).toBe(true)

    store.selectedRun = { id: 'r1', status: 'running', startedAt: '2025-01-01T00:00:00Z', agentId: 'a1' } as never
    expect(store.isCancellable).toBe(true)
  })

  it('isCancellable is false for completed runs', () => {
    const store = useRunStore()
    store.selectedRun = { id: 'r1', status: 'completed', startedAt: '2025-01-01T00:00:00Z', agentId: 'a1' } as never
    expect(store.isCancellable).toBe(false)
  })

  it('traceUsage returns usage from runTrace', () => {
    const store = useRunStore()
    expect(store.traceUsage).toBeNull()
    store.runTrace = { events: [], usage: { tokens: 100, cost: 0.01 } } as never
    expect(store.traceUsage).toEqual({ tokens: 100, cost: 0.01 })
  })

  // ── fetchRuns ───────────────────────────────────────

  it('fetchRuns with default options', async () => {
    getMock.mockResolvedValueOnce({
      data: [
        { id: 'r1', status: 'completed', startedAt: '2025-01-01T00:00:00Z', completedAt: '2025-01-01T00:01:00Z' },
      ],
      count: 1,
    })
    const store = useRunStore()
    await store.fetchRuns()
    expect(store.runs).toHaveLength(1)
    expect(store.totalCount).toBe(1)
    // durationMs should be calculated
    expect(store.runs[0]?.durationMs).toBe(60000)
    expect(store.isLoading).toBe(false)
  })

  it('fetchRuns calculates durationMs as undefined when no completedAt', async () => {
    getMock.mockResolvedValueOnce({
      data: [
        { id: 'r1', status: 'running', startedAt: '2025-01-01T00:00:00Z' },
      ],
    })
    const store = useRunStore()
    await store.fetchRuns()
    expect(store.runs[0]?.durationMs).toBeUndefined()
  })

  it('fetchRuns passes custom options as query parameters', async () => {
    getMock.mockResolvedValueOnce({ data: [], count: 0 })
    const store = useRunStore()
    await store.fetchRuns({ agentId: 'agent-1', status: 'completed', limit: 10, offset: 5 })
    expect(getMock).toHaveBeenCalledWith(
      expect.stringContaining('agentId=agent-1'),
    )
    expect(getMock).toHaveBeenCalledWith(
      expect.stringContaining('status=completed'),
    )
    expect(getMock).toHaveBeenCalledWith(
      expect.stringContaining('limit=10'),
    )
    expect(getMock).toHaveBeenCalledWith(
      expect.stringContaining('offset=5'),
    )
  })

  it('fetchRuns uses result.data.length as totalCount when count missing', async () => {
    getMock.mockResolvedValueOnce({
      data: [
        { id: 'r1', status: 'completed', startedAt: '2025-01-01T00:00:00Z' },
        { id: 'r2', status: 'failed', startedAt: '2025-01-01T00:01:00Z' },
      ],
    })
    const store = useRunStore()
    await store.fetchRuns()
    expect(store.totalCount).toBe(2)
  })

  it('fetchRuns handles errors', async () => {
    getMock.mockRejectedValueOnce(new Error('Server down'))
    const store = useRunStore()
    await store.fetchRuns()
    expect(store.error).toBe('Server down')
    expect(store.isLoading).toBe(false)
  })

  it('fetchRuns handles non-Error exceptions', async () => {
    getMock.mockRejectedValueOnce('unexpected')
    const store = useRunStore()
    await store.fetchRuns()
    expect(store.error).toBe('Failed to fetch runs')
  })

  // ── fetchRun ────────────────────────────────────────

  it('fetchRun sets selectedRun and calculates durationMs', async () => {
    getMock.mockResolvedValueOnce({
      data: {
        id: 'r1',
        status: 'completed',
        startedAt: '2025-01-01T00:00:00Z',
        completedAt: '2025-01-01T00:02:00Z',
        agentId: 'a1',
      },
    })
    const store = useRunStore()
    const result = await store.fetchRun('r1')
    expect(result).not.toBeNull()
    expect(result?.durationMs).toBe(120000)
    expect(store.selectedRun?.id).toBe('r1')
    expect(store.isLoadingDetail).toBe(false)
  })

  it('fetchRun returns null on error', async () => {
    getMock.mockRejectedValueOnce(new Error('Not found'))
    const store = useRunStore()
    const result = await store.fetchRun('missing')
    expect(result).toBeNull()
    expect(store.error).toBe('Not found')
  })

  // ── fetchLogs ───────────────────────────────────────

  it('fetchLogs sets runLogs', async () => {
    getMock.mockResolvedValueOnce({
      data: [
        { level: 'info', message: 'Started', timestamp: '2025-01-01T00:00:00Z' },
      ],
    })
    const store = useRunStore()
    await store.fetchLogs('r1')
    expect(store.runLogs).toHaveLength(1)
    expect(store.error).toBeNull()
  })

  it('fetchLogs handles error', async () => {
    getMock.mockRejectedValueOnce(new Error('Log fetch failed'))
    const store = useRunStore()
    await store.fetchLogs('r1')
    expect(store.error).toBe('Log fetch failed')
  })

  // ── fetchTrace ──────────────────────────────────────

  it('fetchTrace sets runTrace', async () => {
    getMock.mockResolvedValueOnce({
      data: { events: [{ type: 'llm' }], usage: { tokens: 50 } },
    })
    const store = useRunStore()
    await store.fetchTrace('r1')
    expect(store.runTrace).not.toBeNull()
    expect(store.error).toBeNull()
  })

  it('fetchTrace handles error', async () => {
    getMock.mockRejectedValueOnce(new Error('Trace error'))
    const store = useRunStore()
    await store.fetchTrace('r1')
    expect(store.error).toBe('Trace error')
  })

  // ── cancelRun ───────────────────────────────────────

  it('cancelRun updates selectedRun and runs list', async () => {
    postMock.mockResolvedValueOnce({})
    const store = useRunStore()
    store.selectedRun = { id: 'r1', status: 'running', startedAt: '2025-01-01T00:00:00Z', agentId: 'a1' } as unknown as typeof store.selectedRun
    store.runs = [{ id: 'r1', status: 'running', startedAt: '2025-01-01T00:00:00Z', agentId: 'a1' }] as unknown as typeof store.runs

    const result = await store.cancelRun('r1')
    expect(result).toBe(true)
    expect(store.selectedRun?.status).toBe('cancelled')
    expect(store.runs[0]?.status).toBe('cancelled')
  })

  it('cancelRun does not update selectedRun when ids differ', async () => {
    postMock.mockResolvedValueOnce({})
    const store = useRunStore()
    store.selectedRun = { id: 'r2', status: 'running', startedAt: '2025-01-01T00:00:00Z', agentId: 'a1' } as unknown as typeof store.selectedRun
    store.runs = [{ id: 'r1', status: 'running', startedAt: '2025-01-01T00:00:00Z', agentId: 'a1' }] as unknown as typeof store.runs

    await store.cancelRun('r1')
    expect(store.selectedRun?.status).toBe('running')
  })

  it('cancelRun handles error', async () => {
    postMock.mockRejectedValueOnce(new Error('Cancel failed'))
    const store = useRunStore()
    const result = await store.cancelRun('r1')
    expect(result).toBe(false)
    expect(store.error).toBe('Cancel failed')
  })

  // ── approveRun ──────────────────────────────────────

  it('approveRun updates selectedRun status to running', async () => {
    postMock.mockResolvedValueOnce({})
    const store = useRunStore()
    store.selectedRun = { id: 'r1', status: 'awaiting_approval', startedAt: '2025-01-01T00:00:00Z', agentId: 'a1' } as unknown as typeof store.selectedRun

    const result = await store.approveRun('r1')
    expect(result).toBe(true)
    expect(store.selectedRun?.status).toBe('running')
  })

  it('approveRun handles error', async () => {
    postMock.mockRejectedValueOnce(new Error('Approval failed'))
    const store = useRunStore()
    const result = await store.approveRun('r1')
    expect(result).toBe(false)
    expect(store.error).toBe('Approval failed')
  })

  // ── rejectRun ───────────────────────────────────────

  it('rejectRun updates selectedRun status to rejected', async () => {
    postMock.mockResolvedValueOnce({})
    const store = useRunStore()
    store.selectedRun = { id: 'r1', status: 'awaiting_approval', startedAt: '2025-01-01T00:00:00Z', agentId: 'a1' } as unknown as typeof store.selectedRun

    const result = await store.rejectRun('r1', 'Not suitable')
    expect(result).toBe(true)
    expect(store.selectedRun?.status).toBe('rejected')
  })

  it('rejectRun handles error', async () => {
    postMock.mockRejectedValueOnce(new Error('Reject failed'))
    const store = useRunStore()
    const result = await store.rejectRun('r1')
    expect(result).toBe(false)
    expect(store.error).toBe('Reject failed')
  })

  // ── loadRunDetail ───────────────────────────────────

  it('loadRunDetail fetches run, logs, and trace in parallel', async () => {
    getMock
      .mockResolvedValueOnce({ data: { id: 'r1', status: 'completed', startedAt: '2025-01-01T00:00:00Z', agentId: 'a1' } })
      .mockResolvedValueOnce({ data: [{ level: 'info', message: 'test' }] })
      .mockResolvedValueOnce({ data: { events: [] } })

    const store = useRunStore()
    await store.loadRunDetail('r1')
    expect(store.selectedRun).not.toBeNull()
    expect(store.runLogs).toHaveLength(1)
    expect(store.runTrace).not.toBeNull()
  })

  // ── setStatusFilter ─────────────────────────────────

  it('setStatusFilter updates the filter value', () => {
    const store = useRunStore()
    store.setStatusFilter('completed')
    expect(store.statusFilter).toBe('completed')
    store.setStatusFilter('all')
    expect(store.statusFilter).toBe('all')
  })

  // ── clearSelection ──────────────────────────────────

  it('clearSelection resets all detail state', () => {
    const store = useRunStore()
    store.selectedRun = { id: 'r1' } as never
    store.runLogs = [{ level: 'info' }] as never
    store.runTrace = { events: [] } as never

    store.clearSelection()
    expect(store.selectedRun).toBeNull()
    expect(store.runLogs).toEqual([])
    expect(store.runTrace).toBeNull()
  })

  // ── clearError ──────────────────────────────────────

  it('clearError resets error', () => {
    const store = useRunStore()
    store.error = 'Something broke'
    store.clearError()
    expect(store.error).toBeNull()
  })
})
