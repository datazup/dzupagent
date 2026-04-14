import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useEvalStore } from '../stores/eval-store.js'
import type { EvalRunRecord, EvalRunStatus } from '../types.js'
import type * as UseApiModule from '../composables/useApi.js'

const getMock = vi.fn()
const postMock = vi.fn()

vi.mock('../composables/useApi.js', async () => {
  const actual = await vi.importActual<typeof UseApiModule>('../composables/useApi.js')
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

function createRun(id: string, status: EvalRunStatus, queuedAt: string): EvalRunRecord {
  return {
    id,
    suiteId: 'suite-a',
    suite: {
      name: 'suite-a',
      description: 'Suite A',
      cases: [{ id: 'case-1' }],
      scorers: [{ name: 'exact-match' }],
    },
    status,
    createdAt: queuedAt,
    queuedAt,
    startedAt: status === 'queued' ? undefined : queuedAt,
    completedAt: status === 'completed' ? '2025-01-01T00:10:00.000Z' : undefined,
    attempts: status === 'queued' ? 0 : 1,
  }
}

describe('eval-store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getMock.mockReset()
    postMock.mockReset()
  })

  it('loads health and optional queue stats', async () => {
    getMock
      .mockResolvedValueOnce({
        success: true,
        data: {
          service: 'evals',
          status: 'ready',
          mode: 'active',
          writable: true,
          endpoints: ['/api/evals/health', '/api/evals/runs', '/api/evals/queue/stats'],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          service: 'evals',
          mode: 'active',
          writable: true,
          queue: {
            pending: 2,
            active: 1,
            oldestPendingAgeMs: 1250,
            enqueued: 6,
            started: 5,
            completed: 4,
            failed: 1,
            cancelled: 0,
            retried: 1,
            recovered: 0,
            requeued: 1,
          },
        },
      })

    const store = useEvalStore()
    await store.fetchHealth()

    expect(getMock).toHaveBeenNthCalledWith(1, '/api/evals/health')
    expect(getMock).toHaveBeenNthCalledWith(2, '/api/evals/queue/stats')
    expect(store.health?.mode).toBe('active')
    expect(store.queueStats?.pending).toBe(2)
    expect(store.writable).toBe(true)
  })

  it('loads runs and keeps the store filters in sync with the response meta', async () => {
    const newer = createRun('run-new', 'completed', '2025-01-01T00:02:00.000Z')
    const older = createRun('run-old', 'running', '2025-01-01T00:01:00.000Z')

    getMock.mockResolvedValueOnce({
      success: true,
      data: [older, newer],
      count: 2,
      meta: {
        service: 'evals',
        mode: 'active',
        writable: true,
        filters: {
          suiteId: 'suite-a',
          status: 'completed',
          limit: 10,
        },
      },
    })

    const store = useEvalStore()
    store.setSuiteIdFilter('suite-a')
    store.setStatusFilter('completed')
    await store.fetchRuns()

    expect(getMock).toHaveBeenCalledWith('/api/evals/runs?suiteId=suite-a&status=completed&limit=25')
    expect(store.runs[0]?.id).toBe('run-new')
    expect(store.runs[1]?.id).toBe('run-old')
    expect(store.suiteIdFilter).toBe('suite-a')
    expect(store.statusFilter).toBe('completed')
    expect(store.limit).toBe(10)
    expect(store.runCount).toBe(2)
  })

  it('creates, cancels, and retries a run in local state', async () => {
    const queued = createRun('run-1', 'queued', '2025-01-01T00:00:00.000Z')
    const cancelled = { ...queued, status: 'cancelled' as const, completedAt: '2025-01-01T00:05:00.000Z' }
    const retried = { ...queued, status: 'queued' as const, attempts: 1 }

    postMock
      .mockResolvedValueOnce({ success: true, data: queued })
      .mockResolvedValueOnce({ success: true, data: cancelled })
      .mockResolvedValueOnce({ success: true, data: retried })

    const store = useEvalStore()

    const created = await store.createRun('suite-a', { target: 'agent-1' })
    expect(created?.id).toBe('run-1')
    expect(store.selectedRun?.status).toBe('queued')
    expect(store.runs[0]?.status).toBe('queued')

    const cancelledRun = await store.cancelRun('run-1')
    expect(cancelledRun?.status).toBe('cancelled')
    expect(store.selectedRun?.status).toBe('cancelled')
    expect(store.runs[0]?.status).toBe('cancelled')

    const retriedRun = await store.retryRun('run-1')
    expect(retriedRun?.status).toBe('queued')
    expect(store.selectedRun?.status).toBe('queued')
    expect(store.runs[0]?.attempts).toBe(1)
  })
})
