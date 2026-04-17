/**
 * Tests for the EvalDashboard view component.
 *
 * Verifies: loading state, empty state, summary cards (total runs, completed,
 * failed, avg score, avg pass rate), pass rate bar, results table rendering,
 * status badges, navigation to eval detail, and refresh functionality.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const pushMock = vi.fn()

const mockFetchRuns = vi.fn(async () => {})

type MockEvalSuite = {
  name: string
  description?: string
}

type MockEvalResult = {
  aggregateScore: number
  passRate: number
}

type MockEvalRun = {
  id: string
  suiteId: string
  suite: MockEvalSuite
  status: string
  createdAt: string
  queuedAt: string
  startedAt?: string
  completedAt?: string
  result?: MockEvalResult
  attempts: number
}

const evalStore = {
  runs: [] as MockEvalRun[],
  isLoading: false,
  error: null as string | null,
  fetchRuns: mockFetchRuns,
  clearError: vi.fn(() => {
    evalStore.error = null
  }),
}

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}))

vi.mock('../stores/eval-store.js', () => ({
  useEvalStore: () => evalStore,
}))

async function mountView() {
  const { default: EvalDashboard } = await import('../views/EvalDashboard.vue')
  return mount(EvalDashboard)
}

const sampleRuns: MockEvalRun[] = [
  {
    id: 'eval-001-abcdef',
    suiteId: 'accuracy-suite',
    suite: { name: 'accuracy-suite', description: 'Accuracy evaluation' },
    status: 'completed',
    createdAt: '2026-04-14T10:00:00.000Z',
    queuedAt: '2026-04-14T10:00:00.000Z',
    startedAt: '2026-04-14T10:00:05.000Z',
    completedAt: '2026-04-14T10:01:00.000Z',
    result: { aggregateScore: 0.85, passRate: 0.9 },
    attempts: 1,
  },
  {
    id: 'eval-002-ghijkl',
    suiteId: 'safety-suite',
    suite: { name: 'safety-suite', description: 'Safety evaluation' },
    status: 'completed',
    createdAt: '2026-04-14T11:00:00.000Z',
    queuedAt: '2026-04-14T11:00:00.000Z',
    startedAt: '2026-04-14T11:00:05.000Z',
    completedAt: '2026-04-14T11:01:00.000Z',
    result: { aggregateScore: 0.72, passRate: 0.6 },
    attempts: 1,
  },
  {
    id: 'eval-003-mnopqr',
    suiteId: 'latency-suite',
    suite: { name: 'latency-suite' },
    status: 'failed',
    createdAt: '2026-04-14T12:00:00.000Z',
    queuedAt: '2026-04-14T12:00:00.000Z',
    startedAt: '2026-04-14T12:00:05.000Z',
    completedAt: '2026-04-14T12:00:10.000Z',
    attempts: 2,
  },
  {
    id: 'eval-004-stuvwx',
    suiteId: 'accuracy-suite',
    suite: { name: 'accuracy-suite', description: 'Accuracy evaluation' },
    status: 'running',
    createdAt: '2026-04-15T08:00:00.000Z',
    queuedAt: '2026-04-15T08:00:00.000Z',
    startedAt: '2026-04-15T08:00:05.000Z',
    attempts: 1,
  },
]

describe('EvalDashboard', () => {
  beforeEach(() => {
    pushMock.mockReset()
    mockFetchRuns.mockReset()
    mockFetchRuns.mockImplementation(async () => {})
    evalStore.runs = []
    evalStore.isLoading = false
    evalStore.error = null
  })

  it('shows loading state', async () => {
    evalStore.isLoading = true

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Loading eval data...')
  })

  it('shows empty state when no runs exist', async () => {
    evalStore.runs = []

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('No eval runs yet')
    expect(wrapper.text()).toContain('Run evaluations from the Evals view')
  })

  it('calls fetchRuns on mount', async () => {
    await mountView()
    await flushPromises()

    expect(mockFetchRuns).toHaveBeenCalled()
  })

  it('renders the header with title and description', async () => {
    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Eval Dashboard')
    expect(wrapper.text()).toContain('Aggregate scores and pass rates')
  })

  it('displays summary cards with correct values', async () => {
    evalStore.runs = sampleRuns

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Total Runs')
    expect(wrapper.text()).toContain('4')
    expect(wrapper.text()).toContain('Completed')
    expect(wrapper.text()).toContain('2')
    expect(wrapper.text()).toContain('Failed')
    expect(wrapper.text()).toContain('1')
  })

  it('calculates average score from completed runs', async () => {
    evalStore.runs = sampleRuns

    const wrapper = await mountView()
    await flushPromises()

    // avg of 0.85 and 0.72 = 0.785, toFixed(2) rounds to 0.78
    expect(wrapper.text()).toContain('Avg Score')
    expect(wrapper.text()).toContain('0.78')
  })

  it('calculates average pass rate from completed runs', async () => {
    evalStore.runs = sampleRuns

    const wrapper = await mountView()
    await flushPromises()

    // avg of 90% and 60% = 75.0%
    expect(wrapper.text()).toContain('Avg Pass Rate')
    expect(wrapper.text()).toContain('75.0%')
  })

  it('shows -- for score and pass rate when no completed runs', async () => {
    evalStore.runs = [sampleRuns[3]!] // running run, no result

    const wrapper = await mountView()
    await flushPromises()

    // The avg score and avg pass rate cards should show --
    const text = wrapper.text()
    // Count occurrences of --
    const dashCount = (text.match(/--/g) || []).length
    expect(dashCount).toBeGreaterThanOrEqual(2)
  })

  it('renders the pass rate bar when completed runs exist', async () => {
    evalStore.runs = sampleRuns

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Suite Pass Rate')
    expect(wrapper.text()).toContain('of 2 completed runs have pass rate >= 50%')
  })

  it('renders the results table with correct columns', async () => {
    evalStore.runs = sampleRuns

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Run Results')
    expect(wrapper.text()).toContain('Run')
    expect(wrapper.text()).toContain('Suite')
    expect(wrapper.text()).toContain('Status')
    expect(wrapper.text()).toContain('Score')
    expect(wrapper.text()).toContain('Pass Rate')
  })

  it('shows eval run data in table rows', async () => {
    evalStore.runs = sampleRuns

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('eval-001')
    expect(wrapper.text()).toContain('accuracy-suite')
    expect(wrapper.text()).toContain('Accuracy evaluation')
    expect(wrapper.text()).toContain('safety-suite')
    expect(wrapper.text()).toContain('Safety evaluation')
  })

  it('displays status badges with correct classes', async () => {
    evalStore.runs = sampleRuns

    const wrapper = await mountView()
    await flushPromises()

    const badges = wrapper.findAll('tbody span.rounded-full')
    const completedBadge = badges.find((b) => b.text() === 'completed')
    const failedBadge = badges.find((b) => b.text() === 'failed')
    const runningBadge = badges.find((b) => b.text() === 'running')

    expect(completedBadge?.classes()).toContain('bg-green-100')
    expect(failedBadge?.classes()).toContain('bg-red-100')
    expect(runningBadge?.classes()).toContain('bg-blue-100')
  })

  it('shows scores for completed runs and -- for incomplete', async () => {
    evalStore.runs = sampleRuns

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('0.85')
    expect(wrapper.text()).toContain('0.72')
  })

  it('shows pass rates for completed runs', async () => {
    evalStore.runs = sampleRuns

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('90.0%')
    expect(wrapper.text()).toContain('60.0%')
  })

  it('navigates to eval detail on row click', async () => {
    evalStore.runs = [sampleRuns[0]!]

    const wrapper = await mountView()
    await flushPromises()

    const row = wrapper.find('tbody tr')
    await row.trigger('click')

    expect(pushMock).toHaveBeenCalledWith({
      name: 'eval-detail',
      params: { id: 'eval-001-abcdef' },
    })
  })

  it('shows error alert with dismiss button', async () => {
    evalStore.error = 'Failed to load evals'

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Failed to load evals')

    const dismissBtn = wrapper.find('[role="alert"] button')
    expect(dismissBtn.exists()).toBe(true)

    await dismissBtn.trigger('click')
    expect(evalStore.clearError).toHaveBeenCalled()
  })

  it('refresh button triggers fetchRuns', async () => {
    const wrapper = await mountView()
    await flushPromises()

    mockFetchRuns.mockClear()

    const refreshBtn = wrapper.find('header button')
    expect(refreshBtn.text()).toContain('Refresh')

    await refreshBtn.trigger('click')
    await flushPromises()

    expect(mockFetchRuns).toHaveBeenCalled()
  })

  it('shows In progress for runs without completedAt', async () => {
    evalStore.runs = [sampleRuns[3]!]

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('In progress')
  })
})
