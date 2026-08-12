import type { ObservationConfirmationReceipt } from '../observation-candidate-store.js'
import type { StagedRecord } from '../staged-writer.js'
import type {
  MemoryCommandV1,
  MemoryEventV1,
  MemoryTransitionReceiptV1,
  MemoryVersionChainV1,
} from '../lifecycle/types.js'
import type {
  MemoryRecordV1,
  MemoryScopeV1,
  MemoryStatusV1,
} from '../records/types.js'

type MemoryServiceReasonV1 =
  | 'none'
  | 'not-found'
  | 'cas-conflict'
  | 'checkpoint-required'
  | 'checkpoint-conflict'
  | 'unsupported-capability'
  | 'capacity-exceeded'
  | 'store-unavailable'
  | 'ambiguous-outcome'
  | 'invalid-store-snapshot'
  | 'compatibility-mismatch'
  | 'invalidation-incomplete'

interface MemoryAdapterLimitsV1 {
  readonly records: number
  readonly events: number
  readonly receipts: number
  readonly checkpoints: number
  readonly tombstones: number
}

/** Exact, fail-closed capability truth for a lifecycle store adapter. */
export interface MemoryAdapterCapabilitiesV1 {
  readonly schema: 'datazup.memory.adapter-capabilities/v1'
  readonly atomicCompareAndSwap: boolean
  readonly transactions: boolean
  readonly checkpoints: boolean
  readonly delete: boolean
  readonly purge: boolean
  readonly indexInvalidation: boolean
  readonly durableIdempotency: boolean
  readonly authenticatedCustody: boolean
  readonly limits: MemoryAdapterLimitsV1
}

interface MemoryInvalidationTargetV1 {
  readonly kind: 'cache' | 'index'
  readonly owner: string
  readonly id: string
  readonly digest: `sha256:${string}`
}

interface MemoryInvalidationOutcomeV1 {
  readonly target: MemoryInvalidationTargetV1
  readonly status: 'completed' | 'unsupported' | 'retryable'
  readonly receiptRef?: {
    readonly owner: string
    readonly id: string
    readonly digest: `sha256:${string}`
  }
}

interface MemoryInvalidationResultV1 {
  readonly schema: 'datazup.memory.invalidation-result/v1'
  readonly status: 'completed' | 'partial' | 'unsupported' | 'retryable'
  readonly outcomes: readonly MemoryInvalidationOutcomeV1[]
}

/** Host-injected cache/index invalidation effect boundary. */
export interface MemoryInvalidationPort {
  invalidate(input: {
    readonly schema: 'datazup.memory.invalidation-request/v1'
    readonly scope: MemoryScopeV1
    readonly memoryId: string
    readonly versionId: string
    readonly recordDigest: `sha256:${string}`
    readonly idempotencyKey: string
    readonly targets: readonly MemoryInvalidationTargetV1[]
  }): Promise<MemoryInvalidationResultV1>
}

interface MemoryStoreLoadInputV1 {
  readonly schema: 'datazup.memory.store-load/v1'
  readonly scope: MemoryScopeV1
  readonly memoryId: string
}

interface MemoryStoreAppendInputV1 {
  readonly schema: 'datazup.memory.store-append/v1'
  readonly scope: MemoryScopeV1
  readonly memoryId: string
  readonly command: MemoryCommandV1
  readonly expectedRevision: number
  readonly expectedSnapshotDigest?: `sha256:${string}`
}

interface MemoryStoreCheckpointInputV1 {
  readonly schema: 'datazup.memory.store-checkpoint/v1'
  readonly scope: MemoryScopeV1
  readonly memoryId: string
  readonly checkpointId: string
  readonly checkpointedAt: string
  readonly expectedRevision: number
  readonly expectedSnapshotDigest: `sha256:${string}`
  readonly fromGeneration: number
  readonly fromSequence: number
  readonly toGeneration: number
}

/** Atomic lifecycle persistence boundary. Runtime outcomes remain hostile input. */
export interface MemoryLifecycleStorePort {
  readonly capabilities: MemoryAdapterCapabilitiesV1
  load(input: MemoryStoreLoadInputV1): Promise<unknown>
  append(input: MemoryStoreAppendInputV1): Promise<unknown>
  checkpoint(input: MemoryStoreCheckpointInputV1): Promise<unknown>
}

export interface InternalMemoryCheckpointV1 {
  readonly schema: 'datazup.memory.store-checkpoint-record/v1'
  readonly checkpointId: string
  readonly checkpointedAt: string
  readonly memoryId: string
  readonly fromGeneration: number
  readonly fromSequence: number
  readonly toGeneration: number
  readonly priorSnapshotDigest: `sha256:${string}`
  readonly stateDigest: `sha256:${string}`
  readonly chainDigest: `sha256:${string}`
  readonly lastEventDigest: `sha256:${string}`
  readonly lastReceiptDigest: `sha256:${string}`
}

