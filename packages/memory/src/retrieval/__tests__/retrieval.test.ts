import { describe, expect, it } from 'vitest'

import { retrieveMemoryV1 } from '../retrieve-memory-v1.js'
import {
  candidate,
  instant,
  memoryRecord,
  PROFILE,
  QUERY,
  retriever,
} from './fixtures.js'

describe('retrieveMemoryV1 deterministic selection', () => {
  it('fuses lexical and vector candidates against current lifecycle truth', async () => {
    const record = memoryRecord({ text: 'SECRET_CANARY ERR_RETRY_42' })
    const result = await retrieveMemoryV1({
      query: QUERY,
      profile: PROFILE,
      retriever: retriever([
        candidate(record, 'vector', 2, 0.8),
        candidate(record, 'lexical', 1, 0.7),
      ]),
    })

    expect(result).toMatchObject({
      status: 'completed',
      reason: 'none',
      lifecycleRevisionDigest: `sha256:${'a'.repeat(64)}`,
    })
    expect(result.records).toEqual([record])
    expect(result.explanations[0]).toMatchObject({
      memoryId: record.memoryId,
      versionId: record.versionId,
      lifecycleStatus: 'active',
      exactLexicalMatch: true,
      reranked: false,
    })
    expect(result.explanations[0]?.channels.map(entry => entry.channel)).toEqual([
      'lexical', 'vector',
    ])
    expect(JSON.stringify(result.explanations)).not.toContain('SECRET_CANARY')
    expect(JSON.stringify(result.explanations)).not.toContain('content')
  })

  it('keeps exact lexical identifiers ahead of higher semantic-only scores', async () => {
    const exact = memoryRecord({ memoryId: 'memory-exact', text: 'Failure ERR_RETRY_42.' })
    const semantic = memoryRecord({ memoryId: 'memory-semantic', text: 'Retry handling.' })
    const result = await retrieveMemoryV1({
      query: QUERY,
      profile: { ...PROFILE, minimumScore: 0.95 },
      retriever: retriever([
        candidate(semantic, 'vector', 1, 1),
        candidate(exact, 'lexical', 20, 0.1),
        candidate(exact, 'vector', 20, 0.1),
      ], [semantic, exact]),
    })

    expect(result.records.map(record => record.memoryId)).toEqual(['memory-exact'])
    expect(result.explanations[0]?.exactLexicalMatch).toBe(true)
  })

  it('excludes inactive versions by default and admits explicit history', async () => {
    const active = memoryRecord({ memoryId: 'memory-active', status: 'active' })
    const revoked = memoryRecord({ memoryId: 'memory-revoked', status: 'revoked' })
    const superseded = memoryRecord({ memoryId: 'memory-old', status: 'superseded' })
    const candidates = [
      candidate(revoked, 'lexical', 1),
      candidate(active, 'lexical', 2),
      candidate(superseded, 'lexical', 3),
      candidate(revoked, 'vector', 1),
      candidate(active, 'vector', 2),
      candidate(superseded, 'vector', 3),
    ]
    const port = retriever(candidates, [active, revoked, superseded])

    const normal = await retrieveMemoryV1({ query: QUERY, profile: PROFILE, retriever: port })
    expect(normal.records.map(record => record.memoryId)).toEqual(['memory-active'])

    const history = await retrieveMemoryV1({
      query: QUERY,
      profile: { ...PROFILE, lifecycleMode: 'history' },
      retriever: port,
    })
    expect(new Set(history.records.map(record => record.memoryId))).toEqual(new Set([
      'memory-active', 'memory-revoked', 'memory-old',
    ]))
  })

  it('admits disputed records only in the explicit disputed mode', async () => {
    const disputed = memoryRecord({ memoryId: 'memory-disputed', status: 'disputed' })
    const port = retriever([
      candidate(disputed, 'lexical', 1),
      candidate(disputed, 'vector', 1),
    ], [disputed])
    expect((await retrieveMemoryV1({ query: QUERY, profile: PROFILE, retriever: port })).status)
      .toBe('abstained')
    const result = await retrieveMemoryV1({
      query: QUERY,
      profile: { ...PROFILE, lifecycleMode: 'active-and-disputed' },
      retriever: port,
    })
    expect(result.records).toEqual([disputed])
  })

  it('applies recorded, updated, validity, and expiry time filters', async () => {
    const future = memoryRecord({ memoryId: 'memory-future', updatedAt: instant(101) })
    const notYetValid = memoryRecord({ memoryId: 'memory-not-yet', validFrom: instant(101) })
    const noLongerValid = memoryRecord({ memoryId: 'memory-invalid', validTo: instant(100) })
    const expired = memoryRecord({ memoryId: 'memory-expired', expiresAt: instant(100) })
    const current = memoryRecord({ memoryId: 'memory-current' })
    const records = [future, notYetValid, noLongerValid, expired, current]
    const candidates = records.flatMap((record, index) => [
      candidate(record, 'lexical', index + 1),
      candidate(record, 'vector', index + 1),
    ])
    const result = await retrieveMemoryV1({
      query: QUERY,
      profile: PROFILE,
      retriever: retriever(candidates, records),
    })
    expect(result.records.map(record => record.memoryId)).toEqual(['memory-current'])
  })

  it('enforces diversity, per-record, total-token, and result bounds', async () => {
    const decisions = Array.from({ length: 4 }, (_, index) => memoryRecord({
      memoryId: `decision-${index}`,
      kind: 'decision',
      text: `Decision ${index} ${'bounded '.repeat(30)}`,
    }))
    const fact = memoryRecord({ memoryId: 'fact-1', kind: 'fact', text: 'Small fact.' })
    const records = [...decisions, fact]
    const candidates = records.flatMap((record, index) => [
      candidate(record, 'lexical', index + 1),
      candidate(record, 'vector', index + 1),
    ])
    const result = await retrieveMemoryV1({
      query: { ...QUERY, text: 'bounded selection' },
      profile: {
        ...PROFILE,
        resultLimit: 3,
        maxPerKind: 1,
        tokenBudget: 100,
        maxRecordTokens: 100,
      },
      retriever: retriever(candidates, records),
    })
    expect(result.records).toHaveLength(2)
    expect(new Set(result.records.map(record => record.kind))).toEqual(new Set(['decision', 'fact']))
    expect(result.tokenEstimate).toBeLessThanOrEqual(100)
  })

  it('abstains instead of falling back to unrelated memory', async () => {
    const result = await retrieveMemoryV1({
      query: QUERY,
      profile: PROFILE,
      retriever: retriever([]),
    })
    expect(result).toMatchObject({
      status: 'abstained',
      reason: 'no-eligible-candidates',
      records: [],
    })
  })
})
