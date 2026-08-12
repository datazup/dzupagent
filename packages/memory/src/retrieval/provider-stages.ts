import {
  digestValue,
  identifierValue,
  objectValue,
  required,
  scoreValue,
  stringValue,
} from '../records/decoder-primitives.js'
import type { SafeJson } from '../records/safe-json.js'
import { MemoryRetrievalError } from './retrieval-error.js'
import { invokeBoundedStage, stageDeadlineMs } from './stage-runtime.js'
import {
  retrievalQueryDigest,
  retrievalScopeDigest,
  snapshotRetrievalJson,
} from './v1-validation.js'
import type {
  InternalRankedCandidateV1,
  MemoryCandidateV1,
  MemoryQueryRewriterPort,
  MemoryQueryV1,
  MemoryRerankerPort,
  MemoryRetrievalProfileV1,
} from './v1-types.js'

interface QueryRewriteOutcome {
  readonly status: 'completed' | 'degraded' | 'required-failure'
  readonly text: string
}

interface RerankOutcome {
  readonly status: 'completed' | 'degraded' | 'required-failure'
  readonly candidates: readonly InternalRankedCandidateV1[]
}

export async function applyQueryRewrite(
  query: MemoryQueryV1,
  profile: MemoryRetrievalProfileV1,
  port: MemoryQueryRewriterPort | undefined,
): Promise<QueryRewriteOutcome> {
  if (profile.queryRewrite === 'disabled') return { status: 'completed', text: query.text }
  if (port === undefined) return profile.queryRewrite === 'required'
    ? { status: 'required-failure', text: query.text }
    : { status: 'degraded', text: query.text }
  const policy = profile.externalProviderPolicy
  if (policy !== undefined && !policy.allowQueryText) {
    return providerFailure(profile.queryRewrite, query.text)
  }
  const deadlineMs = stageDeadlineMs(profile)
  const response = await invokeBoundedStage(deadlineMs, signal => port.rewrite(Object.freeze({
      schema: 'datazup.memory.query-rewrite-request/v1' as const,
      queryDigest: retrievalQueryDigest(query),
      scopeDigest: retrievalScopeDigest(query.scope),
      text: query.text,
      deadlineMs,
      signal,
      ...(policy === undefined ? {} : { routeRef: policy.routeRef }),
    })))
  if (response.status === 'completed') {
    try {
      const text = decodeRewriteResponse(response.value)
      return { status: 'completed', text }
    } catch {
      return providerFailure(profile.queryRewrite, query.text)
    }
  }
  return providerFailure(profile.queryRewrite, query.text)
}

export async function applyReranker(
  query: MemoryQueryV1,
  effectiveText: string,
  profile: MemoryRetrievalProfileV1,
  candidates: readonly InternalRankedCandidateV1[],
  port: MemoryRerankerPort | undefined,
): Promise<RerankOutcome> {
  if (profile.rerank === 'disabled' || candidates.length === 0) {
    return { status: 'completed', candidates }
  }
  if (port === undefined) return profile.rerank === 'required'
    ? { status: 'required-failure', candidates }
    : { status: 'degraded', candidates }
  const requestCandidates = candidates.map(toRerankerCandidate)
  const policy = profile.externalProviderPolicy
  if (policy !== undefined && (!policy.allowQueryText
    || requestCandidates.some(candidate => candidate.record.content !== undefined
      && !policy.allowedInlineSensitivities.includes(
        candidate.record.governance.sensitivity,
      )))) {
    return rerankerFailure(profile.rerank, candidates)
  }
  const deadlineMs = stageDeadlineMs(profile)
  const response = await invokeBoundedStage(deadlineMs, signal => port.rerank(Object.freeze({
      schema: 'datazup.memory.rerank-request/v1' as const,
      queryDigest: retrievalQueryDigest(query),
      scopeDigest: retrievalScopeDigest(query.scope),
      text: effectiveText,
      candidates: Object.freeze(requestCandidates),
      deadlineMs,
      signal,
      ...(policy === undefined ? {} : { routeRef: policy.routeRef }),
    })))
  if (response.status === 'completed') {
    try {
      return {
        status: 'completed',
        candidates: applyRerankOrder(response.value, candidates),
      }
    } catch {
      return rerankerFailure(profile.rerank, candidates)
    }
  }
  return rerankerFailure(profile.rerank, candidates)
}

