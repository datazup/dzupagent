import type {
  MemoryEvidenceRefV1,
  MemoryRecordV1,
  MemoryStatusV1,
} from '../records/types.js'

type MemoryTransitionKindV1 =
  | 'capture'
  | 'assess'
  | 'require-review'
  | 'promote'
  | 'confirm'
  | 'reject'
  | 'correct'
  | 'dispute'
  | 'resolve'
  | 'revoke'
  | 'expire'
  | 'archive'
  | 'propose-purge'

interface MemoryReferenceV1 {
  readonly owner: string
  readonly id: string
  readonly digest: `sha256:${string}`
}

interface MemoryCommandBaseV1 {
  readonly schema: 'datazup.memory.command/v1'
  readonly type: MemoryTransitionKindV1
  readonly commandId: string
  readonly eventId: string
  readonly receiptId: string
  readonly idempotencyKey: string
  readonly memoryId: string
  readonly generation: number
  readonly expectedSequence: number
  readonly transitionAt: string
  readonly actorRef: string
  readonly decisionRef: string
  readonly reasonCode: string
  readonly evidenceRefs: readonly MemoryEvidenceRefV1[]
}

interface MemoryCaptureCommandV1 extends MemoryCommandBaseV1 {
  readonly type: 'capture'
  readonly record: MemoryRecordV1
}

interface MemoryExistingRecordCommandV1 extends MemoryCommandBaseV1 {
  readonly record: MemoryRecordV1
  readonly expectedVersionId: string
  readonly expectedRecordDigest: `sha256:${string}`
}

interface MemorySimpleTransitionCommandV1 extends MemoryExistingRecordCommandV1 {
  readonly type:
    | 'assess'
    | 'require-review'
    | 'promote'
    | 'confirm'
    | 'reject'
    | 'dispute'
    | 'revoke'
    | 'expire'
}

interface MemoryCorrectCommandV1 extends MemoryExistingRecordCommandV1 {
  readonly type: 'correct'
  readonly replacement: MemoryRecordV1
}

interface MemoryResolveCommandV1 extends MemoryExistingRecordCommandV1 {
  readonly type: 'resolve'
  readonly resolutionStatus: 'active' | 'superseded' | 'revoked'
  readonly supersededByVersionId?: string
  readonly supersedingRecordDigest?: `sha256:${string}`
}

interface MemoryArchiveCommandV1 extends MemoryExistingRecordCommandV1 {
  readonly type: 'archive'
  readonly archiveReceiptRef: MemoryReferenceV1
}

interface MemoryPurgeProposalCommandV1 extends MemoryExistingRecordCommandV1 {
  readonly type: 'propose-purge'
  readonly purgeTargetRefs: readonly MemoryReferenceV1[]
}

/** Caller-supplied, provider-neutral lifecycle command. */
export type MemoryCommandV1 =
  | MemoryCaptureCommandV1
  | MemorySimpleTransitionCommandV1
  | MemoryCorrectCommandV1
  | MemoryResolveCommandV1
  | MemoryArchiveCommandV1
  | MemoryPurgeProposalCommandV1

interface MemoryRecordEffectV1 {
  readonly versionId: string
  readonly priorDigest?: `sha256:${string}`
  readonly resultDigest: `sha256:${string}`
  readonly statusFrom?: MemoryStatusV1
  readonly statusTo: MemoryStatusV1
  readonly supersedesVersionId?: string
  readonly supersededByVersionId?: string
  readonly supersedingRecordDigest?: `sha256:${string}`
}

type MemoryTransitionEffectV1 =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'archive-recorded'
      readonly receiptRef: MemoryReferenceV1
    }
  | {
      readonly kind: 'purge-proposed'
      readonly targetRefs: readonly MemoryReferenceV1[]
      readonly tombstone: {
        readonly schema: 'datazup.memory.purge-proposal-tombstone/v1'
        readonly memoryId: string
        readonly versionId: string
        readonly recordDigest: `sha256:${string}`
        readonly proposalEventId: string
        readonly idempotencyKey: string
      }
    }

