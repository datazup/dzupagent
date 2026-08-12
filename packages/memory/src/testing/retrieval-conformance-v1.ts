import { digestMemoryRecordV1 } from '../records/canonical.js'
import type { MemoryRecordV1, MemoryStatusV1 } from '../records/types.js'
import { retrieveMemoryV1 } from '../retrieval/retrieve-memory-v1.js'
import type { MemoryRetrievalProfileV1 } from '../retrieval/v1-types.js'
import type { MemoryBenchmarkProfileV1 } from './benchmark-profile-v1.js'
import {
  createMemoryConformanceSuiteV1,
  type MemoryConformanceSuiteV1,
} from './conformance-core-v1.js'
import {
  CONFORMANCE_SCOPE,
  conformanceInstant,
  createConformanceRecord,
  MEMORY_CONFORMANCE_FIXTURE_VERSION,
} from './fixtures-v1.js'
import {
  CONFORMANCE_RETRIEVAL_QUERY,
  conformanceCandidate,
  conformanceRetrievalProfile,
  conformanceRetriever,
  DeterministicBenchmarkClock,
} from './retrieval-fixtures-v1.js'
import {
  rankingMetrics,
  ratio,
  resourceMetrics,
} from './retrieval-metrics-v1.js'
import {
  externalProviderAdmission,
  scopeAndContentLeakage,
  stageDeadlines,
} from './retrieval-security-conformance-v1.js'

/** Build deterministic temporal, quality, and retrieval-security conformance. */
export function createMemoryRetrievalConformanceSuite(
  profile: MemoryBenchmarkProfileV1,
): MemoryConformanceSuiteV1 {
  return createMemoryConformanceSuiteV1({
    suiteId: 'memory-retrieval-conformance',
    suiteVersion: 'v1',
    domain: 'retrieval',
    fixtureSetId: 'invented-long-horizon-retrieval-contracts',
    fixtureVersion: MEMORY_CONFORMANCE_FIXTURE_VERSION,
    profile,
    cases: [{
      id: 'retrieval.multi-session-ranking',
      capability: 'multi-session-recall',
      expected: 'pass',
      run: async () => multiSessionRanking(profile),
    }, {
      id: 'retrieval.long-horizon-causal',
      capability: 'causal-recall',
      expected: 'pass',
      run: async () => longHorizonCausal(profile),
    }, {
      id: 'retrieval.temporal-boundaries',
      capability: 'as-of-validity',
      expected: 'pass',
      run: async () => temporalBoundaries(profile),
    }, {
      id: 'retrieval.correction-and-stale-candidates',
      capability: 'active-version-correctness',
      expected: 'pass',
      run: async () => correctionAndStaleCandidates(profile),
    }, {
      id: 'retrieval.lifecycle-modes',
      capability: 'explicit-history-semantics',
      expected: 'pass',
      run: async () => lifecycleModes(profile),
    }, {
      id: 'retrieval.abstention',
      capability: 'explicit-abstention',
      expected: 'pass',
      run: async () => abstention(profile),
    }, {
      id: 'retrieval.scope-and-content-leakage',
      capability: 'privacy-boundary',
      expected: 'pass',
      run: async () => scopeAndContentLeakage(profile),
    }, {
      id: 'retrieval.external-provider-admission',
      capability: 'provider-disclosure-policy',
      expected: 'pass',
      run: async () => externalProviderAdmission(profile),
    }, {
      id: 'retrieval.stage-deadlines',
      capability: 'bounded-cancellation',
      expected: 'pass',
      run: async () => stageDeadlines(),
    }],
  })
}

async function multiSessionRanking(profile: MemoryBenchmarkProfileV1) {
  const first = createConformanceRecord({
    memoryId: 'memory-session-03-decision',
    text: 'SESSION_03 introduced invented decision DECISION_42.',
    tags: ['SESSION_03', 'DECISION_42'],
  })
  const second = createConformanceRecord({
    memoryId: 'memory-session-09-followup',
    versionId: 'version-session-09-followup',
    text: 'SESSION_09 confirmed the consequence of DECISION_42.',
    tags: ['SESSION_09', 'DECISION_42'],
  })
  const distractor = createConformanceRecord({
    memoryId: 'memory-session-07-distractor',
    versionId: 'version-session-07-distractor',
    text: 'An unrelated invented preference from SESSION_07.',
  })
  const clock = new DeterministicBenchmarkClock()
  const result = await retrieveMemoryV1({
    query: CONFORMANCE_RETRIEVAL_QUERY,
    profile: conformanceRetrievalProfile({ resultLimit: 2, maxPerKind: 2 }),
    retriever: conformanceRetriever([
      conformanceCandidate(first, 'lexical', 1),
      conformanceCandidate(second, 'lexical', 2),
      conformanceCandidate(distractor, 'lexical', 3),
      conformanceCandidate(first, 'vector', 1),
      conformanceCandidate(second, 'vector', 2),
      conformanceCandidate(distractor, 'vector', 3),
    ], [first, second, distractor], CONFORMANCE_SCOPE, clock),
  })
  const metrics = [
    ...rankingMetrics(result, [first.memoryId, second.memoryId], profile),
    ratio('grounded-selection-rate', groundedRate(result, [first, second, distractor]),
      profile.thresholds.groundedSelectionRate),
    ...resourceMetrics(result, clock.now(), profile),
  ]
  return {
    passed: result.status === 'completed',
    reasonCode: result.status === 'completed' ? 'multi-session-ranked' : 'multi-session-missed',
    metrics,
    evidenceDigests: result.explanations.map(entry => entry.recordDigest),
  }
}

