import { digestMemoryRecordV1 } from '../../records/canonical.js'
import { decodeMemoryRecordV1 } from '../../records/decoder.js'
import { digestSafeJson, snapshotSafeJson } from '../../records/safe-json.js'
import type {
  MemoryKindV1,
  MemoryRecordV1,
  MemoryScopeV1,
  MemoryStatusV1,
} from '../../records/types.js'
import type {
  MemoryCandidateV1,
  MemoryQueryV1,
  MemoryRetrievalProfileV1,
  MemoryRetrieverPort,
} from '../v1-types.js'

export const SCOPE: MemoryScopeV1 = {
  tenantId: 'tenant-001',
  workspaceId: 'workspace-001',
  projectId: 'project-001',
  namespace: 'facts',
}

export const OTHER_SCOPE: MemoryScopeV1 = {
  ...SCOPE,
  tenantId: 'tenant-002',
}

export const QUERY: MemoryQueryV1 = {
  schema: 'datazup.memory.query/v1',
  scope: SCOPE,
  text: 'Find decision ERR_RETRY_42 from 2026-08-10',
  asOf: instant(100),
}

export const PROFILE: MemoryRetrievalProfileV1 = {
  schema: 'datazup.memory.retrieval-profile/v1',
  profileId: 'balanced-provider-free',
  profileVersion: 'v1',
  channels: ['lexical', 'vector'],
  lifecycleMode: 'active',
  queryRewrite: 'disabled',
  rerank: 'disabled',
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
}

export function instant(offsetMinutes: number): string {
  return new Date(Date.UTC(2026, 7, 11, 10, offsetMinutes, 0)).toISOString()
}

export function memoryRecord(options: {
  readonly memoryId?: string
  readonly versionId?: string
  readonly scope?: MemoryScopeV1
  readonly status?: MemoryStatusV1
  readonly kind?: MemoryKindV1
  readonly text?: string
  readonly sourceTrust?: number
  readonly updatedAt?: string
  readonly validFrom?: string
  readonly validTo?: string
  readonly expiresAt?: string
  readonly tags?: readonly string[]
} = {}): MemoryRecordV1 {
  const memoryId = options.memoryId ?? 'memory-001'
  const versionId = options.versionId ?? 'version-001'
  const updatedAt = options.updatedAt ?? instant(1)
  const content = { summary: options.text ?? 'Retry decision ERR_RETRY_42 on 2026-08-10.' }
  return decodeMemoryRecordV1({
    schema: 'datazup.memory.record/v1',
    memoryId,
    versionId,
    kind: options.kind ?? 'decision',
    scope: options.scope ?? SCOPE,
    lifecycle: {
      status: options.status ?? 'active',
      reasonCode: 'review-admitted',
      transitionSequence: 3,
      lastTransitionAt: updatedAt,
    },
    temporal: {
      observedAt: instant(0),
      recordedAt: instant(1),
      updatedAt,
      validFrom: options.validFrom ?? instant(0),
      ...(options.validTo === undefined ? {} : { validTo: options.validTo }),
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
      lastVerifiedAt: updatedAt,
    },
    provenance: {
      sourceKind: 'application',
      sourceId: `source-${memoryId}`,
      sourceDigest: `sha256:${'1'.repeat(64)}`,
      evidenceRefs: [{
        schema: 'datazup.memory.evidence-ref/v1',
        kind: 'application-event',
        owner: 'fixture-app',
        id: `evidence-${memoryId}`,
        digest: `sha256:${'2'.repeat(64)}`,
        observedAt: instant(0),
        sensitivity: 'internal',
      }],
      createdByRef: 'forge://fixture/memory-writer',
    },
    governance: {
      sensitivity: 'internal',
      retentionPolicyId: 'working-memory',
      retentionPolicyVersion: 'v1',
      accessPolicyRef: 'access-001',
      writePolicyRef: 'write-001',
      legalHold: false,
      exportable: false,
      userVisible: true,
    },
    quality: {
      confidence: 0.8,
      sourceTrust: options.sourceTrust ?? 0.9,
      freshnessState: 'current',
      contradictionState: 'none',
      verificationState: 'human-reviewed',
    },
    contentDigest: digestSafeJson(snapshotSafeJson(content)),
    content,
    tags: options.tags ?? ['retrieval-fixture'],
  })
}

export function candidate(
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

export function retriever(
  candidates: readonly MemoryCandidateV1[],
  records: readonly MemoryRecordV1[] = candidates.map(entry => entry.record),
  scope: MemoryScopeV1 = SCOPE,
): MemoryRetrieverPort {
  return {
    retrieveCandidates: async () => ({
      schema: 'datazup.memory.candidate-set/v1',
      scope,
      candidates,
    }),
    resolveLifecycle: async () => ({
      schema: 'datazup.memory.lifecycle-resolution/v1',
      scope,
      revisionDigest: `sha256:${'a'.repeat(64)}`,
      records,
    }),
  }
}
