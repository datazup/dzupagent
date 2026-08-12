import { describe, expect, it, vi } from 'vitest'

import { retrieveMemoryV1 } from '../retrieve-memory-v1.js'
import type {
  MemoryQueryRewriterPort,
  MemoryRerankerPort,
  MemoryRetrieverPort,
} from '../v1-types.js'
import { candidate, memoryRecord, PROFILE, QUERY, retriever } from './fixtures.js'

describe('retrieveMemoryV1 injected provider stages', () => {
  it('uses a bounded rewritten query without changing the canonical query', async () => {
    const record = memoryRecord()
    const retrieveCandidates = vi.fn<MemoryRetrieverPort['retrieveCandidates']>(async () => ({
      schema: 'datazup.memory.candidate-set/v1',
      scope: QUERY.scope,
      candidates: [candidate(record, 'lexical', 1), candidate(record, 'vector', 1)],
    }))
    const port = {
      retrieveCandidates,
      resolveLifecycle: retriever([], [record]).resolveLifecycle,
    }
    const rewriter: MemoryQueryRewriterPort = {
      rewrite: vi.fn(async () => ({
        schema: 'datazup.memory.query-rewrite-result/v1',
        status: 'completed',
        text: 'ERR_RETRY_42 retry decision',
      })),
    }
    const result = await retrieveMemoryV1({
      query: QUERY,
      profile: { ...PROFILE, queryRewrite: 'required' },
      retriever: port,
      queryRewriter: rewriter,
    })
    expect(result.status).toBe('completed')
    expect(retrieveCandidates.mock.calls[0]?.[0]).toMatchObject({
      effectiveText: 'ERR_RETRY_42 retry decision',
      query: QUERY,
    })
    expect(QUERY.text).toBe('Find decision ERR_RETRY_42 from 2026-08-10')
  })

  it('reports optional rewrite failure as explicit degradation', async () => {
    const record = memoryRecord()
    const rewriter: MemoryQueryRewriterPort = {
      rewrite: async () => { throw new Error('raw provider detail') },
    }
    const result = await retrieveMemoryV1({
      query: QUERY,
      profile: { ...PROFILE, queryRewrite: 'optional' },
      retriever: retriever([candidate(record, 'lexical', 1), candidate(record, 'vector', 1)]),
      queryRewriter: rewriter,
    })
    expect(result).toMatchObject({
      status: 'degraded',
      reason: 'provider-degraded',
      degradations: ['query-rewriter-unavailable'],
    })
    expect(JSON.stringify(result)).not.toContain('raw provider detail')
  })

  it('reports missing optional provider stages instead of silently claiming completion', async () => {
    const record = memoryRecord()
    const port = retriever([
      candidate(record, 'lexical', 1),
      candidate(record, 'vector', 1),
    ])
    await expect(retrieveMemoryV1({
      query: QUERY,
      profile: { ...PROFILE, queryRewrite: 'optional' },
      retriever: port,
    })).resolves.toMatchObject({
      status: 'degraded',
      degradations: ['query-rewriter-unavailable'],
    })
    await expect(retrieveMemoryV1({
      query: QUERY,
      profile: { ...PROFILE, rerank: 'optional' },
      retriever: port,
    })).resolves.toMatchObject({
      status: 'degraded',
      degradations: ['reranker-unavailable'],
    })
  })

  it('fails closed when a required rewriter is absent or malformed', async () => {
    const port = retriever([])
    await expect(retrieveMemoryV1({
      query: QUERY,
      profile: { ...PROFILE, queryRewrite: 'required' },
      retriever: port,
    })).resolves.toMatchObject({
      status: 'retryable',
      reason: 'query-rewriter-unavailable',
    })
    await expect(retrieveMemoryV1({
      query: QUERY,
      profile: { ...PROFILE, queryRewrite: 'required' },
      retriever: port,
      queryRewriter: { rewrite: async () => ({ status: 'completed', text: 'unsafe' }) },
    })).resolves.toMatchObject({
      status: 'retryable',
      reason: 'query-rewriter-unavailable',
    })
  })

  it('applies a complete reranker order while preserving exact lexical priority', async () => {
    const exact = memoryRecord({ memoryId: 'memory-exact' })
    const other = memoryRecord({ memoryId: 'memory-other', text: 'General retry guidance.' })
    const candidates = [
      candidate(exact, 'lexical', 2),
      candidate(exact, 'vector', 2),
      candidate(other, 'lexical', 1),
      candidate(other, 'vector', 1),
    ]
    const reranker: MemoryRerankerPort = {
      rerank: async input => ({
        schema: 'datazup.memory.rerank-result/v1',
        status: 'completed',
        order: [...input.candidates].reverse().map((entry, index) => ({
          memoryId: entry.record.memoryId,
          versionId: entry.record.versionId,
          recordDigest: entry.recordDigest,
          score: index === 0 ? 1 : 0.5,
        })),
      }),
    }
    const result = await retrieveMemoryV1({
      query: QUERY,
      profile: { ...PROFILE, rerank: 'required' },
      retriever: retriever(candidates, [exact, other]),
      reranker,
    })
    expect(result.records.map(record => record.memoryId)).toEqual([
      'memory-exact', 'memory-other',
    ])
    expect(result.explanations).toHaveLength(2)
    expect(result.explanations.filter(entry => entry.reranked)).toHaveLength(2)
  })

  it('degrades optional malformed reranking and refuses required malformed reranking', async () => {
    const record = memoryRecord()
    const port = retriever([candidate(record, 'lexical', 1), candidate(record, 'vector', 1)])
    const malformed: MemoryRerankerPort = {
      rerank: async () => ({
        schema: 'datazup.memory.rerank-result/v1',
        status: 'completed',
        order: [],
      }),
    }
    await expect(retrieveMemoryV1({
      query: QUERY,
      profile: { ...PROFILE, rerank: 'optional' },
      retriever: port,
      reranker: malformed,
    })).resolves.toMatchObject({
      status: 'degraded',
      degradations: ['reranker-unavailable'],
      records: [record],
    })
    await expect(retrieveMemoryV1({
      query: QUERY,
      profile: { ...PROFILE, rerank: 'required' },
      retriever: port,
      reranker: malformed,
    })).resolves.toMatchObject({
      status: 'retryable',
      reason: 'reranker-unavailable',
      records: [],
    })
  })

  it('re-applies the minimum score after a provider rerank', async () => {
    const record = memoryRecord({ text: 'General guidance without an identifier.' })
    const port = retriever([
      candidate(record, 'lexical', 1),
      candidate(record, 'vector', 1),
    ])
    const reranker: MemoryRerankerPort = {
      rerank: async input => ({
        schema: 'datazup.memory.rerank-result/v1',
        status: 'completed',
        order: input.candidates.map(entry => ({
          memoryId: entry.record.memoryId,
          versionId: entry.record.versionId,
          recordDigest: entry.recordDigest,
          score: 0.1,
        })),
      }),
    }
    await expect(retrieveMemoryV1({
      query: QUERY,
      profile: { ...PROFILE, minimumScore: 0.5, rerank: 'required' },
      retriever: port,
      reranker,
    })).resolves.toMatchObject({
      status: 'abstained',
      reason: 'no-eligible-candidates',
      records: [],
    })
  })
})
