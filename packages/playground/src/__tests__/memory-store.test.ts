/**
 * Tests for the memory Pinia store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useMemoryStore } from '../stores/memory-store.js'

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

  it('starts with empty state', () => {
    const store = useMemoryStore()
    expect(store.namespaces).toEqual([])
    expect(store.records).toEqual([])
    expect(store.selectedNamespace).toBeNull()
    expect(store.searchQuery).toBe('')
    expect(store.isLoading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('fetches records for a namespace', async () => {
    getMockReturn = {
      data: [{ key: 'rule-1', value: 'Use strict mode' }],
      total: 1,
    }
    const store = useMemoryStore()
    await store.fetchNamespace('conventions')

    expect(store.selectedNamespace).toBe('conventions')
    expect(store.records).toHaveLength(1)
    expect(store.records[0]?.key).toBe('rule-1')
    expect(store.namespaces[0]?.name).toBe('conventions')
  })

  it('calls /api/memory-browse/:namespace endpoint', async () => {
    const store = useMemoryStore()
    await store.fetchNamespace('my namespace')

    expect(getMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/memory-browse/my%20namespace'),
    )
  })

  it('searches within selected namespace', async () => {
    getMockReturn = {
      data: [{ key: 'lesson-1', value: 'Always test' }],
      total: 1,
    }
    const store = useMemoryStore()
    await store.fetchNamespace('lessons')
    await store.searchRecords('test')

    expect(store.searchQuery).toBe('test')
    expect(store.records).toHaveLength(1)
    expect(getMock).toHaveBeenLastCalledWith(
      expect.stringContaining('search=test'),
    )
  })

  it('requires namespace selection before search', async () => {
    const store = useMemoryStore()
    await store.searchRecords('query')

    expect(store.error).toBe('Select a namespace before searching records')
  })

  it('clearSelection resets selected state', async () => {
    getMockReturn = {
      data: [{ key: 'k', value: 'v' }],
      total: 1,
    }
    const store = useMemoryStore()
    await store.fetchNamespace('ns')
    store.searchQuery = 'x'

    store.clearSelection()

    expect(store.selectedNamespace).toBeNull()
    expect(store.records).toEqual([])
    expect(store.searchQuery).toBe('')
  })
})
