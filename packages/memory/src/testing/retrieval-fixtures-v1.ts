import { digestMemoryRecordV1 } from '../records/canonical.js'
import type { MemoryRecordV1, MemoryScopeV1 } from '../records/types.js'
import type {
  MemoryCandidateV1,
  MemoryQueryV1,
  MemoryRetrievalProfileV1,
  MemoryRetrieverPort,
} from '../retrieval/v1-types.js'
import {
  CONFORMANCE_SCOPE,
  conformanceInstant,
} from './fixtures-v1.js'

export const CONFORMANCE_RETRIEVAL_QUERY: MemoryQueryV1 = Object.freeze({
  schema: 'datazup.memory.query/v1',
  scope: CONFORMANCE_SCOPE,
  text: 'Recall invented decision DECISION_42 at SESSION_09',
  asOf: conformanceInstant(40),
})

export function conformanceRetrievalProfile(
  overrides: Partial<MemoryRetrievalProfileV1> = {},
): MemoryRetrievalProfileV1 {
  return {
    schema: 'datazup.memory.retrieval-profile/v1',
    profileId: 'provider-free-conformance',
    profileVersion: 'v1',
    channels: ['lexical', 'vector', 'graph'],
    lifecycleMode: 'active',
    queryRewrite: 'disabled',
    rerank: 'disabled',
    stageDeadlineMs: 250,
    candidateLimit: 32,
    resultLimit: 8,
    tokenBudget: 2_000,
    maxRecordTokens: 1_000,
    maxPerKind: 4,
    rrfK: 60,
    minimumScore: 0,
    minimumSourceTrust: 0,
    freshnessHalfLifeDays: 30,
    weights: { fusion: 0.6, sourceTrust: 0.25, freshness: 0.15 },
    ...overrides,
  }
}

export function conformanceCandidate(
  record: MemoryRecordV1,
  channel: MemoryCandidateV1['channel'],
  rank: number,
  score = 0.8,
): MemoryCandidateV1 {
  return {
    schema: 'datazup.memory.candidate/v1',
    channel,
    rank,
    score,
    recordDigest: digestMemoryRecordV1(record),
    record,
  }
}

export function conformanceRetriever(
  candidates: readonly MemoryCandidateV1[],
  records: readonly MemoryRecordV1[] = candidates.map(entry => entry.record),
  scope: MemoryScopeV1 = CONFORMANCE_SCOPE,
  clock?: DeterministicBenchmarkClock,
): MemoryRetrieverPort {
  return {
    retrieveCandidates: async () => {
      clock?.advance(1)
      return {
        schema: 'datazup.memory.candidate-set/v1',
        scope,
        candidates,
      }
    },
    resolveLifecycle: async () => {
      clock?.advance(1)
      return {
        schema: 'datazup.memory.lifecycle-resolution/v1',
        scope,
        revisionDigest: `sha256:${'a'.repeat(64)}`,
        records,
      }
    },
  }
}

export class DeterministicBenchmarkClock {
  private elapsed = 0

  now(): number {
    return this.elapsed
  }

  advance(milliseconds: number): void {
    this.elapsed += milliseconds
  }
}
