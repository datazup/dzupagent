import {
  derivedIdentifier,
  digestWorkerValue,
  freezeWorkerValue,
} from './snapshot.js'
import type {
  InternalMemoryOutboxEntryV1,
  InternalMemoryWorkerRefV1,
  MemoryOutboxEnvelopeV1,
} from './types.js'

interface AdmissionRefs {
  readonly schedulerRef: InternalMemoryWorkerRefV1
  readonly policyRef: InternalMemoryWorkerRefV1
  readonly budgetRef: InternalMemoryWorkerRefV1
  readonly providerRouteRef?: InternalMemoryWorkerRefV1
}

export function workerAdmissionRefsMatch(
  envelope: MemoryOutboxEnvelopeV1,
  refs: AdmissionRefs,
): boolean {
  return sameWorkerRef(envelope.schedulerRef, refs.schedulerRef)
    && sameWorkerRef(envelope.policyRef, refs.policyRef)
    && sameWorkerRef(envelope.budgetRef, refs.budgetRef)
    && ((envelope.providerRouteRef === undefined && refs.providerRouteRef === undefined)
      || (envelope.providerRouteRef !== undefined && refs.providerRouteRef !== undefined
        && sameWorkerRef(envelope.providerRouteRef, refs.providerRouteRef)))
}

export function memoryReconciliationRef(
  entry: InternalMemoryOutboxEntryV1,
  reasonCode: string,
): InternalMemoryWorkerRefV1 {
  const digest = digestWorkerValue({
    schema: 'datazup.memory.reconciliation-ref/v1',
    envelopeDigest: entry.envelope.envelopeDigest,
    leaseDigest: entry.lease?.leaseDigest,
    reasonCode,
  })
  return freezeWorkerValue({
    owner: 'memory-outbox',
    id: derivedIdentifier('reconciliation', digest),
    digest,
  })
}

function sameWorkerRef(
  left: InternalMemoryWorkerRefV1,
  right: InternalMemoryWorkerRefV1,
): boolean {
  return left.owner === right.owner && left.id === right.id && left.digest === right.digest
}
