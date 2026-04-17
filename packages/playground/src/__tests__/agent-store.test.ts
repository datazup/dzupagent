/**
 * Tests for the agent Pinia store.
 *
 * Covers: fetchAgents, fetchAgent, createAgent, updateAgent,
 * deleteAgent, setFilter, clearError, computed getters.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAgentStore } from '../stores/agent-store.js'

const getMock = vi.fn()
const postMock = vi.fn()
const patchMock = vi.fn()
const delMock = vi.fn()

vi.mock('../composables/useApi.js', () => ({
  useApi: () => ({
    get: getMock,
    post: postMock,
    patch: patchMock,
    del: delMock,
    buildUrl: vi.fn((p: string) => p),
  }),
}))

describe('agent-store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getMock.mockReset()
    postMock.mockReset()
    patchMock.mockReset()
    delMock.mockReset()
  })

  it('starts with empty state', () => {
    const store = useAgentStore()
    expect(store.agents).toEqual([])
    expect(store.selectedAgent).toBeNull()
    expect(store.isLoading).toBe(false)
    expect(store.isSaving).toBe(false)
    expect(store.error).toBeNull()
    expect(store.filter).toBe('all')
    expect(store.agentCount).toBe(0)
    expect(store.activeCount).toBe(0)
  })

  // ── Getters ─────────────────────────────────────────

  it('filteredAgents returns all agents when filter is all', () => {
    const store = useAgentStore()
    store.agents = [
      { id: '1', name: 'A', active: true, modelTier: 'sonnet' },
      { id: '2', name: 'B', active: false, modelTier: 'haiku' },
    ] as never
    store.filter = 'all'
    expect(store.filteredAgents).toHaveLength(2)
  })

  it('filteredAgents returns only active agents when filter is active', () => {
    const store = useAgentStore()
    store.agents = [
      { id: '1', name: 'A', active: true, modelTier: 'sonnet' },
      { id: '2', name: 'B', active: false, modelTier: 'haiku' },
    ] as never
    store.filter = 'active'
    expect(store.filteredAgents).toHaveLength(1)
    expect(store.filteredAgents[0]?.id).toBe('1')
  })

  it('filteredAgents returns only inactive agents when filter is inactive', () => {
    const store = useAgentStore()
    store.agents = [
      { id: '1', name: 'A', active: true, modelTier: 'sonnet' },
      { id: '2', name: 'B', active: false, modelTier: 'haiku' },
    ] as never
    store.filter = 'inactive'
    expect(store.filteredAgents).toHaveLength(1)
    expect(store.filteredAgents[0]?.id).toBe('2')
  })

  it('agentCount returns total agent count', () => {
    const store = useAgentStore()
    store.agents = [
      { id: '1', name: 'A', active: true, modelTier: 'sonnet' },
      { id: '2', name: 'B', active: false, modelTier: 'haiku' },
    ] as never
    expect(store.agentCount).toBe(2)
  })

  it('activeCount returns only active agents count', () => {
    const store = useAgentStore()
    store.agents = [
      { id: '1', name: 'A', active: true, modelTier: 'sonnet' },
      { id: '2', name: 'B', active: false, modelTier: 'haiku' },
      { id: '3', name: 'C', active: true, modelTier: 'opus' },
    ] as never
    expect(store.activeCount).toBe(2)
  })

  // ── fetchAgents ─────────────────────────────────────

  it('fetchAgents with all filter makes request without params', async () => {
    getMock.mockResolvedValueOnce({ data: [] })
    const store = useAgentStore()
    store.filter = 'all'
    await store.fetchAgents()
    expect(getMock).toHaveBeenCalledWith('/api/agents')
    expect(store.isLoading).toBe(false)
  })

  it('fetchAgents with active filter adds query param', async () => {
    getMock.mockResolvedValueOnce({ data: [] })
    const store = useAgentStore()
    store.filter = 'active'
    await store.fetchAgents()
    expect(getMock).toHaveBeenCalledWith('/api/agents?active=true')
  })

  it('fetchAgents with inactive filter adds query param', async () => {
    getMock.mockResolvedValueOnce({ data: [] })
    const store = useAgentStore()
    store.filter = 'inactive'
    await store.fetchAgents()
    expect(getMock).toHaveBeenCalledWith('/api/agents?active=false')
  })

  it('fetchAgents populates agents array', async () => {
    getMock.mockResolvedValueOnce({
      data: [
        { id: '1', name: 'Agent A', active: true, modelTier: 'sonnet' },
      ],
    })
    const store = useAgentStore()
    await store.fetchAgents()
    expect(store.agents).toHaveLength(1)
    expect(store.agents[0]?.name).toBe('Agent A')
  })

  it('fetchAgents handles errors', async () => {
    getMock.mockRejectedValueOnce(new Error('Fetch failed'))
    const store = useAgentStore()
    await store.fetchAgents()
    expect(store.error).toBe('Fetch failed')
    expect(store.isLoading).toBe(false)
  })

  it('fetchAgents handles non-Error exceptions', async () => {
    getMock.mockRejectedValueOnce(42)
    const store = useAgentStore()
    await store.fetchAgents()
    expect(store.error).toBe('Failed to fetch agents')
  })

  // ── fetchAgent ──────────────────────────────────────

  it('fetchAgent sets selectedAgent and returns it', async () => {
    const agent = { id: 'a1', name: 'Test', active: true, modelTier: 'sonnet', instructions: 'help' }
    getMock.mockResolvedValueOnce({ data: agent })
    const store = useAgentStore()
    const result = await store.fetchAgent('a1')
    expect(result).toEqual(agent)
    expect(store.selectedAgent).toEqual(agent)
    expect(store.isLoading).toBe(false)
  })

  it('fetchAgent returns null on error', async () => {
    getMock.mockRejectedValueOnce(new Error('Not found'))
    const store = useAgentStore()
    const result = await store.fetchAgent('missing')
    expect(result).toBeNull()
    expect(store.error).toBe('Not found')
  })

  // ── createAgent ─────────────────────────────────────

  it('createAgent adds new agent to list', async () => {
    const newAgent = { id: 'a2', name: 'New', active: true, modelTier: 'sonnet' }
    postMock.mockResolvedValueOnce({ data: newAgent })
    const store = useAgentStore()
    store.agents = []
    const result = await store.createAgent({ name: 'New', instructions: 'test', modelTier: 'sonnet' })
    expect(result).toEqual(newAgent)
    expect(store.agents).toHaveLength(1)
    expect(store.isSaving).toBe(false)
  })

  it('createAgent handles error', async () => {
    postMock.mockRejectedValueOnce(new Error('Validation failed'))
    const store = useAgentStore()
    const result = await store.createAgent({ name: 'Bad', instructions: '', modelTier: 'sonnet' })
    expect(result).toBeNull()
    expect(store.error).toBe('Validation failed')
    expect(store.isSaving).toBe(false)
  })

  // ── updateAgent ─────────────────────────────────────

  it('updateAgent updates agent in list and selectedAgent', async () => {
    const updated = { id: 'a1', name: 'Updated', active: true, modelTier: 'opus' }
    patchMock.mockResolvedValueOnce({ data: updated })
    const store = useAgentStore()
    store.agents = [{ id: 'a1', name: 'Old', active: true, modelTier: 'sonnet' }] as unknown as typeof store.agents
    store.selectedAgent = { id: 'a1', name: 'Old' } as unknown as typeof store.selectedAgent

    const result = await store.updateAgent('a1', { name: 'Updated', modelTier: 'opus' })
    expect(result).toEqual(updated)
    expect(store.agents[0]?.name).toBe('Updated')
    expect(store.selectedAgent?.name).toBe('Updated')
    expect(store.isSaving).toBe(false)
  })

  it('updateAgent does not update selectedAgent when ids differ', async () => {
    const updated = { id: 'a1', name: 'Updated', active: true, modelTier: 'opus' }
    patchMock.mockResolvedValueOnce({ data: updated })
    const store = useAgentStore()
    store.agents = [{ id: 'a1', name: 'Old', active: true, modelTier: 'sonnet' }] as unknown as typeof store.agents
    store.selectedAgent = { id: 'a2', name: 'Other' } as unknown as typeof store.selectedAgent

    await store.updateAgent('a1', { name: 'Updated' })
    expect(store.selectedAgent?.name).toBe('Other')
  })

  it('updateAgent handles agent not found in list', async () => {
    const updated = { id: 'a1', name: 'Updated', active: true, modelTier: 'opus' }
    patchMock.mockResolvedValueOnce({ data: updated })
    const store = useAgentStore()
    store.agents = [] as never

    const result = await store.updateAgent('a1', { name: 'Updated' })
    expect(result).toEqual(updated)
    expect(store.agents).toHaveLength(0)
  })

  it('updateAgent handles error', async () => {
    patchMock.mockRejectedValueOnce(new Error('Update failed'))
    const store = useAgentStore()
    const result = await store.updateAgent('a1', { name: 'Updated' })
    expect(result).toBeNull()
    expect(store.error).toBe('Update failed')
  })

  // ── deleteAgent ─────────────────────────────────────

  it('deleteAgent soft-deletes agent in list and selectedAgent', async () => {
    delMock.mockResolvedValueOnce({})
    const store = useAgentStore()
    store.agents = [{ id: 'a1', name: 'Test', active: true, modelTier: 'sonnet' }] as unknown as typeof store.agents
    store.selectedAgent = { id: 'a1', name: 'Test', active: true } as unknown as typeof store.selectedAgent

    const result = await store.deleteAgent('a1')
    expect(result).toBe(true)
    expect(store.agents[0]?.active).toBe(false)
    expect(store.selectedAgent?.active).toBe(false)
    expect(store.isSaving).toBe(false)
  })

  it('deleteAgent does not update selectedAgent when ids differ', async () => {
    delMock.mockResolvedValueOnce({})
    const store = useAgentStore()
    store.agents = [{ id: 'a1', name: 'Test', active: true, modelTier: 'sonnet' }] as unknown as typeof store.agents
    store.selectedAgent = { id: 'a2', name: 'Other', active: true } as unknown as typeof store.selectedAgent

    await store.deleteAgent('a1')
    expect(store.selectedAgent?.active).toBe(true)
  })

  it('deleteAgent handles agent not in list', async () => {
    delMock.mockResolvedValueOnce({})
    const store = useAgentStore()
    store.agents = [] as never

    const result = await store.deleteAgent('a1')
    expect(result).toBe(true)
  })

  it('deleteAgent handles error', async () => {
    delMock.mockRejectedValueOnce(new Error('Delete failed'))
    const store = useAgentStore()
    const result = await store.deleteAgent('a1')
    expect(result).toBe(false)
    expect(store.error).toBe('Delete failed')
    expect(store.isSaving).toBe(false)
  })

  // ── setFilter ───────────────────────────────────────

  it('setFilter updates filter value', () => {
    const store = useAgentStore()
    store.setFilter('active')
    expect(store.filter).toBe('active')
    store.setFilter('inactive')
    expect(store.filter).toBe('inactive')
    store.setFilter('all')
    expect(store.filter).toBe('all')
  })

  // ── clearError ──────────────────────────────────────

  it('clearError resets error to null', () => {
    const store = useAgentStore()
    store.error = 'Something went wrong'
    store.clearError()
    expect(store.error).toBeNull()
  })
})
