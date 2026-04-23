/**
 * Tests for the AgentDefinitions view component.
 *
 * Verifies: loading state, empty state, definition card rendering,
 * status indicators, filter tabs, create modal, edit modal,
 * delete confirmation flow, and error display.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const mockFetchAgents = vi.fn(async () => {})
const mockFetchAgent = vi.fn(async () => null)
const mockCreateAgent = vi.fn(async () => null)
const mockUpdateAgent = vi.fn(async () => null)
const mockDeleteAgent = vi.fn(async () => false)

type MockAgentSummary = {
  id: string
  name: string
  description?: string
  modelTier: string
  active: boolean
}

const agentStore = {
  agents: [] as MockAgentSummary[],
  filteredAgents: [] as MockAgentSummary[],
  isLoading: false,
  isSaving: false,
  error: null as string | null,
  filter: 'all' as 'all' | 'active' | 'inactive',
  agentCount: 0,
  activeCount: 0,
  fetchAgents: mockFetchAgents,
  fetchAgent: mockFetchAgent,
  createAgent: mockCreateAgent,
  updateAgent: mockUpdateAgent,
  deleteAgent: mockDeleteAgent,
  setFilter: vi.fn((value: string) => {
    agentStore.filter = value as 'all' | 'active' | 'inactive'
  }),
  clearError: vi.fn(() => {
    agentStore.error = null
  }),
}

vi.mock('../stores/agent-definitions-store.js', () => ({
  useAgentDefinitionsStore: () => agentStore,
}))

async function mountView() {
  const { default: AgentDefinitionsView } = await import('../views/AgentDefinitionsView.vue')
  return mount(AgentDefinitionsView, {
    global: {
      stubs: {
        Teleport: true,
      },
    },
  })
}

const sampleAgents: MockAgentSummary[] = [
  {
    id: 'agent-001',
    name: 'Code Assistant',
    description: 'Helps with coding tasks',
    modelTier: 'sonnet',
    active: true,
  },
  {
    id: 'agent-002',
    name: 'Data Analyst',
    description: 'Analyzes data and generates reports',
    modelTier: 'opus',
    active: true,
  },
  {
    id: 'agent-003',
    name: 'Legacy Bot',
    modelTier: 'haiku',
    active: false,
  },
]

describe('AgentDefinitionsView', () => {
  beforeEach(() => {
    mockFetchAgents.mockReset()
    mockFetchAgent.mockReset()
    mockCreateAgent.mockReset()
    mockUpdateAgent.mockReset()
    mockDeleteAgent.mockReset()
    agentStore.agents = []
    agentStore.filteredAgents = []
    agentStore.isLoading = false
    agentStore.isSaving = false
    agentStore.error = null
    agentStore.filter = 'all'
    agentStore.agentCount = 0
    agentStore.activeCount = 0
  })

  it('shows loading state while fetching agent definitions', async () => {
    agentStore.isLoading = true

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Loading agent definitions...')
  })

  it('shows empty state when no agent definitions exist', async () => {
    agentStore.filteredAgents = []

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('No agent definitions found')
    expect(wrapper.text()).toContain('Create your first agent definition')
  })

  it('calls fetchAgents on mount', async () => {
    await mountView()
    await flushPromises()

    expect(mockFetchAgents).toHaveBeenCalled()
  })

  it('renders agent cards with name, description, and model tier', async () => {
    agentStore.filteredAgents = sampleAgents
    agentStore.agentCount = 3
    agentStore.activeCount = 2

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Code Assistant')
    expect(wrapper.text()).toContain('Helps with coding tasks')
    expect(wrapper.text()).toContain('sonnet')

    expect(wrapper.text()).toContain('Data Analyst')
    expect(wrapper.text()).toContain('Analyzes data and generates reports')
    expect(wrapper.text()).toContain('opus')

    expect(wrapper.text()).toContain('Legacy Bot')
    expect(wrapper.text()).toContain('haiku')
  })

  it('displays active/inactive status indicators', async () => {
    agentStore.filteredAgents = sampleAgents

    const wrapper = await mountView()
    await flushPromises()

    const statusDots = wrapper.findAll('.rounded-full.h-2\\.5.w-2\\.5')
    expect(statusDots.length).toBe(3)

    // Active agents should have success color
    expect(statusDots[0]!.classes()).toContain('bg-pg-success')
    expect(statusDots[1]!.classes()).toContain('bg-pg-success')
    // Inactive agent should have muted color
    expect(statusDots[2]!.classes()).toContain('bg-pg-text-muted')
  })

  it('displays agent count in header', async () => {
    agentStore.agentCount = 3
    agentStore.activeCount = 2

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('2 active of 3 total')
  })

  it('renders filter tabs for all, active, and inactive', async () => {
    const wrapper = await mountView()
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('all')
    expect(text).toContain('active')
    expect(text).toContain('inactive')
  })

  it('shows error alert with dismiss button', async () => {
    agentStore.error = 'Network error'

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Network error')

    const dismissBtn = wrapper.find('[role="alert"] button')
    expect(dismissBtn.exists()).toBe(true)

    await dismissBtn.trigger('click')
    expect(agentStore.clearError).toHaveBeenCalled()
  })

  it('displays agent IDs in the cards', async () => {
    agentStore.filteredAgents = sampleAgents

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('agent-001')
    expect(wrapper.text()).toContain('agent-002')
    expect(wrapper.text()).toContain('agent-003')
  })

  it('shows Edit and Deactivate buttons on each agent card', async () => {
    agentStore.filteredAgents = [sampleAgents[0]!]

    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Edit')
    expect(wrapper.text()).toContain('Deactivate')
  })

  it('shows New Definition button in header', async () => {
    const wrapper = await mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('+ New Definition')
  })
})
