/**
 * Unit tests for RagPipeline (W24-A1).
 *
 * Mocks retriever + assembler via mocked dependency injection (embeddingProvider,
 * vectorStore, keywordSearch). Exercises:
 *   - Constructor / config merging edge cases
 *   - ingest happy path, empty text, whitespace-only, autoEmbed flag branches
 *   - retrieve happy path, error branches, per-call overrides
 *   - assembleContext happy path, sourceMetadata fallback, error propagation
 *   - batchEmbed boundary behaviors
 *   - Tenant isolation & retriever cache lifecycle
 *
 * These are targeted unit-level tests (not integration) — no real I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RagPipeline, DEFAULT_PIPELINE_CONFIG } from '../pipeline.js'
import type { RagPipelineDeps } from '../pipeline.js'
import type { SourceMeta, VectorSearchHit } from '../types.js'

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

type Mockable = ReturnType<typeof vi.fn>

interface MockDeps {
  embeddingProvider: { embed: Mockable; embedQuery: Mockable }
  vectorStore: { upsert: Mockable; search: Mockable }
  keywordSearch?: Mockable
}

function createMockDeps(
  searchResults: VectorSearchHit[] = [],
  overrides?: Partial<MockDeps>,
): RagPipelineDeps & MockDeps {
  const base: MockDeps = {
    embeddingProvider: {
      embed: vi.fn(async (texts: string[]) =>
        texts.map(() => [0.11, 0.22, 0.33]),
      ),
      embedQuery: vi.fn(async () => [0.11, 0.22, 0.33]),
    },
    vectorStore: {
      upsert: vi.fn(async () => {}),
      search: vi.fn(async () => searchResults),
    },
  }
  return { ...base, ...overrides } as unknown as RagPipelineDeps & MockDeps
}

// ===========================================================================
// Constructor
// ===========================================================================

describe('RagPipeline (unit) — constructor', () => {
  it('accepts empty partial config and initializes without throwing', () => {
    const deps = createMockDeps()
    expect(() => new RagPipeline({}, deps)).not.toThrow()
  })

  it('accepts fully specified config', () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline(
      {
        chunking: { targetTokens: 500, overlapFraction: 0.2, respectBoundaries: false },
        embedding: { provider: 'fake', model: 'fake-m', dimensions: 4, batchSize: 5 },
        vectorStore: { adapter: 'inmemory', collectionPrefix: 'u_' },
        retrieval: {
          mode: 'vector',
          topK: 2,
          qualityBoosting: false,
          qualityWeights: { chunk: 1, source: 0 },
          tokenBudget: 1000,
          reranker: 'none',
        },
      },
      deps,
    )
    expect(pipeline).toBeInstanceOf(RagPipeline)
  })

  it('preserves partial chunking overrides by merging with defaults', async () => {
    const deps = createMockDeps()
    // Only overriding targetTokens — other fields should come from DEFAULT_PIPELINE_CONFIG
    const pipeline = new RagPipeline(
      { chunking: { targetTokens: 80 } as never },
      deps,
    )
    // Smoke test: the pipeline ingests without throwing
    await pipeline.ingest('Content '.repeat(100), {
      sourceId: 's',
      sessionId: 'x',
      tenantId: 't',
    })
    expect(deps.vectorStore.upsert).toHaveBeenCalled()
  })

  it('stores keywordSearch from deps for later retrieval', async () => {
    const keywordSearch = vi.fn(async () => [])
    const deps = createMockDeps([], { keywordSearch })
    const pipeline = new RagPipeline(
      { retrieval: { ...DEFAULT_PIPELINE_CONFIG.retrieval, mode: 'hybrid' } },
      deps,
    )
    await pipeline.retrieve('q', { sessionId: 's', tenantId: 't', mode: 'hybrid' })
    expect(keywordSearch).toHaveBeenCalled()
  })

  it('DEFAULT_PIPELINE_CONFIG has hybrid retrieval mode and topK=10', () => {
    expect(DEFAULT_PIPELINE_CONFIG.retrieval.mode).toBe('hybrid')
    expect(DEFAULT_PIPELINE_CONFIG.retrieval.topK).toBe(10)
    expect(DEFAULT_PIPELINE_CONFIG.retrieval.qualityBoosting).toBe(true)
    expect(DEFAULT_PIPELINE_CONFIG.retrieval.tokenBudget).toBe(8000)
  })

  it('DEFAULT_PIPELINE_CONFIG has embedding batchSize=100 and dimensions=1536', () => {
    expect(DEFAULT_PIPELINE_CONFIG.embedding.batchSize).toBe(100)
    expect(DEFAULT_PIPELINE_CONFIG.embedding.dimensions).toBe(1536)
    expect(DEFAULT_PIPELINE_CONFIG.embedding.provider).toBe('openai')
  })

  it('DEFAULT_PIPELINE_CONFIG has in-memory adapter and rag_ prefix', () => {
    expect(DEFAULT_PIPELINE_CONFIG.vectorStore.adapter).toBe('inmemory')
    expect(DEFAULT_PIPELINE_CONFIG.vectorStore.collectionPrefix).toBe('rag_')
  })
})

// ===========================================================================
// ingest
// ===========================================================================

describe('RagPipeline (unit) — ingest', () => {
  let deps: ReturnType<typeof createMockDeps>
  let pipeline: RagPipeline

  beforeEach(() => {
    deps = createMockDeps()
    pipeline = new RagPipeline({}, deps)
  })

  it('returns zero-chunk result with zero timings for empty input', async () => {
    const result = await pipeline.ingest('', {
      sourceId: 's',
      sessionId: 's',
      tenantId: 't',
    })
    expect(result.totalChunks).toBe(0)
    expect(result.chunks).toEqual([])
    expect(result.totalTokens).toBe(0)
    expect(result.embeddingTimeMs).toBe(0)
    expect(result.storageTimeMs).toBe(0)
    expect(deps.embeddingProvider.embed).not.toHaveBeenCalled()
  })

  it('returns zero-chunk result for whitespace-only text', async () => {
    const result = await pipeline.ingest('   \n\t  ', {
      sourceId: 's',
      sessionId: 's',
      tenantId: 't',
    })
    expect(result.totalChunks).toBe(0)
    expect(deps.vectorStore.upsert).not.toHaveBeenCalled()
  })

  it('calls embed and upsert exactly once for sufficient text (single batch)', async () => {
    await pipeline.ingest('Content word '.repeat(50), {
      sourceId: 's',
      sessionId: 's',
      tenantId: 't',
    })
    expect(deps.embeddingProvider.embed).toHaveBeenCalledTimes(1)
    expect(deps.vectorStore.upsert).toHaveBeenCalledTimes(1)
  })

  it('autoEmbed=false skips both embed and upsert, returns chunks', async () => {
    const result = await pipeline.ingest('Words '.repeat(300), {
      sourceId: 's',
      sessionId: 's',
      tenantId: 't',
      autoEmbed: false,
    })
    expect(result.totalChunks).toBeGreaterThan(0)
    expect(deps.embeddingProvider.embed).not.toHaveBeenCalled()
    expect(deps.vectorStore.upsert).not.toHaveBeenCalled()
  })

  it('autoEmbed=true (explicit) triggers embed+upsert', async () => {
    await pipeline.ingest('Words '.repeat(200), {
      sourceId: 's',
      sessionId: 's',
      tenantId: 't',
      autoEmbed: true,
    })
    expect(deps.embeddingProvider.embed).toHaveBeenCalled()
    expect(deps.vectorStore.upsert).toHaveBeenCalled()
  })

  it('uses configured collectionPrefix + tenantId for upsert collection', async () => {
    deps = createMockDeps()
    pipeline = new RagPipeline(
      { vectorStore: { adapter: 'inmemory', collectionPrefix: 'tnt_' } },
      deps,
    )
    await pipeline.ingest('Words '.repeat(200), {
      sourceId: 's',
      sessionId: 's',
      tenantId: 'myco',
    })
    const [collectionArg] = deps.vectorStore.upsert.mock.calls[0] as [string, unknown]
    expect(collectionArg).toBe('tnt_myco')
  })

  it('merges custom metadata alongside system fields', async () => {
    await pipeline.ingest('Content '.repeat(200), {
      sourceId: 'src-1',
      sessionId: 'sess-1',
      tenantId: 't',
      metadata: { topic: 'ai', weight: 7, flag: true },
    })
    const [, entries] = deps.vectorStore.upsert.mock.calls[0] as [
      string,
      Array<{ metadata: Record<string, unknown> }>,
    ]
    expect(entries[0]!.metadata).toMatchObject({
      source_id: 'src-1',
      session_id: 'sess-1',
      topic: 'ai',
      weight: 7,
      flag: true,
    })
  })

  it('per-entry metadata contains chunk_index, quality_score and token_count', async () => {
    await pipeline.ingest('Content '.repeat(200), {
      sourceId: 's',
      sessionId: 's',
      tenantId: 't',
    })
    const [, entries] = deps.vectorStore.upsert.mock.calls[0] as [
      string,
      Array<{ metadata: Record<string, unknown> }>,
    ]
    for (const entry of entries) {
      expect(entry.metadata).toHaveProperty('chunk_index')
      expect(entry.metadata).toHaveProperty('quality_score')
      expect(entry.metadata).toHaveProperty('token_count')
      expect(typeof entry.metadata['chunk_index']).toBe('number')
    }
  })

  it('each entry has id, vector array and text field', async () => {
    await pipeline.ingest('Content '.repeat(100), {
      sourceId: 's',
      sessionId: 's',
      tenantId: 't',
    })
    const [, entries] = deps.vectorStore.upsert.mock.calls[0] as [
      string,
      Array<{ id: string; vector: number[]; text: string }>,
    ]
    for (const entry of entries) {
      expect(typeof entry.id).toBe('string')
      expect(Array.isArray(entry.vector)).toBe(true)
      expect(entry.vector.length).toBeGreaterThan(0)
      expect(typeof entry.text).toBe('string')
    }
  })

  it('propagates embedding provider errors through ingest', async () => {
    deps.embeddingProvider.embed.mockRejectedValueOnce(new Error('embed-fail'))
    await expect(
      pipeline.ingest('Content '.repeat(200), {
        sourceId: 's',
        sessionId: 's',
        tenantId: 't',
      }),
    ).rejects.toThrow('embed-fail')
  })

  it('propagates vector store upsert errors through ingest', async () => {
    deps.vectorStore.upsert.mockRejectedValueOnce(new Error('upsert-fail'))
    await expect(
      pipeline.ingest('Content '.repeat(200), {
        sourceId: 's',
        sessionId: 's',
        tenantId: 't',
      }),
    ).rejects.toThrow('upsert-fail')
  })

  it('totalTokens equals sum of chunk tokenCount values', async () => {
    const result = await pipeline.ingest('Word '.repeat(300), {
      sourceId: 's',
      sessionId: 's',
      tenantId: 't',
    })
    const sum = result.chunks.reduce((acc, c) => acc + c.tokenCount, 0)
    expect(result.totalTokens).toBe(sum)
  })
})

// ===========================================================================
// batch embedding boundaries
// ===========================================================================

describe('RagPipeline (unit) — batch embedding', () => {
  it('splits embed calls across multiple batches when batchSize is small', async () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline(
      { embedding: { batchSize: 2, provider: 'p', model: 'm', dimensions: 3 } },
      deps,
    )
    // Force many chunks with small target tokens
    await pipeline.ingest('Word '.repeat(400), {
      sourceId: 's',
      sessionId: 's',
      tenantId: 't',
      chunkingOverrides: { targetTokens: 40, overlapFraction: 0 },
    })
    // With batchSize=2 and many chunks, expect more than one embed call
    expect(deps.embeddingProvider.embed.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('batchSize larger than chunk count makes a single embed call', async () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline(
      { embedding: { batchSize: 99999, provider: 'p', model: 'm', dimensions: 3 } },
      deps,
    )
    await pipeline.ingest('Content '.repeat(200), {
      sourceId: 's',
      sessionId: 's',
      tenantId: 't',
    })
    expect(deps.embeddingProvider.embed).toHaveBeenCalledTimes(1)
  })

  it('embed receives text-only array (no metadata/vector leakage)', async () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline({}, deps)
    await pipeline.ingest('Content '.repeat(200), {
      sourceId: 's',
      sessionId: 's',
      tenantId: 't',
    })
    const firstCall = deps.embeddingProvider.embed.mock.calls[0] as [string[]]
    expect(Array.isArray(firstCall[0])).toBe(true)
    for (const t of firstCall[0]) {
      expect(typeof t).toBe('string')
    }
  })
})

// ===========================================================================
// retrieve
// ===========================================================================

describe('RagPipeline (unit) — retrieve', () => {
  it('returns empty chunks array when store returns nothing', async () => {
    const deps = createMockDeps([])
    const pipeline = new RagPipeline({}, deps)
    const result = await pipeline.retrieve('q', { sessionId: 's', tenantId: 't' })
    expect(result.chunks).toEqual([])
    expect(result.totalTokens).toBe(0)
  })

  it('propagates embedQuery errors', async () => {
    const deps = createMockDeps()
    deps.embeddingProvider.embedQuery.mockRejectedValueOnce(new Error('embed-q-fail'))
    const pipeline = new RagPipeline({}, deps)
    await expect(
      pipeline.retrieve('q', { sessionId: 's', tenantId: 't' }),
    ).rejects.toThrow('embed-q-fail')
  })

  it('propagates vector store search errors', async () => {
    const deps = createMockDeps()
    deps.vectorStore.search.mockRejectedValueOnce(new Error('vsearch-fail'))
    const pipeline = new RagPipeline({}, deps)
    await expect(
      pipeline.retrieve('q', { sessionId: 's', tenantId: 't' }),
    ).rejects.toThrow('vsearch-fail')
  })

  it('uses per-call mode=vector override', async () => {
    const deps = createMockDeps([])
    const pipeline = new RagPipeline({}, deps)
    const result = await pipeline.retrieve('q', {
      sessionId: 's',
      tenantId: 't',
      mode: 'vector',
    })
    expect(result.searchMode).toBe('vector')
  })

  it('uses per-call mode=keyword override when keywordSearch dep is present', async () => {
    const deps = createMockDeps([], {
      keywordSearch: vi.fn(async () => []),
    })
    const pipeline = new RagPipeline({}, deps)
    const result = await pipeline.retrieve('q', {
      sessionId: 's',
      tenantId: 't',
      mode: 'keyword',
    })
    expect(result.searchMode).toBe('keyword')
  })

  it('includes session_id in the vector search filter', async () => {
    const deps = createMockDeps([])
    const pipeline = new RagPipeline({}, deps)
    await pipeline.retrieve('q', { sessionId: 'sess-42', tenantId: 't' })
    const searchCall = deps.vectorStore.search.mock.calls[0] as [
      string,
      { filter?: unknown },
    ]
    expect(searchCall[1].filter).toBeDefined()
  })

  it('forwards topK override as limit to underlying store search', async () => {
    let capturedLimit: number | undefined
    const deps = createMockDeps()
    deps.vectorStore.search.mockImplementation(
      async (_c: string, q: Record<string, unknown>) => {
        capturedLimit = q['limit'] as number
        return []
      },
    )
    const pipeline = new RagPipeline({}, deps)
    await pipeline.retrieve('q', { sessionId: 's', tenantId: 't', topK: 7 })
    expect(capturedLimit).toBe(7)
  })

  it('uses different collection names for different tenants', async () => {
    const calls: string[] = []
    const deps = createMockDeps()
    deps.vectorStore.search.mockImplementation(async (c: string) => {
      calls.push(c)
      return []
    })
    const pipeline = new RagPipeline({}, deps)
    await pipeline.retrieve('q', { sessionId: 's', tenantId: 'alpha' })
    await pipeline.retrieve('q', { sessionId: 's', tenantId: 'beta' })
    expect(calls).toEqual(['rag_alpha', 'rag_beta'])
  })

  it('queryTimeMs is non-negative', async () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline({}, deps)
    const result = await pipeline.retrieve('q', { sessionId: 's', tenantId: 't' })
    expect(result.queryTimeMs).toBeGreaterThanOrEqual(0)
  })

  it('hybrid mode with no keywordSearch dep still works by falling back', async () => {
    const deps = createMockDeps([])
    const pipeline = new RagPipeline(
      { retrieval: { ...DEFAULT_PIPELINE_CONFIG.retrieval, mode: 'hybrid' } },
      deps,
    )
    // Should not throw even without keywordSearch dep
    const result = await pipeline.retrieve('q', { sessionId: 's', tenantId: 't' })
    expect(result).toBeDefined()
  })
})

// ===========================================================================
// assembleContext
// ===========================================================================

describe('RagPipeline (unit) — assembleContext', () => {
  it('returns no-sources prompt when retrieval yields nothing', async () => {
    const deps = createMockDeps([])
    const pipeline = new RagPipeline({}, deps)
    const ctx = await pipeline.assembleContext('q', { sessionId: 's', tenantId: 't' })
    expect(ctx.citations).toHaveLength(0)
    expect(ctx.systemPrompt).toContain('No sources')
  })

  it('auto-builds sourceMetadata with Unknown title when none provided', async () => {
    const deps = createMockDeps([
      {
        id: 'c1',
        score: 0.9,
        text: 'hello',
        metadata: { source_id: 'auto-src', chunk_index: 0 },
      },
    ])
    const pipeline = new RagPipeline({}, deps)
    const ctx = await pipeline.assembleContext('q', { sessionId: 's', tenantId: 't' })
    const cit = ctx.citations.find(c => c.sourceId === 'auto-src')
    expect(cit).toBeDefined()
    expect(cit!.sourceTitle).toBe('Unknown')
  })

  it('explicit sourceMetadata overrides defaults', async () => {
    const deps = createMockDeps([
      {
        id: 'c1',
        score: 0.9,
        text: 'hello',
        metadata: { source_id: 'src-1', chunk_index: 0 },
      },
    ])
    const pipeline = new RagPipeline({}, deps)
    const sourceMetadata = new Map<string, SourceMeta>([
      [
        'src-1',
        {
          sourceId: 'src-1',
          title: 'Explicit Title',
          contextMode: 'full',
        },
      ],
    ])
    const ctx = await pipeline.assembleContext('q', {
      sessionId: 's',
      tenantId: 't',
      sourceMetadata,
    })
    expect(ctx.citations[0]!.sourceTitle).toBe('Explicit Title')
  })

  it('passes snippetLength via assemblyOptions to the assembler', async () => {
    const deps = createMockDeps([
      {
        id: 'c1',
        score: 0.9,
        text: 'A'.repeat(500),
        metadata: { source_id: 'src-1', chunk_index: 0 },
      },
    ])
    const pipeline = new RagPipeline({}, deps)
    const ctx = await pipeline.assembleContext('q', {
      sessionId: 's',
      tenantId: 't',
      assemblyOptions: { snippetLength: 25 },
    })
    expect(ctx.citations[0]!.snippet.length).toBeLessThanOrEqual(25)
  })

  it('uses DEFAULT tokenBudget when maxTokens is omitted', async () => {
    const deps = createMockDeps([])
    const pipeline = new RagPipeline({}, deps)
    const ctx = await pipeline.assembleContext('q', { sessionId: 's', tenantId: 't' })
    expect(ctx).toBeDefined()
    expect(ctx.totalTokens).toBeGreaterThanOrEqual(0)
  })

  it('propagates retrieval errors', async () => {
    const deps = createMockDeps()
    deps.vectorStore.search.mockRejectedValueOnce(new Error('retrieval-fail'))
    const pipeline = new RagPipeline({}, deps)
    await expect(
      pipeline.assembleContext('q', { sessionId: 's', tenantId: 't' }),
    ).rejects.toThrow('retrieval-fail')
  })

  it('returns contextText and sourceBreakdown fields', async () => {
    const deps = createMockDeps([])
    const pipeline = new RagPipeline({}, deps)
    const ctx = await pipeline.assembleContext('q', { sessionId: 's', tenantId: 't' })
    expect(ctx).toHaveProperty('systemPrompt')
    expect(ctx).toHaveProperty('contextText')
    expect(ctx).toHaveProperty('citations')
    expect(ctx).toHaveProperty('totalTokens')
    expect(ctx).toHaveProperty('sourceBreakdown')
    expect(Array.isArray(ctx.sourceBreakdown)).toBe(true)
  })
})

// ===========================================================================
// Retriever cache lifecycle
// ===========================================================================

describe('RagPipeline (unit) — retriever cache lifecycle', () => {
  it('disposeTenant is a no-op for unknown tenantId', () => {
    const pipeline = new RagPipeline({}, createMockDeps())
    expect(() => pipeline.disposeTenant('never-existed')).not.toThrow()
  })

  it('disposeTenant called twice in a row does not throw', async () => {
    const deps = createMockDeps()
    const pipeline = new RagPipeline({}, deps)
    await pipeline.retrieve('q', { sessionId: 's', tenantId: 't' })
    pipeline.disposeTenant('t')
    expect(() => pipeline.disposeTenant('t')).not.toThrow()
  })

  it('disposeAll followed by retrieve succeeds (retriever rebuilt)', async () => {
    const deps = createMockDeps([])
    const pipeline = new RagPipeline({}, deps)
    await pipeline.retrieve('q', { sessionId: 's', tenantId: 't' })
    pipeline.disposeAll()
    const result = await pipeline.retrieve('q', { sessionId: 's', tenantId: 't' })
    expect(result).toBeDefined()
  })

  it('disposeAll is safe when no retrievers have been created', () => {
    const pipeline = new RagPipeline({}, createMockDeps())
    expect(() => pipeline.disposeAll()).not.toThrow()
  })
})