/** Immutable, content-free lifecycle event. */
export interface MemoryEventV1 {
  readonly schema: 'datazup.memory.event/v1'
  readonly eventId: string
  readonly commandId: string
  readonly idempotencyKey: string
  readonly commandDigest: `sha256:${string}`
  readonly memoryId: string
  readonly generation: number
  readonly sequence: number
  readonly type: MemoryTransitionKindV1
  readonly occurredAt: string
  readonly actorRef: string
  readonly decisionRef: string
  readonly reasonCode: string
  readonly evidenceRefs: readonly MemoryEvidenceRefV1[]
  readonly currentVersionId: string
  readonly currentRecordDigest: `sha256:${string}`
  readonly currentStatus: MemoryStatusV1
  readonly recordEffects: readonly MemoryRecordEffectV1[]
  readonly effect: MemoryTransitionEffectV1
}

/** Digest-bound receipt used for deterministic command replay. */
export interface MemoryTransitionReceiptV1 {
  readonly schema: 'datazup.memory.transition-receipt/v1'
  readonly receiptId: string
  readonly eventId: string
  readonly commandId: string
  readonly idempotencyKey: string
  readonly commandDigest: `sha256:${string}`
  readonly memoryId: string
  readonly generation: number
  readonly sequence: number
  readonly occurredAt: string
  readonly previousStateDigest?: `sha256:${string}`
  readonly eventDigest: `sha256:${string}`
  readonly resultStateDigest: `sha256:${string}`
  readonly recordEffects: readonly MemoryRecordEffectV1[]
  readonly effectStatus: 'none' | 'recorded' | 'proposed'
}

/** Bounded reducer state for the last transitioned version. It contains no semantic content or authority. */
export interface MemoryLifecycleStateV1 {
  readonly schema: 'datazup.memory.lifecycle-state/v1'
  readonly memoryId: string
  readonly generation: number
  readonly sequence: number
  readonly versionId: string
  readonly recordDigest: `sha256:${string}`
  readonly status: MemoryStatusV1
  readonly lastTransitionAt: string
  readonly retrievalEligible: boolean
  readonly events: readonly MemoryEventV1[]
  readonly receipts: readonly MemoryTransitionReceiptV1[]
}

/** Branch-preserving projection derived only from admitted lifecycle events. */
export interface MemoryVersionChainV1 {
  readonly schema: 'datazup.memory.version-chain/v1'
  readonly memoryId: string
  readonly generation: number
  readonly lastSequence: number
  readonly versions: readonly {
    readonly versionId: string
    readonly recordDigests: readonly `sha256:${string}`[]
    readonly status: MemoryStatusV1
    readonly introducedAt: string
    readonly lastTransitionAt: string
    readonly predecessorVersionId?: string
    readonly successorVersionIds: readonly string[]
    readonly retrievalEligible: boolean
    readonly archiveRecorded: boolean
    readonly purgeProposed: boolean
  }[]
  readonly activeVersionIds: readonly string[]
  readonly conflicts: readonly {
    readonly baseVersionId: string
    readonly headVersionIds: readonly string[]
    readonly resolved: boolean
  }[]
  readonly purgeProposals: readonly {
    readonly eventId: string
    readonly versionId: string
    readonly proposedAt: string
    readonly targetRefs: readonly MemoryReferenceV1[]
    readonly tombstone: {
      readonly schema: 'datazup.memory.purge-proposal-tombstone/v1'
      readonly memoryId: string
      readonly versionId: string
      readonly recordDigest: `sha256:${string}`
      readonly proposalEventId: string
      readonly idempotencyKey: string
    }
  }[]
}

export interface InternalMemoryReducerResultV1 {
  readonly state: MemoryLifecycleStateV1
  readonly receipt: MemoryTransitionReceiptV1
  readonly event?: MemoryEventV1
  readonly records: readonly MemoryRecordV1[]
  readonly replayed: boolean
}
