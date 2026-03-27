import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryVectorStore } from '../in-memory-vector-store.js'
import { cosineSimilarity, evaluateFilter } from '../filter-utils.js'
import type { MetadataFilter } from '../types.js'

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical normalized vectors', () => {
    const v = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)]
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10)
  })

  it('returns 0.0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0, 10)
  })

  it('returns -1.0 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 10)
  })

  it('throws on dimension mismatch', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(
      'Vector dimension mismatch',
    )
  })

  it('throws on zero-length vectors', () => {
    expect(() => cosineSimilarity([], [])).toThrow(
      'zero-length',
    )
  })

  it('returns 0 for zero-magnitude vectors', () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0)
  })
})

describe('evaluateFilter', () => {
  const meta = { name: 'Alice', age: 30, active: true, tags: 'engineering' }

  it('eq matches', () => {
    expect(evaluateFilter(meta, { field: 'name', op: 'eq', value: 'Alice' })).toBe(true)
    expect(evaluateFilter(meta, { field: 'name', op: 'eq', value: 'Bob' })).toBe(false)
  })

  it('neq matches', () => {
    expect(evaluateFilter(meta, { field: 'name', op: 'neq', value: 'Bob' })).toBe(true)
    expect(evaluateFilter(meta, { field: 'name', op: 'neq', value: 'Alice' })).toBe(false)
  })

  it('gt / gte', () => {
    expect(evaluateFilter(meta, { field: 'age', op: 'gt', value: 29 })).toBe(true)
    expect(evaluateFilter(meta, { field: 'age', op: 'gt', value: 30 })).toBe(false)
    expect(evaluateFilter(meta, { field: 'age', op: 'gte', value: 30 })).toBe(true)
  })

  it('lt / lte', () => {
    expect(evaluateFilter(meta, { field: 'age', op: 'lt', value: 31 })).toBe(true)
    expect(evaluateFilter(meta, { field: 'age', op: 'lt', value: 30 })).toBe(false)
    expect(evaluateFilter(meta, { field: 'age', op: 'lte', value: 30 })).toBe(true)
  })

  it('in / not_in', () => {
    expect(evaluateFilter(meta, { field: 'name', op: 'in', value: ['Alice', 'Bob'] })).toBe(true)
    expect(evaluateFilter(meta, { field: 'name', op: 'in', value: ['Bob', 'Carol'] })).toBe(false)
    expect(evaluateFilter(meta, { field: 'name', op: 'not_in', value: ['Bob'] })).toBe(true)
    expect(evaluateFilter(meta, { field: 'name', op: 'not_in', value: ['Alice'] })).toBe(false)
  })

  it('contains', () => {
    expect(evaluateFilter(meta, { field: 'tags', op: 'contains', value: 'engineer' })).toBe(true)
    expect(evaluateFilter(meta, { field: 'tags', op: 'contains', value: 'design' })).toBe(false)
  })

  it('and composition', () => {
    const filter: MetadataFilter = {
      and: [
        { field: 'name', op: 'eq', value: 'Alice' },
        { field: 'age', op: 'gte', value: 25 },
      ],
    }
    expect(evaluateFilter(meta, filter)).toBe(true)

    const failing: MetadataFilter = {
      and: [
        { field: 'name', op: 'eq', value: 'Alice' },
        { field: 'age', op: 'gt', value: 50 },
      ],
    }
    expect(evaluateFilter(meta, failing)).toBe(false)
  })

  it('or composition', () => {
    const filter: MetadataFilter = {
      or: [
        { field: 'name', op: 'eq', value: 'Bob' },
        { field: 'active', op: 'eq', value: true },
      ],
    }
    expect(evaluateFilter(meta, filter)).toBe(true)

    const failing: MetadataFilter = {
      or: [
        { field: 'name', op: 'eq', value: 'Bob' },
        { field: 'active', op: 'eq', value: false },
      ],
    }
    expect(evaluateFilter(meta, failing)).toBe(false)
  })

  it('gt returns false for non-numeric field', () => {
    expect(evaluateFilter(meta, { field: 'name', op: 'gt', value: 5 })).toBe(false)
  })
})