function providerFailure(
  mode: MemoryRetrievalProfileV1['queryRewrite'],
  text: string,
): QueryRewriteOutcome {
  return mode === 'required'
    ? { status: 'required-failure', text }
    : { status: 'degraded', text }
}

function rerankerFailure(
  mode: MemoryRetrievalProfileV1['rerank'],
  candidates: readonly InternalRankedCandidateV1[],
): RerankOutcome {
  return mode === 'required'
    ? { status: 'required-failure', candidates }
    : { status: 'degraded', candidates }
}

function decodeRewriteResponse(input: unknown): string {
  const root = objectValue(snapshotRetrievalJson(input), [], ['schema', 'status', 'text'])
  if (stringValue(root, 'schema', []) !== 'datazup.memory.query-rewrite-result/v1'
    || stringValue(root, 'status', []) !== 'completed') {
    throw new MemoryRetrievalError('invalid-provider-result')
  }
  const value = required(root, 'text', [])
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
    || Buffer.byteLength(value, 'utf8') > 2_048
    || /[\u0000\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new MemoryRetrievalError('invalid-provider-result', ['text'])
  }
  return value
}

function applyRerankOrder(
  input: unknown,
  candidates: readonly InternalRankedCandidateV1[],
): readonly InternalRankedCandidateV1[] {
  const root = objectValue(snapshotRetrievalJson(input), [], ['schema', 'status', 'order'])
  if (stringValue(root, 'schema', []) !== 'datazup.memory.rerank-result/v1'
    || stringValue(root, 'status', []) !== 'completed') {
    throw new MemoryRetrievalError('invalid-provider-result')
  }
  const order = required(root, 'order', [])
  if (!Array.isArray(order) || order.length !== candidates.length) {
    throw new MemoryRetrievalError('invalid-provider-result', ['order'])
  }
  const byKey = new Map(candidates.map(candidate => [candidateKey(candidate), candidate]))
  const seen = new Set<string>()
  const ranked = order.map((entry, index) => {
    const decoded = decodeRerankEntry(entry, index)
    const key = `${decoded.memoryId}\0${decoded.versionId}\0${decoded.recordDigest}`
    const candidate = byKey.get(key)
    if (!candidate || seen.has(key)) {
      throw new MemoryRetrievalError('invalid-provider-result', ['order', String(index)])
    }
    seen.add(key)
    return Object.freeze({
      ...candidate,
      selectionScore: decoded.score,
      reranked: true,
    })
  })
  if (seen.size !== byKey.size) {
    throw new MemoryRetrievalError('invalid-provider-result', ['order'])
  }
  return Object.freeze([
    ...ranked.filter(candidate => candidate.exactLexicalMatch),
    ...ranked.filter(candidate => !candidate.exactLexicalMatch),
  ])
}

function decodeRerankEntry(value: SafeJson, index: number) {
  const path = ['order', String(index)]
  const root = objectValue(value, path, [
    'memoryId', 'versionId', 'recordDigest', 'score',
  ])
  return {
    memoryId: identifierValue(root, 'memoryId', path),
    versionId: identifierValue(root, 'versionId', path),
    recordDigest: digestValue(root, 'recordDigest', path),
    score: scoreValue(root, 'score', path),
  }
}

function toRerankerCandidate(
  candidate: InternalRankedCandidateV1,
  index: number,
): MemoryCandidateV1 {
  const first = candidate.channels[0]
  if (!first) throw new MemoryRetrievalError('invalid-provider-result')
  return Object.freeze({
    schema: 'datazup.memory.candidate/v1' as const,
    channel: first.channel,
    rank: index + 1,
    score: candidate.selectionScore,
    recordDigest: candidate.recordDigest,
    record: candidate.record,
  })
}

function candidateKey(candidate: InternalRankedCandidateV1): string {
  return `${candidate.record.memoryId}\0${candidate.record.versionId}\0${candidate.recordDigest}`
}
