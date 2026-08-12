import { digestWorkerValue } from '../snapshot.js'
import type {
  InternalMemoryReconciliationResultV1,
  InternalMemoryWorkerAdmissionRequestV1,
  InternalMemoryWorkerAdmissionResultV1,
  InternalMemoryWorkerExecutionRequestV1,
  InternalMemoryWorkerReconciliationRequestV1,
  InternalMemoryWorkerRefV1,
  MemoryConsolidationPort,
  MemoryOutboxEnvelopeV1,
  MemoryWorkerLeaseV1,
} from '../types.js'

export const T0 = '2026-08-11T10:00:00.000Z'
export const T1 = '2026-08-11T10:00:01.000Z'
export const T2 = '2026-08-11T10:00:02.000Z'
export const T3 = '2026-08-11T10:00:03.000Z'
export const T4 = '2026-08-11T10:00:04.000Z'
export const T5 = '2026-08-11T10:00:05.000Z'
export const T20 = '2026-08-11T10:00:20.000Z'

export const scope = Object.freeze({ tenantId: 'tenant-001', namespace: 'semantic' })

export function ref(id: string, fill = 'a'): InternalMemoryWorkerRefV1 {
  return Object.freeze({
    owner: 'fixture-owner',
    id,
    digest: `sha256:${fill.repeat(64)}` as `sha256:${string}`,
  })
}

export const schedulerRef = ref('scheduler-001', '1')
export const policyRef = ref('policy-001', '2')
export const budgetRef = ref('budget-001', '3')

export function prepareInput(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'datazup.memory.outbox-prepare/v1',
    envelopeId: 'envelope-001',
    idempotencyKey: 'idempotency-001',
    job: {
      schema: 'datazup.memory.consolidation-job/v1',
      jobId: 'job-001',
      operation: 'consolidate',
      scope,
      sourceRevision: 3,
      sourceRefs: [{
        owner: 'memory-service',
        id: 'snapshot-001',
        versionId: 'version-003',
        digest: `sha256:${'4'.repeat(64)}`,
      }],
      requestedAt: T0,
      profileRef: ref('profile-001', '5'),
      providerMode: 'simulated-local',
      costCeilingMicrousd: 100,
      maxCandidateRefs: 4,
      outputDisposition: 'candidate-review-required',
    },
    retryPolicy: {
      schema: 'datazup.memory.retry-policy/v1',
      maxAttempts: 3,
      backoffMs: [1000, 2000],
      retryableReasonCodes: [
        'admission-failed',
        'admission-timeout',
        'malformed-admission-result',
        'provider-retryable',
        'reconciliation-proved-not-applied',
      ],
    },
    schedulerRef,
    policyRef,
    budgetRef,
    createdAt: T0,
    notBefore: T1,
    deadlineAt: T20,
    ...overrides,
  }
}

export function claimInput(claimedAt = T1, workerId = 'worker-001') {
  return {
    schema: 'datazup.memory.outbox-claim/v1',
    scope,
    workerId,
    claimedAt,
    leaseDurationMs: 10_000,
  }
}

export function runInput(lease: MemoryWorkerLeaseV1, startedAt = T2) {
  return {
    schema: 'datazup.memory.outbox-run-claimed/v1',
    lease,
    startedAt,
    deadlineMs: 5_000,
    schedulerRef,
    policyRef,
    budgetRef,
  }
}

export function reconcileInput(
  envelope: MemoryOutboxEnvelopeV1,
  expectedGeneration: number,
  startedAt = T4,
) {
  return {
    schema: 'datazup.memory.outbox-reconcile/v1',
    scope: envelope.job.scope,
    envelopeId: envelope.envelopeId,
    expectedGeneration,
    workerId: 'reconciler-001',
    startedAt,
    leaseDurationMs: 5_000,
    deadlineMs: 3_000,
    schedulerRef: envelope.schedulerRef,
    policyRef: envelope.policyRef,
    budgetRef: envelope.budgetRef,
    ...(envelope.providerRouteRef === undefined ? {} : {
      providerRouteRef: envelope.providerRouteRef,
    }),
  }
}

export function admitted(
  request: InternalMemoryWorkerAdmissionRequestV1,
): InternalMemoryWorkerAdmissionResultV1 {
  const base: Omit<InternalMemoryWorkerAdmissionResultV1, 'resultDigest'> = {
    schema: 'datazup.memory.worker-admission-result/v1',
    status: 'admitted',
    reasonCode: 'current-admission',
    checkedAt: request.checkedAt,
    validUntil: request.lease.expiresAt,
    requestDigest: request.requestDigest,
    dispatchAuthority: 'not-conveyed',
  }
  return Object.freeze({ ...base, resultDigest: digestWorkerValue(base) })
}

export function consolidationResult(
  request: InternalMemoryWorkerExecutionRequestV1,
  status: 'completed' | 'partial' | 'retryable' | 'terminal' | 'ambiguous' = 'completed',
  finishedAt = T3,
) {
  const candidateRefs = status === 'completed' || status === 'partial'
    ? [ref('candidate-001', '6')]
    : []
  const reconciliationRef = status === 'ambiguous' ? ref('reconcile-001', '7') : undefined
  const base = {
    schema: 'datazup.memory.consolidation-result/v1' as const,
    status,
    reasonCode: status === 'retryable' ? 'provider-retryable' : `provider-${status}`,
    finishedAt,
    requestDigest: request.requestDigest,
    candidateRefs,
    ...(reconciliationRef === undefined ? {} : { reconciliationRef }),
    providerCostMicrousd: 7,
    effectState: status === 'ambiguous'
      ? 'unknown' as const
      : status === 'retryable' || status === 'terminal'
        ? 'not-applied' as const
        : 'applied' as const,
  }
  return Object.freeze({ ...base, resultDigest: digestWorkerValue(base) })
}

export function reconciliationResult(
  request: InternalMemoryWorkerReconciliationRequestV1,
  status: InternalMemoryReconciliationResultV1['status'],
  finishedAt = T5,
) {
  const candidateRefs = status === 'proven-complete' ? [ref('candidate-001', '6')] : []
  const nextRef = status === 'ambiguous' ? ref('reconcile-002', '8') : undefined
  const base: Omit<InternalMemoryReconciliationResultV1, 'resultDigest'> = {
    schema: 'datazup.memory.reconciliation-result/v1',
    status,
    reasonCode: status === 'proven-not-applied'
      ? 'reconciliation-proved-not-applied'
      : `reconciliation-${status}`,
    finishedAt,
    requestDigest: request.requestDigest,
    candidateRefs,
    ...(nextRef === undefined ? {} : { reconciliationRef: nextRef }),
    providerCostMicrousd: 9,
    effectState: status === 'ambiguous'
      ? 'unknown'
      : status === 'proven-not-applied'
        ? 'not-applied'
        : 'applied',
  }
  return Object.freeze({ ...base, resultDigest: digestWorkerValue(base) })
}

export function completingPort(): MemoryConsolidationPort {
  return {
    admit: async request => admitted(request),
    execute: async request => consolidationResult(request),
    reconcile: async request => reconciliationResult(request, 'proven-complete'),
  }
}
