/**
 * Tests for the chat Pinia store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatStore } from '../stores/chat-store.js'

const getMock = vi.fn(async (path: string) => {
  if (path.startsWith('/api/agents')) {
    return {
      data: [
        { id: 'agent-1', name: 'Test Agent', modelTier: 'sonnet', active: true },
      ],
    }
  }

  if (path === '/api/runs/run-1') {
    return {
      data: {
        id: 'run-1',
        agentId: 'agent-1',
        status: 'completed',
        startedAt: '2025-01-01T00:00:00.000Z',
        completedAt: '2025-01-01T00:00:01.000Z',
        output: 'Hello from assistant',
      },
    }
  }

  if (path === '/api/runs/run-1/trace') {
    return {
      data: {
        events: [
          { message: 'model call', phase: 'llm', timestamp: '2025-01-01T00:00:00.500Z' },
        ],
      },
    }
  }

  return { data: [] }
})

const postMock = vi.fn(async () => ({
  data: {
    id: 'run-1',
    agentId: 'agent-1',
    status: 'queued',
    startedAt: '2025-01-01T00:00:00.000Z',
  },
}))

// Mock the useApi composable
vi.mock('../composables/useApi.js', () => ({
  useApi: () => ({
    get: getMock,
    post: postMock,
    patch: vi.fn(),
    del: vi.fn(),
    buildUrl: vi.fn((p: string) => p),
  }),
}))

describe('chat-store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getMock.mockClear()
    postMock.mockClear()
  })

  it('starts with empty state', () => {
    const store = useChatStore()
    expect(store.messages).toEqual([])
    expect(store.currentAgentId).toBeNull()
    expect(store.agents).toEqual([])
    expect(store.isLoading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('sendMessage adds user, system, and assistant messages', async () => {
    const store = useChatStore()
    store.currentAgentId = 'agent-1'

    await store.sendMessage('Hello')

    expect(store.messages.length).toBe(3)
    expect(store.messages[0]?.role).toBe('user')
    expect(store.messages[1]?.role).toBe('system')
    expect(store.messages[2]?.role).toBe('assistant')
    expect(store.messages[2]?.content).toBe('Hello from assistant')
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
    expect(store.messageCount).toBe(3)
  })

  it('currentAgent getter returns the selected agent', async () => {
    const store = useChatStore()
    await store.fetchAgents()
    store.selectAgent('agent-1')

    expect(store.currentAgent).not.toBeNull()
    expect(store.currentAgent?.name).toBe('Test Agent')
  })
})
