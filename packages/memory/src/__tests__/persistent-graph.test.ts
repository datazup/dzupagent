import { describe, it, expect, beforeEach } from 'vitest'
import { PersistentEntityGraph } from '../retrieval/persistent-graph.js'
import type { EntityNode, GraphTraversalResult } from '../retrieval/persistent-graph.js'
import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Minimal in-memory BaseStore for tests
// ---------------------------------------------------------------------------

class TestStore {
  private data = new Map<string, Map<string, { value: Record<string, unknown> }>>()

  async setup(): Promise<void> { /* no-op */ }

  async get(namespace: string[], key: string): Promise<{ value: Record<string, unknown> } | undefined> {
    const nsKey = namespace.join('.')
    return this.data.get(nsKey)?.get(key)
  }

  async put(namespace: string[], key: string, value: Record<string, unknown>): Promise<void> {
    const nsKey = namespace.join('.')
    if (!this.data.has(nsKey)) this.data.set(nsKey, new Map())
    this.data.get(nsKey)!.set(key, { value })
  }

  async delete(namespace: string[], key: string): Promise<void> {
    const nsKey = namespace.join('.')
    this.data.get(nsKey)?.delete(key)
  }

  async search(namespacePrefix: string[]): Promise<Array<{ namespace: string[]; key: string; value: Record<string, unknown> }>> {
    const prefix = namespacePrefix.join('.')
    const results: Array<{ namespace: string[]; key: string; value: Record<string, unknown> }> = []
    for (const [nsKey, entries] of this.data) {
      if (nsKey.startsWith(prefix)) {
        for (const [key, entry] of entries) {
          results.push({ namespace: nsKey.split('.'), key, value: entry.value })
        }
      }
    }
    return results
  }

