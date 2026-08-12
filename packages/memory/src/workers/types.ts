import type { MemoryScopeV1 } from '../records/types.js'

export interface InternalMemoryWorkerRefV1 {
  readonly owner: string
  readonly id: string
  readonly digest: `sha256:${string}`
}

export interface InternalMemoryWorkerSourceRefV1 extends InternalMemoryWorkerRefV1 {
  readonly versionId?: string
}

/** Reference-only extraction or consolidation work. It never contains memory text. */
export interface MemoryConsolidationJobV1 {
  readonly schema: 'datazup.memory.consolidation-job/v1'
  readonly jobId: string
  readonly operation: 'extract' | 'consolidate'
  readonly scope: MemoryScopeV1
  readonly sourceRevision: number
  readonly sourceRefs: readonly InternalMemoryWorkerSourceRefV1[]
  readonly requestedAt: string
  readonly profileRef: InternalMemoryWorkerRefV1
  readonly providerMode: 'none' | 'simulated-local' | 'external'
  readonly costCeilingMicrousd: number
  readonly maxCandidateRefs: number
  readonly outputDisposition: 'candidate-review-required'
}

/** Finite deterministic retry policy. No jitter or hidden clock is permitted. */
export interface MemoryRetryPolicyV1 {
  readonly schema: 'datazup.memory.retry-policy/v1'
  readonly maxAttempts: number
  readonly backoffMs: readonly number[]
  readonly retryableReasonCodes: readonly string[]
}

/** Source- and policy-bound envelope retained by a memory outbox. */
export interface MemoryOutboxEnvelopeV1 {
  readonly schema: 'datazup.memory.outbox-envelope/v1'
  readonly envelopeId: string
  readonly idempotencyKey: string
  readonly job: MemoryConsolidationJobV1
  readonly jobDigest: `sha256:${string}`
  readonly retryPolicy: MemoryRetryPolicyV1
  readonly schedulerRef: InternalMemoryWorkerRefV1
  readonly policyRef: InternalMemoryWorkerRefV1
  readonly budgetRef: InternalMemoryWorkerRefV1
  readonly providerRouteRef?: InternalMemoryWorkerRefV1
  readonly createdAt: string
  readonly notBefore: string
  readonly deadlineAt: string
  readonly envelopeDigest: `sha256:${string}`
}

/** Generation-fenced ownership of one outbox envelope. */
export interface MemoryWorkerLeaseV1 {
  readonly schema: 'datazup.memory.worker-lease/v1'
  readonly envelopeId: string
  readonly envelopeDigest: `sha256:${string}`
  readonly workerId: string
  readonly generation: number
  readonly attempt: number
  readonly acquiredAt: string
  readonly expiresAt: string
  readonly leaseDigest: `sha256:${string}`
}

/** Content-free retained failure record. */
export interface MemoryDeadLetterV1 {
  readonly schema: 'datazup.memory.dead-letter/v1'
  readonly deadLetterId: string
  readonly envelopeId: string
  readonly envelopeDigest: `sha256:${string}`
  readonly jobId: string
  readonly jobDigest: `sha256:${string}`
  readonly scopeDigest: `sha256:${string}`
  readonly attempt: number
  readonly generation: number
  readonly reasonCode: string
  readonly deadLetteredAt: string
  readonly priorOutcomeDigest?: `sha256:${string}`
  readonly deadLetterDigest: `sha256:${string}`
}

/** Digest-bound checkpoint over the reference adapter's complete retained state. */
export interface MemoryWorkerCheckpointV1 {
  readonly schema: 'datazup.memory.worker-checkpoint/v1'
  readonly checkpointId: string
  readonly checkpointedAt: string
  readonly revision: number
  readonly sequence: number
  readonly priorStateDigest: `sha256:${string}`
  readonly priorCheckpointDigest?: `sha256:${string}`
  readonly counts: {
    readonly pending: number
    readonly leased: number
    readonly executing: number
    readonly reconciling: number
    readonly ambiguous: number
    readonly completed: number
    readonly deadLettered: number
  }
  readonly checkpointDigest: `sha256:${string}`
}

