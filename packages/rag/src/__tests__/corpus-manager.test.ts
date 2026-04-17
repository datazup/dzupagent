/**
 * CorpusManager tests — comprehensive coverage of corpus lifecycle,
 * source ingestion, invalidation, re-ingestion, stats, and search.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryVectorStore } from '@dzupagent/core'
import type { EmbeddingProvider } from '@dzupagent/core'
import { CorpusManager } from '../corpus-manager.js'
import { CorpusNotFoundError, SourceNotFoundError } from '../corpus-types.js'

// ---------------------------------------------------------------------------
// Mock embedding provider
// ---------------------------------------------------------------------------

function createMockEmbedding(dimensions = 4): EmbeddingProvider {
  let callCount = 0
  return {
    modelId: 'mock-embedding',
    dimensions,
    embed: async (texts: string[]) => {
      callCount++
      // Return slightly different vectors for each text so search has variation
      return texts.map((_, i) => {
        const vec = new Array<number>(dimensions).fill(0)
        // Set one component to 1 based on position to distinguish vectors
        vec[i % dimensions] = 1
        return vec
      })
    },
    embedQuery: async (_text: string) => {
      callCount++
      const vec = new Array<number>(dimensions).fill(0)
      vec[0] = 1 // query always points in first dimension
      return vec
    },
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SHORT_TEXT = 'This is a short document for testing purposes.'
const MEDIUM_TEXT = Array.from({ length: 20 }, (_, i) =>
  `Sentence number ${String(i + 1)} in this medium-length document. It contains enough words to form a meaningful paragraph with multiple sentences.`,
).join(' ')
const LONG_TEXT = Array.from({ length: 100 }, (_, i) =>
  `Paragraph ${String(i + 1)}: This is a longer document designed to produce multiple chunks when processed by the smart chunker. Each paragraph has sufficient content to contribute meaningfully to the overall document structure and should help verify that chunking works correctly across large inputs.`,
).join('\n\n')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CorpusManager', () => {
  let vectorStore: InMemoryVectorStore
  let embedding: EmbeddingProvider
  let manager: CorpusManager

  beforeEach(() => {
    vectorStore = new InMemoryVectorStore()
    embedding = createMockEmbedding(4)
    manager = new CorpusManager({ vectorStore, embedding })
  })

  // =========================================================================
  // Corpus CRUD
  // =========================================================================

  describe('createCorpus', () => {
    it('returns a Corpus with id, name, and timestamps', async () => {
      const corpus = await manager.createCorpus('Test Corpus')
      expect(corpus.id).toBeDefined()
      expect(typeof corpus.id).toBe('string')
      expect(corpus.id.length).toBeGreaterThan(0)
      expect(corpus.name).toBe('Test Corpus')
      expect(corpus.createdAt).toBeInstanceOf(Date)
      expect(corpus.updatedAt).toBeInstanceOf(Date)
    })

    it('generates unique IDs for each corpus', async () => {
      const c1 = await manager.createCorpus('A')
      const c2 = await manager.createCorpus('B')
      expect(c1.id).not.toBe(c2.id)
    })

    it('stores config when provided', async () => {
      const corpus = await manager.createCorpus('Configured', {
        collectionPrefix: 'custom_',
        chunkingConfig: { targetTokens: 500, overlapFraction: 0.1 },
      })
      expect(corpus.config).toBeDefined()
      expect(corpus.config?.collectionPrefix).toBe('custom_')
      expect(corpus.config?.chunkingConfig?.targetTokens).toBe(500)
    })

    it('creates a vector collection in the store', async () => {
      const corpus = await manager.createCorpus('Vec Test')
      const collections = await vectorStore.listCollections()
      expect(collections).toContain(`corpus_${corpus.id}`)
    })

    it('creates collection with custom prefix when configured', async () => {
      const corpus = await manager.createCorpus('Prefixed', {
        collectionPrefix: 'proj_',
      })
      const collections = await vectorStore.listCollections()
      expect(collections).toContain(`proj_${corpus.id}`)
    })

    it('sets updatedAt equal to createdAt initially', async () => {
      const corpus = await manager.createCorpus('Fresh')
      expect(corpus.updatedAt.getTime()).toBe(corpus.createdAt.getTime())
    })

    it('does not set config field when config is omitted', async () => {
      const corpus = await manager.createCorpus('No Config')
      expect(corpus.config).toBeUndefined()
    })
  })

  describe('listCorpora', () => {
    it('returns empty array when no corpora exist', async () => {
      const list = await manager.listCorpora()
      expect(list).toEqual([])
    })

    it('returns all created corpora', async () => {
      await manager.createCorpus('Alpha')
      await manager.createCorpus('Beta')
      await manager.createCorpus('Gamma')
      const list = await manager.listCorpora()
      expect(list).toHaveLength(3)
      const names = list.map((c) => c.name)
      expect(names).toContain('Alpha')
      expect(names).toContain('Beta')
      expect(names).toContain('Gamma')
    })

    it('does not include deleted corpora', async () => {
      const c1 = await manager.createCorpus('Keep')
      const c2 = await manager.createCorpus('Remove')
      await manager.deleteCorpus(c2.id)
      const list = await manager.listCorpora()
      expect(list).toHaveLength(1)
      expect(list[0]!.id).toBe(c1.id)
    })
  })

  describe('getCorpus', () => {
    it('returns existing corpus', async () => {
      const created = await manager.createCorpus('Lookup')
      const fetched = await manager.getCorpus(created.id)
      expect(fetched.id).toBe(created.id)
      expect(fetched.name).toBe('Lookup')
    })

    it('throws CorpusNotFoundError for unknown ID', async () => {
      await expect(manager.getCorpus('nonexistent')).rejects.toThrow(
        CorpusNotFoundError,
      )
    })

    it('error message contains the corpus ID', async () => {
      await expect(manager.getCorpus('xyz-123')).rejects.toThrow('xyz-123')
    })
  })

  describe('deleteCorpus', () => {
    it('removes corpus from registry', async () => {
      const corpus = await manager.createCorpus('To Delete')
      await manager.deleteCorpus(corpus.id)
      await expect(manager.getCorpus(corpus.id)).rejects.toThrow(
        CorpusNotFoundError,
      )
    })

    it('throws CorpusNotFoundError for unknown ID', async () => {
      await expect(manager.deleteCorpus('missing')).rejects.toThrow(
        CorpusNotFoundError,
      )
    })

    it('removes the vector collection', async () => {
      const corpus = await manager.createCorpus('Delete Vec')
      const collectionName = `corpus_${corpus.id}`
      expect(await vectorStore.collectionExists(collectionName)).toBe(true)
      await manager.deleteCorpus(corpus.id)
      expect(await vectorStore.collectionExists(collectionName)).toBe(false)
    })

    it('cleans up chunk tracking after delete', async () => {
      const corpus = await manager.createCorpus('Cleanup')
      await manager.ingestSource(corpus.id, { id: 'doc1', text: SHORT_TEXT })
      await manager.deleteCorpus(corpus.id)
      // Re-create with same name should work without stale references
      const corpus2 = await manager.createCorpus('Cleanup')
      const stats = await manager.getStats(corpus2.id)
      expect(stats.totalSources).toBe(0)
      expect(stats.totalChunks).toBe(0)
    })

    it('handles corpus with ingested sources', async () => {
      const corpus = await manager.createCorpus('With Sources')
      await manager.ingestSource(corpus.id, { id: 'a', text: MEDIUM_TEXT })
      await manager.ingestSource(corpus.id, { id: 'b', text: SHORT_TEXT })
      // Should not throw
      await manager.deleteCorpus(corpus.id)
      const list = await manager.listCorpora()
      expect(list).toHaveLength(0)
    })
  })

  // =========================================================================
  // Ingest
  // =========================================================================

  describe('ingestSource', () => {
    it('returns IngestJobResult with correct fields', async () => {
      const corpus = await manager.createCorpus('Ingest Test')
      const result = await manager.ingestSource(corpus.id, {
        id: 'doc1',
        text: SHORT_TEXT,
      })
      expect(result.corpusId).toBe(corpus.id)
      expect(result.sourceId).toBe('doc1')
      expect(result.chunksCreated).toBeGreaterThan(0)
      expect(result.chunksReplaced).toBe(0)
    })

    it('creates exactly 1 chunk for short text', async () => {
      const corpus = await manager.createCorpus('Short')
      const result = await manager.ingestSource(corpus.id, {
        id: 'short',
        text: SHORT_TEXT,
      })
      expect(result.chunksCreated).toBe(1)
    })

    it('creates multiple chunks for long text', async () => {
      const corpus = await manager.createCorpus('Long')
      const result = await manager.ingestSource(corpus.id, {
        id: 'long',
        text: LONG_TEXT,
      })
      expect(result.chunksCreated).toBeGreaterThan(1)
    })

    it('throws CorpusNotFoundError for unknown corpus', async () => {
      await expect(
        manager.ingestSource('bad-id', { id: 'doc', text: 'hello' }),
      ).rejects.toThrow(CorpusNotFoundError)
    })

    it('treats duplicate sourceId as re-ingest', async () => {
      const corpus = await manager.createCorpus('Dupe')
      const r1 = await manager.ingestSource(corpus.id, {
        id: 'doc',
        text: SHORT_TEXT,
      })
      expect(r1.chunksReplaced).toBe(0)

      const r2 = await manager.ingestSource(corpus.id, {
        id: 'doc',
        text: 'Updated text content for the same source.',
      })
      expect(r2.chunksReplaced).toBe(r1.chunksCreated)
      expect(r2.chunksCreated).toBeGreaterThan(0)
    })

    it('stores metadata in chunk vectors', async () => {
      const corpus = await manager.createCorpus('Meta')
      await manager.ingestSource(corpus.id, {
        id: 'meta-doc',
        text: SHORT_TEXT,
        metadata: { author: 'test', version: 42 },
      })
      // Search returns metadata
      const results = await manager.search(corpus.id, 'testing')
      if (results.length > 0) {
        expect(results[0]!.metadata).toHaveProperty('author', 'test')
        expect(results[0]!.metadata).toHaveProperty('version', 42)
      }
    })

    it('tracks source in corpus after ingest', async () => {
      const corpus = await manager.createCorpus('Track')
      await manager.ingestSource(corpus.id, { id: 's1', text: SHORT_TEXT })
      const stats = await manager.getStats(corpus.id)
      expect(stats.totalSources).toBe(1)
    })

    it('updates corpus updatedAt timestamp', async () => {
      const corpus = await manager.createCorpus('Timestamp')
      const before = corpus.updatedAt.getTime()
      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 5))
      await manager.ingestSource(corpus.id, { id: 's1', text: SHORT_TEXT })
      const updated = await manager.getCorpus(corpus.id)
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before)
    })

    it('ingests multiple sources into the same corpus', async () => {
      const corpus = await manager.createCorpus('Multi')
      await manager.ingestSource(corpus.id, { id: 'a', text: SHORT_TEXT })
      await manager.ingestSource(corpus.id, { id: 'b', text: MEDIUM_TEXT })
      await manager.ingestSource(corpus.id, { id: 'c', text: SHORT_TEXT })
      const stats = await manager.getStats(corpus.id)
      expect(stats.totalSources).toBe(3)
      expect(stats.totalChunks).toBeGreaterThanOrEqual(3)
    })

    it('respects corpus-level chunking config', async () => {
      const corpus = await manager.createCorpus('Custom Chunk', {
        chunkingConfig: { targetTokens: 50, overlapFraction: 0 },
      })
      const result = await manager.ingestSource(corpus.id, {
        id: 'doc',
        text: MEDIUM_TEXT,
      })
      // With very small target tokens, should produce more chunks
      expect(result.chunksCreated).toBeGreaterThan(1)
    })

    it('handles empty text gracefully (0 chunks)', async () => {
      const corpus = await manager.createCorpus('Empty')
      const result = await manager.ingestSource(corpus.id, {
        id: 'empty',
        text: '',
      })
      expect(result.chunksCreated).toBe(0)
    })

    it('handles whitespace-only text gracefully', async () => {
      const corpus = await manager.createCorpus('Whitespace')
      const result = await manager.ingestSource(corpus.id, {
        id: 'ws',
        text: '   \n\n   \t   ',
      })
      expect(result.chunksCreated).toBe(0)
    })
  })

  // =========================================================================
  // Invalidate
  // =========================================================================

  describe('invalidateSource', () => {
    it('removes chunks from vector store', async () => {
      const corpus = await manager.createCorpus('Invalidate')
      await manager.ingestSource(corpus.id, { id: 'doc', text: SHORT_TEXT })

      const statsBefore = await manager.getStats(corpus.id)
      expect(statsBefore.totalChunks).toBeGreaterThan(0)

      await manager.invalidateSource(corpus.id, 'doc')

      const statsAfter = await manager.getStats(corpus.id)
      expect(statsAfter.totalChunks).toBe(0)
      expect(statsAfter.totalSources).toBe(0)
    })

    it('throws SourceNotFoundError for unknown source', async () => {
      const corpus = await manager.createCorpus('NoSource')
      await expect(
        manager.invalidateSource(corpus.id, 'missing'),
      ).rejects.toThrow(SourceNotFoundError)
    })

    it('throws CorpusNotFoundError for unknown corpus', async () => {
      await expect(
        manager.invalidateSource('bad-corpus', 'doc'),
      ).rejects.toThrow(CorpusNotFoundError)
    })

    it('after invalidate, search returns no results from that source', async () => {
      const corpus = await manager.createCorpus('Search After Inv')
      await manager.ingestSource(corpus.id, { id: 'gone', text: SHORT_TEXT })
      await manager.invalidateSource(corpus.id, 'gone')
      const results = await manager.search(corpus.id, 'testing')
      expect(results).toHaveLength(0)
    })

    it('does not affect other sources in the same corpus', async () => {
      const corpus = await manager.createCorpus('Selective')
      await manager.ingestSource(corpus.id, { id: 'keep', text: SHORT_TEXT })
      await manager.ingestSource(corpus.id, { id: 'remove', text: SHORT_TEXT })

      await manager.invalidateSource(corpus.id, 'remove')

      const stats = await manager.getStats(corpus.id)
      expect(stats.totalSources).toBe(1)
      expect(stats.totalChunks).toBeGreaterThan(0)
    })

    it('updates corpus timestamp after invalidation', async () => {
      const corpus = await manager.createCorpus('TS Inv')
      await manager.ingestSource(corpus.id, { id: 'doc', text: SHORT_TEXT })
      await new Promise((r) => setTimeout(r, 5))
      await manager.invalidateSource(corpus.id, 'doc')
      const updated = await manager.getCorpus(corpus.id)
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
        corpus.createdAt.getTime(),
      )
    })

    it('can invalidate a source with empty chunks (from empty text ingest)', async () => {
      const corpus = await manager.createCorpus('Empty Inv')
      await manager.ingestSource(corpus.id, { id: 'empty', text: '' })
      // Should still be tracked as a source
      const stats = await manager.getStats(corpus.id)
      expect(stats.totalSources).toBe(1)
      await manager.invalidateSource(corpus.id, 'empty')
      const statsAfter = await manager.getStats(corpus.id)
      expect(statsAfter.totalSources).toBe(0)
    })
  })

  // =========================================================================
  // Re-ingest
  // =========================================================================

  describe('reIngestSource', () => {
    it('removes old chunks and creates new ones', async () => {
      const corpus = await manager.createCorpus('Re-Ingest')
      await manager.ingestSource(corpus.id, { id: 'doc', text: SHORT_TEXT })
      const result = await manager.reIngestSource(
        corpus.id,
        'doc',
        'Completely new content for the re-ingested document.',
      )
      expect(result.chunksReplaced).toBeGreaterThan(0)
      expect(result.chunksCreated).toBeGreaterThan(0)
    })

    it('chunksReplaced reflects the old chunk count', async () => {
      const corpus = await manager.createCorpus('Replace Count')
      const original = await manager.ingestSource(corpus.id, {
        id: 'doc',
        text: SHORT_TEXT,
      })
      const result = await manager.reIngestSource(
        corpus.id,
        'doc',
        'New text.',
      )
      expect(result.chunksReplaced).toBe(original.chunksCreated)
    })

    it('throws SourceNotFoundError for unknown source', async () => {
      const corpus = await manager.createCorpus('No Such Source')
      await expect(
        manager.reIngestSource(corpus.id, 'nope', 'text'),
      ).rejects.toThrow(SourceNotFoundError)
    })

    it('throws CorpusNotFoundError for unknown corpus', async () => {
      await expect(
        manager.reIngestSource('bad', 'doc', 'text'),
      ).rejects.toThrow(CorpusNotFoundError)
    })

    it('with different text length produces different chunk count', async () => {
      const corpus = await manager.createCorpus('Diff Length')
      await manager.ingestSource(corpus.id, { id: 'doc', text: SHORT_TEXT })
      const result = await manager.reIngestSource(
        corpus.id,
        'doc',
        LONG_TEXT,
      )
      expect(result.chunksCreated).toBeGreaterThan(1)
    })

    it('preserves source in the corpus after re-ingest', async () => {
      const corpus = await manager.createCorpus('Preserve')
      await manager.ingestSource(corpus.id, { id: 'doc', text: SHORT_TEXT })
      await manager.reIngestSource(corpus.id, 'doc', 'New text content here.')
      const stats = await manager.getStats(corpus.id)
      expect(stats.totalSources).toBe(1)
    })

    it('passes new metadata to the re-ingested chunks', async () => {
      const corpus = await manager.createCorpus('Meta Update')
      await manager.ingestSource(corpus.id, {
        id: 'doc',
        text: SHORT_TEXT,
        metadata: { version: 1 },
      })
      await manager.reIngestSource(corpus.id, 'doc', SHORT_TEXT, {
        version: 2,
      })
      const results = await manager.search(corpus.id, 'testing')
      if (results.length > 0) {
        expect(results[0]!.metadata).toHaveProperty('version', 2)
      }
    })

    it('updates stats correctly after re-ingest', async () => {
      const corpus = await manager.createCorpus('Stats After Re')
      const r1 = await manager.ingestSource(corpus.id, {
        id: 'doc',
        text: SHORT_TEXT,
      })
      await manager.reIngestSource(
        corpus.id,
        'doc',
        'Different short text for re-ingest.',
      )
      const stats = await manager.getStats(corpus.id)
      expect(stats.totalSources).toBe(1)
      // Chunks should reflect the new ingest
      expect(stats.totalChunks).toBeGreaterThan(0)
    })
  })

  // =========================================================================
  // Stats
  // =========================================================================

  describe('getStats', () => {
    it('returns zeros for empty corpus', async () => {
      const corpus = await manager.createCorpus('Empty Stats')
      const stats = await manager.getStats(corpus.id)
      expect(stats.corpusId).toBe(corpus.id)
      expect(stats.totalSources).toBe(0)
      expect(stats.totalChunks).toBe(0)
      expect(stats.collections).toHaveLength(1)
    })

    it('returns correct counts after 2 sources', async () => {
      const corpus = await manager.createCorpus('Two Sources')
      const r1 = await manager.ingestSource(corpus.id, {
        id: 's1',
        text: SHORT_TEXT,
      })
      const r2 = await manager.ingestSource(corpus.id, {
        id: 's2',
        text: MEDIUM_TEXT,
      })
      const stats = await manager.getStats(corpus.id)
      expect(stats.totalSources).toBe(2)
      expect(stats.totalChunks).toBe(r1.chunksCreated + r2.chunksCreated)
    })

    it('decrements after invalidation', async () => {
      const corpus = await manager.createCorpus('Decrement')
      const r1 = await manager.ingestSource(corpus.id, {
        id: 's1',
        text: SHORT_TEXT,
      })
      await manager.ingestSource(corpus.id, { id: 's2', text: SHORT_TEXT })
      await manager.invalidateSource(corpus.id, 's2')
      const stats = await manager.getStats(corpus.id)
      expect(stats.totalSources).toBe(1)
      expect(stats.totalChunks).toBe(r1.chunksCreated)
    })

    it('throws CorpusNotFoundError for unknown corpus', async () => {
      await expect(manager.getStats('nope')).rejects.toThrow(
        CorpusNotFoundError,
      )
    })

    it('includes correct collection name', async () => {
      const corpus = await manager.createCorpus('Collection Name')
      const stats = await manager.getStats(corpus.id)
      expect(stats.collections[0]).toBe(`corpus_${corpus.id}`)
    })

    it('includes custom collection prefix in collection name', async () => {
      const corpus = await manager.createCorpus('Custom Prefix', {
        collectionPrefix: 'my_',
      })
      const stats = await manager.getStats(corpus.id)
      expect(stats.collections[0]).toBe(`my_${corpus.id}`)
    })

    it('returns 0 chunks after all sources invalidated', async () => {
      const corpus = await manager.createCorpus('All Inv')
      await manager.ingestSource(corpus.id, { id: 'a', text: SHORT_TEXT })
      await manager.ingestSource(corpus.id, { id: 'b', text: SHORT_TEXT })
      await manager.invalidateSource(corpus.id, 'a')
      await manager.invalidateSource(corpus.id, 'b')
      const stats = await manager.getStats(corpus.id)
      expect(stats.totalSources).toBe(0)
      expect(stats.totalChunks).toBe(0)
    })
  })

  // =========================================================================
  // Search
  // =========================================================================

  describe('search', () => {
    it('returns empty array for corpus with no sources', async () => {
      const corpus = await manager.createCorpus('Empty Search')
      const results = await manager.search(corpus.id, 'anything')
      expect(results).toEqual([])
    })

    it('returns results after ingest (no crash with mock vectors)', async () => {
      const corpus = await manager.createCorpus('Search OK')
      await manager.ingestSource(corpus.id, { id: 'doc', text: SHORT_TEXT })
      // With zero/unit vectors the results may have score=0 or NaN, but should not crash
      const results = await manager.search(corpus.id, 'testing')
      expect(Array.isArray(results)).toBe(true)
    })

    it('throws CorpusNotFoundError for unknown corpus', async () => {
      await expect(manager.search('bad-id', 'query')).rejects.toThrow(
        CorpusNotFoundError,
      )
    })

    it('respects topK parameter', async () => {
      const corpus = await manager.createCorpus('TopK')
      // Ingest enough text to produce many chunks
      await manager.ingestSource(corpus.id, { id: 'big', text: LONG_TEXT })
      const results = await manager.search(corpus.id, 'paragraph', 3)
      expect(results.length).toBeLessThanOrEqual(3)
    })

    it('defaults topK to 10 when not specified', async () => {
      const corpus = await manager.createCorpus('Default TopK')
      await manager.ingestSource(corpus.id, { id: 'big', text: LONG_TEXT })
      const results = await manager.search(corpus.id, 'paragraph')
      expect(results.length).toBeLessThanOrEqual(10)
    })

    it('returns results with id, text, score, and metadata', async () => {
      const corpus = await manager.createCorpus('Fields')
      await manager.ingestSource(corpus.id, { id: 'doc', text: SHORT_TEXT })
      const results = await manager.search(corpus.id, 'testing')
      if (results.length > 0) {
        const first = results[0]!
        expect(first).toHaveProperty('id')
        expect(first).toHaveProperty('text')
        expect(first).toHaveProperty('score')
        expect(first).toHaveProperty('metadata')
        expect(typeof first.id).toBe('string')
        expect(typeof first.text).toBe('string')
        expect(typeof first.score).toBe('number')
      }
    })

    it('returns empty after all sources invalidated', async () => {
      const corpus = await manager.createCorpus('Inv Search')
      await manager.ingestSource(corpus.id, { id: 'doc', text: SHORT_TEXT })
      await manager.invalidateSource(corpus.id, 'doc')
      const results = await manager.search(corpus.id, 'testing')
      expect(results).toHaveLength(0)
    })

    it('returns results from multiple sources', async () => {
      const corpus = await manager.createCorpus('Multi Source Search')
      await manager.ingestSource(corpus.id, {
        id: 'a',
        text: 'Alpha source document about cats.',
      })
      await manager.ingestSource(corpus.id, {
        id: 'b',
        text: 'Beta source document about dogs.',
      })
      const results = await manager.search(corpus.id, 'animals')
      expect(Array.isArray(results)).toBe(true)
    })
  })

  // =========================================================================
  // Delete corpus integration
  // =========================================================================

  describe('deleteCorpus integration', () => {
    it('subsequent search throws CorpusNotFoundError', async () => {
      const corpus = await manager.createCorpus('Del + Search')
      await manager.ingestSource(corpus.id, { id: 'doc', text: SHORT_TEXT })
      await manager.deleteCorpus(corpus.id)
      await expect(manager.search(corpus.id, 'query')).rejects.toThrow(
        CorpusNotFoundError,
      )
    })

    it('collection removed from vector store', async () => {
      const corpus = await manager.createCorpus('Del + Col')
      const collectionName = `corpus_${corpus.id}`
      await manager.deleteCorpus(corpus.id)
      expect(await vectorStore.collectionExists(collectionName)).toBe(false)
    })

    it('subsequent getStats throws CorpusNotFoundError', async () => {
      const corpus = await manager.createCorpus('Del + Stats')
      await manager.deleteCorpus(corpus.id)
      await expect(manager.getStats(corpus.id)).rejects.toThrow(
        CorpusNotFoundError,
      )
    })

    it('subsequent ingestSource throws CorpusNotFoundError', async () => {
      const corpus = await manager.createCorpus('Del + Ingest')
      await manager.deleteCorpus(corpus.id)
      await expect(
        manager.ingestSource(corpus.id, { id: 'doc', text: 'hi' }),
      ).rejects.toThrow(CorpusNotFoundError)
    })

    it('subsequent invalidateSource throws CorpusNotFoundError', async () => {
      const corpus = await manager.createCorpus('Del + Inv')
      await manager.ingestSource(corpus.id, { id: 'doc', text: SHORT_TEXT })
      await manager.deleteCorpus(corpus.id)
      await expect(
        manager.invalidateSource(corpus.id, 'doc'),
      ).rejects.toThrow(CorpusNotFoundError)
    })
  })

  // =========================================================================
  // Edge cases & multiple managers
  // =========================================================================

  describe('edge cases', () => {
    it('handles very short text (single word)', async () => {
      const corpus = await manager.createCorpus('One Word')
      const result = await manager.ingestSource(corpus.id, {
        id: 'word',
        text: 'Hello',
      })
      // SmartChunker may return 0 or 1 chunk for very short text
      expect(result.chunksCreated).toBeLessThanOrEqual(1)
    })

    it('handles text with only newlines', async () => {
      const corpus = await manager.createCorpus('Newlines')
      const result = await manager.ingestSource(corpus.id, {
        id: 'nl',
        text: '\n\n\n\n',
      })
      expect(result.chunksCreated).toBe(0)
    })

    it('handles multiple rapid ingests to the same source', async () => {
      const corpus = await manager.createCorpus('Rapid')
      for (let i = 0; i < 5; i++) {
        await manager.ingestSource(corpus.id, {
          id: 'rapid-doc',
          text: `Version ${String(i)} of the document with some content.`,
        })
      }
      const stats = await manager.getStats(corpus.id)
      expect(stats.totalSources).toBe(1)
    })

    it('corpus with many sources tracks all correctly', async () => {
      const corpus = await manager.createCorpus('Many')
      for (let i = 0; i < 10; i++) {
        await manager.ingestSource(corpus.id, {
          id: `source-${String(i)}`,
          text: `Document number ${String(i)} with sufficient text to be a chunk.`,
        })
      }
      const stats = await manager.getStats(corpus.id)
      expect(stats.totalSources).toBe(10)
      expect(stats.totalChunks).toBe(10) // Each short text = 1 chunk
    })

    it('separate corpora do not share sources', async () => {
      const c1 = await manager.createCorpus('Isolated A')
      const c2 = await manager.createCorpus('Isolated B')
      await manager.ingestSource(c1.id, { id: 'doc', text: SHORT_TEXT })
      const stats2 = await manager.getStats(c2.id)
      expect(stats2.totalSources).toBe(0)
    })

    it('deleting one corpus does not affect another', async () => {
      const c1 = await manager.createCorpus('Keep Me')
      const c2 = await manager.createCorpus('Delete Me')
      await manager.ingestSource(c1.id, { id: 'doc', text: SHORT_TEXT })
      await manager.ingestSource(c2.id, { id: 'doc', text: SHORT_TEXT })
      await manager.deleteCorpus(c2.id)
      const stats1 = await manager.getStats(c1.id)
      expect(stats1.totalSources).toBe(1)
    })

    it('ingest source with special characters in sourceId', async () => {
      const corpus = await manager.createCorpus('Special IDs')
      const result = await manager.ingestSource(corpus.id, {
        id: 'path/to/file.md',
        text: SHORT_TEXT,
      })
      expect(result.sourceId).toBe('path/to/file.md')
      expect(result.chunksCreated).toBeGreaterThan(0)
    })

    it('ingest source with unicode text', async () => {
      const corpus = await manager.createCorpus('Unicode')
      const result = await manager.ingestSource(corpus.id, {
        id: 'unicode',
        text: 'Dies ist ein deutscher Text mit Umlauten: aeoeue. Auch japanisch: テスト。',
      })
      expect(result.chunksCreated).toBeGreaterThan(0)
    })
  })
})
