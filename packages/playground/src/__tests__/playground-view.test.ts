/**
 * Tests for the PlaygroundView component.
 *
 * Covers: agent selector rendering, agent selection event handling,
 * fetchAgents on mount, model tier badge display, layout structure.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const mockFetchAgents = vi.fn()
const mockSelectAgent = vi.fn()

const chatStore = {
  agents: [] as Array<{ id: string; name: string; modelTier: string }>,
  currentAgentId: null as string | null,
  currentAgent: null as { name: string; modelTier: string } | null,
  fetchAgents: mockFetchAgents,
  selectAgent: mockSelectAgent,
}

vi.mock('../stores/chat-store.js', () => ({
  useChatStore: () => chatStore,
}))

vi.mock('../components/chat/ChatPanel.vue', () => ({
  default: { template: '<div data-testid="chat-panel">ChatPanel</div>' },
}))

vi.mock('../components/inspector/InspectorPanel.vue', () => ({
  default: { template: '<div data-testid="inspector-panel">InspectorPanel</div>' },
}))

async function mountPlaygroundView() {
  const { default: PlaygroundView } = await import('../views/PlaygroundView.vue')
  return mount(PlaygroundView)
}

describe('PlaygroundView', () => {
  beforeEach(() => {
    mockFetchAgents.mockReset()
    mockSelectAgent.mockReset()
    chatStore.agents = []
    chatStore.currentAgentId = null
    chatStore.currentAgent = null
  })

  it('calls fetchAgents on mount', async () => {
    await mountPlaygroundView()
    await flushPromises()
    expect(mockFetchAgents).toHaveBeenCalled()
  })

  it('renders header with title', async () => {
    const wrapper = await mountPlaygroundView()
    await flushPromises()
    expect(wrapper.text()).toContain('Interactive Agent Console')
    expect(wrapper.text()).toContain('Pick an agent, send prompts, and inspect runtime signals.')
  })

  it('renders agent selector dropdown', async () => {
    const wrapper = await mountPlaygroundView()
    await flushPromises()
    expect(wrapper.find('#agent-select').exists()).toBe(true)
    expect(wrapper.text()).toContain('Select an agent...')
  })

  it('renders agent options in dropdown', async () => {
    chatStore.agents = [
      { id: 'a1', name: 'Agent Alpha', modelTier: 'sonnet' },
      { id: 'a2', name: 'Agent Beta', modelTier: 'opus' },
    ]
    const wrapper = await mountPlaygroundView()
    await flushPromises()
    const options = wrapper.findAll('#agent-select option')
    expect(options.length).toBe(3) // disabled placeholder + 2 agents
    expect(options[1]?.text()).toBe('Agent Alpha')
    expect(options[2]?.text()).toBe('Agent Beta')
  })

  it('selecting an agent calls selectAgent', async () => {
    chatStore.agents = [
      { id: 'a1', name: 'Agent Alpha', modelTier: 'sonnet' },
    ]
    const wrapper = await mountPlaygroundView()
    await flushPromises()

    const select = wrapper.find('#agent-select')
    await select.setValue('a1')
    expect(mockSelectAgent).toHaveBeenCalledWith('a1')
  })

  it('shows model tier badge when agent is selected', async () => {
    chatStore.currentAgent = { name: 'Alpha', modelTier: 'sonnet' }
    const wrapper = await mountPlaygroundView()
    await flushPromises()
    expect(wrapper.text()).toContain('sonnet')
  })

  it('does not show model tier badge when no agent selected', async () => {
    chatStore.currentAgent = null
    const wrapper = await mountPlaygroundView()
    await flushPromises()
    const badge = wrapper.findAll('.rounded-full').filter((el) => el.text().includes('sonnet'))
    expect(badge).toHaveLength(0)
  })

  it('renders ChatPanel and InspectorPanel stubs', async () => {
    const wrapper = await mountPlaygroundView()
    await flushPromises()
    expect(wrapper.find('[data-testid="chat-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="inspector-panel"]').exists()).toBe(true)
  })
})