describe('InMemoryVectorStore', () => {
  let store: InMemoryVectorStore

  beforeEach(() => {
    store = new InMemoryVectorStore()
  })

  it('has provider "memory"', () => {
    expect(store.provider).toBe('memory')
  })

  describe('collection lifecycle', () => {
    it('createCollection + collectionExists', async () => {
      expect(await store.collectionExists('test')).toBe(false)
      await store.createCollection('test', { dimensions: 3 })
      expect(await store.collectionExists('test')).toBe(true)
    })

    it('createCollection throws on duplicate', async () => {
      await store.createCollection('test', { dimensions: 3 })
      await expect(store.createCollection('test', { dimensions: 3 })).rejects.toThrow(
        'already exists',
      )
    })

    it('listCollections returns names', async () => {
      await store.createCollection('a', { dimensions: 2 })
      await store.createCollection('b', { dimensions: 4 })
      const names = await store.listCollections()
      expect(names).toEqual(expect.arrayContaining(['a', 'b']))
      expect(names).toHaveLength(2)
    })

    it('deleteCollection removes all data', async () => {
      await store.createCollection('test', { dimensions: 2 })
      await store.upsert('test', [
        { id: '1', vector: [1, 0], metadata: {} },
      ])
      await store.deleteCollection('test')
      expect(await store.collectionExists('test')).toBe(false)
    })
  })

  describe('upsert + count', () => {
    it('upserts entries and counts them', async () => {
      await store.createCollection('docs', { dimensions: 3 })
      await store.upsert('docs', [
        { id: '1', vector: [1, 0, 0], metadata: { source: 'a' } },
        { id: '2', vector: [0, 1, 0], metadata: { source: 'b' } },
      ])
      expect(await store.count('docs')).toBe(2)
    })

    it('upsert overwrites existing entries', async () => {
      await store.createCollection('docs', { dimensions: 2 })
      await store.upsert('docs', [
        { id: '1', vector: [1, 0], metadata: { v: 1 } },
      ])
      await store.upsert('docs', [
        { id: '1', vector: [0, 1], metadata: { v: 2 } },
      ])
      expect(await store.count('docs')).toBe(1)
      const results = await store.search('docs', { vector: [0, 1], limit: 1 })
      expect(results[0]?.metadata).toEqual({ v: 2 })
    })

    it('validates dimensions on upsert', async () => {
      await store.createCollection('docs', { dimensions: 3 })
      await expect(
        store.upsert('docs', [
          { id: '1', vector: [1, 0], metadata: {} },
        ]),
      ).rejects.toThrow('Dimension mismatch')
    })

    it('throws on upsert to non-existent collection', async () => {
      await expect(
        store.upsert('nope', [{ id: '1', vector: [1], metadata: {} }]),
      ).rejects.toThrow('does not exist')
    })
  })

  describe('search', () => {
    beforeEach(async () => {
      await store.createCollection('docs', { dimensions: 3 })
      await store.upsert('docs', [
        { id: 'x', vector: [1, 0, 0], metadata: { cat: 'a' }, text: 'hello' },
        { id: 'y', vector: [0, 1, 0], metadata: { cat: 'b' }, text: 'world' },
        { id: 'z', vector: [0.7, 0.7, 0], metadata: { cat: 'a' }, text: 'mixed' },
      ])
    })

    it('returns results sorted by cosine similarity', async () => {
      const results = await store.search('docs', {
        vector: [1, 0, 0],
        limit: 10,
      })
      expect(results[0]?.id).toBe('x')
      expect(results[0]?.score).toBeCloseTo(1.0)
      expect(results[1]?.id).toBe('z')
      // y is orthogonal so score ~0
      expect(results[2]?.id).toBe('y')
      expect(results[2]?.score).toBeCloseTo(0.0)
    })

    it('respects limit', async () => {
      const results = await store.search('docs', {
        vector: [1, 0, 0],
        limit: 2,
      })
      expect(results).toHaveLength(2)
    })

    it('filters by minScore', async () => {
      const results = await store.search('docs', {
        vector: [1, 0, 0],
        limit: 10,
        minScore: 0.5,
      })
      // Only x (1.0) and z (~0.707) should pass
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.score >= 0.5)).toBe(true)
    })

    it('applies metadata filter (eq)', async () => {
      const results = await store.search('docs', {
        vector: [1, 0, 0],
        limit: 10,
        filter: { field: 'cat', op: 'eq', value: 'a' },
      })
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.metadata['cat'] === 'a')).toBe(true)
    })

    it('applies metadata filter (and)', async () => {
      const results = await store.search('docs', {
        vector: [0.7, 0.7, 0],
        limit: 10,
        filter: {
          and: [
            { field: 'cat', op: 'eq', value: 'a' },
          ],
        },
      })
      expect(results).toHaveLength(2)
    })

    it('applies metadata filter (or)', async () => {
      const results = await store.search('docs', {
        vector: [1, 0, 0],
        limit: 10,
        filter: {
          or: [
            { field: 'cat', op: 'eq', value: 'a' },
            { field: 'cat', op: 'eq', value: 'b' },
          ],
        },
      })
      expect(results).toHaveLength(3)
    })

    it('includes text in results', async () => {
      const results = await store.search('docs', {
        vector: [1, 0, 0],
        limit: 1,
      })
      expect(results[0]?.text).toBe('hello')
    })

    it('includes vectors when requested', async () => {
      const results = await store.search('docs', {
        vector: [1, 0, 0],
        limit: 1,
        includeVectors: true,
      })
      expect(results[0]?.vector).toEqual([1, 0, 0])
    })

    it('excludes vectors by default', async () => {
      const results = await store.search('docs', {
        vector: [1, 0, 0],
        limit: 1,
      })
      expect(results[0]?.vector).toBeUndefined()
    })
  })

  describe('delete', () => {
    beforeEach(async () => {
      await store.createCollection('docs', { dimensions: 2 })
      await store.upsert('docs', [
        { id: '1', vector: [1, 0], metadata: { group: 'a' } },
        { id: '2', vector: [0, 1], metadata: { group: 'a' } },
        { id: '3', vector: [1, 1], metadata: { group: 'b' } },
      ])
    })

    it('deletes by ids', async () => {
      await store.delete('docs', { ids: ['1', '3'] })
      expect(await store.count('docs')).toBe(1)
    })

    it('deletes by metadata filter', async () => {
      await store.delete('docs', {
        filter: { field: 'group', op: 'eq', value: 'a' },
      })
      expect(await store.count('docs')).toBe(1)
    })
  })

  describe('healthCheck', () => {
    it('returns healthy status', async () => {
      const health = await store.healthCheck()
      expect(health.healthy).toBe(true)
      expect(health.provider).toBe('memory')
      expect(health.latencyMs).toBe(0)
    })
  })

  describe('close', () => {
    it('clears all collections', async () => {
      await store.createCollection('a', { dimensions: 2 })
      await store.createCollection('b', { dimensions: 3 })
      await store.close()
      expect(await store.listCollections()).toEqual([])
    })
  })
})
