/**
 * Marketplace store -- browse, search, install, and uninstall agent plugins.
 *
 * Communicates with the server marketplace API endpoints and maintains
 * local state for the marketplace UI (search, category filter, etc.).
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { MarketplaceAgent, MarketplaceCategory, ApiResponse } from '../types.js'
import { useApi } from '../composables/useApi.js'

/** All marketplace categories available for filtering */
export const MARKETPLACE_CATEGORIES: MarketplaceCategory[] = [
  'observability',
  'memory',
  'security',
  'codegen',
  'integration',
  'testing',
]

export const useMarketplaceStore = defineStore('marketplace', () => {
  const { get, post, del } = useApi()

  // ── State ─────────────────────────────────────────
  const agents = ref<MarketplaceAgent[]>([])
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const searchQuery = ref('')
  const selectedCategory = ref<MarketplaceCategory | null>(null)

  // ── Getters ───────────────────────────────────────

  /** Agents filtered by search query and selected category */
  const filteredAgents = computed<MarketplaceAgent[]>(() => {
    let result = agents.value

    // Filter by category
    if (selectedCategory.value) {
      result = result.filter((a) => a.category === selectedCategory.value)
    }

    // Filter by search query (name, description, tags)
    const query = searchQuery.value.toLowerCase().trim()
    if (query) {
      result = result.filter((a) => {
        if (a.name.toLowerCase().includes(query)) return true
        if (a.description.toLowerCase().includes(query)) return true
        if (a.tags.some((tag) => tag.toLowerCase().includes(query))) return true
        return false
      })
    }

    return result
  })

  /** Count of installed plugins */
  const installedCount = computed(() => agents.value.filter((a) => a.installed).length)

  // ── Actions ───────────────────────────────────────

  /**
   * Fetch all available marketplace agents from the server.
   */
  async function fetchAgents(): Promise<void> {
    isLoading.value = true
    error.value = null
    try {
      const result = await get<ApiResponse<MarketplaceAgent[]>>('/api/marketplace/agents')
      agents.value = result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch marketplace agents'
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Install an agent plugin by ID.
   */
  async function installAgent(agentId: string): Promise<boolean> {
    error.value = null
    try {
      await post<ApiResponse<{ installed: boolean }>>('/api/marketplace/install', { agentId })
      const idx = agents.value.findIndex((a) => a.id === agentId)
      if (idx >= 0) {
        agents.value[idx] = { ...agents.value[idx]!, installed: true }
      }
      return true
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to install agent'
      return false
    }
  }

  /**
   * Uninstall an agent plugin by ID.
   */
  async function uninstallAgent(agentId: string): Promise<boolean> {
    error.value = null
    try {
      await del<ApiResponse<{ uninstalled: boolean }>>(`/api/marketplace/${agentId}`)
      const idx = agents.value.findIndex((a) => a.id === agentId)
      if (idx >= 0) {
        agents.value[idx] = { ...agents.value[idx]!, installed: false }
      }
      return true
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to uninstall agent'
      return false
    }
  }

  /**
   * Set the category filter (null means "all").
   */
  function setCategory(category: MarketplaceCategory | null): void {
    selectedCategory.value = category
  }

  /**
   * Set the search query string.
   */
  function setSearchQuery(query: string): void {
    searchQuery.value = query
  }

  /**
   * Clear the current error message.
   */
  function clearError(): void {
    error.value = null
  }

  return {
    // State
    agents,
    isLoading,
    error,
    searchQuery,
    selectedCategory,
    // Getters
    filteredAgents,
    installedCount,
    // Actions
    fetchAgents,
    installAgent,
    uninstallAgent,
    setCategory,
    setSearchQuery,
    clearError,
  }
})