async function longHorizonCausal(profile: MemoryBenchmarkProfileV1) {
  const cause = createConformanceRecord({
    memoryId: 'memory-cause-session-01',
    text: 'SESSION_01 recorded CAUSE_17 before the invented queue change.',
    tags: ['CAUSE_17', 'SESSION_01'],
  })
  const effect = createConformanceRecord({
    memoryId: 'memory-effect-session-12',
    versionId: 'version-effect-session-12',
    kind: 'procedure',
    text: 'SESSION_12 linked EFFECT_17 to CAUSE_17 using reviewed evidence.',
    tags: ['CAUSE_17', 'EFFECT_17', 'SESSION_12'],
  })
  const query = {
    ...CONFORMANCE_RETRIEVAL_QUERY,
    text: 'Which reviewed item links CAUSE_17 to EFFECT_17?',
  }
  const result = await retrieveMemoryV1({
    query,
    profile: conformanceRetrievalProfile({ resultLimit: 1, maxPerKind: 1 }),
    retriever: conformanceRetriever([
      conformanceCandidate(effect, 'graph', 1),
      conformanceCandidate(effect, 'vector', 1),
      conformanceCandidate(cause, 'lexical', 1),
      conformanceCandidate(effect, 'lexical', 2),
    ], [cause, effect]),
  })
  return {
    passed: result.status === 'completed',
    reasonCode: result.records[0]?.memoryId === effect.memoryId
      ? 'causal-record-grounded'
      : 'causal-record-missed',
    metrics: [
      ...rankingMetrics(result, [effect.memoryId], profile),
      ratio('grounded-selection-rate', groundedRate(result, [cause, effect]),
        profile.thresholds.groundedSelectionRate),
    ],
    evidenceDigests: result.explanations.map(entry => entry.recordDigest),
  }
}

async function temporalBoundaries(profile: MemoryBenchmarkProfileV1) {
  const at = conformanceInstant(20)
  const valid = createConformanceRecord({
    memoryId: 'memory-valid-at-boundary',
    validFrom: at,
    updatedAt: conformanceInstant(19),
  })
  const ended = createConformanceRecord({
    memoryId: 'memory-ended-at-boundary',
    versionId: 'version-ended-at-boundary',
    validTo: at,
    updatedAt: conformanceInstant(19),
  })
  const expired = createConformanceRecord({
    memoryId: 'memory-expired-at-boundary',
    versionId: 'version-expired-at-boundary',
    expiresAt: at,
    updatedAt: conformanceInstant(19),
  })
  const future = createConformanceRecord({
    memoryId: 'memory-future-update',
    versionId: 'version-future-update',
    updatedAt: conformanceInstant(21),
  })
  const records = [valid, ended, expired, future]
  const result = await retrieveMemoryV1({
    query: { ...CONFORMANCE_RETRIEVAL_QUERY, asOf: at },
    profile: conformanceRetrievalProfile(),
    retriever: conformanceRetriever(toTwoChannelCandidates(records), records),
  })
  const accuracy = result.records.length === 1
    && result.records[0]?.memoryId === valid.memoryId ? 1 : 0
  return {
    passed: result.status === 'completed',
    reasonCode: accuracy === 1 ? 'temporal-boundaries-exact' : 'temporal-boundary-mismatch',
    metrics: [ratio('temporal-accuracy', accuracy, profile.thresholds.temporalAccuracy)],
    evidenceDigests: result.explanations.map(entry => entry.recordDigest),
  }
}

async function correctionAndStaleCandidates(profile: MemoryBenchmarkProfileV1) {
  const stale = createConformanceRecord({
    memoryId: 'memory-corrected',
    versionId: 'version-before-correction',
    text: 'Stale invented value STALE_VALUE_17.',
  })
  const superseded = createConformanceRecord({
    memoryId: stale.memoryId,
    versionId: stale.versionId,
    status: 'superseded',
    text: 'Stale invented value STALE_VALUE_17.',
  })
  const corrected = createConformanceRecord({
    memoryId: stale.memoryId,
    versionId: 'version-after-correction',
    text: 'Corrected invented value CURRENT_VALUE_17.',
    updatedAt: conformanceInstant(10),
  })
  const staleResult = await retrieveMemoryV1({
    query: CONFORMANCE_RETRIEVAL_QUERY,
    profile: conformanceRetrievalProfile(),
    retriever: conformanceRetriever(
      toTwoChannelCandidates([stale]),
      [superseded, corrected],
    ),
  })
  const currentResult = await retrieveMemoryV1({
    query: { ...CONFORMANCE_RETRIEVAL_QUERY, text: 'CURRENT_VALUE_17' },
    profile: conformanceRetrievalProfile(),
    retriever: conformanceRetriever(
      toTwoChannelCandidates([corrected]),
      [superseded, corrected],
    ),
  })
  const accurate = staleResult.status === 'abstained'
    && currentResult.records[0]?.versionId === corrected.versionId
  const staleRate = staleResult.records.some(record => record.versionId === stale.versionId) ? 1 : 0
  return {
    passed: accurate,
    reasonCode: accurate ? 'correction-re-resolved' : 'stale-correction-returned',
    metrics: [
      ratio('active-version-accuracy', accurate ? 1 : 0,
        profile.thresholds.activeVersionAccuracy),
      ratio('correction-accuracy', accurate ? 1 : 0, profile.thresholds.correctionAccuracy),
      ratio('stale-retrieval-rate', staleRate, profile.thresholds.maxStaleRetrievalRate, 'at-most'),
    ],
    evidenceDigests: currentResult.explanations.map(entry => entry.recordDigest),
  }
}

