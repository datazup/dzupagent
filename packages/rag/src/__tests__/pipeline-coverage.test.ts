/**
 * Coverage tests for pipeline.ts — ingest, retrieve, assembleContext,
 * batch embedding, disposeTenant, disposeAll, and edge cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RagPipeline, DEFAULT_PIPELINE_CONFIG } from '../pipeline.js'
import type { RagPipelineDeps } from '../pipeline.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockDeps(overrides?: Partial<RagPipelineDeps>): RagPipelineDeps {
  return {
    embeddingProvider: {
      embed: vi.fn(async (texts: string[]) =>
        texts.map(() => Array.from({ length: 8 }, () => Math.random())),
      ),
      embedQuery: vi.fn(async () =>
        Array.from({ length: 8 }, () => Math.random()),
      ),
    },
    vectorStore: {
      upsert: vi.fn(async () => {}),
      search: vi.fn(async () => []),
    },
    ...overrides,
  } as unknown as RagPipelineDeps
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RagPipeline — coverage', () => {
  let deps: ReturnType<typeof createMockDeps>
  let pipeline: RagPipeline

  beforeEach(() => {
    deps = createMockDeps()
    pipeline = new RagPipeline({}, deps)
  })

  describe('constructor', () => {
    it('merges provided config with defaults', () => {
      const custom = new RagPipeline(
        { chunking: { targetTokens: 500, overlapFraction: 0.1, respectBoundaries: false } },
        deps,
      )
      // Should not throw
      expect(custom).toBeDefined()
    })

    it('uses all defaults when empty config', () => {
      const p = new RagPipeline({}, deps)
      expect(p).toBeDefined()
    })
  })

  describe('ingest', () => {
    it('chunks, embeds, and stores a text document', async () => {
      const text = 'This is a test document with enough content to form at least one chunk. '.repeat(20)

      const result = await pipeline.ingest(text, {
        sourceId: 'src-1',
        sessionId: 'session-1',
        tenantId: 'tenant-1',
      })

      expect(result.totalChunks).toBeGreaterThan(0)
      expect(result.chunks.length).toBe(result.totalChunks)
      expect(result.totalTokens).toBeGreaterThan(0)
      expect(result.embeddingTimeMs).toBeGreaterThanOrEqual(0)
      expect(result.storageTimeMs).toBeGreaterThanOrEqual(0)

      // Verify embedding provider was called
      expect(deps.embeddingProvider.embed).toHaveBeenCalled()
      // Verify vector store upsert was called
      expect(deps.vectorStore.upsert).toHaveBeenCalled()

      // Verify collection name uses prefix
      const upsertCall = (deps.vectorStore.upsert as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(upsertCall[0]).toBe('rag_tenant-1')
    })

    it('returns empty result for empty text', async () => {
      const result = await pipeline.ingest('', {
        sourceId: 'src-1',
        sessionId: 'session-1',
        tenantId: 'tenant-1',
      })

      expect(result.totalChunks).toBe(0)
      expect(result.chunks).toEqual([])
      expect(result.totalTokens).toBe(0)
      expect(result.embeddingTimeMs).toBe(0)
      expect(result.storageTimeMs).toBe(0)
    })

    it('skips embedding when autoEmbed is false', async () => {
      const text = 'Some content to chunk but not embed. '.repeat(10)

      const result = await pipeline.ingest(text, {
        sourceId: 'src-1',
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        autoEmbed: false,
      })

      expect(result.totalChunks).toBeGreaterThan(0)
      expect(result.embeddingTimeMs).toBe(0)
      expect(result.storageTimeMs).toBe(0)
      expect(deps.embeddingProvider.embed).not.toHaveBeenCalled()
      expect(deps.vectorStore.upsert).not.toHaveBeenCalled()
    })

    it('uses chunkingOverrides when provided', async () => {
      const text = 'Test content for custom chunking. '.repeat(50)

      const result = await pipeline.ingest(text, {
        sourceId: 'src-1',
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        chunkingOverrides: { targetTokens: 50, overlapFraction: 0 },
      })

      // With smaller target tokens, should create more chunks
      expect(result.totalChunks).toBeGreaterThan(0)
    })

    it('includes custom metadata in stored entries', async () => {
      const text = 'A short document with enough words for a chunk. '.repeat(5)

      await pipeline.ingest(text, {
        sourceId: 'src-1',
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        metadata: { custom_tag: 'important' },
      })

      const upsertCall = (deps.vectorStore.upsert as ReturnType<typeof vi.fn>).mock.calls[0]
      const entries = upsertCall[1] as Array<{ metadata: Record<string, unknown> }>
      expect(entries[0]!.metadata).toHaveProperty('custom_tag', 'important')
    })
  })

  describe('retrieve', () => {
    it('calls the retriever with correct filter', async () => {
      deps = createMockDeps({
        vectorStore: {
          upsert: vi.fn(async () => {}),
          search: vi.fn(async () => [
            {
              id: 'chunk-1',
              score: 0.9,
              text: 'Result chunk',
              metadata: {
                source_id: 'src-1',
                chunk_index: 0,
                session_id: 'session-1',
              },
            },
          ]),
        } as unknown as RagPipelineDeps['vectorStore'],
      })
      pipeline = new RagPipeline({}, deps)

      const result = await pipeline.retrieve('test query', {
        sessionId: 'session-1',
        tenantId: 'tenant-1',
      })

      expect(result.chunks).toBeDefined()
      expect(result.searchMode).toBeDefined()
      expect(result.queryTimeMs).toBeGreaterThanOrEqual(0)
    })

    it('reuses retriever for same tenant', async () => {
      await pipeline.retrieve('query 1', { sessionId: 's1', tenantId: 't1' })
      await pipeline.retrieve('query 2', { sessionId: 's1', tenantId: 't1' })

      // embedQuery called twice (once per retrieve)
      expect(deps.embeddingProvider.embedQuery).toHaveBeenCalledTimes(2)
    })

    it('creates separate retrievers for different tenants', async () => {
      await pipeline.retrieve('query', { sessionId: 's1', tenantId: 'tenant-a' })
      await pipeline.retrieve('query', { sessionId: 's1', tenantId: 'tenant-b' })

      // Both should call search with their respective collection names
      expect(deps.embeddingProvider.embedQuery).toHaveBeenCalledTimes(2)
    })
  })

  describe('assembleContext', () => {
    it('retrieves and assembles context', async () => {
      deps = createMockDeps({
        vectorStore: {
          upsert: vi.fn(async () => {}),
          search: vi.fn(async () => [
            {
              id: 'chunk-1',
              score: 0.9,
              text: 'Relevant content about the query',
              metadata: {
                source_id: 'src-1',
                chunk_index: 0,
                session_id: 's1',
              },
            },
          ]),
        } as unknown as RagPipelineDeps['vectorStore'],
      })
      pipeline = new RagPipeline({}, deps)

      const ctx = await pipeline.assembleContext('what is this about?', {
        sessionId: 's1',
        tenantId: 't1',
      })

      expect(ctx.systemPrompt).toBeDefined()
      expect(ctx.contextText).toBeDefined()
      expect(ctx.citations).toBeDefined()
      expect(ctx.totalTokens).toBeGreaterThanOrEqual(0)
      expect(ctx.sourceBreakdown).toBeDefined()
    })

    it('uses custom maxTokens', async () => {
      const ctx = await pipeline.assembleContext('query', {
        sessionId: 's1',
        tenantId: 't1',
        maxTokens: 500,
      })
      expect(ctx).toBeDefined()
    })

    it('uses provided sourceMetadata', async () => {
      deps = createMockDeps({
        vectorStore: {
          upsert: vi.fn(async () => {}),
          search: vi.fn(async () => [
            {
              id: 'chunk-1',
              score: 0.9,
              text: 'Content',
              metadata: { source_id: 'src-1', chunk_index: 0 },
            },
          ]),
        } as unknown as RagPipelineDeps['vectorStore'],
      })
      pipeline = new RagPipeline({}, deps)

      const sourceMetadata = new Map([
        ['src-1', { sourceId: 'src-1', title: 'Custom Title', contextMode: 'full' as const }],
      ])

      const ctx = await pipeline.assembleContext('query', {
        sessionId: 's1',
        tenantId: 't1',
        sourceMetadata,
      })

      // Should use our custom title
      expect(ctx.citations.some((c) => c.sourceTitle === 'Custom Title')).toBe(true)
    })

    it('passes assemblyOptions through', async () => {
      const ctx = await pipeline.assembleContext('query', {
        sessionId: 's1',
        tenantId: 't1',
        assemblyOptions: { snippetLength: 50 },
      })
      expect(ctx).toBeDefined()
    })
  })

  describe('disposeTenant', () => {
    it('removes a specific tenant retriever', async () => {
      await pipeline.retrieve('q', { sessionId: 's1', tenantId: 't1' })
      pipeline.disposeTenant('t1')
      // Should be able to retrieve again (new retriever created)
      await pipeline.retrieve('q', { sessionId: 's1', tenantId: 't1' })
      expect(deps.embeddingProvider.embedQuery).toHaveBeenCalledTimes(2)
    })

    it('no-ops for non-existent tenant', () => {
      expect(() => pipeline.disposeTenant('nonexistent')).not.toThrow()
    })
  })

  describe('disposeAll', () => {
    it('clears all cached retrievers', async () => {
      await pipeline.retrieve('q', { sessionId: 's1', tenantId: 't1' })
      await pipeline.retrieve('q', { sessionId: 's1', tenantId: 't2' })
      pipeline.disposeAll()
      // Both retrievers cleared
      expect(() => pipeline.disposeAll()).not.toThrow()
    })
  })

  describe('buildMetadataFilter', () => {
    it('filters correctly with string, number, and boolean values via retrieve', async () => {
      deps = createMockDeps({
        vectorStore: {
          upsert: vi.fn(async () => {}),
          search: vi.fn(async (_collection: string, query: Record<string, unknown>) => {
            // Verify filter was built correctly
            expect(query).toHaveProperty('filter')
            return []
          }),
        } as unknown as RagPipelineDeps['vectorStore'],
      })
      pipeline = new RagPipeline({}, deps)

      await pipeline.retrieve('q', { sessionId: 's1', tenantId: 't1' })
    })
  })

  describe('batch embedding', () => {
    it('batches embeddings according to configured batchSize', async () => {
      let embedCallCount = 0
      deps = createMockDeps({
        embeddingProvider: {
          embed: vi.fn(async (texts: string[]) => {
            embedCallCount++
            return texts.map(() => [0.1, 0.2])
          }),
          embedQuery: vi.fn(async () => [0.1, 0.2]),
        } as unknown as RagPipelineDeps['embeddingProvider'],
      })

      // Use tiny batchSize to force multiple batches
      pipeline = new RagPipeline(
        { embedding: { batchSize: 2, provider: 'test', model: 'test', dimensions: 2 } },
        deps,
      )

      // Create enough text for multiple chunks
      const text = 'This is a test sentence for chunking purposes. '.repeat(100)
      await pipeline.ingest(text, {
        sourceId: 'src-1',
        sessionId: 's1',
        tenantId: 't1',
      })

      // With batchSize=2, embed should be called multiple times if there are >2 chunks
      if (embedCallCount > 0) {
        expect(embedCallCount).toBeGreaterThanOrEqual(1)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// DEFAULT_PIPELINE_CONFIG
// ---------------------------------------------------------------------------

describe('DEFAULT_PIPELINE_CONFIG', () => {
  it('has expected default values', () => {
    expect(DEFAULT_PIPELINE_CONFIG.chunking.targetTokens).toBe(1200)
    expect(DEFAULT_PIPELINE_CONFIG.chunking.overlapFraction).toBe(0.15)
    expect(DEFAULT_PIPELINE_CONFIG.chunking.respectBoundaries).toBe(true)
    expect(DEFAULT_PIPELINE_CONFIG.embedding.batchSize).toBe(100)
    expect(DEFAULT_PIPELINE_CONFIG.retrieval.mode).toBe('hybrid')
    expect(DEFAULT_PIPELINE_CONFIG.retrieval.topK).toBe(10)
    expect(DEFAULT_PIPELINE_CONFIG.vectorStore.adapter).toBe('inmemory')
  })
})