interface MemoryServiceHeadV1 {
  readonly versionId: string
  readonly recordDigest: `sha256:${string}`
  readonly status: MemoryStatusV1
  readonly lastTransitionAt: string
  readonly retrievalEligible: boolean
}

export interface InternalMemoryServiceSnapshotV1 {
  readonly schema: 'datazup.memory.store-snapshot/v1'
  readonly scope: MemoryScopeV1
  readonly memoryId: string
  readonly generation: number
  readonly sequence: number
  readonly revision: number
  readonly head: MemoryServiceHeadV1
  readonly records: readonly MemoryRecordV1[]
  readonly events: readonly MemoryEventV1[]
  readonly receipts: readonly MemoryTransitionReceiptV1[]
  readonly checkpoints: readonly InternalMemoryCheckpointV1[]
  readonly tombstones: readonly Extract<MemoryEventV1['effect'], {
    readonly kind: 'purge-proposed'
  }>['tombstone'][]
  readonly snapshotDigest: `sha256:${string}`
}

export interface InternalMemoryStoreOutcomeV1 {
  readonly schema: 'datazup.memory.store-outcome/v1'
  readonly status:
    | 'committed'
    | 'replayed'
    | 'conflict'
    | 'unsupported'
    | 'ambiguous'
    | 'rejected'
  readonly reason: MemoryServiceReasonV1
  readonly snapshot?: InternalMemoryServiceSnapshotV1
  readonly receipt?: MemoryTransitionReceiptV1
  readonly event?: MemoryEventV1
  readonly records?: readonly MemoryRecordV1[]
  readonly checkpoint?: InternalMemoryCheckpointV1
}

interface MemoryCheckpointInstructionV1 {
  readonly checkpointId: string
  readonly checkpointedAt: string
}

interface MemoryCompatibilityInputV1 {
  readonly stagedRecord: StagedRecord
  readonly confirmationReceipt?: ObservationConfirmationReceipt
}

export interface InternalMemoryLifecycleWriteInputV1 {
  readonly scope: MemoryScopeV1
  readonly command: MemoryCommandV1
  readonly checkpoint?: MemoryCheckpointInstructionV1
  readonly compatibility?: MemoryCompatibilityInputV1
  readonly invalidationTargets?: readonly MemoryInvalidationTargetV1[]
}

export interface InternalMemoryLifecycleWriteResultV1 {
  readonly schema: 'datazup.memory.service-write-result/v1'
  readonly status:
    | 'committed'
    | 'replayed'
    | 'partial'
    | 'conflict'
    | 'unsupported'
    | 'retryable'
    | 'rejected'
  readonly reason: MemoryServiceReasonV1
  readonly receipt?: MemoryTransitionReceiptV1
  readonly event?: MemoryEventV1
  readonly records: readonly MemoryRecordV1[]
  readonly checkpoint?: InternalMemoryCheckpointV1
  readonly invalidation?: MemoryInvalidationResultV1
}

export interface InternalMemoryLifecycleQueryInputV1 {
  readonly scope: MemoryScopeV1
  readonly memoryId: string
  readonly includeHistory?: boolean
  readonly includeDisputed?: boolean
}

export interface InternalMemoryLifecycleQueryResultV1 {
  readonly schema: 'datazup.memory.service-query-result/v1'
  readonly status: 'completed' | 'not-found' | 'retryable' | 'rejected'
  readonly reason: MemoryServiceReasonV1
  readonly records: readonly MemoryRecordV1[]
  readonly chain?: MemoryVersionChainV1
  readonly generation?: number
  readonly sequence?: number
  readonly checkpointCount: number
}

export interface InternalMemoryLifecycleExplanationV1 {
  readonly schema: 'datazup.memory.service-explanation/v1'
  readonly status: 'completed' | 'not-found' | 'retryable' | 'rejected'
  readonly reason: MemoryServiceReasonV1
  readonly memoryId: string
  readonly scopeDigest: `sha256:${string}`
  readonly generation?: number
  readonly sequence?: number
  readonly head?: MemoryServiceHeadV1
  readonly chain?: MemoryVersionChainV1
  readonly transitions: readonly {
    readonly eventId: string
    readonly type: MemoryEventV1['type']
    readonly occurredAt: string
    readonly reasonCode: string
    readonly evidenceRefs: MemoryEventV1['evidenceRefs']
    readonly currentVersionId: string
    readonly currentStatus: MemoryStatusV1
  }[]
  readonly checkpoints: readonly {
    readonly checkpointId: string
    readonly checkpointedAt: string
    readonly fromGeneration: number
    readonly toGeneration: number
    readonly digest: `sha256:${string}`
  }[]
  readonly capabilities: MemoryAdapterCapabilitiesV1
}
