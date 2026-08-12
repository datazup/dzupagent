import { invokeBoundedStage } from '../retrieval/stage-runtime.js'
import type { InternalInMemoryOutboxState } from './outbox-state.js'
import type {
  InternalReconcileRequestV1,
  InternalRunClaimedRequestV1,
} from './requests.js'
import {
  digestWorkerValue,
  memoryWorkerScopeDigest,
  timestampMs,
} from './snapshot.js'
import type {
  InternalMemoryOutboxEntryV1,
  InternalMemoryWorkerAdmissionResultV1,
  MemoryConsolidationPort,
  MemoryWorkerLeaseV1,
  MemoryWorkerOutcomeV1,
} from './types.js'
import {
  memoryReconciliationRef,
  workerAdmissionRefsMatch,
} from './worker-identity.js'
import {
  decodeMemoryConsolidationResultV1,
  decodeMemoryReconciliationResultV1,
  decodeMemoryWorkerAdmissionResultV1,
} from './validation-results.js'

type AdmissionOutcome =
  | { readonly status: 'admitted'; readonly result: InternalMemoryWorkerAdmissionResultV1 }
  | { readonly status: 'unavailable'; readonly reasonCode: string }
  | { readonly status: 'denied'; readonly reasonCode: string }

export async function runClaimedMemoryEnvelope(
  state: InternalInMemoryOutboxState,
  request: InternalRunClaimedRequestV1,
  port: MemoryConsolidationPort,
): Promise<MemoryWorkerOutcomeV1> {
  let entry = state.entryForLease(request.lease)
  if (!entry) return state.rejectLease(request.lease, 'stale-lease', request.startedAt)
  if (entry.state === 'executing') {
    return state.rejectLease(request.lease, 'execution-already-started', request.startedAt)
  }
  if (entry.state !== 'leased') {
    return state.rejectLease(request.lease, 'worker-phase-mismatch', request.startedAt)
  }
  if (!workerAdmissionRefsMatch(entry.envelope, request)) {
    return state.rejectLease(request.lease, 'admission-reference-mismatch', request.startedAt)
  }
  if (timestampMs(request.startedAt) < timestampMs(request.lease.acquiredAt)) {
    return state.rejectLease(request.lease, 'execution-precedes-lease', request.startedAt)
  }
  if (timestampMs(request.startedAt) >= timestampMs(request.lease.expiresAt)) {
    return state.ambiguous(
      request.lease,
      'execution-lease-expired',
      request.startedAt,
      memoryReconciliationRef(entry, 'execution-lease-expired'),
    )
  }
  entry = state.beginExecution(request.lease)
  if (!entry) return state.rejectLease(request.lease, 'execution-already-started', request.startedAt)
  const effectiveDeadline = effectiveDeadlineAt(entry, request.startedAt, request.deadlineMs)
  const stageDeadlineMs = Math.max(
    1,
    timestampMs(effectiveDeadline) - timestampMs(request.startedAt),
  )
  const admission = await admit(
    entry,
    request.lease,
    request.startedAt,
    stageDeadlineMs,
    effectiveDeadline,
    'execute',
    port,
  )
  if (admission.status === 'unavailable') {
    return state.retryOrDeadLetter(request.lease, admission.reasonCode, request.startedAt)
  }
  if (admission.status === 'denied') {
    return state.deadLetterLease(request.lease, admission.reasonCode, request.startedAt)
  }
  const executionBase = {
    schema: 'datazup.memory.consolidation-request/v1' as const,
    job: entry.envelope.job,
    jobDigest: entry.envelope.jobDigest,
    envelopeId: entry.envelope.envelopeId,
    envelopeDigest: entry.envelope.envelopeDigest,
    idempotencyKey: entry.envelope.idempotencyKey,
    lease: request.lease,
    admissionDigest: admission.result.resultDigest,
    deadlineMs: stageDeadlineMs,
  }
  const requestDigest = digestWorkerValue(executionBase)
  const invocation = await invokeBoundedStage(executionBase.deadlineMs, signal =>
    port.execute(Object.freeze({ ...executionBase, requestDigest, signal })))
  if (invocation.status !== 'completed') {
    return state.ambiguous(
      request.lease,
      invocation.status === 'timed-out' ? 'execution-timeout' : 'execution-failed',
      effectiveDeadline,
      memoryReconciliationRef(entry, invocation.status),
      undefined,
      'unknown',
    )
  }
  let result
  try {
    result = decodeMemoryConsolidationResultV1(
      invocation.value,
      requestDigest,
      entry.envelope.job.maxCandidateRefs,
    )
  } catch {
    return state.ambiguous(
      request.lease,
      'malformed-execution-result',
      effectiveDeadline,
      memoryReconciliationRef(entry, 'malformed-result'),
      undefined,
      'unknown',
    )
  }
  if (!resultIsWithinBounds(entry, request.startedAt, effectiveDeadline, result)) {
    return state.ambiguous(
      request.lease,
      'unbounded-execution-result',
      effectiveDeadline,
      memoryReconciliationRef(entry, 'unbounded-result'),
      undefined,
      'unknown',
    )
  }
  if (result.status === 'completed' || result.status === 'partial') {
    return state.complete(request.lease, {
      status: result.status,
      reasonCode: result.reasonCode,
      occurredAt: result.finishedAt,
      candidateRefs: result.candidateRefs,
      providerCostMicrousd: result.providerCostMicrousd,
    })
  }
  if (result.status === 'retryable') {
    return state.retryOrDeadLetter(
      request.lease, result.reasonCode, result.finishedAt, result.providerCostMicrousd, 'known',
    )
  }
  if (result.status === 'terminal') {
    return state.deadLetterLease(
      request.lease, result.reasonCode, result.finishedAt, result.providerCostMicrousd, 'known',
    )
  }
  return state.ambiguous(
    request.lease,
    result.reasonCode,
    result.finishedAt,
    result.reconciliationRef!,
    result.providerCostMicrousd,
    'known',
  )
}

