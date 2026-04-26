/**
 * Tests for the RunHistoryBrowser view component.
 *
 * Verifies: loading state, empty state, table rendering, status badges,
 * pagination, row expand/collapse, status filtering, and navigation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const pushMock = vi.fn()

const mockFetchRuns = vi.fn(async () => {})

type MockRunEntry = {
  id: string
  agentId: string
  status: string
  startedAt: string
  completedAt?: string
  durationMs?: number
  output?: unknown
  error?: string
}

const runStore = {
  runs: [] as MockRunEntry[],
  filteredRuns: [] as MockRunEntry[],
  isLoading: false,
  isLoadingDetail: false,
  error: null as string | null,
  statusFilter: 'all' as string,
  totalCount: 0,
  fetchRuns: mockFetchRuns,
  setStatusFilter: vi.fn((status: string) => {
    runStore.statusFilter = status
  }),
  clearError: vi.fn(() => {
    runStore.error = null
  }),
}

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}))

vi.mock('../stores/run-store.js', () => ({
  useRunStore: () => runStore,
}))

async function mountView() {
  const { default: RunHistoryBrowser } = await import('../views/RunHistoryBrowser.vue')
  return mount(RunHistoryBrowser)
}

const sampleRuns: MockRunEntry[] = [
  {
    id: 'run-001-abcdef123456',
    agentId: 'agent-alpha',
    status: 'completed',
    startedAt: '2026-04-15T10:00:00.000Z',
    completedAt: '2026-04-15T10:01:00.000Z',
    durationMs: 60000,
    output: 'Task completed successfully',
  },
  {
    id: 'run-002-ghijkl789012',
    agentId: 'agent-beta',
    status: 'running',
    startedAt: '2026-04-15T10:05:00.000Z',
    durationMs: undefined,
  },
  {
    id: 'run-003-mnopqr345678',
    agentId: 'agent-gamma',
    status: 'failed',
    startedAt: '2026-04-15T09:00:00.000Z',
    completedAt: '2026-04-15T09:00:30.000Z',
    durationMs: 30000,
    error: 'Out of budget',
  },
  {
    id: 'run-004-stuvwx901234',
    agentId: 'agent-delta',
    status: 'pending',
    startedAt: '2026-04-15T10:10:00.000Z',
  },
]

describe('RunHistoryBrowser', () => {
  beforeEach(() => {
    pushMock.mockReset()
    mockFetchRuns.mockReset()
    mockFetchRuns.mockImplementation(async () => {})
    runStore.runs = []
    runStore.filteredRuns = []
    runStore.isLoading = false
    runStore.error = null
    runStore.statusFilter = 'all'
    runStore.totalCount = 0
  })

  it('shows loading state while fetching runs', async () => {
    runStore.isLoading = true

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Loading runs...')
  })

  it('shows empty state when no runs exist', async () => {
    runStore.isLoading = false
    runStore.filteredRuns = []

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('No runs found')
    expect(wrapper.text()).toContain('Agent runs will appear here once started')
  })

  it('renders runs in a table with correct columns', async () => {
    runStore.filteredRuns = sampleRuns
    runStore.totalCount = sampleRuns.length

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Run ID')
    expect(wrapper.text()).toContain('Agent')
    expect(wrapper.text()).toContain('Status')
    expect(wrapper.text()).toContain('Started')
    expect(wrapper.text()).toContain('Duration')
    expect(wrapper.text()).toContain('Actions')
  })

  it('shows run data in table rows', async () => {
    runStore.filteredRuns = sampleRuns
    runStore.totalCount = sampleRuns.length

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('run-001-...')
    expect(wrapper.text()).toContain('agent-alpha')
    expect(wrapper.text()).toContain('completed')
    expect(wrapper.text()).toContain('agent-beta')
    expect(wrapper.text()).toContain('running')
    expect(wrapper.text()).toContain('agent-gamma')
    expect(wrapper.text()).toContain('failed')
  })

  it('displays status badges with semantic variant classes', async () => {
    runStore.filteredRuns = sampleRuns
    runStore.totalCount = sampleRuns.length

    const wrapper = await mountView()
    await flushPromises()

    const badges = wrapper.findAll('span.rounded-full')
    const completedBadge = badges.find((b) => b.text() === 'completed')
    const runningBadge = badges.find((b) => b.text() === 'running')
    const failedBadge = badges.find((b) => b.text() === 'failed')
    const pendingBadge = badges.find((b) => b.text() === 'pending')

    expect(completedBadge?.classes()).toContain('pg-badge-success')
    expect(runningBadge?.classes()).toContain('pg-badge-info')
    expect(failedBadge?.classes()).toContain('pg-badge-danger')
    expect(pendingBadge?.classes()).toContain('pg-badge-neutral')
  })

  it('displays formatted duration for completed runs', async () => {
    runStore.filteredRuns = [sampleRuns[0]!]
    runStore.totalCount = 1

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('1.0m')
  })

  it('displays -- for runs without duration', async () => {
    runStore.filteredRuns = [sampleRuns[1]!]
    runStore.totalCount = 1

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('--')
  })

  it('expands row on click to show details', async () => {
    runStore.filteredRuns = [sampleRuns[0]!]
    runStore.totalCount = 1

    const wrapper = await mountView()
    await flushPromises()

    const row = wrapper.find('tbody tr')
    await row.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Full ID:')
    expect(wrapper.text()).toContain('run-001-abcdef123456')
    expect(wrapper.text()).toContain('Output')
    expect(wrapper.text()).toContain('Task completed successfully')
  })

  it('shows error in expanded row for failed runs', async () => {
    runStore.filteredRuns = [sampleRuns[2]!]
    runStore.totalCount = 1

    const wrapper = await mountView()
    await flushPromises()

    const row = wrapper.find('tbody tr')
    await row.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Error')
    expect(wrapper.text()).toContain('Out of budget')
  })

  it('collapses expanded row on second click', async () => {
    runStore.filteredRuns = [sampleRuns[0]!]
    runStore.totalCount = 1

    const wrapper = await mountView()
    await flushPromises()

    const row = wrapper.find('tbody tr')
    await row.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Full ID:')

    await row.trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('Full ID:')
  })

  it('navigates to run detail on View button click', async () => {
    runStore.filteredRuns = [sampleRuns[0]!]
    runStore.totalCount = 1

    const wrapper = await mountView()
    await flushPromises()

    const viewBtn = wrapper.find('button')
    const allBtns = wrapper.findAll('button')
    const viewButton = allBtns.find((b) => b.text() === 'View')
    expect(viewButton).toBeDefined()

    await viewButton!.trigger('click')

    expect(pushMock).toHaveBeenCalledWith({
      name: 'run-detail',
      params: { id: 'run-001-abcdef123456' },
    })
  })

  it('calls fetchRuns on mount', async () => {
    await mountView()
    await flushPromises()

    expect(mockFetchRuns).toHaveBeenCalled()
  })

  it('applies status filter and resets page to 1', async () => {
    runStore.filteredRuns = sampleRuns
    runStore.totalCount = sampleRuns.length

    const wrapper = await mountView()
    await flushPromises()

    const filterBtns = wrapper.findAll('header button')
    const completedFilter = filterBtns.find((b) => b.text() === 'Completed')
    expect(completedFilter).toBeDefined()

    await completedFilter!.trigger('click')
    await flushPromises()

    expect(runStore.setStatusFilter).toHaveBeenCalledWith('completed')
  })

  it('shows error alert with dismiss button', async () => {
    runStore.error = 'Failed to fetch runs'

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Failed to fetch runs')

    const dismissBtn = wrapper.find('[role="alert"] button')
    expect(dismissBtn.exists()).toBe(true)

    await dismissBtn.trigger('click')
    expect(runStore.clearError).toHaveBeenCalled()
  })

  it('shows pagination controls', async () => {
    runStore.filteredRuns = sampleRuns
    runStore.totalCount = 100

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Page 1 of 4')
    expect(wrapper.text()).toContain('Previous')
    expect(wrapper.text()).toContain('Next')
  })

  it('disables Previous button on first page', async () => {
    runStore.filteredRuns = sampleRuns
    runStore.totalCount = 100

    const wrapper = await mountView()
    await flushPromises()

    const paginationBtns = wrapper.findAll('.mt-4 button')
    const prevBtn = paginationBtns.find((b) => b.text() === 'Previous')
    expect(prevBtn?.attributes('disabled')).toBeDefined()
  })

  it('shows total count in header', async () => {
    runStore.totalCount = 42

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('42 total runs')
  })

  it('truncates long run IDs in the table', async () => {
    runStore.filteredRuns = [sampleRuns[0]!]
    runStore.totalCount = 1

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('run-001-...')
    expect(wrapper.text()).not.toContain('run-001-abcdef123456')
  })
})
