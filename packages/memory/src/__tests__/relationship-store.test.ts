import { describe, it, expect, beforeEach } from 'vitest'
import { RelationshipStore } from '../retrieval/relationship-store.js'
import type { RelationshipEdge, RelationshipType } from '../retrieval/relationship-store.js'
import type { BaseStore } from '@langchain/langgraph'
import type { MemoryStoreCapabilities } from '../store-capabilities.js'

// ---------------------------------------------------------------------------
// Mock BaseStore — in-memory implementation with filter support
// ---------------------------------------------------------------------------

function createMockStore() {
  const data = new Map<string, Map<string, Record<string, unknown>>>()
  const capabilities: MemoryStoreCapabilities = {
    supportsDelete: true,
    supportsSearchFilters: true,
    supportsPagination: true,
  }
  return {
    async get(ns: string[], key: string) {
      const entry = data.get(ns.join('.'))?.get(key)
      return entry ? { value: entry, key } : undefined
    },
    async put(ns: string[], key: string, value: Record<string, unknown>) {
      const nsKey = ns.join('.')
      if (!data.has(nsKey)) data.set(nsKey, new Map())
      data.get(nsKey)!.set(key, value)
    },
    async delete(ns: string[], key: string) {
      data.get(ns.join('.'))?.delete(key)
    },
    async search(ns: string[], opts?: { limit?: number; query?: string; filter?: Record<string, unknown> }) {
      const nsKey = ns.join('.')
      const entries = data.get(nsKey)
      if (!entries) return []
      let results = [...entries].map(([k, v]) => ({ key: k, value: v }))
      // Apply filter matching (simple equality on fields)
      if (opts?.filter) {
        results = results.filter(r => {
          for (const [fk, fv] of Object.entries(opts.filter!)) {
            if ((r.value as Record<string, unknown>)[fk] !== fv) return false
          }
          return true
        })
      }
      return results.slice(0, opts?.limit ?? 100)
    },
    capabilities,
  } as unknown as BaseStore & {
    capabilities: MemoryStoreCapabilities
    _data: Map<string, Map<string, Record<string, unknown>>>
    search: ReturnType<typeof vi.fn>
    put: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEdge(
  from: string,
  type: RelationshipType,
  to: string,
  confidence = 0.9,
): RelationshipEdge {
  return {
    fromKey: from,
    toKey: to,
    type,
    createdAt: Date.now(),
    metadata: { confidence },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RelationshipStore', () => {
  let store: ReturnType<typeof createMockStore>
  let rs: RelationshipStore

  beforeEach(() => {
    store = createMockStore()
    rs = new RelationshipStore(store as unknown as BaseStore, ['test', 'ns'])
  })

  // -----------------------------------------------------------------------
  // addEdge / removeEdge
  // -----------------------------------------------------------------------

  describe('addEdge', () => {
    it('stores forward and reverse entries', async () => {
      const edge = makeEdge('A', 'causes', 'B')
      await rs.addEdge(edge)

      // Should be retrievable as outgoing from A
      const outgoing = await rs.getEdges('A', 'outgoing')
      expect(outgoing).toHaveLength(1)
      expect(outgoing[0]!.fromKey).toBe('A')
      expect(outgoing[0]!.toKey).toBe('B')
      expect(outgoing[0]!.type).toBe('causes')

      // Should be retrievable as incoming to B
      const incoming = await rs.getEdges('B', 'incoming')
      expect(incoming).toHaveLength(1)
      expect(incoming[0]!.fromKey).toBe('A')
      expect(incoming[0]!.toKey).toBe('B')
    })
  })

  describe('removeEdge', () => {
    it('removes both forward and reverse entries', async () => {
      await rs.addEdge(makeEdge('A', 'causes', 'B'))
      await rs.removeEdge('A', 'causes', 'B')

      const outgoing = await rs.getEdges('A', 'outgoing')
      expect(outgoing).toHaveLength(0)

      const incoming = await rs.getEdges('B', 'incoming')
      expect(incoming).toHaveLength(0)
    })

    it('removing non-existent edge does not throw', async () => {
      await expect(rs.removeEdge('X', 'causes', 'Y')).resolves.toBeUndefined()
    })

    it('soft-deletes when delete capability is unavailable', async () => {
      store.capabilities.supportsDelete = false
      rs = new RelationshipStore(store as unknown as BaseStore, ['test', 'ns'])

      await rs.addEdge(makeEdge('A', 'causes', 'B'))
      await rs.removeEdge('A', 'causes', 'B')

      const outgoing = await rs.getEdges('A', 'outgoing')
      expect(outgoing).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // getEdges
  // -----------------------------------------------------------------------

  describe('getEdges', () => {
    beforeEach(async () => {
      await rs.addEdge(makeEdge('A', 'causes', 'B'))
      await rs.addEdge(makeEdge('A', 'triggers', 'C'))
      await rs.addEdge(makeEdge('D', 'solves', 'A'))
    })

    it('returns only outgoing edges', async () => {
      const edges = await rs.getEdges('A', 'outgoing')
      expect(edges).toHaveLength(2)
      expect(edges.every(e => e.fromKey === 'A')).toBe(true)
    })

    it('returns only incoming edges', async () => {
      const edges = await rs.getEdges('A', 'incoming')
      expect(edges).toHaveLength(1)
      expect(edges[0]!.fromKey).toBe('D')
      expect(edges[0]!.toKey).toBe('A')
    })

    it('returns both directions when direction is both', async () => {
      const edges = await rs.getEdges('A', 'both')
      // 2 outgoing (A->B, A->C) + 1 incoming (D->A)
      expect(edges).toHaveLength(3)
    })

    it('defaults to both direction', async () => {
      const edges = await rs.getEdges('A')
      expect(edges).toHaveLength(3)
    })

    it('filters by edge types', async () => {
      const edges = await rs.getEdges('A', 'outgoing', ['causes'])
      expect(edges).toHaveLength(1)
      expect(edges[0]!.type).toBe('causes')
    })

    it('applies filters locally when search filters are unsupported', async () => {
      store.capabilities.supportsSearchFilters = false
      rs = new RelationshipStore(store as unknown as BaseStore, ['test', 'ns'])
      await rs.addEdge(makeEdge('A', 'causes', 'B'))
      await rs.addEdge(makeEdge('A', 'triggers', 'C'))

      const edges = await rs.getEdges('A', 'outgoing', ['causes'])
      expect(edges).toHaveLength(1)
      expect(edges[0]!.type).toBe('causes')
    })

    it('returns empty array for node with no edges', async () => {
      const edges = await rs.getEdges('Z', 'both')
      expect(edges).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // traverse
  // -----------------------------------------------------------------------

  describe('traverse', () => {
    beforeEach(async () => {
      // A -causes-> B -causes-> C -causes-> D
      await rs.addEdge(makeEdge('A', 'causes', 'B'))
      await rs.addEdge(makeEdge('B', 'causes', 'C'))
      await rs.addEdge(makeEdge('C', 'causes', 'D'))
      // Store some values in the base namespace so traverse can load them
      await store.put(['test', 'ns'], 'B', { text: 'node B' })
      await store.put(['test', 'ns'], 'C', { text: 'node C' })
      await store.put(['test', 'ns'], 'D', { text: 'node D' })
    })

    it('traverses 1 hop from start', async () => {
      const results = await rs.traverse('A', ['causes'], 1)
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('B')
      expect(results[0]!.hops).toBe(1)
      expect(results[0]!.path).toHaveLength(1)
    })

    it('traverses 2 hops from start', async () => {
      const results = await rs.traverse('A', ['causes'], 2)
      expect(results).toHaveLength(2)
      expect(results.map(r => r.key)).toContain('B')
      expect(results.map(r => r.key)).toContain('C')
    })

    it('traverses full chain with maxHops=3', async () => {
      const results = await rs.traverse('A', ['causes'], 3)
      expect(results).toHaveLength(3)
      expect(results.map(r => r.key)).toEqual(expect.arrayContaining(['B', 'C', 'D']))
    })

    it('respects limit parameter', async () => {
      const results = await rs.traverse('A', ['causes'], 3, 1)
      expect(results).toHaveLength(1)
    })

    it('does not revisit nodes (no cycles in output)', async () => {
      // Add a back-edge: C -> A
      await rs.addEdge(makeEdge('C', 'causes', 'A'))
      const results = await rs.traverse('A', ['causes'], 5)
      const keys = results.map(r => r.key)
      // No duplicates
      expect(new Set(keys).size).toBe(keys.length)
      // Start node should not appear in results
      expect(keys).not.toContain('A')
    })

    it('returns empty for node with no outgoing edges of type', async () => {
      const results = await rs.traverse('D', ['causes'], 3)
      expect(results).toHaveLength(0)
    })

    it('loads value from store for each result', async () => {
      const results = await rs.traverse('A', ['causes'], 1)
      expect(results[0]!.value).toEqual({ text: 'node B' })
    })

    it('returns empty object when target has no stored value', async () => {
      // E has no stored value
      await rs.addEdge(makeEdge('A', 'triggers', 'E'))
      const results = await rs.traverse('A', ['triggers'], 1)
      expect(results).toHaveLength(1)
      expect(results[0]!.value).toEqual({})
    })
  })

  // -----------------------------------------------------------------------
  // findCausalChain
  // -----------------------------------------------------------------------

  describe('findCausalChain', () => {
    beforeEach(async () => {
      // A -causes-> B -triggers-> C -causes-> D
      await rs.addEdge(makeEdge('A', 'causes', 'B'))
      await rs.addEdge(makeEdge('B', 'triggers', 'C'))
      await rs.addEdge(makeEdge('C', 'causes', 'D'))
    })

    it('finds a causal chain between connected nodes', async () => {
      const path = await rs.findCausalChain('A', 'D')
      expect(path).not.toBeNull()
      expect(path!).toHaveLength(3)
      expect(path![0]!.fromKey).toBe('A')
      expect(path![0]!.toKey).toBe('B')
      expect(path![2]!.toKey).toBe('D')
    })

    it('finds shortest path (1 hop)', async () => {
      const path = await rs.findCausalChain('A', 'B')
      expect(path).not.toBeNull()
      expect(path!).toHaveLength(1)
    })

    it('returns null when no path exists', async () => {
      const path = await rs.findCausalChain('D', 'A')
      expect(path).toBeNull()
    })

    it('returns null when nodes are completely disconnected', async () => {
      const path = await rs.findCausalChain('A', 'Z')
      expect(path).toBeNull()
    })

    it('respects maxHops limit', async () => {
      // Path A -> B -> C -> D is 3 hops, maxHops=2 should fail
      const path = await rs.findCausalChain('A', 'D', 2)
      expect(path).toBeNull()
    })

    it('only follows causal edge types', async () => {
      // Add non-causal edge A -solves-> D (shortcut, but not causal)
      await rs.addEdge(makeEdge('A', 'solves', 'D'))
      // Should still follow the 3-hop causal path, not the shortcut
      const path = await rs.findCausalChain('A', 'D')
      expect(path).not.toBeNull()
      expect(path!.every(e => ['causes', 'triggers', 'prevents'].includes(e.type))).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // buildAdjacency
  // -----------------------------------------------------------------------

  describe('buildAdjacency', () => {
    beforeEach(async () => {
      await rs.addEdge(makeEdge('A', 'causes', 'B'))
      await rs.addEdge(makeEdge('A', 'solves', 'C'))
      await rs.addEdge(makeEdge('B', 'triggers', 'D'))
    })

    it('builds correct adjacency map from all edges', async () => {
      const adj = await rs.buildAdjacency()
      expect(adj.get('A')).toEqual(expect.arrayContaining(['B', 'C']))
      expect(adj.get('B')).toEqual(['D'])
    })

    it('filters adjacency by edge types', async () => {
      const adj = await rs.buildAdjacency(['causes'])
      expect(adj.get('A')).toEqual(['B'])
      expect(adj.has('B')).toBe(false) // B only has 'triggers', not 'causes'
    })

    it('returns empty map when no edges exist', async () => {
      const emptyStore = createMockStore()
      const emptyRs = new RelationshipStore(emptyStore as unknown as BaseStore, ['empty'])
      const adj = await emptyRs.buildAdjacency()
      expect(adj.size).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // removeAllEdges
  // -----------------------------------------------------------------------

  describe('removeAllEdges', () => {
    it('removes all edges involving a key', async () => {
      await rs.addEdge(makeEdge('A', 'causes', 'B'))
      await rs.addEdge(makeEdge('C', 'solves', 'A'))
      await rs.addEdge(makeEdge('A', 'triggers', 'D'))

      await rs.removeAllEdges('A')

      // No outgoing from A
      const outgoing = await rs.getEdges('A', 'outgoing')
      expect(outgoing).toHaveLength(0)

      // No incoming to A
      const incoming = await rs.getEdges('A', 'incoming')
      expect(incoming).toHaveLength(0)

      // Reverse entries should also be cleaned: B should have no incoming from A
      const bIncoming = await rs.getEdges('B', 'incoming')
      expect(bIncoming).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // getAllEdges
  // -----------------------------------------------------------------------

  describe('getAllEdges', () => {
    it('returns all forward edges', async () => {
      await rs.addEdge(makeEdge('A', 'causes', 'B'))
      await rs.addEdge(makeEdge('C', 'solves', 'D'))

      const all = await rs.getAllEdges()
      expect(all).toHaveLength(2)
      const pairs = all.map(e => `${e.fromKey}->${e.toKey}`)
      expect(pairs).toContain('A->B')
      expect(pairs).toContain('C->D')
    })

    it('returns empty array when no edges exist', async () => {
      const all = await rs.getAllEdges()
      expect(all).toHaveLength(0)
    })

    it('respects limit parameter', async () => {
      await rs.addEdge(makeEdge('A', 'causes', 'B'))
      await rs.addEdge(makeEdge('C', 'causes', 'D'))
      await rs.addEdge(makeEdge('E', 'causes', 'F'))

      const limited = await rs.getAllEdges(2)
      expect(limited.length).toBeLessThanOrEqual(2)
    })
  })
})
