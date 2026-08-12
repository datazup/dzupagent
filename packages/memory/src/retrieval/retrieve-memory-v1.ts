import { types as utilTypes } from 'node:util'

import { MemoryRetrievalError } from './retrieval-error.js'
import {
  rankResolvedCandidates,
  selectRankedCandidates,
  toSelectionExplanation,
} from './fusion-v1.js'
import { applyQueryRewrite, applyReranker } from './provider-stages.js'
import { invokeBoundedStage, stageDeadlineMs } from './stage-runtime.js'
import {
  decodeCandidateSetV1,
  decodeLifecycleResolutionV1,
  decodeMemoryQueryV1,
  decodeMemoryRetrievalProfileV1,
  sameScope,
} from './v1-validation.js'
import type {
  InternalCandidateSetV1,
  InternalRetrieveMemoryInputV1,
  MemoryResultV1,
} from './v1-types.js'

/** Run deterministic lifecycle-aware retrieval with optional injected stages. */
export async function retrieveMemoryV1(
  input: InternalRetrieveMemoryInputV1,
): Promise<MemoryResultV1> {
  const dependencies = decodeInputEnvelope(input)
  let query
  try {
    query = decodeMemoryQueryV1(dependencies.query)
  } catch {
    return result('rejected', 'invalid-query')
  }
  let profile
  try {
    profile = decodeMemoryRetrievalProfileV1(dependencies.profile)
  } catch {
    return result('rejected', 'invalid-profile')
  }

  const degradations: Array<'query-rewriter-unavailable' | 'reranker-unavailable'> = []
  const rewrite = await applyQueryRewrite(
    query,
    profile,
    dependencies.queryRewriter,
  )
  if (rewrite.status === 'required-failure') {
    return result('retryable', 'query-rewriter-unavailable')
  }
  if (rewrite.status === 'degraded') degradations.push('query-rewriter-unavailable')

  const deadlineMs = stageDeadlineMs(profile)
  const candidateOutcome = await invokeBoundedStage(deadlineMs, signal =>
    dependencies.retriever.retrieveCandidates(Object.freeze({
      schema: 'datazup.memory.candidate-request/v1' as const,
      query,
      effectiveText: rewrite.text,
      channels: profile.channels,
      limit: profile.candidateLimit,
      deadlineMs,
      signal,
    })))
  if (candidateOutcome.status !== 'completed') {
    return result('retryable', 'retriever-unavailable', { degradations })
  }
  const candidateValue = candidateOutcome.value
  let candidateSet
  try {
    candidateSet = decodeCandidateSetV1(candidateValue, profile.candidateLimit)
    validateCandidateSetBeforeResolution(candidateSet, query.scope, profile)
  } catch {
    return result('rejected', 'invalid-candidate-set', { degradations })
  }
  const memoryIds = Object.freeze([
    ...new Set(candidateSet.candidates.map(candidate => candidate.record.memoryId)),
  ].sort())
  if (memoryIds.length === 0) {
    return result(
      degradations.length > 0 ? 'degraded' : 'abstained',
      degradations.length > 0 ? 'provider-degraded' : 'no-eligible-candidates',
      { degradations },
    )
  }

  const lifecycleOutcome = await invokeBoundedStage(deadlineMs, signal =>
    dependencies.retriever.resolveLifecycle(Object.freeze({
      schema: 'datazup.memory.lifecycle-resolution-request/v1' as const,
      scope: query.scope,
      memoryIds,
      asOf: query.asOf,
      lifecycleMode: profile.lifecycleMode,
      deadlineMs,
      signal,
    })))
  if (lifecycleOutcome.status !== 'completed') {
    return result('retryable', 'retriever-unavailable', { degradations })
  }
  const lifecycleValue = lifecycleOutcome.value
  let lifecycle
  try {
    lifecycle = decodeLifecycleResolutionV1(lifecycleValue, profile.candidateLimit)
  } catch {
    return result('rejected', 'invalid-lifecycle-resolution', { degradations })
  }

  let ranked
  try {
    ranked = rankResolvedCandidates(query, profile, candidateSet, lifecycle)
  } catch (cause) {
    return result(
      'rejected',
      cause instanceof MemoryRetrievalError
        && cause.code === 'invalid-candidate-set'
        ? 'invalid-candidate-set'
        : 'invalid-lifecycle-resolution',
      { degradations },
    )
  }
  const rerank = await applyReranker(
    query,
    rewrite.text,
    profile,
    ranked,
    dependencies.reranker,
  )
  if (rerank.status === 'required-failure') {
    return result('retryable', 'reranker-unavailable', {
      degradations,
      lifecycleRevisionDigest: lifecycle.revisionDigest,
    })
  }
  if (rerank.status === 'degraded') degradations.push('reranker-unavailable')

  const selected = selectRankedCandidates(rerank.candidates, profile)
  const records = Object.freeze(selected.map(candidate => candidate.record))
  const explanations = Object.freeze(selected.map(toSelectionExplanation))
  const tokenEstimate = selected.reduce((total, candidate) => total + candidate.tokenEstimate, 0)
  if (selected.length === 0) {
    return result(
      degradations.length > 0 ? 'degraded' : 'abstained',
      degradations.length > 0 ? 'provider-degraded' : 'no-eligible-candidates',
      {
        degradations,
        lifecycleRevisionDigest: lifecycle.revisionDigest,
      },
    )
  }
  return result(
    degradations.length > 0 ? 'degraded' : 'completed',
    degradations.length > 0 ? 'provider-degraded' : 'none',
    {
      records,
      explanations,
      tokenEstimate,
      lifecycleRevisionDigest: lifecycle.revisionDigest,
      degradations,
    },
  )
}

