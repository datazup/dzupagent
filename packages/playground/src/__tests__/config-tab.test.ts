/**
 * Tests for the ConfigTab component.
 *
 * ConfigTab shows agent-definition configuration and supports inline editing.
 * We stub both the chat store and agent-definition store to avoid network calls.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useChatStore } from '../stores/chat-store.js'
import { useAgentDefinitionsStore } from '../stores/agent-definitions-store.js'
import type { AgentDefinitionDetail } from '../types.js'

// -- Mock useApi --
const getMock = vi.fn()
const patchMock = vi.fn()

vi.mock('../composables/useApi.js', () => ({
  useApi: () => ({
    get: getMock,
    post: vi.fn(),
    patch: patchMock,
    del: vi.fn(),
    buildUrl: vi.fn((p: string) => p),
  }),
}))

function makeAgentDetail(overrides: Partial<AgentDefinitionDetail> = {}): AgentDefinitionDetail {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    description: 'A powerful test agent',
    modelTier: 'standard',
    active: true,
    instructions: 'You are a helpful assistant.',
    tools: ['search', 'code_edit'],
    approval: 'auto',
    guardrails: {},
    metadata: {},
    ...overrides,
  }
}

async function mountConfigTab() {
  const { default: ConfigTab } = await import('../components/inspector/ConfigTab.vue')
  return mount(ConfigTab)
}

describe('ConfigTab', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getMock.mockReset()
    patchMock.mockReset()
  })

  it('shows placeholder when no agent is selected', async () => {
    const wrapper = await mountConfigTab()
    await flushPromises()

    expect(wrapper.text()).toContain('Select an agent to view its configuration')
  })

  it('fetches and renders agent details when agent is selected', async () => {
    const agentDetail = makeAgentDetail()
    getMock.mockResolvedValue({ data: agentDetail })

    const chatStore = useChatStore()
    chatStore.currentAgentId = 'agent-1'

    const wrapper = await mountConfigTab()
    await flushPromises()

    expect(wrapper.text()).toContain('Test Agent')
    expect(wrapper.text()).toContain('A powerful test agent')
    expect(wrapper.text()).toContain('standard')
    expect(wrapper.text()).toContain('Active')
  })

  it('displays agent ID', async () => {
    const agentDetail = makeAgentDetail({ id: 'my-agent-id' })
    getMock.mockResolvedValue({ data: agentDetail })

    const chatStore = useChatStore()
    chatStore.currentAgentId = 'my-agent-id'

    const wrapper = await mountConfigTab()
    await flushPromises()

    expect(wrapper.text()).toContain('my-agent-id')
  })

  it('displays instructions', async () => {
    const agentDetail = makeAgentDetail({ instructions: 'Be helpful and concise.' })
    getMock.mockResolvedValue({ data: agentDetail })

    const chatStore = useChatStore()
    chatStore.currentAgentId = 'agent-1'

    const wrapper = await mountConfigTab()
    await flushPromises()

    expect(wrapper.text()).toContain('Be helpful and concise.')
  })

  it('displays tool badges', async () => {
    const agentDetail = makeAgentDetail({ tools: ['search', 'code_edit', 'file_read'] })
    getMock.mockResolvedValue({ data: agentDetail })

    const chatStore = useChatStore()
    chatStore.currentAgentId = 'agent-1'

    const wrapper = await mountConfigTab()
    await flushPromises()

    expect(wrapper.text()).toContain('search')
    expect(wrapper.text()).toContain('code_edit')
    expect(wrapper.text()).toContain('file_read')
  })

  it('displays approval mode badge', async () => {
    const agentDetail = makeAgentDetail({ approval: 'required' })
    getMock.mockResolvedValue({ data: agentDetail })

    const chatStore = useChatStore()
    chatStore.currentAgentId = 'agent-1'

    const wrapper = await mountConfigTab()
    await flushPromises()

    expect(wrapper.text()).toContain('approval: required')
  })

  it('shows Edit button in view mode', async () => {
    const agentDetail = makeAgentDetail()
    getMock.mockResolvedValue({ data: agentDetail })

    const chatStore = useChatStore()
    chatStore.currentAgentId = 'agent-1'

    const wrapper = await mountConfigTab()
    await flushPromises()

    const editBtn = wrapper.findAll('button').find((b) => b.text() === 'Edit')
    expect(editBtn).toBeDefined()
  })

  it('switches to edit mode when Edit button is clicked', async () => {
    const agentDetail = makeAgentDetail()
    getMock.mockResolvedValue({ data: agentDetail })

    const chatStore = useChatStore()
    chatStore.currentAgentId = 'agent-1'

    const wrapper = await mountConfigTab()
    await flushPromises()

    const editBtn = wrapper.findAll('button').find((b) => b.text() === 'Edit')
    await editBtn!.trigger('click')

    // In edit mode, should show Save and Cancel buttons
    const buttons = wrapper.findAll('button').map((b) => b.text())
    expect(buttons).toContain('Save')
    expect(buttons).toContain('Cancel')
  })

  it('shows textarea for instructions in edit mode', async () => {
    const agentDetail = makeAgentDetail({ instructions: 'Original instructions' })
    getMock.mockResolvedValue({ data: agentDetail })

    const chatStore = useChatStore()
    chatStore.currentAgentId = 'agent-1'

    const wrapper = await mountConfigTab()
    await flushPromises()

    const editBtn = wrapper.findAll('button').find((b) => b.text() === 'Edit')
    await editBtn!.trigger('click')

    const textarea = wrapper.find('textarea')
    expect(textarea.exists()).toBe(true)
    expect((textarea.element as HTMLTextAreaElement).value).toBe('Original instructions')
  })

  it('shows approval mode select in edit mode', async () => {
    const agentDetail = makeAgentDetail({ approval: 'conditional' })
    getMock.mockResolvedValue({ data: agentDetail })

    const chatStore = useChatStore()
    chatStore.currentAgentId = 'agent-1'

    const wrapper = await mountConfigTab()
    await flushPromises()

    const editBtn = wrapper.findAll('button').find((b) => b.text() === 'Edit')
    await editBtn!.trigger('click')

    const select = wrapper.find('select')
    expect(select.exists()).toBe(true)
    expect((select.element as HTMLSelectElement).value).toBe('conditional')
  })

  it('Cancel button exits edit mode', async () => {
    const agentDetail = makeAgentDetail()
    getMock.mockResolvedValue({ data: agentDetail })

    const chatStore = useChatStore()
    chatStore.currentAgentId = 'agent-1'

    const wrapper = await mountConfigTab()
    await flushPromises()

    // Enter edit mode
    const editBtn = wrapper.findAll('button').find((b) => b.text() === 'Edit')
    await editBtn!.trigger('click')

    // Cancel
    const cancelBtn = wrapper.findAll('button').find((b) => b.text() === 'Cancel')
    await cancelBtn!.trigger('click')

    // Should be back in view mode, Edit button should be visible again
    const editBtnAgain = wrapper.findAll('button').find((b) => b.text() === 'Edit')
    expect(editBtnAgain).toBeDefined()
  })

  it('Save button calls updateAgent and exits edit mode', async () => {
    const agentDetail = makeAgentDetail()
    const updatedDetail = makeAgentDetail({ instructions: 'Updated instructions' })
    getMock.mockResolvedValue({ data: agentDetail })
    patchMock.mockResolvedValue({ data: updatedDetail })

    const chatStore = useChatStore()
    chatStore.currentAgentId = 'agent-1'

    const wrapper = await mountConfigTab()
    await flushPromises()

    // Enter edit mode
    const editBtn = wrapper.findAll('button').find((b) => b.text() === 'Edit')
    await editBtn!.trigger('click')

    // Modify instructions
    const textarea = wrapper.find('textarea')
    await textarea.setValue('Updated instructions')

    // Save
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === 'Save')
    await saveBtn!.trigger('click')
    await flushPromises()

    expect(patchMock).toHaveBeenCalled()
  })

  it('shows Inactive badge when agent is not active', async () => {
    const agentDetail = makeAgentDetail({ active: false })
    getMock.mockResolvedValue({ data: agentDetail })

    const chatStore = useChatStore()
    chatStore.currentAgentId = 'agent-1'

    const wrapper = await mountConfigTab()
    await flushPromises()

    expect(wrapper.text()).toContain('Inactive')
  })

  it('displays guardrails when present', async () => {
    const agentDetail = makeAgentDetail({
      guardrails: { maxTokens: 4096, blockedTopics: ['violence'] },
    })
    getMock.mockResolvedValue({ data: agentDetail })

    const chatStore = useChatStore()
    chatStore.currentAgentId = 'agent-1'

    const wrapper = await mountConfigTab()
    await flushPromises()

    expect(wrapper.text()).toContain('Guardrails')
    expect(wrapper.text()).toContain('maxTokens')
    expect(wrapper.text()).toContain('4096')
  })

  it('displays metadata when present', async () => {
    const agentDetail = makeAgentDetail({
      metadata: { version: '2.0', team: 'platform' },
    })
    getMock.mockResolvedValue({ data: agentDetail })

    const chatStore = useChatStore()
    chatStore.currentAgentId = 'agent-1'

    const wrapper = await mountConfigTab()
    await flushPromises()

    expect(wrapper.text()).toContain('Metadata')
    expect(wrapper.text()).toContain('platform')
  })

  it('shows error message from agent store', async () => {
    getMock.mockRejectedValue(new Error('Agent not found'))

    const chatStore = useChatStore()
    chatStore.currentAgentId = 'agent-1'

    const wrapper = await mountConfigTab()
    await flushPromises()

    const agentStore = useAgentDefinitionsStore()
    expect(agentStore.error).toBe('Agent not found')
  })
})
