import { canonicalizeSafeJson, snapshotSafeJson } from '../records/safe-json.js'
import { digestMemoryRecordV1 } from '../records/canonical.js'
import type {
  MemoryKindV1,
  MemoryRecordV1,
  MemoryStatusV1,
} from '../records/types.js'
import { MemoryRetrievalError } from './retrieval-error.js'
import { sameScope } from './v1-validation.js'
import type {
  InternalCandidateSetV1,
  InternalLifecycleResolutionV1,
  InternalRankedCandidateV1,
  MemoryQueryV1,
  MemoryRetrievalProfileV1,
  MemorySelectionExplanationV1,
} from './v1-types.js'

interface CandidateAccumulator {
  readonly record: MemoryRecordV1
  readonly recordDigest: `sha256:${string}`
  readonly channels: Map<string, MemorySelectionExplanationV1['channels'][number]>
}

export function rankResolvedCandidates(
  query: MemoryQueryV1,
  profile: MemoryRetrievalProfileV1,
  candidateSet: InternalCandidateSetV1,
  resolution: InternalLifecycleResolutionV1,
): readonly InternalRankedCandidateV1[] {
  if (!sameScope(query.scope, candidateSet.scope)
    || !sameScope(query.scope, resolution.scope)) {
    throw new MemoryRetrievalError('invalid-lifecycle-resolution', ['scope'])
  }
  const requestedChannels = new Set(profile.channels)
  const sourceRanks = new Set<string>()
  const candidateMemoryIds = new Set<string>()
  for (const [index, candidate] of candidateSet.candidates.entries()) {
    if (!sameScope(query.scope, candidate.record.scope)
      || !requestedChannels.has(candidate.channel)
      || candidate.rank > profile.candidateLimit) {
      throw new MemoryRetrievalError('invalid-candidate-set', ['candidates', String(index)])
    }
    const rankKey = `${candidate.channel}\0${candidate.rank}`
    if (sourceRanks.has(rankKey)) {
      throw new MemoryRetrievalError('invalid-candidate-set', [
        'candidates', String(index), 'rank',
      ])
    }
    sourceRanks.add(rankKey)
    candidateMemoryIds.add(candidate.record.memoryId)
  }

  const resolvedByVersion = buildResolvedIndex(
    query,
    profile,
    resolution.records,
    candidateMemoryIds,
  )
  const accumulated = new Map<string, CandidateAccumulator>()
  for (const candidate of candidateSet.candidates) {
    const key = versionKey(
      candidate.record.memoryId,
      candidate.record.versionId,
      candidate.recordDigest,
    )
    const resolved = resolvedByVersion.get(key)
    if (!resolved) continue
    const current = accumulated.get(key) ?? {
      record: resolved,
      recordDigest: candidate.recordDigest,
      channels: new Map(),
    }
    if (current.channels.has(candidate.channel)) {
      throw new MemoryRetrievalError('invalid-candidate-set', ['candidates'])
    }
    current.channels.set(candidate.channel, Object.freeze({
      channel: candidate.channel,
      rank: candidate.rank,
      score: candidate.score,
    }))
    accumulated.set(key, current)
  }

  const exactTerms = extractExactTerms(query.text)
  const ranked: InternalRankedCandidateV1[] = []
  for (const candidate of accumulated.values()) {
    const channels = [...candidate.channels.values()].sort((left, right) =>
      channelOrder(left.channel) - channelOrder(right.channel))
    const fusionScore = normalizedRrf(channels, profile)
    const sourceTrust = candidate.record.quality.sourceTrust
    const freshnessScore = calculateFreshness(candidate.record, query.asOf, profile)
    const selectionScore = clampScore(
      fusionScore * profile.weights.fusion
      + sourceTrust * profile.weights.sourceTrust
      + freshnessScore * profile.weights.freshness,
    )
    const exactLexicalMatch = channels.some(channel => channel.channel === 'lexical')
      && hasExactTerm(candidate.record, exactTerms)
    const tokenEstimate = estimateRecordTokens(candidate.record)
    if (sourceTrust < profile.minimumSourceTrust
      || (!exactLexicalMatch && selectionScore < profile.minimumScore)
      || tokenEstimate > profile.maxRecordTokens) {
      continue
    }
    ranked.push(Object.freeze({
      record: candidate.record,
      recordDigest: candidate.recordDigest,
      channels: Object.freeze(channels),
      exactLexicalMatch,
      sourceTrust,
      freshnessScore,
      selectionScore,
      tokenEstimate,
      evidenceRefs: candidate.record.provenance.evidenceRefs,
      reranked: false,
    }))
  }
  return Object.freeze(ranked.sort(compareRanked))
}

