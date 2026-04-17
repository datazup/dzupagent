/**
 * Deep coverage tests for eval-store branch gaps.
 *
 * Covers: fetchHealth error path, fetchQueueStats 404 handling,
 * fetchRun, setLimit bounds, clearSelection, clearError,
 * upsertRun for existing vs new, filteredCounts, non-Error exceptions.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useEvalStore } from '../stores/eval-store.js'
import { ApiRequestError } from '../composables/useApi.js'
import type { EvalRunRecord } from '../types.js'

const getMock = vi.fn()
const postMock = vi.fn()

vi.mock('../composables/useApi.js', async () => {
  const actual = await vi.importActual('../composables/useApi.js') as Record<string, unknown>
  return {
    ...actual,
    useApi: () => ({
      get: getMock,
      post: postMock,
      patch: vi.fn(),
      del: vi.fn(),
      buildUrl: vi.fn((path: string) => path),
    }),
  }
})

function makeRun(id: string, status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'): EvalRunRecord {
  return {
    id,
    suiteId: 'suite-1',
    suite: { name: 'suite-1', description: 'Test', cases: [], scorers: [] },
    status,
    createdAt: '2025-01-01T00:00:00Z',
    queuedAt: '2025-01-01T00:00:00Z',
    startedAt: status !== 'queued' ? '2025-01-01T00:01:00Z' : undefined,
    completedAt: status === 'completed' ? '2025-01-01T00:10:00Z' : undefined,
    attempts: 1,
  }
}

describe('eval-store (deep coverage)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getMock.mockReset()
    postMock.mockReset()
  })

  // ── fetchHealth error path ──────────────────────────

  it('fetchHealth sets error on failure and nullifies health', async () => {
    getMock.mockRejectedValueOnce(new Error('Connection refused'))
    const store = useEvalStore()
    await store.fetchHealth()
    expect(store.error).toBe('Connection refused')
    expect(store.health).toBeNull()
  })

  it('fetchHealth handles non-Error exceptions', async () => {
    getMock.mockRejectedValueOnce('string error')
    const store = useEvalStore()
    await store.fetchHealth()
    expect(store.error).toBe('Failed to fetch eval health')
  })

  it('fetchHealth skips queue stats when endpoint not available', async () => {
    getMock.mockResolvedValueOnce({
      success: true,
      data: {
        service: 'evals',
        status: 'ready',
        mode: 'active',
        writable: true,
        endpoints: ['/api/evals/health', '/api/evals/runs'],
      },
    })

    const store = useEvalStore()
    await store.fetchHealth()
    expect(store.queueStats).toBeNull()
    // Only 1 call (health), no queue stats call
    expect(getMock).toHaveBeenCalledTimes(1)
  })

  // ── fetchQueueStats 404 handling ────────────────────

  it('fetchQueueStats returns null on 404', async () => {
    getMock.mockRejectedValueOnce(new ApiRequestError(404, 'NOT_FOUND', 'Not found'))
    const store = useEvalStore()
    await store.fetchQueueStats()
    expect(store.queueStats).toBeNull()
  })

  it('fetchQueueStats returns null on non-404 error', async () => {
    getMock.mockRejectedValueOnce(new Error('Server error'))
    const store = useEvalStore()
    await store.fetchQueueStats()
    expect(store.queueStats).toBeNull()
  })

  // ── fetchRun ────────────────────────────────────────

  it('fetchRun sets selectedRun on success', async () => {
    const run = makeRun('r1', 'completed')
    getMock.mockResolvedValueOnce({ success: true, data: run })
    const store = useEvalStore()
    const result = await store.fetchRun('r1')
    expect(result?.id).toBe('r1')
    expect(store.selectedRun?.id).toBe('r1')
    expect(store.isLoadingDetail).toBe(false)
  })

  it('fetchRun returns null and sets error on failure', async () => {
    getMock.mockRejectedValueOnce(new Error('Run not found'))
    const store = useEvalStore()
    const result = await store.fetchRun('missing')
    expect(result).toBeNull()
    expect(store.selectedRun).toBeNull()
    expect(store.error).toBe('Run not found')
    expect(store.isLoadingDetail).toBe(false)
  })

  it('fetchRun handles non-Error exceptions', async () => {
    getMock.mockRejectedValueOnce(42)
    const store = useEvalStore()
    const result = await store.fetchRun('missing')
    expect(result).toBeNull()
    expect(store.error).toBe('Failed to fetch eval run')
  })

  // ── fetchRuns error handling ────────────────────────

  it('fetchRuns sets error on failure', async () => {
    getMock.mockRejectedValueOnce(new Error('List failed'))
    const store = useEvalStore()
    await store.fetchRuns()
    expect(store.error).toBe('List failed')
    expect(store.isLoading).toBe(false)
  })

  it('fetchRuns handles non-Error exceptions', async () => {
    getMock.mockRejectedValueOnce(null)
    const store = useEvalStore()
    await store.fetchRuns()
    expect(store.error).toBe('Failed to fetch eval runs')
  })

  // ── cancelRun error handling ────────────────────────

  it('cancelRun returns null on error', async () => {
    postMock.mockRejectedValueOnce(new Error('Cancel failed'))
    const store = useEvalStore()
    const result = await store.cancelRun('r1')
    expect(result).toBeNull()
    expect(store.error).toBe('Cancel failed')
    expect(store.activeActionRunId).toBeNull()
  })

  it('cancelRun handles non-Error exceptions', async () => {
    postMock.mockRejectedValueOnce('boom')
    const store = useEvalStore()
    const result = await store.cancelRun('r1')
    expect(result).toBeNull()
    expect(store.error).toBe('Failed to cancel eval run')
  })

  // ── retryRun error handling ─────────────────────────

  it('retryRun returns null on error', async () => {
    postMock.mockRejectedValueOnce(new Error('Retry failed'))
    const store = useEvalStore()
    const result = await store.retryRun('r1')
    expect(result).toBeNull()
    expect(store.error).toBe('Retry failed')
    expect(store.activeActionRunId).toBeNull()
  })

  // ── createRun error handling ────────────────────────

  it('createRun returns null on error', async () => {
    postMock.mockRejectedValueOnce(new Error('Create failed'))
    const store = useEvalStore()
    const result = await store.createRun('suite-1')
    expect(result).toBeNull()
    expect(store.error).toBe('Create failed')
    expect(store.isSubmitting).toBe(false)
  })

  it('createRun handles non-Error exceptions', async () => {
    postMock.mockRejectedValueOnce(undefined)
    const store = useEvalStore()
    const result = await store.createRun('suite-1')
    expect(result).toBeNull()
    expect(store.error).toBe('Failed to create eval run')
  })

  // ── setLimit ────────────────────────────────────────

  it('setLimit clamps to minimum 1', () => {
    const store = useEvalStore()
    store.setLimit(0)
    expect(store.limit).toBe(1)
    store.setLimit(-5)
    expect(store.limit).toBe(1)
  })

  it('setLimit clamps to maximum 250', () => {
    const store = useEvalStore()
    store.setLimit(500)
    expect(store.limit).toBe(250)
  })

  it('setLimit floors fractional values', () => {
    const store = useEvalStore()
    store.setLimit(10.9)
    expect(store.limit).toBe(10)
  })

  // ── clearSelection ──────────────────────────────────

  it('clearSelection sets selectedRun to null', () => {
    const store = useEvalStore()
    store.selectedRun = makeRun('r1', 'completed')
    store.clearSelection()
    expect(store.selectedRun).toBeNull()
  })

  // ── clearError ──────────────────────────────────────

  it('clearError sets error to null', () => {
    const store = useEvalStore()
    store.error = 'Something broke'
    store.clearError()
    expect(store.error).toBeNull()
  })

  // ── filteredCounts ──────────────────────────────────

  it('filteredCounts returns correct counts by status', () => {
    const store = useEvalStore()
    store.runs = [
      makeRun('r1', 'queued'),
      makeRun('r2', 'running'),
      makeRun('r3', 'completed'),
      makeRun('r4', 'completed'),
      makeRun('r5', 'failed'),
    ]
    expect(store.filteredCounts).toEqual({
      queued: 1,
      running: 1,
      completed: 2,
      failed: 1,
      cancelled: 0,
    })
  })

  // ── computed getters ────────────────────────────────

  it('writable is false when health is null', () => {
    const store = useEvalStore()
    expect(store.writable).toBe(false)
  })

  it('mode defaults to read-only when health is null', () => {
    const store = useEvalStore()
    expect(store.mode).toBe('read-only')
  })

  it('endpoints is empty when health is null', () => {
    const store = useEvalStore()
    expect(store.endpoints).toEqual([])
  })

  it('runCount reflects runs array length', () => {
    const store = useEvalStore()
    expect(store.runCount).toBe(0)
    store.runs = [makeRun('r1', 'completed')]
    expect(store.runCount).toBe(1)
  })
})
