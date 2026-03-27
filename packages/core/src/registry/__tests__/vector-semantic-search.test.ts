import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VectorStoreSemanticSearch } from '../vector-semantic-search.js'
import { InMemoryVectorStore } from '../../vectordb/in-memory-vector-store.js'
import { SemanticStore } from '../../vectordb/semantic-store.js'
import type { EmbeddingProvider } from '../../vectordb/embedding-types.js'
import type { RegisteredAgent } from '../types.js'
import type { ForgeCapability } from '../../identity/index.js'

// ─── Mock EmbeddingProvider ─────────────────────────────────────────────────

const DIMS = 4

function createMockEmbedding(): EmbeddingProvider {
  let callCount = 0
  return {
    modelId: 'test-embed',
    dimensions: DIMS,
    embed: vi.fn(async (texts: string[]) => {
      return texts.map(() => {
        callCount++
        // Generate a deterministic but varied vector
        const base = callCount * 0.1
        return [Math.sin(base), Math.cos(base), Math.sin(base * 2), Math.cos(base * 2)]
      })
    }),
    embedQuery: vi.fn(async (_text: string) => {
      callCount++
      const base = callCount * 0.1
      return [Math.sin(base), Math.cos(base), Math.sin(base * 2), Math.cos(base * 2)]
    }),
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCap(name: string, description?: string): ForgeCapability {
  return { name, version: '1.0.0', description: description ?? `Cap: ${name}` }
}

function makeAgent(id: string, name: string, caps: ForgeCapability[]): RegisteredAgent {
  return {
    id,
    name,
    description: `Agent ${name}`,
    protocols: ['a2a'],
    capabilities: caps,
    health: { status: 'healthy' },
    registeredAt: new Date(),
    lastUpdatedAt: new Date(),
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('VectorStoreSemanticSearch (VEC-011)', () => {
  let vectorStore: InMemoryVectorStore
  let embeddingProvider: EmbeddingProvider
  let semanticStore: SemanticStore
  let search: VectorStoreSemanticSearch

  beforeEach(async () => {
    vectorStore = new InMemoryVectorStore()
    embeddingProvider = createMockEmbedding()
    semanticStore = new SemanticStore({
      embedding: embeddingProvider,
      vectorStore,
    })
    await semanticStore.ensureCollection('agent_registry', { dimensions: DIMS })
    search = new VectorStoreSemanticSearch(semanticStore)
  })

  it('embedQuery delegates to the embedding provider', async () => {
    const result = await search.embedQuery('code review')

    expect(embeddingProvider.embedQuery).toHaveBeenCalledWith('code review')
    expect(result).toHaveLength(DIMS)
    expect(result.every(v => typeof v === 'number')).toBe(true)
  })

  it('indexAgent embeds agent capabilities into vector store', async () => {
    const agent = makeAgent('a1', 'code-reviewer', [
      makeCap('code.review', 'Reviews code for quality and bugs'),
      makeCap('testing.suggest', 'Suggests test improvements'),
    ])

    search.indexAgent(agent)

    // Give fire-and-forget a tick to complete
    await new Promise(resolve => setTimeout(resolve, 10))

    // Verify the entry exists in the vector store
    const count = await vectorStore.count('agent_registry')
    expect(count).toBe(1)
  })

  it('search returns scored results from vector store', async () => {
    const agent1 = makeAgent('a1', 'code-reviewer', [
      makeCap('code.review', 'Reviews code for quality'),
    ])
    const agent2 = makeAgent('a2', 'test-writer', [
      makeCap('testing.unit', 'Writes unit tests'),
    ])

    // Index both agents (with await for the fire-and-forget)
    search.indexAgent(agent1)
    search.indexAgent(agent2)
    await new Promise(resolve => setTimeout(resolve, 10))

    const embedding = await search.embedQuery('code quality review')
    const results = await search.search(embedding, 10)

    expect(results.length).toBe(2)
    // Each result has agentId and score
    for (const r of results) {
      expect(r).toHaveProperty('agentId')
      expect(r).toHaveProperty('score')
      expect(typeof r.agentId).toBe('string')
      expect(typeof r.score).toBe('number')
    }
  })

  it('removeAgent deletes from the collection', async () => {
    const agent = makeAgent('a1', 'code-reviewer', [
      makeCap('code.review', 'Reviews code'),
    ])

    search.indexAgent(agent)
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(await vectorStore.count('agent_registry')).toBe(1)

    search.removeAgent('a1')
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(await vectorStore.count('agent_registry')).toBe(0)
  })

  it('indexAgent does not throw when upsert fails', async () => {
    // Create a SemanticStore with a failing vector store
    const failingStore = new InMemoryVectorStore()
    // Don't create the collection — upsert will throw
    const failingSemanticStore = new SemanticStore({
      embedding: embeddingProvider,
      vectorStore: failingStore,
    })
    const failingSearch = new VectorStoreSemanticSearch(failingSemanticStore)

    // Should not throw
    expect(() => {
      failingSearch.indexAgent(
        makeAgent('a1', 'test', [makeCap('test', 'Test cap')]),
      )
    }).not.toThrow()
  })

  it('removeAgent does not throw when delete fails', async () => {
    // Create a SemanticStore with a failing vector store
    const failingStore = new InMemoryVectorStore()
    const failingSemanticStore = new SemanticStore({
      embedding: embeddingProvider,
      vectorStore: failingStore,
    })
    const failingSearch = new VectorStoreSemanticSearch(failingSemanticStore)

    // Should not throw
    expect(() => {
      failingSearch.removeAgent('nonexistent')
    }).not.toThrow()
  })
})
