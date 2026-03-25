/**
 * Tests for the memory Pinia store — covers namespace fetching,
 * record fetching, search, filtering, clearing, and error handling.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useMemoryStore } from '../stores/memory-store.js'

// Track mock return values so individual tests can override
let getMockReturn: unknown = { data: [] }
const getMock = vi.fn().mockImplementation(() => Promise.resolve(getMockReturn))

vi.mock('../composables/useApi.js', () => ({
  useApi: () => ({
    get: getMock,
    post: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    buildUrl: vi.fn((p: string) => p),
  }),
}))

describe('memory-store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getMock.mockClear()
    getMockReturn = { data: [] }
  })

  // ── Initial state ───────────────────────────────────

  it('starts with empty state', () => {
    const store = useMemoryStore()
    expect(store.namespaces).toEqual([])
    expect(store.records).toEqual([])
    expect(store.selectedNamespace).toBeNull()
    expect(store.searchQuery).toBe('')
    expect(store.isLoading).toBe(false)
    expect(store.error).toBeNull()
  })

  // ── fetchNamespaces ─────────────────────────────────

  describe('fetchNamespaces', () => {
    it('populates namespaces from API', async () => {
      getMockReturn = {
        data: [
          { name: 'conventions', recordCount: 5 },
          { name: 'lessons', recordCount: 12 },
        ],
      }
      const store = useMemoryStore()
      await store.fetchNamespaces()

      expect(store.namespaces).toHaveLength(2)
      expect(store.namespaces[0]?.name).toBe('conventions')
      expect(store.isLoading).toBe(false)
      expect(store.error).toBeNull()
    })

    it('sets error on fetch failure', async () => {
      getMock.mockRejectedValueOnce(new Error('Network error'))
      const store = useMemoryStore()
      await store.fetchNamespaces()

      expect(store.error).toBe('Network error')
      expect(store.namespaces).toEqual([])
      expect(store.isLoading).toBe(false)
    })

    it('sets generic error for non-Error exceptions', async () => {
      getMock.mockRejectedValueOnce('string-error')
      const store = useMemoryStore()
      await store.fetchNamespaces()

      expect(store.error).toBe('Failed to fetch namespaces')
    })
  })

  // ── fetchNamespace ──────────────────────────────────

  describe('fetchNamespace', () => {
    it('fetches records for a namespace', async () => {
      getMockReturn = {
        data: [
          { key: 'rule-1', value: 'Use strict mode', namespace: 'conventions' },
        ],
      }
      const store = useMemoryStore()
      await store.fetchNamespace('conventions')

      expect(store.selectedNamespace).toBe('conventions')
      expect(store.records).toHaveLength(1)
      expect(store.records[0]?.key).toBe('rule-1')
      expect(store.isLoading).toBe(false)
    })

    it('calls correct API endpoint with encoded namespace', async () => {
      getMockReturn = { data: [] }
      const store = useMemoryStore()
      await store.fetchNamespace('my namespace')

      expect(getMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/memory-browse/namespaces/my%20namespace/records'),
      )
    })

    it('sets error on fetch failure', async () => {
      getMock.mockRejectedValueOnce(new Error('Not found'))
      const store = useMemoryStore()
      await store.fetchNamespace('missing')

      expect(store.error).toBe('Not found')
      expect(store.isLoading).toBe(false)
    })
  })

  // ── searchRecords ───────────────────────────────────

  describe('searchRecords', () => {
    it('searches records via API', async () => {
      getMockReturn = {
        data: [
          { key: 'lesson-1', value: 'Always test', namespace: 'lessons' },
        ],
      }
      const store = useMemoryStore()
      await store.searchRecords('test')

      expect(store.searchQuery).toBe('test')
      expect(store.records).toHaveLength(1)
      expect(store.isLoading).toBe(false)
    })

    it('clears records when query is empty', async () => {
      const store = useMemoryStore()
      // First populate records
      getMockReturn = { data: [{ key: 'k', value: 'v', namespace: 'ns' }] }
      await store.searchRecords('something')
      expect(store.records).toHaveLength(1)

      // Then clear with empty query
      await store.searchRecords('')
      expect(store.records).toEqual([])
      expect(store.searchQuery).toBe('')
    })

    it('sets error on search failure', async () => {
      getMock.mockRejectedValueOnce(new Error('Search timeout'))
      const store = useMemoryStore()
      await store.searchRecords('query')

      expect(store.error).toBe('Search timeout')
      expect(store.isLoading).toBe(false)
    })
  })

  // ── filteredRecords ─────────────────────────────────

  describe('filteredRecords', () => {
    it('returns all records when no search query', async () => {
      getMockReturn = {
        data: [
          { key: 'a', value: 'alpha', namespace: 'ns' },
          { key: 'b', value: 'beta', namespace: 'ns' },
        ],
      }
      const store = useMemoryStore()
      await store.fetchNamespace('ns')

      expect(store.filteredRecords).toHaveLength(2)
    })

    it('filters records by key matching search query', async () => {
      getMockReturn = {
        data: [
          { key: 'typescript-rule', value: 'Use strict', namespace: 'ns' },
          { key: 'python-rule', value: 'Use types', namespace: 'ns' },
        ],
      }
      const store = useMemoryStore()
      await store.fetchNamespace('ns')
      store.searchQuery = 'typescript'

      expect(store.filteredRecords).toHaveLength(1)
      expect(store.filteredRecords[0]?.key).toBe('typescript-rule')
    })

    it('filters records by value matching search query', async () => {
      getMockReturn = {
        data: [
          { key: 'r1', value: 'Always use ESLint', namespace: 'ns' },
          { key: 'r2', value: 'Format with Prettier', namespace: 'ns' },
        ],
      }
      const store = useMemoryStore()
      await store.fetchNamespace('ns')
      store.searchQuery = 'eslint'

      expect(store.filteredRecords).toHaveLength(1)
      expect(store.filteredRecords[0]?.key).toBe('r1')
    })
  })

  // ── clearSelection ──────────────────────────────────

  describe('clearSelection', () => {
    it('resets all selection state', async () => {
      getMockReturn = {
        data: [{ key: 'k', value: 'v', namespace: 'ns' }],
      }
      const store = useMemoryStore()
      await store.fetchNamespace('ns')
      store.searchQuery = 'test'

      store.clearSelection()

      expect(store.selectedNamespace).toBeNull()
      expect(store.records).toEqual([])
      expect(store.searchQuery).toBe('')
      expect(store.error).toBeNull()
    })
  })
})
