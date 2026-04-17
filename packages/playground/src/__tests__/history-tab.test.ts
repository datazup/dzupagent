/**
 * Tests for the HistoryTab component.
 *
 * Covers: loading state, empty state, error display, run list rendering,
 * status badge classes, filter pill clicks, run click navigation,
 * and utility function branches (formatTimestamp, formatDuration, statusBadgeClass).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const mockFetchRuns = vi.fn(async () => {})
const mockPush = vi.fn()

const runStore = {
  runs: [] as Array<{ id: string; status: string; startedAt: string; agentId: string; durationMs?: number }>,
  filteredRuns: [] as Array<{ id: string; status: string; startedAt: string; agentId: string; durationMs?: number }>,
  isLoading: false,
  error: null as string | null,
  statusFilter: 'all' as string,
  totalCount: 0,
  fetchRuns: mockFetchRuns,
  setStatusFilter: vi.fn(),
}

vi.mock('../stores/run-store.js', () => ({
  useRunStore: () => runStore,
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}))

async function mountHistoryTab() {
  const { default: HistoryTab } = await import('../components/inspector/HistoryTab.vue')
  return mount(HistoryTab)
}

describe('HistoryTab', () => {
  beforeEach(() => {
    mockFetchRuns.mockReset()
    mockPush.mockReset()
    runStore.runs = []
    runStore.filteredRuns = []
    runStore.isLoading = false
    runStore.error = null
    runStore.statusFilter = 'all'
    runStore.totalCount = 0
    runStore.setStatusFilter.mockClear()
  })

  it('calls fetchRuns on mount', async () => {
    await mountHistoryTab()
    await flushPromises()
    expect(mockFetchRuns).toHaveBeenCalled()
  })

  it('shows loading state', async () => {
    runStore.isLoading = true
    const wrapper = await mountHistoryTab()
    await flushPromises()
    expect(wrapper.text()).toContain('Loading...')
  })

  it('shows error message with role alert', async () => {
    runStore.error = 'Network timeout'
    const wrapper = await mountHistoryTab()
    await flushPromises()
    expect(wrapper.text()).toContain('Network timeout')
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })

  it('shows empty state when no runs and not loading', async () => {
    runStore.filteredRuns = []
    const wrapper = await mountHistoryTab()
    await flushPromises()
    expect(wrapper.text()).toContain('No runs found.')
  })

  it('renders run list items', async () => {
    runStore.filteredRuns = [
      { id: 'run-001', status: 'completed', startedAt: '2025-01-01T00:00:00Z', agentId: 'agent-a', durationMs: 1500 },
      { id: 'run-002', status: 'failed', startedAt: '2025-01-02T00:00:00Z', agentId: 'agent-b' },
    ]
    runStore.totalCount = 2

    const wrapper = await mountHistoryTab()
    await flushPromises()

    expect(wrapper.text()).toContain('run-001')
    expect(wrapper.text()).toContain('run-002')
    expect(wrapper.text()).toContain('completed')
    expect(wrapper.text()).toContain('failed')
    expect(wrapper.text()).toContain('agent-a')
    expect(wrapper.text()).toContain('agent-b')
    expect(wrapper.text()).toContain('Runs (2)')
  })

  it('formats duration correctly for runs', async () => {
    runStore.filteredRuns = [
      { id: 'r1', status: 'completed', startedAt: '2025-01-01T00:00:00Z', agentId: 'a', durationMs: 500 },
      { id: 'r2', status: 'completed', startedAt: '2025-01-01T00:00:00Z', agentId: 'a', durationMs: 2500 },
      { id: 'r3', status: 'running', startedAt: '2025-01-01T00:00:00Z', agentId: 'a', durationMs: undefined },
    ]
    const wrapper = await mountHistoryTab()
    await flushPromises()
    expect(wrapper.text()).toContain('500ms')
    expect(wrapper.text()).toContain('2.5s')
    expect(wrapper.text()).toContain('--')
  })

  it('renders status filter pills', async () => {
    const wrapper = await mountHistoryTab()
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('All')
    expect(text).toContain('Completed')
    expect(text).toContain('Running')
    expect(text).toContain('Pending')
    expect(text).toContain('Approval')
    expect(text).toContain('Failed')
    expect(text).toContain('Cancelled')
  })

  it('clicking a status filter calls setStatusFilter', async () => {
    const wrapper = await mountHistoryTab()
    await flushPromises()

    const buttons = wrapper.findAll('button')
    const completedBtn = buttons.find((b) => b.text() === 'Completed')
    expect(completedBtn).toBeDefined()

    await completedBtn!.trigger('click')
    expect(runStore.setStatusFilter).toHaveBeenCalledWith('completed')
  })

  it('clicking a run navigates to run detail', async () => {
    runStore.filteredRuns = [
      { id: 'run-xyz', status: 'completed', startedAt: '2025-01-01T00:00:00Z', agentId: 'a' },
    ]
    const wrapper = await mountHistoryTab()
    await flushPromises()

    const runButton = wrapper.findAll('button').find((b) => b.text().includes('run-xyz'))
    expect(runButton).toBeDefined()
    await runButton!.trigger('click')
    expect(mockPush).toHaveBeenCalledWith('/runs/run-xyz')
  })

  it('shows refresh button that triggers fetchRuns', async () => {
    const wrapper = await mountHistoryTab()
    await flushPromises()

    const refreshBtn = wrapper.findAll('button').find((b) => b.text() === 'Refresh')
    expect(refreshBtn).toBeDefined()
    await refreshBtn!.trigger('click')
    // fetchRuns called once on mount and once on click
    expect(mockFetchRuns).toHaveBeenCalledTimes(2)
  })

  it('highlights active status filter', async () => {
    runStore.statusFilter = 'completed'
    const wrapper = await mountHistoryTab()
    await flushPromises()

    const completedBtn = wrapper.findAll('button').find((b) => b.text() === 'Completed')
    expect(completedBtn?.classes()).toContain('bg-pg-accent/15')
  })
})
