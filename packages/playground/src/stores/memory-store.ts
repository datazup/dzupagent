/**
 * Memory store -- manages memory namespace browsing and record search.
 *
 * Fetches memory data from the DzipAgent server's memory-browse API
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
  const scopeJson = ref('{"tenant":"default","project":"default"}')
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

  function updateNamespaceSummary(namespace: string, recordCount: number): void {
    const existingIndex = namespaces.value.findIndex((n) => n.name === namespace)
    const next = { name: namespace, recordCount }
    if (existingIndex === -1) {
      namespaces.value = [next, ...namespaces.value].slice(0, 10)
      return
    }
    namespaces.value = [
      next,
      ...namespaces.value.filter((n) => n.name !== namespace),
    ]
  }

  function parseScope(scopeOverride?: Record<string, string>): Record<string, string> {
    if (scopeOverride) return scopeOverride
    if (!scopeJson.value.trim()) return {}
    try {
      const parsed = JSON.parse(scopeJson.value) as unknown
      if (typeof parsed === 'object' && parsed && !Array.isArray(parsed)) {
        return Object.fromEntries(
          Object.entries(parsed).filter(
            ([, v]) => typeof v === 'string',
          ),
        ) as Record<string, string>
      }
    } catch {
      throw new Error('Scope must be valid JSON object (e.g. {"tenant":"default","project":"default"})')
    }
    return {}
  }

  /** Fetch records for a specific namespace */
  async function fetchNamespace(
    namespace: string,
    options?: { search?: string; scope?: Record<string, string> },
  ): Promise<void> {
    selectedNamespace.value = namespace
    isLoading.value = true
    error.value = null
    try {
      const query = new URLSearchParams()
      const scope = parseScope(options?.scope)
      if (Object.keys(scope).length > 0) {
        query.set('scope', JSON.stringify(scope))
      }
      if (options?.search) {
        query.set('search', options.search)
      }

      const url = `/api/memory-browse/${encodeURIComponent(namespace)}${query.size > 0 ? `?${query.toString()}` : ''}`
      const result = await get<ApiResponse<Array<{ key?: string; value: unknown }>> & { total?: number }>(url)
      records.value = result.data.map((record, index) => ({
        key: record.key ?? `record-${index}`,
        value: record.value,
        namespace,
      }))
      updateNamespaceSummary(namespace, result.total ?? records.value.length)
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch records'
    } finally {
      isLoading.value = false
    }
  }

  /** Search records across namespaces */
  async function searchRecords(query: string): Promise<void> {
    searchQuery.value = query
    if (!selectedNamespace.value) {
      error.value = 'Select a namespace before searching records'
      return
    }

    if (!query) {
      await fetchNamespace(selectedNamespace.value)
      return
    }

    await fetchNamespace(selectedNamespace.value, { search: query })
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
    scopeJson,
    isLoading,
    error,

    // Getters
    filteredRecords,

    // Actions
    fetchNamespace,
    searchRecords,
    clearSelection,
  }
})