export type InternalMemoryWorkerOutcomeStatusV1 =
  | 'enqueued'
  | 'replayed'
  | 'claimed'
  | 'renewed'
  | 'completed'
  | 'partial'
  | 'retry-scheduled'
  | 'ambiguous'
  | 'reconciled'
  | 'dead-lettered'
  | 'checkpointed'
  | 'rejected'
  | 'idle'

/** Truthful, content-free result from one outbox or worker transition. */
export interface MemoryWorkerOutcomeV1 {
  readonly schema: 'datazup.memory.worker-outcome/v1'
  readonly outcomeId: string
  readonly status: InternalMemoryWorkerOutcomeStatusV1
  readonly reasonCode: string
  readonly occurredAt: string
  readonly revision: number
  readonly attempt: number
  readonly generation: number
  readonly envelopeId?: string
  readonly envelopeDigest?: `sha256:${string}`
  readonly jobId?: string
  readonly jobDigest?: `sha256:${string}`
  readonly lease?: MemoryWorkerLeaseV1
  readonly candidateRefs: readonly InternalMemoryWorkerRefV1[]
  readonly deadLetterRef?: InternalMemoryWorkerRefV1
  readonly checkpointRef?: InternalMemoryWorkerRefV1
  /** Cumulative known provider cost for this envelope; zero when cost state is unknown. */
  readonly providerCostMicrousd: number
  readonly providerCostState: 'known' | 'unknown'
  readonly candidateReview: 'required'
  readonly canonicalPromotion: 'not-performed'
  readonly effectAuthority: 'none'
  readonly outcomeDigest: `sha256:${string}`
}

export interface InternalMemoryWorkerAdmissionRequestV1 {
  readonly schema: 'datazup.memory.worker-admission-request/v1'
  readonly phase: 'execute' | 'reconcile'
  readonly checkedAt: string
  readonly envelopeId: string
  readonly envelopeDigest: `sha256:${string}`
  readonly idempotencyKey: string
  readonly jobId: string
  readonly jobDigest: `sha256:${string}`
  readonly scopeDigest: `sha256:${string}`
  readonly lease: MemoryWorkerLeaseV1
  readonly schedulerRef: InternalMemoryWorkerRefV1
  readonly policyRef: InternalMemoryWorkerRefV1
  readonly budgetRef: InternalMemoryWorkerRefV1
  readonly providerRouteRef?: InternalMemoryWorkerRefV1
  readonly deadlineMs: number
  readonly signal: AbortSignal
  readonly requestDigest: `sha256:${string}`
}

export interface InternalMemoryWorkerExecutionRequestV1 {
  readonly schema: 'datazup.memory.consolidation-request/v1'
  readonly job: MemoryConsolidationJobV1
  readonly jobDigest: `sha256:${string}`
  readonly envelopeId: string
  readonly envelopeDigest: `sha256:${string}`
  readonly idempotencyKey: string
  readonly lease: MemoryWorkerLeaseV1
  readonly admissionDigest: `sha256:${string}`
  readonly deadlineMs: number
  readonly signal: AbortSignal
  readonly requestDigest: `sha256:${string}`
}

export interface InternalMemoryWorkerReconciliationRequestV1 {
  readonly schema: 'datazup.memory.reconciliation-request/v1'
  readonly job: MemoryConsolidationJobV1
  readonly jobDigest: `sha256:${string}`
  readonly envelopeId: string
  readonly envelopeDigest: `sha256:${string}`
  readonly idempotencyKey: string
  readonly lease: MemoryWorkerLeaseV1
  readonly ambiguousOutcomeDigest: `sha256:${string}`
  readonly reconciliationRef: InternalMemoryWorkerRefV1
  readonly admissionDigest: `sha256:${string}`
  readonly deadlineMs: number
  readonly signal: AbortSignal
  readonly requestDigest: `sha256:${string}`
}

/** Host-injected admission, consolidation, and ambiguous-outcome boundary. */
export interface MemoryConsolidationPort {
  admit(input: InternalMemoryWorkerAdmissionRequestV1): Promise<unknown>
  execute(input: InternalMemoryWorkerExecutionRequestV1): Promise<unknown>
  reconcile(input: InternalMemoryWorkerReconciliationRequestV1): Promise<unknown>
}

