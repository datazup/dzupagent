import { describe, it, expect } from 'vitest'
import { RagPipeline } from '../pipeline.js'
import type { RagPipelineDeps } from '../pipeline.js'
import { RagMemoryNamespace } from '../memory-namespace.js'
import { HybridRetriever } from '../retriever.js'

describe('RagPipeline tenant retriever isolation', () => {
  it('uses tenant-specific collections across mixed traffic', async () => {
    const searchedCollections: string[] = []

    const deps = {
      embeddingProvider: {
        embed: async () => [],
        embedQuery: async () => [0.1, 0.2],
      },
      vectorStore: {
        upsert: async () => {},
        search: async (collection: string) => {
          searchedCollections.push(collection)
          return [{
            id: `chunk-${collection}`,
            score: 0.9,
            text: 'chunk',
            metadata: {
              source_id: 'src-1',
              chunk_index: 0,
              session_id: 's1',
            },
          }]
        },
      },
    } as unknown as RagPipelineDeps
    const pipeline = new RagPipeline({}, deps)

    await pipeline.retrieve('q1', { sessionId: 's1', tenantId: 'tenant-a' })
    await pipeline.retrieve('q2', { sessionId: 's1', tenantId: 'tenant-b' })

    expect(searchedCollections).toEqual(['rag_tenant-a', 'rag_tenant-b'])
  })
})

describe('RagMemoryNamespace scope enforcement', () => {
  it('throws when a required scope key is missing', async () => {
    const memory = new RagMemoryNamespace(
      {
        put: async () => {},
        get: async () => [],
      },
      {
        namespace: 'rag',
        scopeKeys: ['tenantId', 'sessionId'],
      },
    )

    await expect(
      memory.getChunks({ tenantId: 't1' }),
    ).rejects.toThrow('sessionId')
  })
})

describe('HybridRetriever source quality boosting', () => {
  it('applies source quality from metadata to final score', async () => {
    const makeRetriever = (sourceQuality: number) => new HybridRetriever({
      mode: 'vector',
      topK: 1,
      qualityBoosting: true,
      qualityWeights: { chunk: 0.6, source: 0.4 },
      tokenBudget: 8000,
      embedQuery: async () => [0.1],
      vectorSearch: async () => [{
        id: 'c1',
        score: 1,
        text: 'doc',
        metadata: {
          source_id: 's1',
          chunk_index: 0,
          quality_score: 0.5,
          source_quality: sourceQuality,
        },
      }],
    })

    const high = await makeRetriever(1).retrieve('q', {}, { mode: 'vector' })
    const low = await makeRetriever(0).retrieve('q', {}, { mode: 'vector' })

    expect(high.chunks[0]?.score).toBeGreaterThan(low.chunks[0]?.score ?? 0)
  })
})
