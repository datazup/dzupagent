/**
 * Tests for the BenchmarksView component.
 *
 * Verifies metadata validation rejects non-object JSON payloads before a run is queued.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const pushMock = vi.fn()
const mockCreateRun = vi.fn()
const mockLoadRecentRuns = vi.fn(async () => {})
const mockFetchBaselines = vi.fn(async () => {})
const mockLoadMoreHistory = vi.fn(async () => [])

type MockBenchmarkRun = {
  id: string
  result: { passedBaseline: boolean; regressions: string[] }
  strict: boolean
  createdAt: string
  suiteId: string
  targetId: string
  artifact?: {
    suiteVersion?: string
    datasetHash?: string
    promptConfigVersion?: string
    promptVersion?: string
    configVersion?: string
    buildSha?: string
    modelProfile?: string
  }
}

const benchmarkStore = {
  historyRuns: [] as MockBenchmarkRun[],
  recentRuns: [] as MockBenchmarkRun[],
  historySource: null as 'server' | 'session' | null,
  isSessionFallback: false,
  isLoadingHistory: false,
  isLoadingHistoryMore: false,
  historyHasMore: false,
  historyNextCursor: null as string | null,
  baselineCount: 0,
  baselines: [] as Array<{ suiteId: string; targetId: string; runId: string; updatedAt: string; result: unknown }>,
  error: null as string | null,
  isLoading: false,
  isLoadingBaselines: false,
  isSubmitting: false,
  createRun: mockCreateRun,
  loadHistory: mockLoadRecentRuns,
  loadRecentRuns: mockLoadRecentRuns,
  loadMoreHistory: mockLoadMoreHistory,
  fetchBaselines: mockFetchBaselines,
  clearError: vi.fn(() => {
    benchmarkStore.error = null
  }),
}

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}))

vi.mock('../stores/benchmark-store.js', () => ({
  useBenchmarkStore: () => benchmarkStore,
}))

async function mountBenchmarksView() {
  const { default: BenchmarksView } = await import('../views/BenchmarksView.vue')
  return mount(BenchmarksView)
}

describe('BenchmarksView', () => {
  beforeEach(() => {
    pushMock.mockReset()
    mockCreateRun.mockReset()
    mockLoadRecentRuns.mockClear()
    mockLoadMoreHistory.mockClear()
    mockFetchBaselines.mockClear()
    benchmarkStore.error = null
    benchmarkStore.baselineCount = 0
    benchmarkStore.historyRuns = []
    benchmarkStore.recentRuns = []
    benchmarkStore.historySource = null
    benchmarkStore.isSessionFallback = false
    benchmarkStore.isLoadingHistory = false
    benchmarkStore.isLoadingHistoryMore = false
    benchmarkStore.historyHasMore = false
    benchmarkStore.historyNextCursor = null
    benchmarkStore.isLoading = false
    benchmarkStore.isLoadingBaselines = false
    benchmarkStore.isSubmitting = false
  })

  it('rejects non-object metadata before queueing a benchmark run', async () => {
    const wrapper = await mountBenchmarksView()
    await flushPromises()

    await wrapper.get('input[placeholder="code-gen"]').setValue('suite-a')
    await wrapper.get('input[placeholder="agent-1"]').setValue('target-a')
    await wrapper.get('textarea').setValue('[]')

    await wrapper.get('form').trigger('submit.prevent')

    expect(mockCreateRun).not.toHaveBeenCalled()
    expect(benchmarkStore.error).toBe('Metadata must be a JSON object')
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('shows a session fallback badge when history is sourced from session runs', async () => {
    const sharedRuns = [
      {
        id: 'session-run',
        result: {
          passedBaseline: false,
          regressions: ['latency'],
        },
        strict: false,
        createdAt: '2026-03-31T11:00:00.000Z',
        suiteId: 'session-suite',
        targetId: 'session-target',
        artifact: {
          modelProfile: 'llama-4-mini',
          suiteVersion: 'v12',
          datasetHash: 'dataset-abcdef123456',
          buildSha: '0123456789abcdef',
        },
      },
    ]
    benchmarkStore.historySource = 'session'
    benchmarkStore.isSessionFallback = true
    benchmarkStore.historyRuns = sharedRuns
    benchmarkStore.recentRuns = sharedRuns

    const wrapper = await mountBenchmarksView()
    await flushPromises()

    expect(mockLoadRecentRuns).toHaveBeenCalled()
    expect(benchmarkStore.loadHistory).toHaveBeenCalled()
    expect(wrapper.text()).toContain('Session fallback')
    expect(wrapper.text()).toContain('session-suite')
  })

  it('does not show the session fallback badge when server history is active', async () => {
    benchmarkStore.historyRuns = [
      {
        id: 'server-run',
        result: {
          passedBaseline: true,
          regressions: [],
        },
        strict: true,
        createdAt: '2026-03-31T12:00:00.000Z',
        suiteId: 'server-suite',
        targetId: 'server-target',
        artifact: {
          modelProfile: 'llama-4-mini',
          suiteVersion: 'v12',
          datasetHash: 'dataset-abcdef123456',
          buildSha: '0123456789abcdef',
        },
      },
    ]
    benchmarkStore.historySource = 'server'
    benchmarkStore.isSessionFallback = false
    benchmarkStore.recentRuns = [
      {
        id: 'session-run',
        result: {
          passedBaseline: false,
          regressions: ['latency'],
        },
        strict: false,
        createdAt: '2026-03-31T11:00:00.000Z',
        suiteId: 'session-suite',
        targetId: 'session-target',
      },
    ]

    const wrapper = await mountBenchmarksView()
    await flushPromises()

    expect(mockLoadRecentRuns).toHaveBeenCalled()
    expect(benchmarkStore.loadHistory).toHaveBeenCalled()
    expect(wrapper.text()).toContain('server-suite')
    expect(wrapper.text()).toContain('server-target')
    expect(wrapper.text()).not.toContain('Session fallback')
  })

  it('shows a loading indicator while server history is loading', async () => {
    benchmarkStore.isLoadingHistory = true
    benchmarkStore.historySource = null
    benchmarkStore.historyRuns = []
    benchmarkStore.recentRuns = []

    const wrapper = await mountBenchmarksView()
    await flushPromises()

    expect(wrapper.text()).toContain('Loading server history...')
    expect(wrapper.text()).not.toContain('Session fallback')
  })

  it('loads more benchmark history when pagination is available', async () => {
    benchmarkStore.historySource = 'server'
    benchmarkStore.isSessionFallback = false
    benchmarkStore.historyHasMore = true
    benchmarkStore.historyNextCursor = 'cursor-1'
    benchmarkStore.historyRuns = [
      {
        id: 'server-run',
        result: {
          passedBaseline: true,
          regressions: [],
        },
        strict: false,
        createdAt: '2026-03-31T12:00:00.000Z',
        suiteId: 'server-suite',
        targetId: 'server-target',
        artifact: {
          modelProfile: 'llama-4-mini',
          suiteVersion: 'v12',
          datasetHash: 'dataset-abcdef123456',
          buildSha: '0123456789abcdef',
        },
      },
    ]

    const wrapper = await mountBenchmarksView()
    await flushPromises()

    const loadMore = wrapper.get('button[type="button"]')
    expect(loadMore.text()).toContain('Load more')

    await loadMore.trigger('click')

    expect(mockLoadMoreHistory).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('server-suite')
  })

  it('renders benchmark artifact telemetry in the history table', async () => {
    benchmarkStore.historySource = 'server'
    benchmarkStore.historyRuns = [
      {
        id: 'server-run',
        result: {
          passedBaseline: true,
          regressions: [],
        },
        strict: true,
        createdAt: '2026-03-31T12:00:00.000Z',
        suiteId: 'server-suite',
        targetId: 'server-target',
        artifact: {
          modelProfile: 'llama-4-mini',
          suiteVersion: 'v12',
          datasetHash: 'dataset-abcdef123456',
          buildSha: '0123456789abcdef',
          promptConfigVersion: 'prompt-config-v7',
        },
      },
    ]

    const wrapper = await mountBenchmarksView()
    await flushPromises()

    expect(wrapper.text()).toContain('Artifact')
    expect(wrapper.text()).toContain('llama-4-mini')
    expect(wrapper.text()).toContain('suite v12')
    expect(wrapper.text()).toContain('dataset dataset-')
    expect(wrapper.text()).toContain('cfg prompt-config-v7')
    expect(wrapper.text()).toContain('build 01234567…')
  })
})
