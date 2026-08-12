import { digestWorkerValue } from '../workers/snapshot.js'
import type {
  InternalMemoryReconciliationResultV1,
  InternalMemoryWorkerAdmissionRequestV1,
  InternalMemoryWorkerAdmissionResultV1,
  InternalMemoryWorkerExecutionRequestV1,
  InternalMemoryWorkerReconciliationRequestV1,
  MemoryConsolidationPort,
  MemoryOutboxEnvelopeV1,
  MemoryWorkerLeaseV1,
} from '../workers/types.js'

export const WORKER_TIMES = Object.freeze({
  requested: '2026-08-11T12:00:00.000Z',
  due: '2026-08-11T12:00:01.000Z',
  started: '2026-08-11T12:00:02.000Z',
  finished: '2026-08-11T12:00:03.000Z',
  reconcile: '2026-08-11T12:00:04.000Z',
  reconciled: '2026-08-11T12:00:05.000Z',
  retryDue: '2026-08-11T12:00:06.000Z',
  deadline: '2026-08-11T12:00:20.000Z',
})

export const WORKER_SCOPE = Object.freeze({
  tenantId: 'invented-tenant',
  namespace: 'semantic',
})

export function workerRef(id: string, fill: string) {
  return Object.freeze({
    owner: 'invented-owner',
    id,
    digest: `sha256:${fill.repeat(64)}` as `sha256:${string}`,
  })
}

export const WORKER_REFS = Object.freeze({
  scheduler: workerRef('scheduler-v1', '1'),
  policy: workerRef('policy-v1', '2'),
  budget: workerRef('budget-v1', '3'),
})

export function workerPrepareInput(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'datazup.memory.outbox-prepare/v1',
    envelopeId: 'envelope-001',
    idempotencyKey: 'idempotency-001',
    job: {
      schema: 'datazup.memory.consolidation-job/v1',
      jobId: 'job-001',
      operation: 'consolidate',
      scope: WORKER_SCOPE,
      sourceRevision: 2,
      sourceRefs: [{
        owner: 'memory-service',
        id: 'snapshot-002',
        versionId: 'version-002',
        digest: `sha256:${'4'.repeat(64)}`,
      }],
      requestedAt: WORKER_TIMES.requested,
      profileRef: workerRef('profile-v1', '5'),
      providerMode: 'none',
      costCeilingMicrousd: 0,
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
    schedulerRef: WORKER_REFS.scheduler,
    policyRef: WORKER_REFS.policy,
    budgetRef: WORKER_REFS.budget,
    createdAt: WORKER_TIMES.requested,
    notBefore: WORKER_TIMES.due,
    deadlineAt: WORKER_TIMES.deadline,
    ...overrides,
  }
}

export function workerClaimInput(claimedAt = WORKER_TIMES.due) {
  return {
    schema: 'datazup.memory.outbox-claim/v1',
    scope: WORKER_SCOPE,
    workerId: 'worker-001',
    claimedAt,
    leaseDurationMs: 10_000,
  }
}

export function workerRunInput(lease: MemoryWorkerLeaseV1) {
  return {
    schema: 'datazup.memory.outbox-run-claimed/v1',
    lease,
    startedAt: WORKER_TIMES.started,
    deadlineMs: 5_000,
    schedulerRef: WORKER_REFS.scheduler,
    policyRef: WORKER_REFS.policy,
    budgetRef: WORKER_REFS.budget,
  }
}

export function workerReconcileInput(
  envelope: MemoryOutboxEnvelopeV1,
  expectedGeneration: number,
) {
  return {
    schema: 'datazup.memory.outbox-reconcile/v1',
    scope: envelope.job.scope,
    envelopeId: envelope.envelopeId,
    expectedGeneration,
    workerId: 'reconciler-001',
    startedAt: WORKER_TIMES.reconcile,
    leaseDurationMs: 5_000,
    deadlineMs: 3_000,
    schedulerRef: envelope.schedulerRef,
    policyRef: envelope.policyRef,
    budgetRef: envelope.budgetRef,
  }
}

export function workerAdmissionResult(
  request: InternalMemoryWorkerAdmissionRequestV1,
  status: 'admitted' | 'denied' | 'stale' = 'admitted',
): InternalMemoryWorkerAdmissionResultV1 {
  const base: Omit<InternalMemoryWorkerAdmissionResultV1, 'resultDigest'> = {
    schema: 'datazup.memory.worker-admission-result/v1',
    status,
    reasonCode: `admission-${status}`,
    checkedAt: request.checkedAt,
    ...(status === 'admitted' ? { validUntil: request.lease.expiresAt } : {}),
    requestDigest: request.requestDigest,
    dispatchAuthority: 'not-conveyed',
  }
  return Object.freeze({ ...base, resultDigest: digestWorkerValue(base) })
}

export function workerExecutionResult(
  request: InternalMemoryWorkerExecutionRequestV1,
  status: 'completed' | 'retryable' | 'ambiguous' = 'completed',
) {
  const base = {
    schema: 'datazup.memory.consolidation-result/v1' as const,
    status,
    reasonCode: status === 'retryable' ? 'provider-retryable' : `provider-${status}`,
    finishedAt: WORKER_TIMES.finished,
    requestDigest: request.requestDigest,
    candidateRefs: status === 'completed' ? [workerRef('candidate-001', '6')] : [],
    ...(status === 'ambiguous' ? {
      reconciliationRef: workerRef('reconciliation-001', '7'),
    } : {}),
    providerCostMicrousd: 0,
    effectState: status === 'ambiguous'
      ? 'unknown' as const
      : status === 'retryable'
        ? 'not-applied' as const
        : 'applied' as const,
  }
  return Object.freeze({ ...base, resultDigest: digestWorkerValue(base) })
}

export function workerReconciliationResult(
  request: InternalMemoryWorkerReconciliationRequestV1,
  status: InternalMemoryReconciliationResultV1['status'],
) {
  const base: Omit<InternalMemoryReconciliationResultV1, 'resultDigest'> = {
    schema: 'datazup.memory.reconciliation-result/v1',
    status,
    reasonCode: status === 'proven-not-applied'
      ? 'reconciliation-proved-not-applied'
      : `reconciliation-${status}`,
    finishedAt: WORKER_TIMES.reconciled,
    requestDigest: request.requestDigest,
    candidateRefs: status === 'proven-complete' ? [workerRef('candidate-001', '6')] : [],
    ...(status === 'ambiguous' ? {
      reconciliationRef: workerRef('reconciliation-002', '8'),
    } : {}),
    providerCostMicrousd: 0,
    effectState: status === 'ambiguous'
      ? 'unknown'
      : status === 'proven-not-applied'
        ? 'not-applied'
        : 'applied',
  }
  return Object.freeze({ ...base, resultDigest: digestWorkerValue(base) })
}

export function workerCompletingPort(): MemoryConsolidationPort {
  return {
    admit: async request => workerAdmissionResult(request),
    execute: async request => workerExecutionResult(request),
    reconcile: async request => workerReconciliationResult(request, 'proven-complete'),
  }
}
