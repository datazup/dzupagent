import { describe, it, expect } from 'vitest'
import type {
  VectorEntry,
  VectorQuery,
  VectorSearchResult,
  CollectionConfig,
  MetadataFilter,
  VectorDeleteFilter,
  VectorStoreHealth,
  DistanceMetric,
} from '../types.js'

describe('VectorDB Types', () => {
  describe('VectorEntry', () => {
    it('accepts required fields', () => {
      const entry: VectorEntry = {
        id: 'doc-1',
        vector: [0.1, 0.2, 0.3],
        metadata: { source: 'test' },
      }
      expect(entry.id).toBe('doc-1')
      expect(entry.vector).toHaveLength(3)
      expect(entry.metadata).toEqual({ source: 'test' })
      expect(entry.text).toBeUndefined()
    })

    it('accepts optional text field', () => {
      const entry: VectorEntry = {
        id: 'doc-2',
        vector: [0.5, 0.6],
        metadata: {},
        text: 'Hello world',
      }
      expect(entry.text).toBe('Hello world')
    })
  })

  describe('VectorQuery', () => {
    it('accepts minimal query', () => {
      const query: VectorQuery = {
        vector: [0.1, 0.2, 0.3],
        limit: 10,
      }
      expect(query.limit).toBe(10)
      expect(query.filter).toBeUndefined()
      expect(query.minScore).toBeUndefined()
      expect(query.includeMetadata).toBeUndefined()
      expect(query.includeVectors).toBeUndefined()
    })

    it('accepts all optional fields', () => {
      const query: VectorQuery = {
        vector: [0.1, 0.2],
        limit: 5,
        filter: { field: 'type', op: 'eq', value: 'article' },
        minScore: 0.7,
        includeMetadata: true,
        includeVectors: true,
      }
      expect(query.minScore).toBe(0.7)
      expect(query.includeVectors).toBe(true)
    })
  })

  describe('VectorSearchResult', () => {
    it('has correct shape with required fields', () => {
      const result: VectorSearchResult = {
        id: 'doc-1',
        score: 0.95,
        metadata: { category: 'science' },
      }
      expect(result.id).toBe('doc-1')
      expect(result.score).toBe(0.95)
      expect(result.text).toBeUndefined()
      expect(result.vector).toBeUndefined()
    })

    it('includes optional text and vector', () => {
      const result: VectorSearchResult = {
        id: 'doc-2',
        score: 0.88,
        metadata: {},
        text: 'some text',
        vector: [0.1, 0.2],
      }
      expect(result.text).toBe('some text')
      expect(result.vector).toEqual([0.1, 0.2])
    })
  })

  describe('CollectionConfig', () => {
    it('requires dimensions', () => {
      const config: CollectionConfig = {
        dimensions: 1536,
      }
      expect(config.dimensions).toBe(1536)
      expect(config.metric).toBeUndefined()
      expect(config.metadata).toBeUndefined()
    })

    it('accepts metric and metadata schema', () => {
      const config: CollectionConfig = {
        dimensions: 1024,
        metric: 'dot_product',
        metadata: {
          title: 'string',
          year: 'number',
          published: 'boolean',
          tags: 'string[]',
        },
      }
      expect(config.metric).toBe('dot_product')
      expect(config.metadata?.['title']).toBe('string')
      expect(config.metadata?.['tags']).toBe('string[]')
    })

    it('supports all distance metrics', () => {
      const metrics: DistanceMetric[] = ['cosine', 'euclidean', 'dot_product']
      expect(metrics).toHaveLength(3)
    })
  })

  describe('MetadataFilter', () => {
    it('supports eq filter', () => {
      const filter: MetadataFilter = { field: 'status', op: 'eq', value: 'active' }
      expect(filter).toHaveProperty('op', 'eq')
    })

    it('supports neq filter', () => {
      const filter: MetadataFilter = { field: 'status', op: 'neq', value: 'deleted' }
      expect(filter).toHaveProperty('op', 'neq')
    })

    it('supports numeric comparison filters', () => {
      const gt: MetadataFilter = { field: 'score', op: 'gt', value: 0.5 }
      const gte: MetadataFilter = { field: 'score', op: 'gte', value: 0.5 }
      const lt: MetadataFilter = { field: 'score', op: 'lt', value: 1.0 }
      const lte: MetadataFilter = { field: 'score', op: 'lte', value: 1.0 }
      expect(gt).toHaveProperty('op', 'gt')
      expect(gte).toHaveProperty('op', 'gte')
      expect(lt).toHaveProperty('op', 'lt')
      expect(lte).toHaveProperty('op', 'lte')
    })

    it('supports in/not_in filters', () => {
      const inFilter: MetadataFilter = { field: 'category', op: 'in', value: ['a', 'b'] }
      const notIn: MetadataFilter = { field: 'priority', op: 'not_in', value: [1, 2] }
      expect(inFilter).toHaveProperty('op', 'in')
      expect(notIn).toHaveProperty('op', 'not_in')
    })

    it('supports contains filter', () => {
      const filter: MetadataFilter = { field: 'title', op: 'contains', value: 'search' }
      expect(filter).toHaveProperty('op', 'contains')
    })

    it('supports AND composition', () => {
      const filter: MetadataFilter = {
        and: [
          { field: 'status', op: 'eq', value: 'active' },
          { field: 'score', op: 'gte', value: 0.5 },
        ],
      }
      expect('and' in filter).toBe(true)
      if ('and' in filter) {
        expect(filter.and).toHaveLength(2)
      }
    })

    it('supports OR composition', () => {
      const filter: MetadataFilter = {
        or: [
          { field: 'type', op: 'eq', value: 'article' },
          { field: 'type', op: 'eq', value: 'blog' },
        ],
      }
      expect('or' in filter).toBe(true)
      if ('or' in filter) {
        expect(filter.or).toHaveLength(2)
      }
    })

    it('supports nested AND/OR composition', () => {
      const filter: MetadataFilter = {
        and: [
          { field: 'status', op: 'eq', value: 'published' },
          {
            or: [
              { field: 'category', op: 'eq', value: 'tech' },
              { field: 'category', op: 'eq', value: 'science' },
            ],
          },
        ],
      }
      expect('and' in filter).toBe(true)
      if ('and' in filter) {
        expect(filter.and).toHaveLength(2)
        const nested = filter.and[1]
        expect(nested).toBeDefined()
        if (nested && 'or' in nested) {
          expect(nested.or).toHaveLength(2)
        }
      }
    })
  })

  describe('VectorDeleteFilter', () => {
    it('supports deletion by IDs', () => {
      const filter: VectorDeleteFilter = { ids: ['doc-1', 'doc-2'] }
      expect('ids' in filter).toBe(true)
    })

    it('supports deletion by metadata filter', () => {
      const filter: VectorDeleteFilter = {
        filter: { field: 'expired', op: 'eq', value: true },
      }
      expect('filter' in filter).toBe(true)
    })
  })

  describe('VectorStoreHealth', () => {
    it('has correct shape', () => {
      const health: VectorStoreHealth = {
        healthy: true,
        latencyMs: 12,
        provider: 'qdrant',
        details: { version: '1.8.0' },
      }
      expect(health.healthy).toBe(true)
      expect(health.latencyMs).toBe(12)
      expect(health.provider).toBe('qdrant')
      expect(health.details).toEqual({ version: '1.8.0' })
    })

    it('details is optional', () => {
      const health: VectorStoreHealth = {
        healthy: false,
        latencyMs: 5000,
        provider: 'pinecone',
      }
      expect(health.details).toBeUndefined()
    })
  })
})
