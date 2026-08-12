/** Provider-neutral, versioned semantic-memory record contracts. */

export type MemoryKindV1 =
  | 'fact'
  | 'preference'
  | 'decision'
  | 'episode'
  | 'lesson'
  | 'procedure'
  | 'summary'
  | 'document-ref'

export type MemoryStatusV1 =
  | 'captured'
  | 'candidate'
  | 'review-required'
  | 'active'
  | 'disputed'
  | 'superseded'
  | 'revoked'
  | 'expired'
  | 'archived'
  | 'purged'
  | 'rejected'

export type MemorySensitivityClassV1 =
  | 'public'
  | 'internal'
  | 'confidential'
  | 'restricted'

export type MemoryContradictionStateV1 =
  | 'none'
  | 'possible'
  | 'confirmed'
  | 'resolved'

export type MemoryVerificationStateV1 =
  | 'unverified'
  | 'machine-checked'
  | 'human-reviewed'

export interface MemoryScopeV1 {
  readonly tenantId: string
  readonly workspaceId?: string
  readonly projectId?: string
  readonly repositoryId?: string
  readonly taskId?: string
  readonly threadId?: string
  readonly userId?: string
  readonly agentId?: string
  readonly personaId?: string
  readonly namespace: string
}

export interface MemoryLifecycleV1 {
  readonly status: MemoryStatusV1
  readonly priorVersionId?: string
  readonly supersedesVersionId?: string
  readonly supersededByVersionId?: string
  readonly revokesVersionId?: string
  readonly reasonCode: string
  readonly transitionSequence: number
  readonly lastTransitionAt: string
}

/**
 * All times are caller-supplied canonical ISO-8601 instants. `recordedAt` and
 * `updatedAt` describe custody, while `observedAt` and validity describe truth.
 */
export interface MemoryTemporalV1 {
  readonly observedAt: string
  readonly recordedAt: string
  readonly updatedAt: string
  readonly validFrom?: string
  readonly validTo?: string
  readonly lastVerifiedAt?: string
  readonly expiresAt?: string
  readonly sourceEventTime?: string
}

export interface MemoryEvidenceRefV1 {
  readonly schema: 'datazup.memory.evidence-ref/v1'
  readonly kind:
    | 'application-event'
    | 'document'
    | 'run-evidence'
    | 'tool-result'
    | 'transition-receipt'
  readonly owner: string
  readonly id: string
  readonly digest: `sha256:${string}`
  readonly observedAt: string
  readonly sensitivity: MemorySensitivityClassV1
}

export interface MemoryContentRefV1 {
  readonly schema: 'datazup.memory.content-ref/v1'
  readonly owner: string
  readonly id: string
  readonly digest: `sha256:${string}`
  readonly mediaType: string
  readonly byteLength: number
}

export interface MemoryProvenanceV1 {
  readonly sourceKind:
    | 'explicit-user'
    | 'application'
    | 'model-observation'
    | 'tool-observation'
    | 'document'
    | 'run-evidence'
    | 'import'
  readonly sourceId: string
  readonly sourceDigest: `sha256:${string}`
  readonly evidenceRefs: readonly MemoryEvidenceRefV1[]
  readonly createdByRef: string
  readonly reviewedByRef?: string
  readonly extractionProfileId?: string
  readonly extractionProfileVersion?: string
}

/** Reference to host-owned retention policy; it intentionally has no duration. */
export interface MemoryRetentionProfileRefV1 {
  readonly retentionPolicyId: string
  readonly retentionPolicyVersion: string
}

export interface MemoryGovernanceV1 extends MemoryRetentionProfileRefV1 {
  readonly sensitivity: MemorySensitivityClassV1
  readonly consentRef?: string
  readonly accessPolicyRef: string
  readonly writePolicyRef: string
  readonly legalHold: boolean
  readonly exportable: boolean
  readonly userVisible: boolean
}

export interface MemoryQualityV1 {
  readonly confidence: number
  readonly sourceTrust: number
  readonly extractionQuality?: number
  readonly freshnessState: 'unknown' | 'current' | 'stale'
  readonly contradictionState: MemoryContradictionStateV1
  readonly verificationState: MemoryVerificationStateV1
}

export interface MemoryRecordV1 {
  readonly schema: 'datazup.memory.record/v1'
  readonly memoryId: string
  readonly versionId: string
  readonly kind: MemoryKindV1
  readonly scope: MemoryScopeV1
  readonly lifecycle: MemoryLifecycleV1
  readonly temporal: MemoryTemporalV1
  readonly provenance: MemoryProvenanceV1
  readonly governance: MemoryGovernanceV1
  readonly quality: MemoryQualityV1
  readonly contentDigest: `sha256:${string}`
  readonly content?: Readonly<Record<string, unknown>>
  readonly contentRef?: MemoryContentRefV1
  readonly searchTextRef?: MemoryContentRefV1
  readonly tags: readonly string[]
}
