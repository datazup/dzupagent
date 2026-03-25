/**
 * Memory store -- manages memory namespace browsing and record search.
 *
 * Fetches memory data from the ForgeAgent server's memory-browse API
 * and provides namespace listing and record search.
 *
 * @module memory-store
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { MemoryNamespace, MemoryRecord, ApiResponse } from '../types.js'
import { useApi } from '../composables/useApi.js'

export const useMemoryStore = defineStore('memory', () => {
  // ── State ─────────────────────────────────────────
  const namespaces = ref<MemoryNamespace[]>([])
  const records = ref<MemoryRecord[]>([])
  const selectedNamespace = ref<string | null>(null)
  const searchQuery = ref('')
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  // ── Getters ───────────────────────────────────────
  const filteredRecords = computed(() => {
    if (!searchQuery.value) return records.value
    const query = searchQuery.value.toLowerCase()
    return records.value.filter(
      (r) =>
        r.key.toLowerCase().includes(query) ||
        String(r.value).toLowerCase().includes(query),
    )
  })

  // ── Actions ───────────────────────────────────────
  const { get } = useApi()

  /** Fetch all memory namespaces */
  async function fetchNamespaces(): Promise<void> {
    isLoading.value = true
    error.value = null
    try {
      const result = await get<ApiResponse<MemoryNamespace[]>>('/api/memory-browse/namespaces')
      namespaces.value = result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch namespaces'
    } finally {
      isLoading.value = false
    }
  }

  /** Fetch records for a specific namespace */
  async function fetchNamespace(namespace: string): Promise<void> {
    selectedNamespace.value = namespace
    isLoading.value = true
    error.value = null
    try {
      const result = await get<ApiResponse<MemoryRecord[]>>(
        `/api/memory-browse/namespaces/${encodeURIComponent(namespace)}/records`,
      )
      records.value = result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch records'
    } finally {
      isLoading.value = false
    }
  }

  /** Search records across namespaces */
  async function searchRecords(query: string): Promise<void> {
    searchQuery.value = query
    if (!query) {
      records.value = []
      return
    }

    isLoading.value = true
    error.value = null
    try {
      const result = await get<ApiResponse<MemoryRecord[]>>(
        `/api/memory-browse/search?q=${encodeURIComponent(query)}`,
      )
      records.value = result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Search failed'
    } finally {
      isLoading.value = false
    }
  }

  /** Clear selection and records */
  function clearSelection(): void {
    selectedNamespace.value = null
    records.value = []
    searchQuery.value = ''
    error.value = null
  }

  return {
    // State
    namespaces,
    records,
    selectedNamespace,
    searchQuery,
    isLoading,
    error,

    // Getters
    filteredRecords,

    // Actions
    fetchNamespaces,
    fetchNamespace,
    searchRecords,
    clearSelection,
  }
})
