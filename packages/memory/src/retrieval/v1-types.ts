import type {
  MemoryEvidenceRefV1,
  MemoryKindV1,
  MemoryRecordV1,
  MemoryScopeV1,
  MemoryStatusV1,
} from '../records/types.js'

type MemoryRetrievalChannelV1 = 'lexical' | 'vector' | 'graph'
type MemoryLifecycleQueryModeV1 = 'active' | 'active-and-disputed' | 'history'
type MemoryProviderStageModeV1 = 'disabled' | 'optional' | 'required'

/** Strict provider-neutral query for lifecycle-aware semantic memory. */
export interface MemoryQueryV1 {
  readonly schema: 'datazup.memory.query/v1'
  readonly scope: MemoryScopeV1
  readonly text: string
  readonly asOf: string
}

/** One source candidate. Store truth is re-resolved before selection. */
export interface MemoryCandidateV1 {
  readonly schema: 'datazup.memory.candidate/v1'
  readonly channel: MemoryRetrievalChannelV1
  readonly rank: number
  readonly score: number
  readonly recordDigest: `sha256:${string}`
  readonly record: MemoryRecordV1
  readonly relationshipRef?: string
}

/** Content-free explanation for one selected canonical record version. */
export interface MemorySelectionExplanationV1 {
  readonly schema: 'datazup.memory.selection-explanation/v1'
  readonly memoryId: string
  readonly versionId: string
  readonly recordDigest: `sha256:${string}`
  readonly lifecycleStatus: MemoryStatusV1
  readonly kind: MemoryKindV1
  readonly channels: readonly {
    readonly channel: MemoryRetrievalChannelV1
    readonly rank: number
    readonly score: number
  }[]
  readonly exactLexicalMatch: boolean
  readonly sourceTrust: number
  readonly freshnessScore: number
  readonly selectionScore: number
  readonly tokenEstimate: number
  readonly reranked: boolean
  readonly evidenceRefs: readonly MemoryEvidenceRefV1[]
}

type MemoryRetrievalReasonV1 =
  | 'none'
  | 'no-eligible-candidates'
  | 'invalid-query'
  | 'invalid-profile'
  | 'invalid-candidate-set'
  | 'invalid-lifecycle-resolution'
  | 'retriever-unavailable'
  | 'query-rewriter-unavailable'
  | 'reranker-unavailable'
  | 'provider-degraded'

type MemoryRetrievalDegradationV1 =
  | 'query-rewriter-unavailable'
  | 'reranker-unavailable'

/** Retrieval output with canonical records and content-free selection facts. */
export interface MemoryResultV1 {
  readonly schema: 'datazup.memory.result/v1'
  readonly status: 'completed' | 'abstained' | 'degraded' | 'retryable' | 'rejected'
  readonly reason: MemoryRetrievalReasonV1
  readonly records: readonly MemoryRecordV1[]
  readonly explanations: readonly MemorySelectionExplanationV1[]
  readonly tokenEstimate: number
  readonly lifecycleRevisionDigest?: `sha256:${string}`
  readonly degradations: readonly MemoryRetrievalDegradationV1[]
}

/** Deterministic selection, lifecycle, provider-stage, and budget policy. */
export interface MemoryRetrievalProfileV1 {
  readonly schema: 'datazup.memory.retrieval-profile/v1'
  readonly profileId: string
  readonly profileVersion: string
  readonly channels: readonly MemoryRetrievalChannelV1[]
  readonly lifecycleMode: MemoryLifecycleQueryModeV1
  readonly queryRewrite: MemoryProviderStageModeV1
  readonly rerank: MemoryProviderStageModeV1
  /** Bounded deadline shared by rewrite, retrieval, resolution, and rerank stages. */
  readonly stageDeadlineMs?: number
  /** Explicit disclosure contract for externally routed rewrite/rerank stages. */
  readonly externalProviderPolicy?: {
    readonly routeRef: string
    readonly retainsInput: false
    readonly allowQueryText: boolean
    readonly allowedInlineSensitivities: readonly MemoryRecordV1['governance']['sensitivity'][]
  }
  readonly candidateLimit: number
  readonly resultLimit: number
  readonly tokenBudget: number
  readonly maxRecordTokens: number
  readonly maxPerKind: number
  readonly rrfK: number
  readonly minimumScore: number
  readonly minimumSourceTrust: number
  readonly freshnessHalfLifeDays: number
  readonly weights: {
    readonly fusion: number
    readonly sourceTrust: number
    readonly freshness: number
  }
}

/** Optional host/provider query-rewrite boundary. */
export interface MemoryQueryRewriterPort {
  rewrite(input: {
    readonly schema: 'datazup.memory.query-rewrite-request/v1'
    readonly queryDigest: `sha256:${string}`
    readonly scopeDigest: `sha256:${string}`
    readonly text: string
    readonly deadlineMs: number
    readonly signal: AbortSignal
    readonly routeRef?: string
  }): Promise<unknown>
}

/** Optional host/provider reranking boundary. */
export interface MemoryRerankerPort {
  rerank(input: {
    readonly schema: 'datazup.memory.rerank-request/v1'
    readonly queryDigest: `sha256:${string}`
    readonly scopeDigest: `sha256:${string}`
    readonly text: string
    readonly candidates: readonly MemoryCandidateV1[]
    readonly deadlineMs: number
    readonly signal: AbortSignal
    readonly routeRef?: string
  }): Promise<unknown>
}

/** Candidate acquisition plus current lifecycle/store-truth resolution. */
export interface MemoryRetrieverPort {
  retrieveCandidates(input: {
    readonly schema: 'datazup.memory.candidate-request/v1'
    readonly query: MemoryQueryV1
    readonly effectiveText: string
    readonly channels: readonly MemoryRetrievalChannelV1[]
    readonly limit: number
    readonly deadlineMs: number
    readonly signal: AbortSignal
  }): Promise<unknown>
  resolveLifecycle(input: {
    readonly schema: 'datazup.memory.lifecycle-resolution-request/v1'
    readonly scope: MemoryScopeV1
    readonly memoryIds: readonly string[]
    readonly asOf: string
    readonly lifecycleMode: MemoryLifecycleQueryModeV1
    readonly deadlineMs: number
    readonly signal: AbortSignal
  }): Promise<unknown>
}

export interface InternalRetrieveMemoryInputV1 {
  readonly query: MemoryQueryV1
  readonly profile: MemoryRetrievalProfileV1
  readonly retriever: MemoryRetrieverPort
  readonly queryRewriter?: MemoryQueryRewriterPort
  readonly reranker?: MemoryRerankerPort
}

export interface InternalCandidateSetV1 {
  readonly schema: 'datazup.memory.candidate-set/v1'
  readonly scope: MemoryScopeV1
  readonly candidates: readonly MemoryCandidateV1[]
}

export interface InternalLifecycleResolutionV1 {
  readonly schema: 'datazup.memory.lifecycle-resolution/v1'
  readonly scope: MemoryScopeV1
  readonly revisionDigest: `sha256:${string}`
  readonly records: readonly MemoryRecordV1[]
}

export interface InternalRankedCandidateV1 {
  readonly record: MemoryRecordV1
  readonly recordDigest: `sha256:${string}`
  readonly channels: readonly MemorySelectionExplanationV1['channels'][number][]
  readonly exactLexicalMatch: boolean
  readonly sourceTrust: number
  readonly freshnessScore: number
  readonly selectionScore: number
  readonly tokenEstimate: number
  readonly evidenceRefs: readonly MemoryEvidenceRefV1[]
  readonly reranked: boolean
}
