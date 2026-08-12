import { describe, expect, it, vi } from 'vitest'

import { digestMemoryRecordV1 } from '../../records/canonical.js'
import { retrieveMemoryV1 } from '../retrieve-memory-v1.js'
import type { MemoryRetrieverPort } from '../v1-types.js'
import {
  candidate,
  memoryRecord,
  OTHER_SCOPE,
  PROFILE,
  QUERY,
  retriever,
} from './fixtures.js'

describe('retrieveMemoryV1 hostile and fail-closed boundaries', () => {
  it('rejects cross-scope candidates before lifecycle resolution', async () => {
    const foreign = memoryRecord({ scope: OTHER_SCOPE })
    const resolveLifecycle = vi.fn(async () => null)
    const port: MemoryRetrieverPort = {
      retrieveCandidates: async () => ({
        schema: 'datazup.memory.candidate-set/v1',
        scope: QUERY.scope,
        candidates: [candidate(foreign, 'lexical', 1)],
      }),
      resolveLifecycle,
    }
    const result = await retrieveMemoryV1({ query: QUERY, profile: PROFILE, retriever: port })
    expect(result).toMatchObject({ status: 'rejected', reason: 'invalid-candidate-set' })
    expect(resolveLifecycle).not.toHaveBeenCalled()
  })

  it('abstains when candidate status/content is stale against current store truth', async () => {
    const stale = memoryRecord({ memoryId: 'memory-stale', status: 'active', text: 'old value' })
    const current = memoryRecord({
      memoryId: stale.memoryId,
      versionId: stale.versionId,
      status: 'superseded',
      text: 'old value',
    })
    const result = await retrieveMemoryV1({
      query: QUERY,
      profile: PROFILE,
      retriever: retriever([
        candidate(stale, 'lexical', 1),
        candidate(stale, 'vector', 1),
      ], [current]),
    })
    expect(result).toMatchObject({ status: 'abstained', records: [] })
  })

  it('rejects conflicting current records for one version identity', async () => {
    const first = memoryRecord({ memoryId: 'memory-conflict', text: 'first' })
    const second = memoryRecord({ memoryId: first.memoryId, text: 'second' })
    const result = await retrieveMemoryV1({
      query: QUERY,
      profile: PROFILE,
      retriever: retriever([
        candidate(first, 'lexical', 1),
        candidate(first, 'vector', 1),
      ], [first, second]),
    })
    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'invalid-lifecycle-resolution',
    })
  })

  it('rejects forged digests, duplicate ranks, unknown fields, accessors, and proxies', async () => {
    const record = memoryRecord()
    const valid = candidate(record, 'lexical', 1)
    const cases: unknown[] = [
      { ...valid, recordDigest: `sha256:${'f'.repeat(64)}` },
      [valid, candidate(record, 'lexical', 1)],
      { ...valid, unexpected: true },
      Object.defineProperty({}, 'schema', { enumerable: true, get: () => 'datazup.memory.candidate/v1' }),
      new Proxy(valid, {}),
    ]
    for (const hostile of cases) {
      const candidates = Array.isArray(hostile) ? hostile : [hostile]
      const port: MemoryRetrieverPort = {
        retrieveCandidates: async () => ({
          schema: 'datazup.memory.candidate-set/v1',
          scope: QUERY.scope,
          candidates,
        }),
        resolveLifecycle: async () => ({
          schema: 'datazup.memory.lifecycle-resolution/v1',
          scope: QUERY.scope,
          revisionDigest: `sha256:${'a'.repeat(64)}`,
          records: [record],
        }),
      }
      await expect(retrieveMemoryV1({ query: QUERY, profile: PROFILE, retriever: port }))
        .resolves.toMatchObject({ status: 'rejected', reason: 'invalid-candidate-set' })
    }
  })

  it('rejects invalid query/profile values and never invokes the retriever', async () => {
    const port = retriever([])
    const retrieveCandidates = vi.spyOn(port, 'retrieveCandidates')
    await expect(retrieveMemoryV1({
      query: { ...QUERY, text: ' x ' },
      profile: PROFILE,
      retriever: port,
    })).resolves.toMatchObject({ status: 'rejected', reason: 'invalid-query' })
    await expect(retrieveMemoryV1({
      query: QUERY,
      profile: { ...PROFILE, channels: ['lexical'] as never },
      retriever: port,
    })).resolves.toMatchObject({ status: 'rejected', reason: 'invalid-profile' })
    expect(retrieveCandidates).not.toHaveBeenCalled()
  })

  it('reports retriever exceptions as retryable without raw error leakage', async () => {
    const port: MemoryRetrieverPort = {
      retrieveCandidates: async () => { throw new Error('SECRET_STORE_DETAIL') },
      resolveLifecycle: async () => null,
    }
    const result = await retrieveMemoryV1({ query: QUERY, profile: PROFILE, retriever: port })
    expect(result).toMatchObject({
      status: 'retryable',
      reason: 'retriever-unavailable',
      records: [],
    })
    expect(JSON.stringify(result)).not.toContain('SECRET_STORE_DETAIL')
  })

  it('does not let caller candidate mutation change returned canonical store truth', async () => {
    const record = memoryRecord()
    const source = {
      schema: 'datazup.memory.candidate/v1' as const,
      channel: 'lexical' as const,
      rank: 1,
      score: 1,
      recordDigest: digestMemoryRecordV1(record),
      record,
    }
    const port = retriever([source, candidate(record, 'vector', 1)], [record])
    const result = await retrieveMemoryV1({ query: QUERY, profile: PROFILE, retriever: port })
    expect(Object.isFrozen(result.records[0])).toBe(true)
    expect(result.records[0]).toEqual(record)
  })
})