export function selectRankedCandidates(
  candidates: readonly InternalRankedCandidateV1[],
  profile: MemoryRetrievalProfileV1,
): readonly InternalRankedCandidateV1[] {
  const selected: InternalRankedCandidateV1[] = []
  const byKind = new Map<MemoryKindV1, number>()
  let tokens = 0
  for (const candidate of candidates) {
    if (selected.length >= profile.resultLimit) break
    if (!candidate.exactLexicalMatch && candidate.selectionScore < profile.minimumScore) {
      continue
    }
    const kindCount = byKind.get(candidate.record.kind) ?? 0
    if (kindCount >= profile.maxPerKind) continue
    if (tokens + candidate.tokenEstimate > profile.tokenBudget) continue
    selected.push(candidate)
    byKind.set(candidate.record.kind, kindCount + 1)
    tokens += candidate.tokenEstimate
  }
  return Object.freeze(selected)
}

export function toSelectionExplanation(
  candidate: InternalRankedCandidateV1,
): MemorySelectionExplanationV1 {
  return Object.freeze({
    schema: 'datazup.memory.selection-explanation/v1' as const,
    memoryId: candidate.record.memoryId,
    versionId: candidate.record.versionId,
    recordDigest: candidate.recordDigest,
    lifecycleStatus: candidate.record.lifecycle.status,
    kind: candidate.record.kind,
    channels: candidate.channels,
    exactLexicalMatch: candidate.exactLexicalMatch,
    sourceTrust: candidate.sourceTrust,
    freshnessScore: candidate.freshnessScore,
    selectionScore: candidate.selectionScore,
    tokenEstimate: candidate.tokenEstimate,
    reranked: candidate.reranked,
    evidenceRefs: candidate.evidenceRefs,
  })
}

function buildResolvedIndex(
  query: MemoryQueryV1,
  profile: MemoryRetrievalProfileV1,
  records: readonly MemoryRecordV1[],
  requestedMemoryIds: ReadonlySet<string>,
): Map<string, MemoryRecordV1> {
  const output = new Map<string, MemoryRecordV1>()
  const identities = new Map<string, string>()
  for (const [index, record] of records.entries()) {
    if (!sameScope(query.scope, record.scope)
      || !requestedMemoryIds.has(record.memoryId)) {
      throw new MemoryRetrievalError('invalid-lifecycle-resolution', [
        'records', String(index),
      ])
    }
    const digest = digestMemoryRecordV1(record)
    const identity = `${record.memoryId}\0${record.versionId}`
    const previousDigest = identities.get(identity)
    if (previousDigest !== undefined && previousDigest !== digest) {
      throw new MemoryRetrievalError('invalid-lifecycle-resolution', [
        'records', String(index),
      ])
    }
    identities.set(identity, digest)
    if (!lifecycleEligible(record.lifecycle.status, profile.lifecycleMode)
      || !temporallyEligible(record, query.asOf)) {
      continue
    }
    output.set(versionKey(record.memoryId, record.versionId, digest), record)
  }
  return output
}