function validateCandidateSetBeforeResolution(
  candidateSet: InternalCandidateSetV1,
  scope: Parameters<typeof sameScope>[0],
  profile: ReturnType<typeof decodeMemoryRetrievalProfileV1>,
): void {
  if (!sameScope(candidateSet.scope, scope)) {
    throw new MemoryRetrievalError('invalid-candidate-set', ['scope'])
  }
  const channels = new Set(profile.channels)
  const ranks = new Set<string>()
  for (const [index, candidate] of candidateSet.candidates.entries()) {
    if (!sameScope(candidate.record.scope, scope)
      || !channels.has(candidate.channel)
      || candidate.rank > profile.candidateLimit) {
      throw new MemoryRetrievalError('invalid-candidate-set', ['candidates', String(index)])
    }
    const key = `${candidate.channel}\0${candidate.rank}`
    if (ranks.has(key)) {
      throw new MemoryRetrievalError('invalid-candidate-set', [
        'candidates', String(index), 'rank',
      ])
    }
    ranks.add(key)
  }
}

function decodeInputEnvelope(input: InternalRetrieveMemoryInputV1): InternalRetrieveMemoryInputV1 {
  try {
    if (input === null || typeof input !== 'object' || utilTypes.isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype) {
      throw new MemoryRetrievalError('invalid-query')
    }
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const allowed = new Set(['query', 'profile', 'retriever', 'queryRewriter', 'reranker'])
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !allowed.has(key)) {
        throw new MemoryRetrievalError('invalid-query')
      }
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new MemoryRetrievalError('invalid-query')
      }
    }
    const query = dataValue(descriptors, 'query')
    const profile = dataValue(descriptors, 'profile')
    const retriever = dataValue(descriptors, 'retriever')
    const queryRewriter = optionalDataValue(descriptors, 'queryRewriter')
    const reranker = optionalDataValue(descriptors, 'reranker')
    assertPort(retriever, ['retrieveCandidates', 'resolveLifecycle'])
    if (queryRewriter !== undefined) assertPort(queryRewriter, ['rewrite'])
    if (reranker !== undefined) assertPort(reranker, ['rerank'])
    return {
      query: query as InternalRetrieveMemoryInputV1['query'],
      profile: profile as InternalRetrieveMemoryInputV1['profile'],
      retriever: retriever as InternalRetrieveMemoryInputV1['retriever'],
      ...(queryRewriter === undefined
        ? {}
        : { queryRewriter: queryRewriter as NonNullable<InternalRetrieveMemoryInputV1['queryRewriter']> }),
      ...(reranker === undefined
        ? {}
        : { reranker: reranker as NonNullable<InternalRetrieveMemoryInputV1['reranker']> }),
    }
  } catch {
    return {
      query: null as never,
      profile: null as never,
      retriever: {
        retrieveCandidates: async () => null,
        resolveLifecycle: async () => null,
      },
    }
  }
}

function assertPort(value: unknown, methods: readonly string[]): void {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')
    || utilTypes.isProxy(value)) {
    throw new MemoryRetrievalError('invalid-query')
  }
  for (const method of methods) {
    let owner: object | null = value as object
    let descriptor: PropertyDescriptor | undefined
    while (owner !== null && descriptor === undefined) {
      descriptor = Object.getOwnPropertyDescriptor(owner, method)
      owner = Object.getPrototypeOf(owner) as object | null
    }
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') {
      throw new MemoryRetrievalError('invalid-query')
    }
  }
}

function dataValue(descriptors: PropertyDescriptorMap, key: string): unknown {
  const descriptor = descriptors[key]
  if (!descriptor || !('value' in descriptor)) throw new MemoryRetrievalError('invalid-query')
  return descriptor.value
}

function optionalDataValue(descriptors: PropertyDescriptorMap, key: string): unknown {
  const descriptor = descriptors[key]
  if (!descriptor) return undefined
  if (!('value' in descriptor)) throw new MemoryRetrievalError('invalid-query')
  return descriptor.value
}

function result(
  status: MemoryResultV1['status'],
  reason: MemoryResultV1['reason'],
  fields: Partial<Pick<
    MemoryResultV1,
    'records' | 'explanations' | 'tokenEstimate' | 'lifecycleRevisionDigest' | 'degradations'
  >> = {},
): MemoryResultV1 {
  return Object.freeze({
    schema: 'datazup.memory.result/v1' as const,
    status,
    reason,
    records: fields.records ?? Object.freeze([]),
    explanations: fields.explanations ?? Object.freeze([]),
    tokenEstimate: fields.tokenEstimate ?? 0,
    ...(fields.lifecycleRevisionDigest === undefined
      ? {}
      : { lifecycleRevisionDigest: fields.lifecycleRevisionDigest }),
    degradations: Object.freeze([...(fields.degradations ?? [])]),
  })
}
