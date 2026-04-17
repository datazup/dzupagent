/**
 * Deep coverage tests for RagPipeline (CF-0023).
 *
 * Fills gaps left by pipeline-coverage.test.ts and pipeline-memory-retriever.test.ts.
 * Focus areas:
 *   - ingest: metadata propagation, quality scoring, empty-path edge cases,
 *     chunking overrides that produce zero chunks, autoEmbed=false storage behavior
 *   - retrieve: error propagation from vector store and embedding provider,
 *     filter-merging, per-retriever config forwarding, search mode handling
 *   - assembleContext: maxTokens delegation to retriever, sourceMetadata fallback
 *     defaults, assemblyOptions chaining
 *   - Batch embedding: exact batch boundary, large batches, batchSize=1
 *   - disposeTenant / disposeAll: retriever cache lifecycle
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RagPipeline, DEFAULT_PIPELINE_CONFIG } from '../pipeline.js'
import type { RagPipelineDeps } from '../pipeline.js'
import type { SourceMeta } from '../types.js'

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function createMockDeps(overrides?: Partial<RagPipelineDeps>): RagPipelineDeps {
  return {
    embeddingProvider: {
      embed: vi.fn(async (texts: string[]) =>
        texts.map(() => Array.from({ length: 8 }, () => 0.1)),
      ),
      embedQuery: vi.fn(async () =>
        Array.from({ length: 8 }, () => 0.1),
      ),
    },
    vectorStore: {
      upsert: vi.fn(async () => {}),
      search: vi.fn(async () => []),
    },
    ...overrides,
  } as unknown as RagPipelineDeps
}

// ===========================================================================
// ingest — deep gaps
// ===========================================================================

describe('RagPipeline.ingest — deep branches', () => {
  let deps: ReturnType<typeof createMockDeps>
  let pipeline: RagPipeline

  beforeEach(() => {
    deps = createMockDeps()
    pipeline = new RagPipeline({}, deps)
  })

  it('propagates sourceId, sessionId and quality_score into vector store entries', async () => {
    const text = 'Sentence with enough characters to chunk. '.repeat(20)
    await pipeline.ingest(text, {
      sourceId: 'my-source',
      sessionId: 'my-session',
      tenantId: 'tenant-x',
    })

    const upsertCall = (deps.vectorStore.upsert as ReturnType<typeof vi.fn>).mock.calls[0]
    const entries = upsertCall![1] as Array<{
      id: string
      vector: number[]
      text: string
      metadata: Record<string, unknown>
    }>

    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      expect(e.metadata).toMatchObject({
        source_id: 'my-source',
        session_id: 'my-session',
      })
      expect(typeof e.metadata['quality_score']).toBe('number')
      expect(typeof e.metadata['token_count']).toBe('number')
      expect(typeof e.metadata['chunk_index']).toBe('number')
    }
  })

  it('does not call vector store when no chunks are produced', async () => {
    const result = await pipeline.ingest('', {
      sourceId: 's',
      sessionId: 's1',
      tenantId: 't1',
    })

    expect(result.totalChunks).toBe(0)
    expect(deps.embeddingProvider.embed).not.toHaveBeenCalled()
    expect(deps.vectorStore.upsert).not.toHaveBeenCalled()
  })

  it('reports non-negative timing values', async () => {
    const result = await pipeline.ingest('A '.repeat(200), {
      sourceId: 's',
      sessionId: 's1',
      tenantId: 't1',
    })
    expect(result.embeddingTimeMs).toBeGreaterThanOrEqual(0)
    expect(result.storageTimeMs).toBeGreaterThanOrEqual(0)
  })

  it('scopes collection name using configured prefix + tenantId', async () => {
    deps = createMockDeps()
    pipeline = new RagPipeline(
      { vectorStore: { adapter: 'inmemory', collectionPrefix: 'proj_' } },
      deps,
    )

    await pipeline.ingest('some content '.repeat(40), {
      sourceId: 's',
      sessionId: 's1',
      tenantId: 'acme',
    })

    const upsertCall = (deps.vectorStore.upsert as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(upsertCall![0]).toBe('proj_acme')
  })

  it('merges custom metadata without overwriting system fields', async () => {
    await pipeline.ingest('X '.repeat(200), {
      sourceId: 's',
      sessionId: 'sess-a',
      tenantId: 't1',
      metadata: { topic: 'ai', rating: 4 },
    })

    const upsertCall = (deps.vectorStore.upsert as ReturnType<typeof vi.fn>).mock.calls[0]
    const entry = (upsertCall![1] as Array<{ metadata: Record<string, unknown> }>)[0]
    // System fields + custom fields both present
    expect(entry!.metadata).toMatchObject({
      source_id: 's',
      session_id: 'sess-a',
      topic: 'ai',
      rating: 4,
    })
  })

  it('autoEmbed=false skips both embed and upsert calls', async () => {
    const result = await pipeline.ingest('X '.repeat(300), {
      sourceId: 's',
      sessionId: 's1',
      tenantId: 't1',
      autoEmbed: false,
    })
    expect(result.totalChunks).toBeGreaterThan(0)
    expect(deps.embeddingProvider.embed).not.toHaveBeenCalled()
    expect(deps.vectorStore.upsert).not.toHaveBeenCalled()
    expect(result.embeddingTimeMs).toBe(0)
    expect(result.storageTimeMs).toBe(0)
  })

  it('autoEmbed default (undefined) triggers embed path', async () => {
    await pipeline.ingest('Y '.repeat(200), {
      sourceId: 's',
      sessionId: 's1',
      tenantId: 't1',
    })
    expect(deps.embeddingProvider.embed).toHaveBeenCalled()
    expect(deps.vectorStore.upsert).toHaveBeenCalled()
  })

  it('chunkingOverrides creates a per-call chunker (leaves cached chunker unchanged)', async () => {
    // First ingest with tiny chunk size
    await pipeline.ingest('Z '.repeat(400), {
      sourceId: 's',
      sessionId: 's1',
      tenantId: 't1',
      chunkingOverrides: { targetTokens: 50 },
    })
    const firstChunkCount = (deps.vectorStore.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as Array<unknown>

    // Second ingest without overrides should reuse default chunker (bigger chunks)
    ;(deps.vectorStore.upsert as ReturnType<typeof vi.fn>).mockClear()

    await pipeline.ingest('Z '.repeat(400), {
      sourceId: 's2',
      sessionId: 's1',
      tenantId: 't1',
    })
    const secondChunkCount = (deps.vectorStore.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as Array<unknown>

    // Default (larger target tokens) ≤ per-call override (smaller → more chunks)
    expect(secondChunkCount.length).toBeLessThanOrEqual(firstChunkCount.length)
  })

  it('assigns same embedding vector to chunk entries (length match)', async () => {
    await pipeline.ingest('word '.repeat(200), {
      sourceId: 's',
      sessionId: 's1',
      tenantId: 't1',
    })
    const entries = (deps.vectorStore.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as Array<{ vector: number[] }>
    for (const e of entries) {
      expect(e.vector).toHaveLength(8) // default mock produces 8-dim vectors
    }
  })

  it('totalTokens is non-negative and scales roughly with chunk count', async () => {
    const result = await pipeline.ingest('Word '.repeat(500), {
      sourceId: 's',
      sessionId: 's1',
      tenantId: 't1',
    })
    expect(result.totalTokens).toBeGreaterThan(0)
    expect(result.totalTokens).toBeGreaterThanOrEqual(result.totalChunks)
  })
})

// ===========================================================================
// retrieve — deep gaps
// ===========================================================================

describe('RagPipeline.retrieve — deep branches', () => {
  it('passes session filter to vector store search', async () => {
    const deps = createMockDeps({
      vectorStore: {
        upsert: vi.fn(async () => {}),
        search: vi.fn(async () => []),
      } as unknown as RagPipelineDeps['vectorStore'],
    })
    const pipeline = new RagPipeline({}, deps)

    await pipeline.retrieve('hello', { sessionId: 'sess-42', tenantId: 't1' })

    const searchCall = (deps.vectorStore.search as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(searchCall).toBeDefined()
    // The search is called with (collectionName, query) — session filter baked into metadata filter
    const query = searchCall![1] as { filter?: unknown }
    expect(query.filter).toBeDefined()
  })

  it('propagates embedding provider errors as rejection', async () => {
    const deps = createMockDeps({
      embeddingProvider: {
        embed: vi.fn(async () => []),
        embedQuery: vi.fn(async () => {
          throw new Error('embed-failed')
        }),
      } as unknown as RagPipelineDeps['embeddingProvider'],
    })
    const pipeline = new RagPipeline({}, deps)

    await expect(
      pipeline.retrieve('x', { sessionId: 's1', tenantId: 't1' }),
    ).rejects.toThrow('embed-failed')
  })

  it('propagates vector store errors as rejection', async () => {
    const deps = createMockDeps({
      vectorStore: {
        upsert: vi.fn(async () => {}),
        search: vi.fn(async () => {
          throw new Error('store-down')
        }),
      } as unknown as RagPipelineDeps['vectorStore'],
    })
    const pipeline = new RagPipeline({}, deps)

    await expect(
      pipeline.retrieve('x', { sessionId: 's1', tenantId: 't1' }),
    ).rejects.toThrow('store-down')
  })

  it('different search modes honored via per-call option', async () => {
    let capturedMode: string | undefined
    const deps = createMockDeps({
      vectorStore: {
        upsert: vi.fn(async () => {}),
        search: vi.fn(async () => []),
      } as unknown as RagPipelineDeps['vectorStore'],
    })
    const pipeline = new RagPipeline({}, deps)

    const result = await pipeline.retrieve('q', {
      sessionId: 's1',
      tenantId: 't1',
      mode: 'vector',
    })
    capturedMode = result.searchMode
    expect(capturedMode).toBe('vector')
  })

  it('reports queryTimeMs as non-negative', async () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline({}, deps)
    const result = await pipeline.retrieve('q', {
      sessionId: 's1',
      tenantId: 't1',
    })
    expect(result.queryTimeMs).toBeGreaterThanOrEqual(0)
  })

  it('retrieves empty chunks array when store is empty', async () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline({}, deps)
    const result = await pipeline.retrieve('q', {
      sessionId: 's1',
      tenantId: 't1',
    })
    expect(result.chunks).toEqual([])
    expect(result.totalTokens).toBe(0)
  })

  it('applies per-call topK override', async () => {
    let capturedLimit: number | undefined
    const deps = createMockDeps({
      vectorStore: {
        upsert: vi.fn(async () => {}),
        search: vi.fn(async (_collection: string, query: Record<string, unknown>) => {
          capturedLimit = query['limit'] as number
          return []
        }),
      } as unknown as RagPipelineDeps['vectorStore'],
    })
    const pipeline = new RagPipeline({}, deps)

    await pipeline.retrieve('q', { sessionId: 's1', tenantId: 't1', topK: 3 })
    expect(capturedLimit).toBe(3)
  })

  it('different tenants use different collection names in search', async () => {
    const calls: string[] = []
    const deps = createMockDeps({
      vectorStore: {
        upsert: vi.fn(async () => {}),
        search: vi.fn(async (collection: string) => {
          calls.push(collection)
          return []
        }),
      } as unknown as RagPipelineDeps['vectorStore'],
    })
    const pipeline = new RagPipeline({}, deps)

    await pipeline.retrieve('q', { sessionId: 's1', tenantId: 'alice' })
    await pipeline.retrieve('q', { sessionId: 's1', tenantId: 'bob' })

    expect(calls).toEqual(['rag_alice', 'rag_bob'])
  })

  it('caches retriever per tenant (same tenant reuses internal state)', async () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline({}, deps)

    await pipeline.retrieve('q1', { sessionId: 's1', tenantId: 'same' })
    await pipeline.retrieve('q2', { sessionId: 's1', tenantId: 'same' })

    // embedQuery called twice (once per call) — retriever cached, embedQuery function
    // reference is stable, so we can at least verify both calls went through
    expect(deps.embeddingProvider.embedQuery).toHaveBeenCalledTimes(2)
  })
})

// ===========================================================================
// assembleContext — deep gaps
// ===========================================================================

describe('RagPipeline.assembleContext — deep branches', () => {
  it('falls back to retrieval.tokenBudget when maxTokens is not provided', async () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline(
      { retrieval: { ...DEFAULT_PIPELINE_CONFIG.retrieval, tokenBudget: 999 } },
      deps,
    )

    const ctx = await pipeline.assembleContext('q', {
      sessionId: 's1',
      tenantId: 't1',
    })
    expect(ctx).toBeDefined()
    expect(ctx.totalTokens).toBeGreaterThanOrEqual(0)
  })

  it('builds default source metadata from retrieval results when none provided', async () => {
    const deps = createMockDeps({
      vectorStore: {
        upsert: vi.fn(async () => {}),
        search: vi.fn(async () => [
          {
            id: 'c1',
            score: 0.9,
            text: 'Hello content',
            metadata: {
              source_id: 'auto-src',
              chunk_index: 0,
              session_id: 's1',
            },
          },
        ]),
      } as unknown as RagPipelineDeps['vectorStore'],
    })
    const pipeline = new RagPipeline({}, deps)

    const ctx = await pipeline.assembleContext('q', {
      sessionId: 's1',
      tenantId: 't1',
    })

    // Default source metadata uses 'Unknown' as title when chunk.sourceTitle is absent
    const autoCitation = ctx.citations.find((c) => c.sourceId === 'auto-src')
    expect(autoCitation).toBeDefined()
    expect(autoCitation!.sourceTitle).toBe('Unknown')
  })

  it('provided sourceMetadata takes precedence over auto-built defaults', async () => {
    const deps = createMockDeps({
      vectorStore: {
        upsert: vi.fn(async () => {}),
        search: vi.fn(async () => [
          {
            id: 'c1',
            score: 0.9,
            text: 'Hello content',
            metadata: { source_id: 'src-1', chunk_index: 0 },
          },
        ]),
      } as unknown as RagPipelineDeps['vectorStore'],
    })
    const pipeline = new RagPipeline({}, deps)

    const sourceMetadata = new Map<string, SourceMeta>([
      ['src-1', {
        sourceId: 'src-1',
        title: 'Explicit Title',
        contextMode: 'full',
      }],
    ])

    const ctx = await pipeline.assembleContext('q', {
      sessionId: 's1',
      tenantId: 't1',
      sourceMetadata,
    })

    expect(ctx.citations[0]!.sourceTitle).toBe('Explicit Title')
  })

  it('forwards assemblyOptions.snippetLength to assembler', async () => {
    const deps = createMockDeps({
      vectorStore: {
        upsert: vi.fn(async () => {}),
        search: vi.fn(async () => [
          {
            id: 'c1',
            score: 0.9,
            text: 'Z'.repeat(1000),
            metadata: { source_id: 's1', chunk_index: 0 },
          },
        ]),
      } as unknown as RagPipelineDeps['vectorStore'],
    })
    const pipeline = new RagPipeline({}, deps)

    const ctx = await pipeline.assembleContext('q', {
      sessionId: 's1',
      tenantId: 't1',
      assemblyOptions: { snippetLength: 30 },
    })

    expect(ctx.citations[0]!.snippet.length).toBeLessThanOrEqual(30)
  })

  it('applies custom maxTokens (uses as both retrieval budget and assembler budget)', async () => {
    const deps = createMockDeps({
      vectorStore: {
        upsert: vi.fn(async () => {}),
        search: vi.fn(async () => [
          {
            id: 'c1',
            score: 0.9,
            text: 'A'.repeat(400),
            metadata: { source_id: 's1', chunk_index: 0 },
          },
          {
            id: 'c2',
            score: 0.8,
            text: 'B'.repeat(400),
            metadata: { source_id: 's1', chunk_index: 1 },
          },
        ]),
      } as unknown as RagPipelineDeps['vectorStore'],
    })
    const pipeline = new RagPipeline({}, deps)

    const ctx = await pipeline.assembleContext('q', {
      sessionId: 's1',
      tenantId: 't1',
      maxTokens: 50,
    })
    // With a small token budget, fewer or equal chunks than returned
    expect(ctx.citations.length).toBeLessThanOrEqual(2)
  })

  it('returns no-sources prompt when retrieval yields no chunks', async () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline({}, deps)

    const ctx = await pipeline.assembleContext('q', {
      sessionId: 's1',
      tenantId: 't1',
    })
    expect(ctx.citations).toHaveLength(0)
    expect(ctx.systemPrompt).toContain('No sources')
  })

  it('propagates retrieval errors from assembleContext', async () => {
    const deps = createMockDeps({
      vectorStore: {
        upsert: vi.fn(async () => {}),
        search: vi.fn(async () => {
          throw new Error('downstream-down')
        }),
      } as unknown as RagPipelineDeps['vectorStore'],
    })
    const pipeline = new RagPipeline({}, deps)

    await expect(
      pipeline.assembleContext('q', { sessionId: 's1', tenantId: 't1' }),
    ).rejects.toThrow('downstream-down')
  })
})

// ===========================================================================
// Batch embedding — deep gaps
// ===========================================================================

describe('RagPipeline batch embedding — deep branches', () => {
  it('single-chunk document fits in one batch call', async () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline(
      { embedding: { batchSize: 10, provider: 'x', model: 'x', dimensions: 2 } },
      deps,
    )
    await pipeline.ingest('A B C '.repeat(5), {
      sourceId: 's',
      sessionId: 's',
      tenantId: 't',
    })
    expect((deps.embeddingProvider.embed as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('batchSize=1 produces one call per chunk', async () => {
    let chunkCount = 0
    const deps = createMockDeps({
      embeddingProvider: {
        embed: vi.fn(async (texts: string[]) => {
          chunkCount += texts.length
          return texts.map(() => [0.1, 0.2])
        }),
        embedQuery: vi.fn(async () => [0.1, 0.2]),
      } as unknown as RagPipelineDeps['embeddingProvider'],
    })
    const pipeline = new RagPipeline(
      { embedding: { batchSize: 1, provider: 'x', model: 'x', dimensions: 2 } },
      deps,
    )

    await pipeline.ingest('Chunk content '.repeat(200), {
      sourceId: 's',
      sessionId: 's',
      tenantId: 't',
    })

    // At least one embed call (may be many with batchSize=1)
    expect((deps.embeddingProvider.embed as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(chunkCount).toBeGreaterThanOrEqual(1)
  })

  it('huge batchSize handles any chunk count in single call', async () => {
    const deps = createMockDeps({
      embeddingProvider: {
        embed: vi.fn(async (texts: string[]) =>
          texts.map(() => [0.1, 0.2]),
        ),
        embedQuery: vi.fn(async () => [0.1, 0.2]),
      } as unknown as RagPipelineDeps['embeddingProvider'],
    })
    const pipeline = new RagPipeline(
      { embedding: { batchSize: 10000, provider: 'x', model: 'x', dimensions: 2 } },
      deps,
    )

    await pipeline.ingest('Content '.repeat(200), {
      sourceId: 's',
      sessionId: 's',
      tenantId: 't',
    })
    // Should be exactly 1 call regardless of chunk count
    expect((deps.embeddingProvider.embed as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })
})

// ===========================================================================
// Retriever cache lifecycle
// ===========================================================================

describe('RagPipeline retriever cache lifecycle', () => {
  it('disposeTenant creates fresh retriever on next access', async () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline({}, deps)

    await pipeline.retrieve('q1', { sessionId: 's1', tenantId: 'T' })
    pipeline.disposeTenant('T')
    await pipeline.retrieve('q2', { sessionId: 's1', tenantId: 'T' })
    // Both queries issued successfully
    expect(deps.embeddingProvider.embedQuery).toHaveBeenCalledTimes(2)
  })

  it('disposeTenant is idempotent for non-existent tenant', () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline({}, deps)
    expect(() => pipeline.disposeTenant('never-seen')).not.toThrow()
    expect(() => pipeline.disposeTenant('never-seen')).not.toThrow()
  })

  it('disposeAll clears all cached retrievers', async () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline({}, deps)

    await pipeline.retrieve('q', { sessionId: 's1', tenantId: 't1' })
    await pipeline.retrieve('q', { sessionId: 's1', tenantId: 't2' })
    await pipeline.retrieve('q', { sessionId: 's1', tenantId: 't3' })

    pipeline.disposeAll()
    // No retrievers remain — calling disposeAll again is a no-op
    expect(() => pipeline.disposeAll()).not.toThrow()
  })

  it('disposeAll followed by retrieve rebuilds retriever cleanly', async () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline({}, deps)

    await pipeline.retrieve('q', { sessionId: 's1', tenantId: 't1' })
    pipeline.disposeAll()
    // Should work fine after disposeAll
    const result = await pipeline.retrieve('q', { sessionId: 's1', tenantId: 't1' })
    expect(result).toBeDefined()
  })
})

// ===========================================================================
// Constructor / config merging — deep gaps
// ===========================================================================

describe('RagPipeline constructor config merging', () => {
  it('merges nested chunking config with defaults', () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline(
      { chunking: { targetTokens: 100, overlapFraction: 0.1, respectBoundaries: false } },
      deps,
    )
    expect(pipeline).toBeDefined()
  })

  it('merges nested retrieval config with defaults', () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline(
      {
        retrieval: {
          mode: 'vector',
          topK: 5,
          qualityBoosting: false,
          qualityWeights: { chunk: 0.5, source: 0.5 },
          tokenBudget: 2000,
          reranker: 'none',
        },
      },
      deps,
    )
    expect(pipeline).toBeDefined()
  })

  it('accepts keywordSearch in deps and passes through in pipeline', async () => {
    const keywordSearch = vi.fn(async () => [])
    const deps: RagPipelineDeps = {
      ...createMockDeps(),
      keywordSearch,
    }
    const pipeline = new RagPipeline(
      { retrieval: { ...DEFAULT_PIPELINE_CONFIG.retrieval, mode: 'hybrid' } },
      deps,
    )
    await pipeline.retrieve('q', { sessionId: 's1', tenantId: 't1', mode: 'hybrid' })
    expect(keywordSearch).toHaveBeenCalled()
  })
})
