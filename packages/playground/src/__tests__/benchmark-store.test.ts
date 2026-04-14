import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useBenchmarkStore } from '../stores/benchmark-store.js'
import { ApiRequestError } from '../composables/useApi.js'
import type * as UseApiModule from '../composables/useApi.js'
import type {
  BenchmarkBaselineRecord,
  BenchmarkCompareRecord,
  BenchmarkRunListResponse,
  BenchmarkResult,
  BenchmarkRunRecord,
} from '../types.js'

const getMock = vi.fn()
const postMock = vi.fn()
const buildUrlMock = vi.fn((path: string) => path)

vi.mock('../composables/useApi.js', async () => {
  const actual = await vi.importActual<typeof UseApiModule>('../composables/useApi.js')
  return {
    ...actual,
    useApi: () => ({
      get: getMock,
      post: postMock,
      patch: vi.fn(),
      del: vi.fn(),
      buildUrl: buildUrlMock,
    }),
  }
})

function createResult(suiteId: string, passedBaseline: boolean): BenchmarkResult {
  return {
    suiteId,
    timestamp: '2026-03-31T12:00:00.000Z',
    scores: {
      accuracy: passedBaseline ? 0.95 : 0.72,
      latency: passedBaseline ? 0.88 : 0.61,
    },
    passedBaseline,
    regressions: passedBaseline ? [] : ['accuracy'],
  }
}

function createRun(
  id: string,
  suiteId = 'suite-a',
  targetId = 'target-a',
  passedBaseline = true,
  artifact?: BenchmarkRunRecord['artifact'],
): BenchmarkRunRecord {
  return {
    id,
    suiteId,
    targetId,
    result: createResult(suiteId, passedBaseline),
    createdAt: '2026-03-31T11:00:00.000Z',
    strict: false,
    metadata: { build: 'local' },
    ...(artifact ? { artifact } : {}),
  }
}

