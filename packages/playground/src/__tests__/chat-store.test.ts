/**
 * Tests for the chat Pinia store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatStore } from '../stores/chat-store.js'

// Mock the useApi composable
vi.mock('../composables/useApi.js', () => ({
  useApi: () => ({
    get: vi.fn().mockResolvedValue({
      data: [
        { id: 'agent-1', name: 'Test Agent', modelTier: 'sonnet', active: true },
      ],
    }),
    post: vi.fn().mockResolvedValue({
      data: {
        id: 'msg-1',
        role: 'assistant' as const,
        content: 'Hello from assistant',
        timestamp: '2025-01-01T00:00:00.000Z',
      },
    }),
    patch: vi.fn(),
    del: vi.fn(),
    buildUrl: vi.fn((p: string) => p),
  }),
}))

describe('chat-store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts with empty state', () => {
    const store = useChatStore()
    expect(store.messages).toEqual([])
    expect(store.currentAgentId).toBeNull()
    expect(store.agents).toEqual([])
    expect(store.isLoading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('sendMessage adds a user message optimistically', async () => {
    const store = useChatStore()
    store.currentAgentId = 'agent-1'

    await store.sendMessage('Hello')

    // Should have user message + assistant response
    expect(store.messages.length).toBe(2)
    expect(store.messages[0]?.role).toBe('user')
    expect(store.messages[0]?.content).toBe('Hello')
    expect(store.messages[1]?.role).toBe('assistant')
  })

  it('sendMessage does nothing when no agent is selected', async () => {
    const store = useChatStore()

    await store.sendMessage('Hello')
    expect(store.messages.length).toBe(0)
  })

  it('clearMessages resets messages and error', async () => {
    const store = useChatStore()
    store.currentAgentId = 'agent-1'
    await store.sendMessage('Hello')

    store.clearMessages()

    expect(store.messages).toEqual([])
    expect(store.error).toBeNull()
  })

  it('selectAgent sets current agent and clears messages', async () => {
    const store = useChatStore()
    store.currentAgentId = 'agent-1'
    await store.sendMessage('Hello')

    store.selectAgent('agent-2')

    expect(store.currentAgentId).toBe('agent-2')
    expect(store.messages).toEqual([])
  })

  it('fetchAgents populates agents list', async () => {
    const store = useChatStore()
    await store.fetchAgents()

    expect(store.agents.length).toBe(1)
    expect(store.agents[0]?.name).toBe('Test Agent')
  })

  it('messageCount getter returns correct count', async () => {
    const store = useChatStore()
    store.currentAgentId = 'agent-1'

    expect(store.messageCount).toBe(0)

    await store.sendMessage('Hello')

    expect(store.messageCount).toBe(2)
  })

  it('currentAgent getter returns the selected agent', async () => {
    const store = useChatStore()
    await store.fetchAgents()
    store.selectAgent('agent-1')

    expect(store.currentAgent).not.toBeNull()
    expect(store.currentAgent?.name).toBe('Test Agent')
  })

  it('currentAgent getter returns null when no agent selected', () => {
    const store = useChatStore()
    expect(store.currentAgent).toBeNull()
  })
})