async function lifecycleModes(profile: MemoryBenchmarkProfileV1) {
  const statuses: readonly MemoryStatusV1[] = [
    'active', 'disputed', 'superseded', 'revoked', 'expired', 'archived',
  ]
  const records = statuses.map((status, index) => createConformanceRecord({
    memoryId: `memory-mode-${status}`,
    versionId: `version-mode-${status}`,
    status,
    text: `Invented lifecycle fixture MODE_${index}.`,
    tags: status === 'revoked' ? ['purge-path', 'MODE_3'] : [`MODE_${index}`],
  }))
  const candidates = toTwoChannelCandidates(records)
  const active = await retrieveWithMode('active', candidates, records)
  const disputed = await retrieveWithMode('active-and-disputed', candidates, records)
  const history = await retrieveWithMode('history', candidates, records)
  const exact = ids(active).join(',') === 'memory-mode-active'
    && new Set(ids(disputed)).size === 2
    && ids(disputed).includes('memory-mode-active')
    && ids(disputed).includes('memory-mode-disputed')
    && new Set(ids(history)).size === statuses.length
  const revokedRate = active.records.some(record => record.lifecycle.status === 'revoked') ? 1 : 0
  return {
    passed: exact,
    reasonCode: exact ? 'history-as-of-semantics-explicit' : 'lifecycle-mode-mismatch',
    metrics: [
      ratio('active-version-accuracy', exact ? 1 : 0,
        profile.thresholds.activeVersionAccuracy),
      ratio('revoked-retrieval-rate', revokedRate,
        profile.thresholds.maxRevokedRetrievalRate, 'at-most'),
    ],
    evidenceDigests: history.explanations.map(entry => entry.recordDigest),
  }
}

async function abstention(profile: MemoryBenchmarkProfileV1) {
  const empty = await retrieveMemoryV1({
    query: CONFORMANCE_RETRIEVAL_QUERY,
    profile: conformanceRetrievalProfile(),
    retriever: conformanceRetriever([]),
  })
  const weak = createConformanceRecord({
    memoryId: 'memory-below-trust-threshold',
    sourceTrust: 0.1,
  })
  const lowTrust = await retrieveMemoryV1({
    query: CONFORMANCE_RETRIEVAL_QUERY,
    profile: conformanceRetrievalProfile({ minimumSourceTrust: 0.9 }),
    retriever: conformanceRetriever(toTwoChannelCandidates([weak]), [weak]),
  })
  const accurate = empty.status === 'abstained'
    && lowTrust.status === 'abstained'
    && empty.records.length === 0
    && lowTrust.records.length === 0
  return {
    passed: accurate,
    reasonCode: accurate ? 'abstention-explicit' : 'abstention-fallback-used',
    metrics: [ratio('abstention-accuracy', accurate ? 1 : 0,
      profile.thresholds.abstentionAccuracy)],
  }
}

function toTwoChannelCandidates(records: readonly MemoryRecordV1[]) {
  return records.flatMap((record, index) => [
    conformanceCandidate(record, 'lexical', index + 1),
    conformanceCandidate(record, 'vector', index + 1),
  ])
}

function groundedRate(result: Awaited<ReturnType<typeof retrieveMemoryV1>>, records: readonly MemoryRecordV1[]) {
  const digests = new Set(records.map(digestMemoryRecordV1))
  if (result.explanations.length === 0) return 0
  return result.explanations.filter(entry => digests.has(entry.recordDigest)).length
    / result.explanations.length
}

function retrieveWithMode(
  lifecycleMode: MemoryRetrievalProfileV1['lifecycleMode'],
  candidates: ReturnType<typeof toTwoChannelCandidates>,
  records: readonly MemoryRecordV1[],
) {
  return retrieveMemoryV1({
    query: CONFORMANCE_RETRIEVAL_QUERY,
    profile: conformanceRetrievalProfile({ lifecycleMode, maxPerKind: 8 }),
    retriever: conformanceRetriever(candidates, records),
  })
}

function ids(result: Awaited<ReturnType<typeof retrieveMemoryV1>>): string[] {
  return result.records.map(record => record.memoryId).sort()
}