function createBaseline(): BenchmarkBaselineRecord {
  return {
    suiteId: 'suite-a',
    targetId: 'target-a',
    runId: 'run-1',
    result: createResult('suite-a', true),
    updatedAt: '2026-03-31T13:00:00.000Z',
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void

  const promise = new Promise<T>((res) => {
    resolve = res
  })

  return { promise, resolve }
}

describe('benchmark-store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getMock.mockReset()
    postMock.mockReset()
    buildUrlMock.mockClear()
    window.sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hydrates recent runs from session storage and keeps created runs in recency order', async () => {
    window.sessionStorage.setItem('dzupagent.playground.benchmark.recentRunIds', JSON.stringify(['run-1', 'run-2']))
    getMock
      .mockResolvedValueOnce({ success: true, data: createRun('run-1') })
      .mockResolvedValueOnce({ success: true, data: createRun('run-2', 'suite-b', 'target-b', false) })

    const store = useBenchmarkStore()
    await store.loadRecentRuns()

    expect(getMock).toHaveBeenNthCalledWith(1, '/api/benchmarks/runs/run-1')
    expect(getMock).toHaveBeenNthCalledWith(2, '/api/benchmarks/runs/run-2')
    expect(store.recentRunIds).toEqual(['run-1', 'run-2'])
    expect(store.recentRuns.map((run) => run.id)).toEqual(['run-1', 'run-2'])
  })

  it('creates runs, compares runs, and updates baselines', async () => {
    const created = createRun('run-1')
    const previous = createRun('run-0', 'suite-a', 'target-a', false)
    const comparison: BenchmarkCompareRecord = {
      currentRun: created,
      previousRun: previous,
      comparison: {
        improved: ['accuracy'],
        regressed: ['latency'],
        unchanged: [],
      },
    }
    const baseline = createBaseline()

    postMock
      .mockResolvedValueOnce({ success: true, data: created })
      .mockResolvedValueOnce({ success: true, data: comparison })

    getMock.mockResolvedValueOnce({
      success: true,
      data: [baseline],
      count: 1,
    })

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/benchmarks/baselines/suite-a')
      expect(init?.method).toBe('PUT')
      expect(init?.body).toBe(JSON.stringify({ targetId: 'target-a', runId: 'run-1' }))
      return jsonResponse({ success: true, data: baseline })
    })
    vi.stubGlobal('fetch', fetchMock)

    const store = useBenchmarkStore()

    const createdRun = await store.createRun({
      suiteId: 'suite-a',
      targetId: 'target-a',
      strict: true,
      metadata: { build: 'local' },
    })
    expect(createdRun?.id).toBe('run-1')
    expect(store.selectedRun?.id).toBe('run-1')
    expect(store.recentRunIds[0]).toBe('run-1')

    const compared = await store.compareRun('run-1', 'run-0')
    expect(compared?.comparison.improved).toEqual(['accuracy'])
    expect(store.comparison?.previousRun.id).toBe('run-0')
    expect(store.recentRunIds[0]).toBe('run-1')

    await store.fetchBaselines()
    expect(store.baselines).toHaveLength(1)
    expect(store.baselineCount).toBe(1)

    const saved = await store.setBaseline({
      suiteId: 'suite-a',
      targetId: 'target-a',
      runId: 'run-1',
    })
    expect(saved?.runId).toBe('run-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(store.findBaseline('suite-a', 'target-a')?.runId).toBe('run-1')
  })

  it('keeps the latest detail fetch result when responses arrive out of order', async () => {
    const firstRun = createRun('run-1')
    const secondRun = createRun('run-2', 'suite-b', 'target-b', false)
    const firstResponse = deferred<{ success: boolean; data: BenchmarkRunRecord }>()
    const secondResponse = deferred<{ success: boolean; data: BenchmarkRunRecord }>()

    getMock
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise)

    const store = useBenchmarkStore()
    const firstLoad = store.fetchRun('run-1')
    const secondLoad = store.fetchRun('run-2')

    secondResponse.resolve({ success: true, data: secondRun })
    await secondLoad

    expect(store.selectedRun?.id).toBe('run-2')

    firstResponse.resolve({ success: true, data: firstRun })
    await firstLoad

    expect(store.selectedRun?.id).toBe('run-2')
    expect(store.isLoadingDetail).toBe(false)
  })

  it('preserves prompt/config artifact telemetry from server history payloads', async () => {
    window.sessionStorage.setItem('dzupagent.playground.benchmark.recentRunIds', JSON.stringify(['run-1']))
    const artifact = {
      suiteVersion: 'suite-v12',
      datasetHash: 'dataset-abcdef123456',
      promptConfigVersion: 'prompt-config-v7',
      buildSha: '0123456789abcdef',
      modelProfile: 'llama-4-mini',
    }

    getMock.mockResolvedValueOnce({
      success: true,
      data: [
        createRun('run-1', 'suite-a', 'target-a', true, artifact),
      ],
      count: 1,
      meta: {
        filters: {
          limit: 25,
        },
      },
    })

    const store = useBenchmarkStore()
    const runs = await store.loadHistory()

    expect(runs[0]?.artifact).toEqual(artifact)
    expect(store.historyRuns[0]?.artifact).toEqual(artifact)

    await store.loadRecentRuns()

    expect(getMock).toHaveBeenCalledTimes(1)
    expect(store.recentRuns[0]?.artifact).toEqual(artifact)
  })

  it('preserves prompt/config artifact telemetry on detail fetch', async () => {
    const artifact = {
      suiteVersion: 'suite-v12',
      datasetHash: 'dataset-abcdef123456',
      promptConfigVersion: 'prompt-config-v7',
      buildSha: '0123456789abcdef',
      modelProfile: 'llama-4-mini',
    }

    getMock.mockResolvedValueOnce({
      success: true,
      data: createRun('run-1', 'suite-a', 'target-a', true, artifact),
    })

    const store = useBenchmarkStore()
    const run = await store.fetchRun('run-1')

    expect(run?.artifact).toEqual(artifact)
    expect(store.selectedRun?.artifact).toEqual(artifact)
  })

  it('round-trips promptConfigVersion through create, history list, and detail fetch caches', async () => {
    const artifact = {
      suiteVersion: 'suite-v13',
      datasetHash: 'dataset-fedcba654321',
      promptConfigVersion: 'prompt-config-v8',
      buildSha: 'fedcba9876543210',
      modelProfile: 'gpt-5-mini',
    }
    const created = createRun('run-1', 'suite-a', 'target-a', true, artifact)
    const historyEntry = createRun('run-1', 'suite-a', 'target-a', true, artifact)
    const detailEntry = createRun('run-1', 'suite-a', 'target-a', true, artifact)

    postMock.mockResolvedValueOnce({
      success: true,
      data: created,
    })
    getMock
      .mockResolvedValueOnce({
        success: true,
        data: [historyEntry],
        count: 1,
        meta: {
          filters: {
            limit: 25,
          },
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: detailEntry,
      })

    const store = useBenchmarkStore()

    const createdRun = await store.createRun({
      suiteId: 'suite-a',
      targetId: 'target-a',
      metadata: { build: 'local' },
      artifact,
    })
    expect(createdRun?.artifact?.promptConfigVersion).toBe('prompt-config-v8')
    expect(store.selectedRun?.artifact?.promptConfigVersion).toBe('prompt-config-v8')
    expect(store.recentRuns[0]?.artifact?.promptConfigVersion).toBe('prompt-config-v8')

    const historyRuns = await store.loadHistory()
    expect(historyRuns[0]?.artifact?.promptConfigVersion).toBe('prompt-config-v8')
    expect(store.historyRuns[0]?.artifact?.promptConfigVersion).toBe('prompt-config-v8')
    expect(store.selectedRun?.artifact?.promptConfigVersion).toBe('prompt-config-v8')

    const detailRun = await store.fetchRun('run-1')
    expect(detailRun?.artifact?.promptConfigVersion).toBe('prompt-config-v8')
    expect(store.selectedRun?.artifact?.promptConfigVersion).toBe('prompt-config-v8')
    expect(store.historyRuns[0]?.artifact?.promptConfigVersion).toBe('prompt-config-v8')
  })

  it('locks baseline updates while a save is in flight', async () => {
    const baseline = createBaseline()
    const response = deferred<Response>()
    const fetchMock = vi.fn(() => response.promise)
    vi.stubGlobal('fetch', fetchMock)

    const store = useBenchmarkStore()
    const firstSave = store.setBaseline({
      suiteId: 'suite-a',
      targetId: 'target-a',
      runId: 'run-1',
    })

    expect(store.isSettingBaseline).toBe(true)

    const secondSave = await store.setBaseline({
      suiteId: 'suite-a',
      targetId: 'target-a',
      runId: 'run-1',
    })

    expect(secondSave).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    response.resolve(jsonResponse({ success: true, data: baseline }))
    await firstSave

    expect(store.isSettingBaseline).toBe(false)
    expect(store.findBaseline('suite-a', 'target-a')?.runId).toBe('run-1')
  })

  it('loads server-backed benchmark history before falling back to session runs', async () => {
    const serverRuns = [
      { ...createRun('run-2', 'suite-b', 'target-b', false), createdAt: '2026-03-31T14:00:00.000Z' },
      { ...createRun('run-1'), createdAt: '2026-03-31T13:00:00.000Z' },
    ]

    getMock.mockResolvedValueOnce({
      success: true,
      data: serverRuns,
      count: 2,
      meta: {
        filters: {
          limit: 25,
        },
        nextCursor: 'cursor-page-2',
        hasMore: true,
      },
    })

    const store = useBenchmarkStore()
    const runs = await store.fetchRuns()

    expect(getMock).toHaveBeenCalledWith('/api/benchmarks/runs?limit=25')
    expect(runs.map((run) => run.id)).toEqual(['run-2', 'run-1'])
    expect(store.historyRuns.map((run) => run.id)).toEqual(['run-2', 'run-1'])
    expect(store.historySource).toBe('server')
    expect(store.isSessionFallback).toBe(false)
    expect(store.isLoadingHistory).toBe(false)
    expect(store.historyHasMore).toBe(true)
    expect(store.historyNextCursor).toBe('cursor-page-2')
    expect(store.recentRuns).toEqual([])
  })

  it('keeps empty server history when the list endpoint is available, even with cached session runs', async () => {
    window.sessionStorage.setItem('dzupagent.playground.benchmark.recentRunIds', JSON.stringify(['session-run']))

    getMock
      .mockResolvedValueOnce({ success: true, data: createRun('session-run') })
      .mockResolvedValueOnce({
      success: true,
      data: [],
      count: 0,
      meta: {
        filters: {
          limit: 25,
        },
      },
      })

    const store = useBenchmarkStore()
    await store.loadRecentRuns()
    expect(store.recentRuns.map((run) => run.id)).toEqual(['session-run'])

    const runs = await store.loadHistory()

    expect(getMock).toHaveBeenNthCalledWith(1, '/api/benchmarks/runs/session-run')
    expect(getMock).toHaveBeenNthCalledWith(2, '/api/benchmarks/runs?limit=25')
    expect(runs).toEqual([])
    expect(store.historyRuns).toEqual([])
    expect(store.historySource).toBe('server')
    expect(store.isSessionFallback).toBe(false)
    expect(store.isLoadingHistory).toBe(false)
    expect(store.recentRuns.map((run) => run.id)).toEqual(['session-run'])
    expect(store.error).toBeNull()
  })

  it('falls back to session history when the server run list is unavailable', async () => {
    window.sessionStorage.setItem('dzupagent.playground.benchmark.recentRunIds', JSON.stringify(['session-run']))

    getMock
      .mockRejectedValueOnce(new ApiRequestError(404, 'NOT_FOUND', 'Benchmark runs not found'))
      .mockResolvedValueOnce({ success: true, data: createRun('session-run') })

    const store = useBenchmarkStore()
    const runs = await store.loadHistory()

    expect(getMock).toHaveBeenNthCalledWith(1, '/api/benchmarks/runs?limit=25')
    expect(getMock).toHaveBeenNthCalledWith(2, '/api/benchmarks/runs/session-run')
    expect(runs.map((run) => run.id)).toEqual(['session-run'])
    expect(store.historyRuns.map((run) => run.id)).toEqual(['session-run'])
    expect(store.historySource).toBe('session')
    expect(store.isSessionFallback).toBe(true)
    expect(store.isLoadingHistory).toBe(false)
    expect(store.recentRuns.map((run) => run.id)).toEqual(['session-run'])
    expect(store.error).toBeNull()
  })

  it('preserves the server error while session fallback loads recent runs', async () => {
    window.sessionStorage.setItem('dzupagent.playground.benchmark.recentRunIds', JSON.stringify(['session-run']))

    getMock
      .mockRejectedValueOnce(new ApiRequestError(500, 'SERVER_ERROR', 'Benchmark history unavailable'))
      .mockResolvedValueOnce({ success: true, data: createRun('session-run') })

    const store = useBenchmarkStore()
    const runs = await store.loadHistory()

    expect(getMock).toHaveBeenNthCalledWith(1, '/api/benchmarks/runs?limit=25')
    expect(getMock).toHaveBeenNthCalledWith(2, '/api/benchmarks/runs/session-run')
    expect(runs.map((run) => run.id)).toEqual(['session-run'])
    expect(store.historyRuns.map((run) => run.id)).toEqual(['session-run'])
    expect(store.historySource).toBe('session')
    expect(store.isSessionFallback).toBe(true)
    expect(store.isLoadingHistory).toBe(false)
    expect(store.recentRuns.map((run) => run.id)).toEqual(['session-run'])
    expect(store.error).toBe('Benchmark history unavailable')
  })

  it('tracks history loading state while the server request is in flight', async () => {
    const response = deferred<BenchmarkRunListResponse>()
    getMock.mockReturnValueOnce(response.promise)

    const store = useBenchmarkStore()
    const pending = store.loadHistory()

    expect(store.isLoadingHistory).toBe(true)
    expect(store.isSessionFallback).toBe(false)

    response.resolve({
      success: true,
      data: [],
      count: 0,
      meta: {
        filters: {
          limit: 25,
        },
      },
    })

    await pending

    expect(store.isLoadingHistory).toBe(false)
    expect(store.historySource).toBe('server')
  })

  it('loads additional benchmark history pages with the next cursor', async () => {
    getMock
      .mockResolvedValueOnce({
        success: true,
        data: [
          { ...createRun('run-3'), createdAt: '2026-03-31T15:00:00.000Z' },
          { ...createRun('run-2'), createdAt: '2026-03-31T14:00:00.000Z' },
        ],
        count: 2,
        meta: {
          filters: {
            limit: 2,
          },
          nextCursor: 'cursor-page-2',
          hasMore: true,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          { ...createRun('run-1'), createdAt: '2026-03-31T13:00:00.000Z' },
        ],
        count: 1,
        meta: {
          filters: {
            limit: 2,
            cursor: 'cursor-page-2',
          },
          hasMore: false,
          nextCursor: null,
        },
      })

    const store = useBenchmarkStore()
    const firstPage = await store.loadHistory({ limit: 2 })
    expect(firstPage.map((run) => run.id)).toEqual(['run-3', 'run-2'])
    expect(store.historySource).toBe('server')
    expect(store.historyHasMore).toBe(true)
    expect(store.historyNextCursor).toBe('cursor-page-2')

    const more = await store.loadMoreHistory()

    expect(getMock).toHaveBeenNthCalledWith(1, '/api/benchmarks/runs?limit=2')
    expect(getMock).toHaveBeenNthCalledWith(2, '/api/benchmarks/runs?limit=2&cursor=cursor-page-2')
    expect(more.map((run) => run.id)).toEqual(['run-3', 'run-2', 'run-1'])
    expect(store.historyRuns.map((run) => run.id)).toEqual(['run-3', 'run-2', 'run-1'])
    expect(store.historyHasMore).toBe(false)
    expect(store.historyNextCursor).toBeNull()
    expect(store.isLoadingHistoryMore).toBe(false)
  })
})
