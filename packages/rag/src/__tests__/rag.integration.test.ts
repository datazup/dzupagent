import { describe, it, expect } from 'vitest'
import { HybridRetriever } from '../retriever.js'

describe('rag integration', () => {
  it('fuses vector and keyword retrieval results through the public retriever surface', async () => {
    const retriever = new HybridRetriever({
      mode: 'hybrid',
      topK: 3,
      qualityBoosting: false,
      tokenBudget: 500,
      embedQuery: async () => [0.1, 0.2, 0.3],
      vectorSearch: async () => [
        {
          id: 'chunk-a',
          score: 0.9,
          text: 'Alpha chunk',
          metadata: {
            source_id: 'source-a',
            chunk_index: 0,
            quality_score: 0.6,
          },
        },
        {
          id: 'chunk-b',
          score: 0.8,
          text: 'Shared chunk',
          metadata: {
            source_id: 'source-b',
            chunk_index: 1,
            quality_score: 0.7,
          },
        },
      ],
      keywordSearch: async () => [
        {
          id: 'chunk-b',
          score: 0.95,
          text: 'Shared chunk',
          metadata: {
            source_id: 'source-b',
            chunk_index: 1,
            quality_score: 0.7,
          },
        },
        {
          id: 'chunk-c',
          score: 0.7,
          text: 'Keyword-only chunk',
          metadata: {
            source_id: 'source-c',
            chunk_index: 2,
            quality_score: 0.5,
          },
        },
      ],
    })

    const result = await retriever.retrieve('find the shared chunk', {}, { mode: 'hybrid' })

    expect(result.searchMode).toBe('hybrid')
    expect(result.chunks).toHaveLength(3)
    expect(result.chunks[0]?.id).toBe('chunk-b')
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(
      expect.arrayContaining(['chunk-a', 'chunk-b', 'chunk-c']),
    )
  })
})