function lifecycleEligible(
  status: MemoryStatusV1,
  mode: MemoryRetrievalProfileV1['lifecycleMode'],
): boolean {
  if (mode === 'active') return status === 'active'
  if (mode === 'active-and-disputed') return status === 'active' || status === 'disputed'
  return true
}

function temporallyEligible(record: MemoryRecordV1, asOf: string): boolean {
  const at = Date.parse(asOf)
  const temporal = record.temporal
  if (Date.parse(temporal.recordedAt) > at || Date.parse(temporal.updatedAt) > at) return false
  if (temporal.validFrom !== undefined && Date.parse(temporal.validFrom) > at) return false
  if (temporal.validTo !== undefined && Date.parse(temporal.validTo) <= at) return false
  if (temporal.expiresAt !== undefined && Date.parse(temporal.expiresAt) <= at) return false
  return true
}

function calculateFreshness(
  record: MemoryRecordV1,
  asOf: string,
  profile: MemoryRetrievalProfileV1,
): number {
  const reference = Date.parse(record.temporal.lastVerifiedAt ?? record.temporal.updatedAt)
  const ageDays = Math.max(0, Date.parse(asOf) - reference) / 86_400_000
  return clampScore(2 ** (-ageDays / profile.freshnessHalfLifeDays))
}

function normalizedRrf(
  channels: readonly MemorySelectionExplanationV1['channels'][number][],
  profile: MemoryRetrievalProfileV1,
): number {
  const sum = channels.reduce((total, channel) => total + 1 / (profile.rrfK + channel.rank), 0)
  return clampScore(sum * (profile.rrfK + 1) / profile.channels.length)
}

function extractExactTerms(text: string): readonly string[] {
  const matches = text.match(/[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}/g) ?? []
  return Object.freeze([...new Set(matches.filter(term =>
    /\d/.test(term) || /[._:@/-]/.test(term) || /^[A-Z][A-Z0-9_-]+$/.test(term),
  ).map(term => term.toLocaleLowerCase('en-US')))])
}

function hasExactTerm(record: MemoryRecordV1, terms: readonly string[]): boolean {
  if (terms.length === 0) return false
  const searchable = [
    record.memoryId,
    record.versionId,
    record.kind,
    ...record.tags,
    record.temporal.observedAt,
    record.temporal.validFrom ?? '',
    record.temporal.validTo ?? '',
    record.temporal.expiresAt ?? '',
    ...record.provenance.evidenceRefs.flatMap(ref => [ref.owner, ref.id, ref.digest]),
    record.content === undefined
      ? ''
      : canonicalizeSafeJson(snapshotSafeJson(record.content)),
  ].join('\n').toLocaleLowerCase('en-US')
  return terms.some(term => searchable.includes(term))
}

function estimateRecordTokens(record: MemoryRecordV1): number {
  const value = record.content === undefined
    ? record.contentRef ?? record.searchTextRef ?? { memoryId: record.memoryId }
    : record.content
  const serialized = canonicalizeSafeJson(snapshotSafeJson(value))
  return Math.max(1, Math.ceil(Buffer.byteLength(serialized, 'utf8') / 4))
}

function compareRanked(left: InternalRankedCandidateV1, right: InternalRankedCandidateV1): number {
  if (left.exactLexicalMatch !== right.exactLexicalMatch) {
    return left.exactLexicalMatch ? -1 : 1
  }
  return right.selectionScore - left.selectionScore
    || right.sourceTrust - left.sourceTrust
    || right.freshnessScore - left.freshnessScore
    || left.record.memoryId.localeCompare(right.record.memoryId)
    || left.record.versionId.localeCompare(right.record.versionId)
    || left.recordDigest.localeCompare(right.recordDigest)
}

function channelOrder(channel: string): number {
  if (channel === 'lexical') return 0
  if (channel === 'vector') return 1
  return 2
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function versionKey(
  memoryId: string,
  versionId: string,
  digest: string,
): string {
  return `${memoryId}\0${versionId}\0${digest}`
}
