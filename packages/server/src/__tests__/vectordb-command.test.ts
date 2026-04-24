import { describe, it, expect } from 'vitest'
import { vectordbStatus, formatVectorDBStatus } from '../cli/vectordb-command.js'
import type { VectorDBStatusResult } from '../cli/vectordb-command.js'
import type { VectorStore, VectorStoreHealth, CollectionConfig, VectorEntry, VectorQuery, VectorDBSearchResult as VectorSearchResult, VectorDeleteFilter } from '@dzupagent/core'

/**
 * Minimal mock VectorStore for testing.
 */
function createMockVectorStore(overrides: {
  healthy?: boolean
  collections?: Array<{ name: string; count: number }>
  provider?: string
  throwOnHealth?: boolean
} = {}): VectorStore {
  const {
    healthy = true,
    collections = [],
    provider = 'test-provider',
    throwOnHealth = false,
  } = overrides

  return {
    provider,

    async createCollection(_name: string, _config: CollectionConfig): Promise<void> {
      // noop
    },
    async deleteCollection(_name: string): Promise<void> {
      // noop
    },
    async listCollections(): Promise<string[]> {
      return collections.map((c) => c.name)
    },
    async collectionExists(_name: string): Promise<boolean> {
      return collections.some((c) => c.name === _name)
    },
    async upsert(_collection: string, _entries: VectorEntry[]): Promise<void> {
      // noop
    },
    async search(_collection: string, _query: VectorQuery): Promise<VectorSearchResult[]> {
      return []
    },
    async delete(_collection: string, _filter: VectorDeleteFilter): Promise<void> {
      // noop
    },
    async count(collection: string): Promise<number> {
      const col = collections.find((c) => c.name === collection)
      return col ? col.count : 0
    },
    async healthCheck(): Promise<VectorStoreHealth> {
      if (throwOnHealth) {
        throw new Error('Connection refused')
      }
      return { healthy, latencyMs: 5, provider }
    },
    async close(): Promise<void> {
      // noop
    },
  }
}

describe('vectordbStatus', () => {
  it('returns provider info from a healthy store', async () => {
    const store = createMockVectorStore({ provider: 'qdrant', healthy: true })
    const result = await vectordbStatus(store)

    expect(result.provider).toBe('qdrant')
    expect(result.healthy).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('returns collection counts', async () => {
    const store = createMockVectorStore({
      collections: [
        { name: 'features', count: 100 },
        { name: 'docs', count: 50 },
      ],
    })

    const result = await vectordbStatus(store)

    expect(result.collections).toHaveLength(2)
    expect(result.collections[0]).toEqual({ name: 'features', count: 100 })
    expect(result.collections[1]).toEqual({ name: 'docs', count: 50 })
  })

  it('handles unhealthy vector store gracefully', async () => {
    const store = createMockVectorStore({ throwOnHealth: true, provider: 'qdrant' })
    const result = await vectordbStatus(store)

    expect(result.healthy).toBe(false)
    expect(result.provider).toBe('qdrant')
    expect(result.collections).toEqual([])
  })

  it('returns empty collections when health check reports unhealthy', async () => {
    const store = createMockVectorStore({
      healthy: false,
      collections: [{ name: 'features', count: 10 }],
    })

    const result = await vectordbStatus(store)
    expect(result.healthy).toBe(false)
    // Collections not listed when unhealthy
    expect(result.collections).toEqual([])
  })
})

describe('formatVectorDBStatus', () => {
  it('produces formatted string with provider and health info', () => {
    const status: VectorDBStatusResult = {
      provider: 'qdrant',
      healthy: true,
      latencyMs: 12,
      collections: [
        { name: 'features', count: 100 },
        { name: 'docs', count: 50 },
      ],
    }

    const output = formatVectorDBStatus(status)

    expect(output).toContain('qdrant')
    expect(output).toContain('yes')
    expect(output).toContain('12ms')
    expect(output).toContain('features')
    expect(output).toContain('100 vectors')
    expect(output).toContain('docs')
    expect(output).toContain('50 vectors')
  })

  it('shows NO for unhealthy status', () => {
    const status: VectorDBStatusResult = {
      provider: 'pinecone',
      healthy: false,
      latencyMs: 5000,
      collections: [],
    }

    const output = formatVectorDBStatus(status)

    expect(output).toContain('NO')
    expect(output).toContain('pinecone')
    expect(output).toContain('none')
  })

  it('includes embedding info when present', () => {
    const status: VectorDBStatusResult = {
      provider: 'qdrant',
      healthy: true,
      latencyMs: 8,
      collections: [],
      embeddingProvider: 'openai',
      embeddingDimensions: 1536,
    }

    const output = formatVectorDBStatus(status)

    expect(output).toContain('openai')
    expect(output).toContain('1536')
  })

  it('shows error count for failed collections', () => {
    const status: VectorDBStatusResult = {
      provider: 'qdrant',
      healthy: true,
      latencyMs: 5,
      collections: [{ name: 'broken', count: -1 }],
    }

    const output = formatVectorDBStatus(status)
    expect(output).toContain('error')
  })
})
