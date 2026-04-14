/**
 * Tests for the EvalRunDetailView component.
 *
 * Verifies attempt history, recovery metadata, and per-attempt error rendering.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

const pushMock = vi.fn()
const mockUseEvalStore = vi.fn()

vi.mock('vue-router', () => ({
  useRoute: () => ({
    params: {
      id: 'run-123',
    },
  }),
  useRouter: () => ({
    push: pushMock,
  }),
}))

vi.mock('../stores/eval-store.js', () => ({
  useEvalStore: () => mockUseEvalStore(),
}))

async function mountEvalRunDetailView() {
  const { default: EvalRunDetailView } = await import('../views/EvalRunDetailView.vue')
  return mount(EvalRunDetailView)
}

describe('EvalRunDetailView', () => {
  beforeEach(() => {
    pushMock.mockReset()
    mockUseEvalStore.mockReset()

    const selectedRun = ref({
      id: 'run-123',
      suiteId: 'suite-a',
      suite: {
        name: 'suite-a',
        description: 'Suite A',
        cases: [{ id: 'case-1' }],
        scorers: [{ name: 'exact-match' }],
      },
      status: 'failed',
      createdAt: '2026-03-31T09:00:00.000Z',
      queuedAt: '2026-03-31T09:01:00.000Z',
      startedAt: '2026-03-31T09:02:00.000Z',
      completedAt: '2026-03-31T09:03:00.000Z',
      attempts: 2,
      error: {
        code: 'Error',
        message: 'Second attempt failed',
      },
      attemptHistory: [
        {
          attempt: 1,
          status: 'cancelled',
          queuedAt: '2026-03-31T08:59:00.000Z',
          startedAt: '2026-03-31T09:00:30.000Z',
          completedAt: '2026-03-31T09:01:30.000Z',
          recovery: {
            previousStatus: 'running',
            previousStartedAt: '2026-03-31T09:00:30.000Z',
            recoveredAt: '2026-03-31T09:01:30.000Z',
            reason: 'process-restart',
          },
        },
        {
          attempt: 2,
          status: 'failed',
          queuedAt: '2026-03-31T09:01:30.000Z',
          startedAt: '2026-03-31T09:02:00.000Z',
          completedAt: '2026-03-31T09:03:00.000Z',
          error: {
            code: 'Error',
            message: 'Second attempt failed',
          },
        },
      ],
    })

    mockUseEvalStore.mockReturnValue({
      selectedRun: selectedRun.value,
      health: {
        service: 'evals',
        status: 'ready',
        mode: 'active',
        writable: true,
        endpoints: ['/api/evals/health', '/api/evals/queue/stats', '/api/evals/runs'],
      },
      queueStats: null,
      error: null,
      mode: 'active',
      writable: true,
      endpoints: ['/api/evals/health', '/api/evals/queue/stats', '/api/evals/runs'],
      activeActionRunId: null,
      isLoadingDetail: false,
      fetchHealth: vi.fn(async () => {}),
      fetchRun: vi.fn(async () => selectedRun.value),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
      clearError: vi.fn(),
    })
  })

  it('renders attempt history, recovery metadata, and attempt errors', async () => {
    const wrapper = await mountEvalRunDetailView()
    await flushPromises()

    expect(wrapper.text()).toContain('Attempt history')
    expect(wrapper.text()).toContain('Attempt 1')
    expect(wrapper.text()).toContain('Attempt 2')
    expect(wrapper.text()).toContain('cancelled')
    expect(wrapper.text()).toContain('failed')
    expect(wrapper.text()).toContain('Recovered')
    expect(wrapper.text()).toContain('Recovered from running')
    expect(wrapper.text()).toContain('Previous start:')
    expect(wrapper.text()).toContain('Second attempt failed')
    expect(wrapper.text()).toContain('Error')
  })
})
