/**
 * Tests for BenchmarkRunDetailView.
 *
 * Verifies route param changes do not let stale in-flight responses render the wrong run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { BenchmarkRunRecord } from '../types.js'
import type * as UseApiModule from '../composables/useApi.js'

const pushMock = vi.fn()
const routeRunId = ref('run-1')
const getMock = vi.fn()
const postMock = vi.fn()

vi.mock('vue-router', () => ({
  useRoute: () => ({
    params: {
      get runId() {
        return routeRunId.value
      },
    },
  }),
  useRouter: () => ({
    push: pushMock,
  }),
}))

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void

  const promise = new Promise<T>((res) => {
    resolve = res
  })

  return { promise, resolve }
}

function createRun(
  id: string,
  suiteId: string,
  targetId: string,
  passedBaseline: boolean,
  artifact?: BenchmarkRunRecord['artifact'],
): BenchmarkRunRecord {
  return {
    id,
    suiteId,
    targetId,
    result: {
      suiteId,
      timestamp: '2026-03-31T12:00:00.000Z',
      scores: {
        accuracy: passedBaseline ? 0.95 : 0.61,
        latency: passedBaseline ? 0.88 : 0.52,
      },
      passedBaseline,
      regressions: passedBaseline ? [] : ['accuracy'],
    },
    createdAt: '2026-03-31T11:00:00.000Z',
    strict: false,
    metadata: { build: 'local' },
    ...(artifact ? { artifact } : {}),
  }
}

async function mountBenchmarkRunDetailView() {
  const { default: BenchmarkRunDetailView } = await import('../views/BenchmarkRunDetailView.vue')
  return mount(BenchmarkRunDetailView)
}

describe('BenchmarkRunDetailView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    pushMock.mockReset()
    getMock.mockReset()
    postMock.mockReset()
    routeRunId.value = 'run-1'
  })

  it('keeps the latest route-selected run visible when responses arrive out of order', async () => {
    const firstResponse = deferred<{ success: boolean; data: BenchmarkRunRecord }>()
    const secondResponse = deferred<{ success: boolean; data: BenchmarkRunRecord }>()

    getMock.mockImplementation((path: string) => {
      if (path === '/api/benchmarks/baselines') {
        return Promise.resolve({ success: true, data: [], count: 0 })
      }

      if (path === '/api/benchmarks/runs/run-1') {
        return firstResponse.promise
      }

      if (path === '/api/benchmarks/runs/run-2') {
        return secondResponse.promise
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const wrapper = await mountBenchmarkRunDetailView()
    await flushPromises()

    routeRunId.value = 'run-2'
    await flushPromises()

    secondResponse.resolve({
      success: true,
      data: createRun('run-2', 'suite-b', 'target-b', true),
    })
    await flushPromises()

    expect(wrapper.text()).toContain('run-2')
    expect(wrapper.text()).not.toContain('run-1')

    firstResponse.resolve({
      success: true,
      data: createRun('run-1', 'suite-a', 'target-a', false),
    })
    await flushPromises()

    expect(wrapper.text()).toContain('run-2')
    expect(wrapper.text()).not.toContain('run-1')
  })

  it('renders artifact provenance in the detail view', async () => {
    getMock.mockImplementation((path: string) => {
      if (path === '/api/benchmarks/baselines') {
        return Promise.resolve({ success: true, data: [], count: 0 })
      }

      if (path === '/api/benchmarks/runs/run-1') {
        return Promise.resolve({
          success: true,
          data: createRun('run-1', 'suite-a', 'target-a', true, {
            modelProfile: 'llama-4-mini',
            suiteVersion: 'v12',
            datasetHash: 'dataset-abcdef123456',
            promptConfigVersion: 'prompt-config-v7',
            buildSha: '0123456789abcdef',
          }),
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const wrapper = await mountBenchmarkRunDetailView()
    await flushPromises()

    expect(wrapper.text()).toContain('Artifact provenance')
    expect(wrapper.text()).toContain('Model profile')
    expect(wrapper.text()).toContain('llama-4-mini')
    expect(wrapper.text()).toContain('Suite version')
    expect(wrapper.text()).toContain('v12')
    expect(wrapper.text()).toContain('Dataset hash')
    expect(wrapper.text()).toContain('dataset-abcdef123456')
    expect(wrapper.text()).toContain('Prompt/config version')
    expect(wrapper.text()).toContain('prompt-config-v7')
    expect(wrapper.text()).toContain('Build SHA')
    expect(wrapper.text()).toContain('01234567…')
  })
})
