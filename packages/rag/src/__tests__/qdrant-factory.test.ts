/**
 * QdrantRagFactory tests.
 *
 * Unit tests run always (mock fetch). Integration tests require QDRANT_URL env var.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QdrantAdapter } from '@dzupagent/core'
import type { EmbeddingProvider } from '@dzupagent/core'
import { createQdrantRagPipeline, ensureTenantCollection } from '../qdrant-factory.js'
import { RagPipeline } from '../pipeline.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockFetch(responses: Array<{ status: number; body: unknown }>): typeof globalThis.fetch {
  let call = 0
  return vi.fn().mockImplementation(() => {
    const r = responses[call % responses.length]!
    call++
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () => Promise.resolve(r.body),
    })
  }) as unknown as typeof globalThis.fetch
}

function makeEmbeddingProvider(dims = 3): EmbeddingProvider {
  return {
    modelId: 'mock-embed',
    dimensions: dims,
    embed: async (texts: string[]) => texts.map(() => Array(dims).fill(0.1) as number[]),
    embedQuery: async () => Array(dims).fill(0.1) as number[],
  }
}

// ---------------------------------------------------------------------------
// Unit tests — no live Qdrant
// ---------------------------------------------------------------------------

describe('createQdrantRagPipeline', () => {
  it('returns a RagPipeline instance', () => {
    const pipeline = createQdrantRagPipeline({
      embeddingProvider: makeEmbeddingProvider(),
      qdrant: { url: 'http://localhost:6333' },
    })
    expect(pipeline).toBeInstanceOf(RagPipeline)
  })

  it('uses custom collectionPrefix', () => {
    const pipeline = createQdrantRagPipeline({
      embeddingProvider: makeEmbeddingProvider(),
      collectionPrefix: 'custom_',
    })
    expect(pipeline).toBeInstanceOf(RagPipeline)
  })

  it('accepts keywordSearch override', () => {
    const pipeline = createQdrantRagPipeline({
      embeddingProvider: makeEmbeddingProvider(),
      keywordSearch: async () => [],
    })
    expect(pipeline).toBeInstanceOf(RagPipeline)
  })

  it('applies pipeline config overrides', () => {
    const pipeline = createQdrantRagPipeline({
      embeddingProvider: makeEmbeddingProvider(),
      pipeline: {
        retrieval: { mode: 'vector', topK: 5, qualityBoosting: false, qualityWeights: { chunk: 1, source: 0 }, tokenBudget: 4000 },
      },
    })
    expect(pipeline).toBeInstanceOf(RagPipeline)
  })
})

describe('ensureTenantCollection', () => {
  let fetchFn: ReturnType<typeof vi.fn>
  let adapter: QdrantAdapter

  beforeEach(() => {
    fetchFn = vi.fn()
    adapter = new QdrantAdapter({ url: 'http://localhost:6333', fetch: fetchFn as unknown as typeof globalThis.fetch })
  })

  it('creates collection when it does not exist', async () => {
    // First call: collectionExists → 404
    // Second call: createCollection → 200
    fetchFn
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: true }) })

    const name = await ensureTenantCollection(adapter, 'tenant-a')
    expect(name).toBe('rag_tenant-a')
    expect(fetchFn).toHaveBeenCalledTimes(2)
    // Second call should be PUT to create the collection
    const [createUrl, createOpts] = fetchFn.mock.calls[1] as [string, RequestInit]
    expect(createUrl).toContain('/collections/rag_tenant-a')
    expect(createOpts.method).toBe('PUT')
  })

  it('skips creation when collection already exists', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: { name: 'rag_tenant-b' } }),
    })

    const name = await ensureTenantCollection(adapter, 'tenant-b')
    expect(name).toBe('rag_tenant-b')
    // Only one call (collectionExists check), no create
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('respects custom collectionPrefix and dimensions', async () => {
    fetchFn
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: true }) })

    const name = await ensureTenantCollection(adapter, 'xyz', {
      collectionPrefix: 'myapp_',
      dimensions: 768,
    })
    expect(name).toBe('myapp_xyz')
    const [, createOpts] = fetchFn.mock.calls[1] as [string, RequestInit]
    const body = JSON.parse(createOpts.body as string) as { vectors: { size: number } }
    expect(body.vectors.size).toBe(768)
  })
})

describe('QdrantRagFactory — ingest + retrieve (mock Qdrant)', () => {
  it('routes ingest through QdrantAdapter upsert', async () => {
    const upsertFetch = makeMockFetch([
      // createCollection or upsert — just return ok
      { status: 200, body: { result: { operation_id: 1, status: 'completed' } } },
    ])

    const pipeline = createQdrantRagPipeline({
      embeddingProvider: makeEmbeddingProvider(3),
      qdrant: { url: 'http://qdrant:6333', fetch: upsertFetch },
      collectionPrefix: 'test_',
    })

    const result = await pipeline.ingest('Hello world document', {
      sourceId: 'src-1',
      sessionId: 'sess-1',
      tenantId: 'tenant-1',
    })

    // Chunks produced and embed called
    expect(result.totalChunks).toBeGreaterThan(0)
    // Upsert call made (fetch called at least once)
    expect(upsertFetch).toHaveBeenCalled()
    const [url] = (upsertFetch as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [string]
    expect(url).toContain('test_tenant-1')
  })
})

// ---------------------------------------------------------------------------
// Integration tests — require live Qdrant (skipped in CI)
// ---------------------------------------------------------------------------

const QDRANT_URL = process.env['QDRANT_URL']
const runIntegration = QDRANT_URL !== undefined && QDRANT_URL !== ''

describe.skipIf(!runIntegration)('QdrantRagFactory integration (live Qdrant)', () => {
  const tenantId = `test-${Date.now()}`

  it('ingest → retrieve round-trip with real Qdrant', async () => {
    // Minimal deterministic embedding: returns constant vector
    const embeddingProvider: EmbeddingProvider = {
      modelId: 'constant-embed',
      dimensions: 4,
      embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
      embedQuery: async () => [0.1, 0.2, 0.3, 0.4],
    }

    const adapter = new QdrantAdapter({ url: QDRANT_URL })

    // Ensure collection exists
    const collectionName = await ensureTenantCollection(adapter, tenantId, { dimensions: 4 })
    expect(collectionName).toBe(`rag_${tenantId}`)

    const pipeline = createQdrantRagPipeline({
      qdrant: { url: QDRANT_URL },
      embeddingProvider,
      dimensions: 4,
    })

    const ingestResult = await pipeline.ingest(
      'The quick brown fox jumps over the lazy dog. This is a test document for integration testing.',
      { sourceId: 'integ-src-1', sessionId: 'integ-sess-1', tenantId },
    )

    expect(ingestResult.totalChunks).toBeGreaterThan(0)
    expect(ingestResult.embeddingTimeMs).toBeGreaterThan(0)

    const retrievalResult = await pipeline.retrieve('quick brown fox', {
      sessionId: 'integ-sess-1',
      tenantId,
      topK: 3,
      mode: 'vector',
    })

    expect(retrievalResult.chunks.length).toBeGreaterThan(0)
    expect(retrievalResult.chunks[0]!.text).toBeTruthy()

    // Cleanup
    await adapter.deleteCollection(collectionName)
  })
})
