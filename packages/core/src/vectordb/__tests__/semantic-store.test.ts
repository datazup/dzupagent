import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SemanticStore } from '../semantic-store.js'
import { InMemoryVectorStore } from '../in-memory-vector-store.js'
import type { EmbeddingProvider } from '../embedding-types.js'

/**
 * Mock embedding provider that returns deterministic vectors.
 *
 * Generates a simple hash-based vector from text:
 * - dimension 0: normalized char-code sum
 * - dimension 1: normalized length
 * - dimension 2: 0.5 constant
 */
function createMockEmbedding(dims = 3): EmbeddingProvider {
  const embedFn = (texts: string[]): number[][] => {
    return texts.map((text) => {
      const charSum = [...text].reduce((sum, c) => sum + c.charCodeAt(0), 0)
      const vec: number[] = new Array(dims).fill(0) as number[]
      vec[0] = (charSum % 100) / 100
      vec[1] = Math.min(text.length / 50, 1)
      if (dims >= 3) vec[2] = 0.5
      // Fill remaining dims with small values
      for (let i = 3; i < dims; i++) {
        vec[i] = (charSum % (i + 7)) / (i + 7)
      }
      return vec
    })
  }

  return {
    modelId: 'mock-embedding',
    dimensions: dims,
    embed: vi.fn(async (texts: string[]): Promise<number[][]> => embedFn(texts)),
    embedQuery: vi.fn(async (text: string): Promise<number[]> => embedFn([text])[0]!),
  }
}

describe('SemanticStore', () => {
  let store: SemanticStore
  let vectorStore: InMemoryVectorStore
  let embedding: EmbeddingProvider

  beforeEach(async () => {
    vectorStore = new InMemoryVectorStore()
    embedding = createMockEmbedding(3)
    store = new SemanticStore({
      embedding,
      vectorStore,
    })
  })

  describe('ensureCollection', () => {
    it('creates collection if not exists', async () => {
      await store.ensureCollection('docs')
      expect(await vectorStore.collectionExists('docs')).toBe(true)
    })

    it('is no-op if collection already exists', async () => {
      await vectorStore.createCollection('docs', { dimensions: 3 })
      // Should not throw
      await store.ensureCollection('docs')
      expect(await vectorStore.listCollections()).toEqual(['docs'])
    })

    it('uses embedding dimensions by default', async () => {
      await store.ensureCollection('docs')
      // Verify by upserting a 3-dim vector (should not throw)
      await vectorStore.upsert('docs', [
        { id: '1', vector: [1, 0, 0], metadata: {} },
      ])
      expect(await vectorStore.count('docs')).toBe(1)
    })

    it('respects custom config dimensions', async () => {
      await store.ensureCollection('docs', { dimensions: 5 })
      // 3-dim vector should fail
      await expect(
        vectorStore.upsert('docs', [
          { id: '1', vector: [1, 0, 0], metadata: {} },
        ]),
      ).rejects.toThrow('Dimension mismatch')
    })
  })

  describe('upsert', () => {
    beforeEach(async () => {
      await store.ensureCollection('docs')
    })

    it('auto-embeds text via EmbeddingProvider', async () => {
      await store.upsert('docs', [
        { id: '1', text: 'Hello world' },
      ])
      expect(embedding.embed).toHaveBeenCalledWith(['Hello world'])
      expect(await vectorStore.count('docs')).toBe(1)
    })

    it('batch embeds all texts at once', async () => {
      await store.upsert('docs', [
        { id: '1', text: 'Hello' },
        { id: '2', text: 'World' },
        { id: '3', text: 'Test' },
      ])
      // embed should be called once with all texts
      expect(embedding.embed).toHaveBeenCalledTimes(1)
      expect(embedding.embed).toHaveBeenCalledWith(['Hello', 'World', 'Test'])
      expect(await vectorStore.count('docs')).toBe(3)
    })

    it('preserves metadata', async () => {
      await store.upsert('docs', [
        { id: '1', text: 'Hello', metadata: { source: 'test', priority: 1 } },
      ])
      const results = await vectorStore.search('docs', {
        vector: [1, 0, 0],
        limit: 1,
      })
      expect(results[0]?.metadata).toEqual({ source: 'test', priority: 1 })
    })

    it('stores original text for retrieval', async () => {
      await store.upsert('docs', [
        { id: '1', text: 'Hello world' },
      ])
      const results = await vectorStore.search('docs', {
        vector: [1, 0, 0],
        limit: 1,
      })
      expect(results[0]?.text).toBe('Hello world')
    })

    it('no-ops on empty array', async () => {
      await store.upsert('docs', [])
      expect(embedding.embed).not.toHaveBeenCalled()
    })
  })

  describe('search', () => {
    beforeEach(async () => {
      await store.ensureCollection('docs')
      await store.upsert('docs', [
        { id: '1', text: 'machine learning algorithms', metadata: { cat: 'ml' } },
        { id: '2', text: 'web development with react', metadata: { cat: 'web' } },
        { id: '3', text: 'deep learning neural networks', metadata: { cat: 'ml' } },
      ])
    })

    it('embeds query then searches vector store', async () => {
      const results = await store.search('docs', 'machine learning', 10)
      expect(embedding.embedQuery).toHaveBeenCalledWith('machine learning')
      expect(results.length).toBeGreaterThan(0)
    })

    it('returns ScoredDocument with text', async () => {
      const results = await store.search('docs', 'test query', 10)
      for (const r of results) {
        expect(r).toHaveProperty('id')
        expect(r).toHaveProperty('text')
        expect(r).toHaveProperty('score')
        expect(r).toHaveProperty('metadata')
        expect(typeof r.score).toBe('number')
        expect(typeof r.text).toBe('string')
      }
    })

    it('respects limit', async () => {
      const results = await store.search('docs', 'test', 2)
      expect(results.length).toBeLessThanOrEqual(2)
    })

    it('applies metadata filter', async () => {
      const results = await store.search(
        'docs',
        'anything',
        10,
        { field: 'cat', op: 'eq', value: 'ml' },
      )
      expect(results.every((r) => r.metadata['cat'] === 'ml')).toBe(true)
      expect(results).toHaveLength(2)
    })

    it('returns empty text as empty string when text is missing', async () => {
      // Directly insert an entry without text
      await vectorStore.upsert('docs', [
        { id: 'notext', vector: [0.5, 0.5, 0.5], metadata: {} },
      ])
      const results = await store.search('docs', 'test', 10)
      const noText = results.find((r) => r.id === 'notext')
      expect(noText?.text).toBe('')
    })
  })

  describe('delete', () => {
    beforeEach(async () => {
      await store.ensureCollection('docs')
      await store.upsert('docs', [
        { id: '1', text: 'aaa', metadata: { group: 'x' } },
        { id: '2', text: 'bbb', metadata: { group: 'y' } },
      ])
    })

    it('delegates delete by ids to vector store', async () => {
      await store.delete('docs', { ids: ['1'] })
      expect(await vectorStore.count('docs')).toBe(1)
    })

    it('delegates delete by filter to vector store', async () => {
      await store.delete('docs', {
        filter: { field: 'group', op: 'eq', value: 'x' },
      })
      expect(await vectorStore.count('docs')).toBe(1)
    })
  })

  describe('accessors', () => {
    it('exposes embedding provider', () => {
      expect(store.embedding).toBe(embedding)
    })

    it('exposes vector store', () => {
      expect(store.store).toBe(vectorStore)
    })
  })
})