  clear(): void {
    this.data.clear()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_NS = ['tenant1', 'project1', 'memories']

function createGraph(store: TestStore): PersistentEntityGraph {
  return new PersistentEntityGraph(store as unknown as BaseStore, BASE_NS)
}

async function seedRecord(store: TestStore, key: string, text: string): Promise<void> {
  await store.put(BASE_NS, key, { text })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PersistentEntityGraph', () => {
  let store: TestStore
  let graph: PersistentEntityGraph

  beforeEach(() => {
    store = new TestStore()
    graph = createGraph(store)
  })

  // -----------------------------------------------------------------------
  // indexRecord
  // -----------------------------------------------------------------------

  describe('indexRecord', () => {
    it('extracts backtick entities and stores inverted index', async () => {
      const entities = await graph.indexRecord('rec-1', 'Use `ModelRegistry` to get models')

      expect(entities).toContain('modelregistry')
      expect(entities.length).toBeGreaterThan(0)

      // Check the entity record exists in the store
      const entityNodes = await graph.getEntities()
      const modelReg = entityNodes.find(n => n.name === 'modelregistry')
      expect(modelReg).toBeDefined()
      expect(modelReg!.memoryKeys).toContain('rec-1')
      expect(modelReg!.degree).toBe(1)
    })

    it('extracts PascalCase entities', async () => {
      const entities = await graph.indexRecord('rec-2', 'The MemoryService handles reads')

      expect(entities).toContain('memoryservice')
    })

    it('extracts double-quoted entities', async () => {
      const entities = await graph.indexRecord('rec-3', 'Set "connection string" in config')

      expect(entities).toContain('connection string')
    })

    it('returns empty array for text with no entities', async () => {
      const entities = await graph.indexRecord('rec-4', 'just some plain text here')

      expect(entities).toEqual([])
    })

    it('updates inverted index when same record is re-indexed with different entities', async () => {
      await graph.indexRecord('rec-1', 'Use `ModelRegistry` to configure')
      await graph.indexRecord('rec-1', 'Use `MemoryService` instead')

      const entities = await graph.getEntities()
      const modelReg = entities.find(n => n.name === 'modelregistry')
      const memSvc = entities.find(n => n.name === 'memoryservice')

      // Old entity should have been removed
      expect(modelReg).toBeUndefined()
      // New entity should reference rec-1
      expect(memSvc).toBeDefined()
      expect(memSvc!.memoryKeys).toContain('rec-1')
    })

    it('accumulates memory keys for the same entity across records', async () => {
      await graph.indexRecord('rec-1', 'Use `ModelRegistry` for providers')
      await graph.indexRecord('rec-2', 'The `ModelRegistry` supports fallback')

      const entities = await graph.getEntities()
      const modelReg = entities.find(n => n.name === 'modelregistry')

      expect(modelReg).toBeDefined()
      expect(modelReg!.memoryKeys).toContain('rec-1')
      expect(modelReg!.memoryKeys).toContain('rec-2')
      expect(modelReg!.degree).toBe(2)
    })
  })

  // -----------------------------------------------------------------------
  // removeRecord
  // -----------------------------------------------------------------------

  describe('removeRecord', () => {
    it('removes record references from all entity entries', async () => {
      await graph.indexRecord('rec-1', 'Use `ModelRegistry` and `MemoryService`')
      await graph.removeRecord('rec-1')

      const entities = await graph.getEntities()
      // Both entities should have been removed (they had only rec-1)
      expect(entities).toHaveLength(0)
    })

    it('only removes the specific record, not other records sharing the entity', async () => {
      await graph.indexRecord('rec-1', 'The `ModelRegistry` handles providers')
      await graph.indexRecord('rec-2', 'The `ModelRegistry` supports fallback')
      await graph.removeRecord('rec-1')

      const entities = await graph.getEntities()
      const modelReg = entities.find(n => n.name === 'modelregistry')

      expect(modelReg).toBeDefined()
      expect(modelReg!.memoryKeys).not.toContain('rec-1')
      expect(modelReg!.memoryKeys).toContain('rec-2')
      expect(modelReg!.degree).toBe(1)
    })

    it('is a no-op for unknown records', async () => {
      // Should not throw
      await graph.removeRecord('nonexistent')
      const entities = await graph.getEntities()
      expect(entities).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // reindexAll
  // -----------------------------------------------------------------------

  describe('reindexAll', () => {
    it('rebuilds the entity index from all records in the base namespace', async () => {
      // Seed records directly in the store (bypassing the graph)
      await seedRecord(store, 'rec-1', 'The `ModelRegistry` provides models')
      await seedRecord(store, 'rec-2', 'The `MemoryService` stores data')

      const result = await graph.reindexAll()

      expect(result.recordsProcessed).toBe(2)
      expect(result.entitiesIndexed).toBeGreaterThanOrEqual(2)

      const entities = await graph.getEntities()
      expect(entities.find(n => n.name === 'modelregistry')).toBeDefined()
      expect(entities.find(n => n.name === 'memoryservice')).toBeDefined()
    })

    it('clears stale entity data before rebuilding', async () => {
      // Index a record, then remove the backing record and reindex
      await graph.indexRecord('rec-1', 'The `ModelRegistry` is useful')

      // Delete from base namespace (simulating external deletion)
      await store.delete(BASE_NS, 'rec-1')

      // Seed a new record
      await seedRecord(store, 'rec-2', 'Use `MemoryService` now')

      const result = await graph.reindexAll()
      expect(result.recordsProcessed).toBe(1)

      const entities = await graph.getEntities()
      // ModelRegistry should be gone (no backing record)
      expect(entities.find(n => n.name === 'modelregistry')).toBeUndefined()
      expect(entities.find(n => n.name === 'memoryservice')).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // search
  // -----------------------------------------------------------------------

  describe('search', () => {
    beforeEach(async () => {
      // Seed and index several records
      await seedRecord(store, 'rec-model', 'The `ModelRegistry` handles provider fallback with `CircuitBreaker`')
      await graph.indexRecord('rec-model', 'The `ModelRegistry` handles provider fallback with `CircuitBreaker`')

      await seedRecord(store, 'rec-circuit', 'The `CircuitBreaker` trips after 3 failures and `EventBus` emits')
      await graph.indexRecord('rec-circuit', 'The `CircuitBreaker` trips after 3 failures and `EventBus` emits')

      await seedRecord(store, 'rec-events', 'The `EventBus` supports typed events')
      await graph.indexRecord('rec-events', 'The `EventBus` supports typed events')

      await seedRecord(store, 'rec-memory', 'The `MemoryService` stores data')
      await graph.indexRecord('rec-memory', 'The `MemoryService` stores data')
    })

    it('returns direct matches (hop 0) for query entities', async () => {
      const results = await graph.search('How does the `ModelRegistry` work?', 0, 10)

      expect(results.length).toBeGreaterThan(0)
      const keys = results.map(r => r.key)
      expect(keys).toContain('rec-model')
      expect(results[0]!.hops).toBe(0)
      expect(results[0]!.score).toBe(1.0)
    })

    it('returns 1-hop results through shared entities', async () => {
      const results = await graph.search('How does the `ModelRegistry` work?', 1, 10)

      const keys = results.map(r => r.key)
      // Direct: rec-model (shares `modelregistry`)
      expect(keys).toContain('rec-model')
      // 1-hop: rec-circuit (shares `circuitbreaker` via rec-model)
      expect(keys).toContain('rec-circuit')

      const circuitResult = results.find(r => r.key === 'rec-circuit')
      expect(circuitResult).toBeDefined()
      expect(circuitResult!.hops).toBe(1)
      expect(circuitResult!.score).toBe(0.5)
    })

    it('returns 2-hop results when maxHops is 2', async () => {
      const results = await graph.search('How does the `ModelRegistry` work?', 2, 10)

      const keys = results.map(r => r.key)
      // rec-events is 2 hops away: ModelRegistry → CircuitBreaker → EventBus
      expect(keys).toContain('rec-events')

      const eventsResult = results.find(r => r.key === 'rec-events')
      expect(eventsResult).toBeDefined()
      expect(eventsResult!.hops).toBe(2)
      expect(eventsResult!.score).toBe(0.25) // 0.5^2
    })

    it('returns empty array for query with no entities', async () => {
      const results = await graph.search('hello world', 1, 10)
      expect(results).toEqual([])
    })

    it('respects the limit parameter', async () => {
      const results = await graph.search('How does the `ModelRegistry` work?', 2, 2)
      expect(results.length).toBeLessThanOrEqual(2)
    })

    it('scores direct matches higher than hop-N matches', async () => {
      const results = await graph.search('How does the `ModelRegistry` work?', 2, 10)

      // Results should be sorted by score descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score)
      }
    })

    it('does not return unrelated records', async () => {
      const results = await graph.search('How does the `ModelRegistry` work?', 0, 10)

      const keys = results.map(r => r.key)
      // MemoryService is completely unrelated at hop 0
      expect(keys).not.toContain('rec-memory')
    })

    it('loads actual values from the base namespace', async () => {
      const results = await graph.search('`ModelRegistry`', 0, 10)

      expect(results.length).toBeGreaterThan(0)
      const first = results[0]!
      expect(first.value).toBeDefined()
      expect(typeof first.value['text']).toBe('string')
    })

    it('deduplicates keys keeping the highest score', async () => {
      // Add another record that shares both modelregistry and circuitbreaker
      await seedRecord(store, 'rec-both', 'The `ModelRegistry` and `CircuitBreaker` work together')
      await graph.indexRecord('rec-both', 'The `ModelRegistry` and `CircuitBreaker` work together')

      // Search for circuitbreaker — rec-both should appear once (direct hit, not also as hop)
      const results = await graph.search('`CircuitBreaker`', 1, 10)
      const bothResults = results.filter(r => r.key === 'rec-both')
      expect(bothResults).toHaveLength(1)
    })
  })

  // -----------------------------------------------------------------------
  // getEntities
  // -----------------------------------------------------------------------

  describe('getEntities', () => {
    it('returns entities sorted by degree descending', async () => {
      await graph.indexRecord('rec-1', '`ModelRegistry` config')
      await graph.indexRecord('rec-2', '`ModelRegistry` fallback')
      await graph.indexRecord('rec-3', '`MemoryService` stores')

      const entities = await graph.getEntities()

      // ModelRegistry has degree 2, MemoryService has degree 1
      expect(entities[0]!.name).toBe('modelregistry')
      expect(entities[0]!.degree).toBe(2)
    })

    it('respects the limit parameter', async () => {
      await graph.indexRecord('rec-1', '`ModelRegistry` and `MemoryService` and `EventBus`')

      const entities = await graph.getEntities(2)
      expect(entities.length).toBeLessThanOrEqual(2)
    })
  })

  // -----------------------------------------------------------------------
  // getRelatedEntities
  // -----------------------------------------------------------------------

  describe('getRelatedEntities', () => {
    it('returns entities that co-occur with the given entity', async () => {
      await graph.indexRecord('rec-1', '`ModelRegistry` uses `CircuitBreaker`')
      await graph.indexRecord('rec-2', '`ModelRegistry` uses `EventBus`')

      const related = await graph.getRelatedEntities('ModelRegistry')

      const names = related.map(n => n.name)
      expect(names).toContain('circuitbreaker')
      expect(names).toContain('eventbus')
      // Should not include modelregistry itself
      expect(names).not.toContain('modelregistry')
    })

    it('returns empty array for unknown entity', async () => {
      const related = await graph.getRelatedEntities('nonexistent')
      expect(related).toEqual([])
    })

    it('lowercases the entity name for lookup', async () => {
      await graph.indexRecord('rec-1', '`ModelRegistry` uses `CircuitBreaker`')

      // Query with mixed case — should still find it
      const related = await graph.getRelatedEntities('MODELREGISTRY')
      expect(related.length).toBeGreaterThan(0)
    })
  })

  // -----------------------------------------------------------------------
  // Non-fatal error handling
  // -----------------------------------------------------------------------

  describe('error handling', () => {
    it('indexRecord returns empty array on store failure', async () => {
      const badStore = {
        get: () => { throw new Error('store down') },
        put: () => { throw new Error('store down') },
        delete: () => { throw new Error('store down') },
        search: () => { throw new Error('store down') },
      } as unknown as BaseStore

      const badGraph = new PersistentEntityGraph(badStore, BASE_NS)
      const result = await badGraph.indexRecord('key', '`SomeEntity` text')
      expect(result).toEqual([])
    })

    it('search returns empty array on store failure', async () => {
      const badStore = {
        get: () => { throw new Error('store down') },
        put: () => { throw new Error('store down') },
        delete: () => { throw new Error('store down') },
        search: () => { throw new Error('store down') },
      } as unknown as BaseStore

      const badGraph = new PersistentEntityGraph(badStore, BASE_NS)
      const result = await badGraph.search('`SomeEntity`', 1, 10)
      expect(result).toEqual([])
    })

    it('removeRecord does not throw on store failure', async () => {
      const badStore = {
        get: () => { throw new Error('store down') },
        put: () => { throw new Error('store down') },
        delete: () => { throw new Error('store down') },
        search: () => { throw new Error('store down') },
      } as unknown as BaseStore

      const badGraph = new PersistentEntityGraph(badStore, BASE_NS)
      // Should not throw
      await badGraph.removeRecord('key')
    })

    it('getEntities returns empty array on store failure', async () => {
      const badStore = {
        get: () => { throw new Error('store down') },
        put: () => { throw new Error('store down') },
        delete: () => { throw new Error('store down') },
        search: () => { throw new Error('store down') },
      } as unknown as BaseStore

      const badGraph = new PersistentEntityGraph(badStore, BASE_NS)
      const result = await badGraph.getEntities()
      expect(result).toEqual([])
    })

    it('getRelatedEntities returns empty array on store failure', async () => {
      const badStore = {
        get: () => { throw new Error('store down') },
        put: () => { throw new Error('store down') },
        delete: () => { throw new Error('store down') },
        search: () => { throw new Error('store down') },
      } as unknown as BaseStore

      const badGraph = new PersistentEntityGraph(badStore, BASE_NS)
      const result = await badGraph.getRelatedEntities('test')
      expect(result).toEqual([])
    })
  })
})