export async function reconcileMemoryEnvelope(
  state: InternalInMemoryOutboxState,
  request: InternalReconcileRequestV1,
  port: MemoryConsolidationPort,
): Promise<MemoryWorkerOutcomeV1> {
  const claim = state.beginReconciliation(request)
  if (claim.status !== 'claimed' || claim.lease === undefined) return claim
  const lease = claim.lease
  const entry = state.entryForLease(lease)
  if (!entry || entry.state !== 'reconciling' || entry.reconciliationRef === undefined
    || entry.outcome?.status !== 'ambiguous') {
    return state.rejectLease(lease, 'reconciliation-state-mismatch', request.startedAt)
  }
  const effectiveDeadline = effectiveDeadlineAt(entry, request.startedAt, request.deadlineMs)
  const stageDeadlineMs = Math.max(
    1,
    timestampMs(effectiveDeadline) - timestampMs(request.startedAt),
  )
  const admission = await admit(
    entry,
    lease,
    request.startedAt,
    stageDeadlineMs,
    effectiveDeadline,
    'reconcile',
    port,
  )
  if (admission.status === 'unavailable') {
    return state.ambiguous(
      lease,
      admission.reasonCode,
      request.startedAt,
      entry.reconciliationRef,
    )
  }
  if (admission.status === 'denied') {
    return state.deadLetterLease(
      lease,
      admission.reasonCode,
      request.startedAt,
      entry.outcome.providerCostMicrousd,
      entry.outcome.providerCostState,
    )
  }
  const reconciliationBase = {
    schema: 'datazup.memory.reconciliation-request/v1' as const,
    job: entry.envelope.job,
    jobDigest: entry.envelope.jobDigest,
    envelopeId: entry.envelope.envelopeId,
    envelopeDigest: entry.envelope.envelopeDigest,
    idempotencyKey: entry.envelope.idempotencyKey,
    lease,
    ambiguousOutcomeDigest: entry.outcome.outcomeDigest,
    reconciliationRef: entry.reconciliationRef,
    admissionDigest: admission.result.resultDigest,
    deadlineMs: stageDeadlineMs,
  }
  const requestDigest = digestWorkerValue(reconciliationBase)
  const invocation = await invokeBoundedStage(reconciliationBase.deadlineMs, signal =>
    port.reconcile(Object.freeze({ ...reconciliationBase, requestDigest, signal })))
  if (invocation.status !== 'completed') {
    return state.ambiguous(
      lease,
      invocation.status === 'timed-out' ? 'reconciliation-timeout' : 'reconciliation-failed',
      effectiveDeadline,
      entry.reconciliationRef,
      undefined,
      'unknown',
    )
  }
  let result
  try {
    result = decodeMemoryReconciliationResultV1(
      invocation.value,
      requestDigest,
      entry.envelope.job.maxCandidateRefs,
    )
  } catch {
    return state.ambiguous(
      lease,
      'malformed-reconciliation-result',
      effectiveDeadline,
      entry.reconciliationRef,
      undefined,
      'unknown',
    )
  }
  if (!resultIsWithinBounds(entry, request.startedAt, effectiveDeadline, result, true)) {
    return state.ambiguous(
      lease,
      'unbounded-reconciliation-result',
      effectiveDeadline,
      entry.reconciliationRef,
      undefined,
      'unknown',
    )
  }
  if (result.status === 'proven-complete') {
    return state.complete(lease, {
      status: 'reconciled',
      reasonCode: result.reasonCode,
      occurredAt: result.finishedAt,
      candidateRefs: result.candidateRefs,
      providerCostMicrousd: result.providerCostMicrousd,
    })
  }
  if (result.status === 'proven-not-applied') {
    return state.retryOrDeadLetter(
      lease, result.reasonCode, result.finishedAt, result.providerCostMicrousd, 'known',
    )
  }
  return state.ambiguous(
    lease,
    result.reasonCode,
    result.finishedAt,
    result.reconciliationRef!,
    result.providerCostMicrousd,
    'known',
  )
}

