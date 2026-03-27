/**
 * Agent store -- full CRUD management of agent definitions.
 *
 * Powers the AgentsView for listing, creating, editing, and
 * soft-deleting agent definitions via the server API.
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  AgentSummary,
  AgentDetail,
  AgentCreateInput,
  AgentUpdateInput,
  ApiResponse,
} from '../types.js'
import { useApi } from '../composables/useApi.js'

export const useAgentStore = defineStore('agent', () => {
  const { get, post, patch, del } = useApi()

  // ── State ─────────────────────────────────────────
  const agents = ref<AgentSummary[]>([])
  const selectedAgent = ref<AgentDetail | null>(null)
  const isLoading = ref(false)
  const isSaving = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<'all' | 'active' | 'inactive'>('all')

  // ── Getters ───────────────────────────────────────
  const filteredAgents = computed(() => {
    if (filter.value === 'active') return agents.value.filter((a) => a.active)
    if (filter.value === 'inactive') return agents.value.filter((a) => !a.active)
    return agents.value
  })

  const agentCount = computed(() => agents.value.length)
  const activeCount = computed(() => agents.value.filter((a) => a.active).length)

  // ── Actions ───────────────────────────────────────

  async function fetchAgents(): Promise<void> {
    isLoading.value = true
    error.value = null
    try {
      const params = filter.value === 'all' ? '' : `?active=${filter.value === 'active'}`
      const result = await get<ApiResponse<AgentSummary[]>>(`/api/agents${params}`)
      agents.value = result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch agents'
    } finally {
      isLoading.value = false
    }
  }

  async function fetchAgent(id: string): Promise<AgentDetail | null> {
    isLoading.value = true
    error.value = null
    try {
      const result = await get<ApiResponse<AgentDetail>>(`/api/agents/${id}`)
      selectedAgent.value = result.data
      return result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch agent'
      return null
    } finally {
      isLoading.value = false
    }
  }

  async function createAgent(input: AgentCreateInput): Promise<AgentDetail | null> {
    isSaving.value = true
    error.value = null
    try {
      const result = await post<ApiResponse<AgentDetail>>('/api/agents', input)
      agents.value.push(result.data)
      return result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to create agent'
      return null
    } finally {
      isSaving.value = false
    }
  }

  async function updateAgent(id: string, input: AgentUpdateInput): Promise<AgentDetail | null> {
    isSaving.value = true
    error.value = null
    try {
      const result = await patch<ApiResponse<AgentDetail>>(`/api/agents/${id}`, input)
      const idx = agents.value.findIndex((a) => a.id === id)
      if (idx >= 0) {
        agents.value[idx] = result.data
      }
      if (selectedAgent.value?.id === id) {
        selectedAgent.value = result.data
      }
      return result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to update agent'
      return null
    } finally {
      isSaving.value = false
    }
  }

  async function deleteAgent(id: string): Promise<boolean> {
    isSaving.value = true
    error.value = null
    try {
      await del(`/api/agents/${id}`)
      const idx = agents.value.findIndex((a) => a.id === id)
      if (idx >= 0) {
        agents.value[idx] = { ...agents.value[idx]!, active: false }
      }
      if (selectedAgent.value?.id === id) {
        selectedAgent.value = { ...selectedAgent.value, active: false }
      }
      return true
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to delete agent'
      return false
    } finally {
      isSaving.value = false
    }
  }

  function setFilter(value: 'all' | 'active' | 'inactive'): void {
    filter.value = value
  }

  function clearError(): void {
    error.value = null
  }

  return {
    agents,
    selectedAgent,
    isLoading,
    isSaving,
    error,
    filter,
    filteredAgents,
    agentCount,
    activeCount,
    fetchAgents,
    fetchAgent,
    createAgent,
    updateAgent,
    deleteAgent,
    setFilter,
    clearError,
  }
})
