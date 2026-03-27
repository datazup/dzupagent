/**
 * Tests for the ChatPanel component.
 *
 * ChatPanel composes MessageList + ChatInput, connects to the chat store,
 * and shows error banners.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useChatStore } from '../stores/chat-store.js'
import type { ChatMessage, AgentSummary } from '../types.js'

// ---------- mock useApi so the store never touches the network ----------
vi.mock('../composables/useApi.js', () => ({
  useApi: () => ({
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(async () => ({ data: { id: 'run-1', status: 'pending', startedAt: new Date().toISOString(), agentId: 'a1' } })),
    patch: vi.fn(),
    del: vi.fn(),
    buildUrl: vi.fn((p: string) => p),
  }),
}))

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: 'Hello world',
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

function makeAgent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    description: 'A test agent',
    modelTier: 'standard',
    active: true,
    ...overrides,
  }
}

async function mountChatPanel() {
  const { default: ChatPanel } = await import('../components/chat/ChatPanel.vue')
  return mount(ChatPanel)
}

describe('ChatPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders with empty messages and shows "No conversation yet"', async () => {
    const wrapper = await mountChatPanel()
    expect(wrapper.text()).toContain('No conversation yet')
  })

  it('shows "Not selected" when no agent is selected', async () => {
    const wrapper = await mountChatPanel()
    expect(wrapper.text()).toContain('Not selected')
  })

  it('shows active agent name when agent is selected', async () => {
    const store = useChatStore()
    const agent = makeAgent({ id: 'a1', name: 'CodeBot' })
    store.agents = [agent]
    store.currentAgentId = 'a1'

    const wrapper = await mountChatPanel()
    await flushPromises()

    expect(wrapper.text()).toContain('CodeBot')
  })

  it('displays messages via MessageList when messages exist', async () => {
    const store = useChatStore()
    store.messages = [
      makeMessage({ content: 'First message', role: 'user' }),
      makeMessage({ content: 'Reply from assistant', role: 'assistant' }),
    ]

    const wrapper = await mountChatPanel()
    await flushPromises()

    expect(wrapper.text()).toContain('First message')
    expect(wrapper.text()).toContain('Reply from assistant')
    expect(wrapper.text()).not.toContain('No conversation yet')
  })

  it('shows the chat input area', async () => {
    const wrapper = await mountChatPanel()
    const textarea = wrapper.find('textarea[aria-label="Chat message input"]')
    expect(textarea.exists()).toBe(true)
  })

  it('disables input when no agent is selected', async () => {
    const wrapper = await mountChatPanel()
    const textarea = wrapper.find('textarea[aria-label="Chat message input"]')
    expect((textarea.element as HTMLTextAreaElement).disabled).toBe(true)
  })

  it('shows placeholder text for disabled state', async () => {
    const wrapper = await mountChatPanel()
    const textarea = wrapper.find('textarea[aria-label="Chat message input"]')
    expect((textarea.element as HTMLTextAreaElement).placeholder).toContain('Select an agent')
  })

  it('enables input when agent is selected', async () => {
    const store = useChatStore()
    store.agents = [makeAgent({ id: 'a1' })]
    store.currentAgentId = 'a1'

    const wrapper = await mountChatPanel()
    await flushPromises()

    const textarea = wrapper.find('textarea[aria-label="Chat message input"]')
    expect((textarea.element as HTMLTextAreaElement).disabled).toBe(false)
  })

  it('shows send button', async () => {
    const wrapper = await mountChatPanel()
    const sendBtn = wrapper.find('button[aria-label="Send message"]')
    expect(sendBtn.exists()).toBe(true)
  })

  it('shows loading state with "Sending..." text', async () => {
    const store = useChatStore()
    store.agents = [makeAgent({ id: 'a1' })]
    store.currentAgentId = 'a1'
    store.isLoading = true

    const wrapper = await mountChatPanel()
    await flushPromises()

    expect(wrapper.text()).toContain('Sending...')
  })

  it('shows error banner when store has error', async () => {
    const store = useChatStore()
    store.error = 'Connection failed'

    const wrapper = await mountChatPanel()
    await flushPromises()

    const alert = wrapper.find('[role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('Connection failed')
  })

  it('hides error banner when no error', async () => {
    const wrapper = await mountChatPanel()
    const alert = wrapper.find('[role="alert"]')
    expect(alert.exists()).toBe(false)
  })

  it('dismiss button clears the error', async () => {
    const store = useChatStore()
    store.error = 'Something went wrong'

    const wrapper = await mountChatPanel()
    await flushPromises()

    const dismissBtn = wrapper.find('[role="alert"] button')
    expect(dismissBtn.exists()).toBe(true)
    await dismissBtn.trigger('click')

    expect(store.error).toBeNull()
  })
})