export interface InternalMemoryWorkerAdmissionResultV1 {
  readonly schema: 'datazup.memory.worker-admission-result/v1'
  readonly status: 'admitted' | 'denied' | 'stale'
  readonly reasonCode: string
  readonly checkedAt: string
  readonly validUntil?: string
  readonly requestDigest: `sha256:${string}`
  readonly dispatchAuthority: 'not-conveyed'
  readonly resultDigest: `sha256:${string}`
}

export interface InternalMemoryConsolidationResultV1 {
  readonly schema: 'datazup.memory.consolidation-result/v1'
  readonly status: 'completed' | 'partial' | 'retryable' | 'terminal' | 'ambiguous'
  readonly reasonCode: string
  readonly finishedAt: string
  readonly requestDigest: `sha256:${string}`
  readonly candidateRefs: readonly InternalMemoryWorkerRefV1[]
  readonly reconciliationRef?: InternalMemoryWorkerRefV1
  /** Cumulative provider cost for this envelope through this result. */
  readonly providerCostMicrousd: number
  readonly effectState: 'applied' | 'not-applied' | 'unknown'
  readonly resultDigest: `sha256:${string}`
}

export interface InternalMemoryReconciliationResultV1 {
  readonly schema: 'datazup.memory.reconciliation-result/v1'
  readonly status: 'proven-complete' | 'proven-not-applied' | 'ambiguous'
  readonly reasonCode: string
  readonly finishedAt: string
  readonly requestDigest: `sha256:${string}`
  readonly candidateRefs: readonly InternalMemoryWorkerRefV1[]
  readonly reconciliationRef?: InternalMemoryWorkerRefV1
  /** Cumulative provider cost for this envelope through this result. */
  readonly providerCostMicrousd: number
  readonly effectState: 'applied' | 'not-applied' | 'unknown'
  readonly resultDigest: `sha256:${string}`
}

export interface InternalMemoryOutboxEntryV1 {
  readonly envelope: MemoryOutboxEnvelopeV1
  readonly state:
    | 'pending'
    | 'leased'
    | 'executing'
    | 'reconciling'
    | 'ambiguous'
    | 'completed'
    | 'dead-lettered'
  readonly attempt: number
  readonly generation: number
  readonly nextAvailableAt: string
  readonly lease?: MemoryWorkerLeaseV1
  readonly outcome?: MemoryWorkerOutcomeV1
  readonly reconciliationRef?: InternalMemoryWorkerRefV1
  readonly deadLetter?: MemoryDeadLetterV1
}

export interface InternalMemoryOutboxStateV1 {
  readonly schema: 'datazup.memory.in-memory-outbox-state/v1'
  readonly revision: number
  readonly sequence: number
  readonly entries: readonly InternalMemoryOutboxEntryV1[]
  readonly checkpoints: readonly MemoryWorkerCheckpointV1[]
  readonly stateDigest: `sha256:${string}`
}

export interface InternalMemoryOutboxLimitsV1 {
  readonly entries: number
  readonly deadLetters: number
  readonly checkpoints: number
}

export interface InternalMemoryOutboxInspectionV1 {
  readonly schema: 'datazup.memory.outbox-inspection/v1'
  readonly revision: number
  readonly sequence: number
  readonly stateDigest: `sha256:${string}`
  readonly counts: MemoryWorkerCheckpointV1['counts']
  readonly entries: readonly {
    readonly scopeDigest: `sha256:${string}`
    readonly envelopeId: string
    readonly envelopeDigest: `sha256:${string}`
    readonly jobId: string
    readonly jobDigest: `sha256:${string}`
    readonly state: InternalMemoryOutboxEntryV1['state']
    readonly attempt: number
    readonly generation: number
    readonly nextAvailableAt: string
  }[]
  readonly deadLetters: readonly MemoryDeadLetterV1[]
  readonly checkpoints: readonly MemoryWorkerCheckpointV1[]
}
