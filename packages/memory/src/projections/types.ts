import type {
  MemoryEventV1,
  MemoryTransitionReceiptV1,
  MemoryVersionChainV1,
} from '../lifecycle/types.js'
import type { SafeJson } from '../records/safe-json.js'
import type {
  MemoryContentRefV1,
  MemoryGovernanceV1,
  MemoryProvenanceV1,
  MemoryQualityV1,
  MemoryRecordV1,
  MemoryScopeV1,
  MemorySensitivityClassV1,
  MemoryStatusV1,
  MemoryTemporalV1,
} from '../records/types.js'

type Sha256 = `sha256:${string}`

interface MemoryProjectionRedactionPolicyRefV1 {
  readonly id: string
  readonly version: string
  readonly digest: Sha256
}

interface MemoryProjectionExpectedSourceV1 {
  readonly recordSetDigest: Sha256
  readonly historyDigest: Sha256
  readonly generation: number
  readonly sequence: number
}

/** Caller-declared deterministic bounds and content projection policy. */
export interface MemoryProjectionProfileV1 {
  readonly schema: 'datazup.memory.projection-profile/v1'
  readonly formatVersion: '1.0'
  readonly contentMode: 'reference-only' | 'exportable-inline'
  readonly inlineSensitivities: readonly Exclude<MemorySensitivityClassV1, 'restricted'>[]
  readonly maxRecords: number
  readonly maxEvents: number
  readonly maxReceipts: number
  readonly maxInlineContentBytes: number
  readonly maxOutputBytes: number
}

/** Exact canonical inputs for one scope-bound memory history projection. */
export interface MemoryProjectionRequestV1 {
  readonly schema: 'datazup.memory.projection-request/v1'
  readonly scope: MemoryScopeV1
  readonly records: readonly MemoryRecordV1[]
  readonly events: readonly MemoryEventV1[]
  readonly receipts: readonly MemoryTransitionReceiptV1[]
  readonly expectedSource: MemoryProjectionExpectedSourceV1
  readonly redactionPolicyRef: MemoryProjectionRedactionPolicyRefV1
  readonly generatedAt: string
  readonly profile: MemoryProjectionProfileV1
}

interface MemoryProjectedContentV1 {
  readonly mode: 'inline' | 'reference-only'
  readonly reason:
    | 'profile-reference-only'
    | 'not-exportable'
    | 'restricted'
    | 'sensitivity-excluded'
    | 'oversized'
    | 'content-reference'
    | 'inline'
  readonly digest: Sha256
  readonly byteLength: number
  readonly value?: SafeJson
  readonly contentRef?: MemoryContentRefV1
  readonly searchTextRef?: MemoryContentRefV1
}

interface MemoryProjectedRecordV1 {
  readonly memoryId: string
  readonly versionId: string
  readonly kind: MemoryRecordV1['kind']
  readonly status: MemoryStatusV1
  readonly recordDigest: Sha256
  readonly lifecycle: MemoryRecordV1['lifecycle']
  readonly temporal: MemoryTemporalV1
  readonly provenance: MemoryProvenanceV1
  readonly governance: MemoryGovernanceV1
  readonly quality: MemoryQualityV1
  readonly tags: readonly string[]
  readonly content: MemoryProjectedContentV1
}

interface MemoryProjectionSourceV1 extends MemoryProjectionExpectedSourceV1 {
  readonly sourceDigest: Sha256
}

interface MemoryProjectionSummaryV1 {
  readonly memoryId: string
  readonly recordCount: number
  readonly eventCount: number
  readonly receiptCount: number
  readonly statuses: Readonly<Record<MemoryStatusV1, number>>
  readonly activeVersionIds: readonly string[]
  readonly purgeState:
    | 'not-proposed'
    | 'proposed-incomplete'
    | 'record-claims-purged-unverified'
}

/** Non-authoritative, deterministic semantic projection of canonical history. */
export interface MemoryProjectionV1 {
  readonly schema: 'datazup.memory.projection/v1'
  readonly formatVersion: '1.0'
  readonly authority: 'none'
  readonly generatedAt: string
  readonly scope: MemoryScopeV1
  readonly scopeDigest: Sha256
  readonly profileDigest: Sha256
  readonly redactionPolicyRef: MemoryProjectionRedactionPolicyRefV1
  readonly source: MemoryProjectionSourceV1
  readonly projectionDigest: Sha256
  readonly summary: MemoryProjectionSummaryV1
  readonly records: readonly MemoryProjectedRecordV1[]
  readonly chain: MemoryVersionChainV1
  readonly events: readonly MemoryEventV1[]
  readonly receipts: readonly MemoryTransitionReceiptV1[]
}

type MemoryProjectionDiffKindV1 =
  | 'added'
  | 'removed'
  | 'changed'
  | 'superseded'
  | 'lifecycle-only'
  | 'governance'
  | 'provenance'
  | 'receipt'

interface MemoryProjectionDiffEntryV1 {
  readonly kind: MemoryProjectionDiffKindV1
  readonly memoryId: string
  readonly identity: string
  readonly baseDigest?: Sha256
  readonly targetDigest?: Sha256
  readonly fields: readonly string[]
}

/** Structured, content-free semantic delta between two exact projections. */
export interface MemoryProjectionDiffV1 {
  readonly schema: 'datazup.memory.projection-diff/v1'
  readonly formatVersion: '1.0'
  readonly authority: 'none'
  readonly scopeDigest: Sha256
  readonly profileDigest: Sha256
  readonly baseProjectionDigest: Sha256
  readonly targetProjectionDigest: Sha256
  readonly baseSourceDigest: Sha256
  readonly targetSourceDigest: Sha256
  readonly empty: boolean
  readonly changes: readonly MemoryProjectionDiffEntryV1[]
  readonly diffDigest: Sha256
}

export type {
  MemoryProjectedRecordV1,
  MemoryProjectionDiffEntryV1,
  MemoryProjectionExpectedSourceV1,
  MemoryProjectionRedactionPolicyRefV1,
  MemoryProjectionSourceV1,
}