async function admit(
  entry: InternalMemoryOutboxEntryV1,
  lease: MemoryWorkerLeaseV1,
  checkedAt: string,
  deadlineMs: number,
  effectiveDeadline: string,
  phase: 'execute' | 'reconcile',
  port: MemoryConsolidationPort,
): Promise<AdmissionOutcome> {
  const base = {
    schema: 'datazup.memory.worker-admission-request/v1' as const,
    phase,
    checkedAt,
    envelopeId: entry.envelope.envelopeId,
    envelopeDigest: entry.envelope.envelopeDigest,
    idempotencyKey: entry.envelope.idempotencyKey,
    jobId: entry.envelope.job.jobId,
    jobDigest: entry.envelope.jobDigest,
    scopeDigest: memoryWorkerScopeDigest(entry.envelope.job.scope),
    lease,
    schedulerRef: entry.envelope.schedulerRef,
    policyRef: entry.envelope.policyRef,
    budgetRef: entry.envelope.budgetRef,
    ...(entry.envelope.providerRouteRef === undefined ? {} : {
      providerRouteRef: entry.envelope.providerRouteRef,
    }),
    deadlineMs,
  }
  const requestDigest = digestWorkerValue(base)
  const invocation = await invokeBoundedStage(deadlineMs, signal =>
    port.admit(Object.freeze({ ...base, requestDigest, signal })))
  if (invocation.status !== 'completed') {
    return {
      status: 'unavailable',
      reasonCode: invocation.status === 'timed-out' ? 'admission-timeout' : 'admission-failed',
    }
  }
  let result
  try {
    result = decodeMemoryWorkerAdmissionResultV1(invocation.value, requestDigest)
  } catch {
    return { status: 'unavailable', reasonCode: 'malformed-admission-result' }
  }
  if (result.status !== 'admitted') {
    return {
      status: 'denied',
      reasonCode: result.status === 'stale' ? 'admission-stale' : 'admission-denied',
    }
  }
  if (result.checkedAt !== checkedAt
    || timestampMs(result.validUntil!) < timestampMs(effectiveDeadline)) {
    return { status: 'denied', reasonCode: 'admission-validity-insufficient' }
  }
  return { status: 'admitted', result }
}

function effectiveDeadlineAt(
  entry: InternalMemoryOutboxEntryV1,
  startedAt: string,
  deadlineMs: number,
): string {
  return new Date(Math.min(
    timestampMs(startedAt) + deadlineMs,
    timestampMs(entry.lease!.expiresAt),
    timestampMs(entry.envelope.deadlineAt),
  )).toISOString()
}

function resultIsWithinBounds(
  entry: InternalMemoryOutboxEntryV1,
  startedAt: string,
  effectiveDeadline: string,
  result: { readonly finishedAt: string; readonly providerCostMicrousd: number },
  mayResolveUnknownCost = false,
): boolean {
  return timestampMs(result.finishedAt) >= timestampMs(startedAt)
    && timestampMs(result.finishedAt) <= timestampMs(effectiveDeadline)
    && result.providerCostMicrousd <= entry.envelope.job.costCeilingMicrousd
    && (entry.outcome?.providerCostState !== 'unknown' || mayResolveUnknownCost)
    && (entry.outcome === undefined
      || result.providerCostMicrousd >= entry.outcome.providerCostMicrousd)
    && (entry.envelope.job.providerMode !== 'none' || result.providerCostMicrousd === 0)
}
