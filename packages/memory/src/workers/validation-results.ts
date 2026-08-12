import {
  digestValue,
  enumValue,
  identifierValue,
  objectValue,
  required,
  stringValue,
} from '../records/decoder-primitives.js'
import {
  digestWorkerValue,
  freezeWorkerValue,
  snapshotWorkerJson,
} from './snapshot.js'
import type {
  InternalMemoryConsolidationResultV1,
  InternalMemoryReconciliationResultV1,
  InternalMemoryWorkerAdmissionResultV1,
  InternalMemoryWorkerOutcomeStatusV1,
  MemoryDeadLetterV1,
  MemoryWorkerCheckpointV1,
  MemoryWorkerOutcomeV1,
} from './types.js'
import { decodeMemoryWorkerLeaseV1 } from './validation-contracts.js'
import {
  boundedInteger,
  decodeReasonCode,
  decodeWorkerRef,
  decodeWorkerRefs,
  requireSchema,
  requireTimeOrder,
  timestampFrom,
  workerFail,
} from './validation-core.js'

const OUTCOME_STATUSES = [
  'enqueued', 'replayed', 'claimed', 'renewed', 'completed', 'partial',
  'retry-scheduled', 'ambiguous', 'reconciled', 'dead-lettered',
  'checkpointed', 'rejected', 'idle',
] as const satisfies readonly InternalMemoryWorkerOutcomeStatusV1[]

export function decodeMemoryWorkerAdmissionResultV1(
  input: unknown,
  expectedRequestDigest: `sha256:${string}`,
): InternalMemoryWorkerAdmissionResultV1 {
  const root = objectValue(snapshotWorkerJson(input), [], [
    'schema', 'status', 'reasonCode', 'checkedAt', 'validUntil',
    'requestDigest', 'dispatchAuthority', 'resultDigest',
  ])
  requireSchema(root, 'datazup.memory.worker-admission-result/v1')
  const status = enumValue(root, 'status', [], ['admitted', 'denied', 'stale'] as const)
  const checkedAt = timestampFrom(root, 'checkedAt', [])
  const validUntil = root['validUntil'] === undefined
    ? undefined
    : timestampFrom(root, 'validUntil', [])
  if ((status === 'admitted') !== (validUntil !== undefined)) {
    workerFail('invalid-value', ['validUntil'])
  }
  if (validUntil !== undefined) requireTimeOrder(checkedAt, validUntil, ['validUntil'])
  if (stringValue(root, 'dispatchAuthority', []) !== 'not-conveyed') {
    workerFail('invalid-value', ['dispatchAuthority'])
  }
  const requestDigest = digestValue(root, 'requestDigest', [])
  if (requestDigest !== expectedRequestDigest) workerFail('invalid-value', ['requestDigest'])
  const base: Omit<InternalMemoryWorkerAdmissionResultV1, 'resultDigest'> = {
    schema: 'datazup.memory.worker-admission-result/v1',
    status,
    reasonCode: decodeReasonCode(root, 'reasonCode', []),
    checkedAt,
    ...(validUntil === undefined ? {} : { validUntil }),
    requestDigest,
    dispatchAuthority: 'not-conveyed',
  }
  const resultDigest = digestValue(root, 'resultDigest', [])
  if (resultDigest !== digestWorkerValue(base)) workerFail('invalid-value', ['resultDigest'])
  return freezeWorkerValue({ ...base, resultDigest })
}

export function decodeMemoryConsolidationResultV1(
  input: unknown,
  expectedRequestDigest: `sha256:${string}`,
  maximumCandidateRefs: number,
): InternalMemoryConsolidationResultV1 {
  const root = objectValue(snapshotWorkerJson(input), [], [
    'schema', 'status', 'reasonCode', 'finishedAt', 'requestDigest',
    'candidateRefs', 'reconciliationRef', 'providerCostMicrousd', 'effectState', 'resultDigest',
  ])
  requireSchema(root, 'datazup.memory.consolidation-result/v1')
  const status = enumValue(root, 'status', [], [
    'completed', 'partial', 'retryable', 'terminal', 'ambiguous',
  ] as const)
  const candidateRefs = decodeWorkerRefs(
    required(root, 'candidateRefs', []),
    ['candidateRefs'],
    maximumCandidateRefs,
  )
  const reconciliationRef = root['reconciliationRef'] === undefined
    ? undefined
    : decodeWorkerRef(root['reconciliationRef'], ['reconciliationRef'])
  const effectState = enumValue(root, 'effectState', [], [
    'applied', 'not-applied', 'unknown',
  ] as const)
  validateResultFields(status, candidateRefs.length, reconciliationRef !== undefined, effectState)
  const requestDigest = digestValue(root, 'requestDigest', [])
  if (requestDigest !== expectedRequestDigest) workerFail('invalid-value', ['requestDigest'])
  const base: Omit<InternalMemoryConsolidationResultV1, 'resultDigest'> = {
    schema: 'datazup.memory.consolidation-result/v1',
    status,
    reasonCode: decodeReasonCode(root, 'reasonCode', []),
    finishedAt: timestampFrom(root, 'finishedAt', []),
    requestDigest,
    candidateRefs,
    ...(reconciliationRef === undefined ? {} : { reconciliationRef }),
    providerCostMicrousd: boundedInteger(
      root,
      'providerCostMicrousd',
      [],
      0,
      1_000_000_000,
    ),
    effectState,
  }
  const resultDigest = digestValue(root, 'resultDigest', [])
  if (resultDigest !== digestWorkerValue(base)) workerFail('invalid-value', ['resultDigest'])
  return freezeWorkerValue({ ...base, resultDigest })
}

export function decodeMemoryReconciliationResultV1(
  input: unknown,
  expectedRequestDigest: `sha256:${string}`,
  maximumCandidateRefs: number,
): InternalMemoryReconciliationResultV1 {
  const root = objectValue(snapshotWorkerJson(input), [], [
    'schema', 'status', 'reasonCode', 'finishedAt', 'requestDigest',
    'candidateRefs', 'reconciliationRef', 'providerCostMicrousd', 'effectState', 'resultDigest',
  ])
  requireSchema(root, 'datazup.memory.reconciliation-result/v1')
  const status = enumValue(root, 'status', [], [
    'proven-complete', 'proven-not-applied', 'ambiguous',
  ] as const)
  const candidateRefs = decodeWorkerRefs(
    required(root, 'candidateRefs', []),
    ['candidateRefs'],
    maximumCandidateRefs,
  )
  const reconciliationRef = root['reconciliationRef'] === undefined
    ? undefined
    : decodeWorkerRef(root['reconciliationRef'], ['reconciliationRef'])
  const effectState = enumValue(root, 'effectState', [], [
    'applied', 'not-applied', 'unknown',
  ] as const)
  if ((status === 'ambiguous') !== (reconciliationRef !== undefined)
    || (status === 'proven-complete' && effectState !== 'applied')
    || (status === 'proven-not-applied' && effectState !== 'not-applied')
    || (status === 'ambiguous' && effectState !== 'unknown')
    || (status === 'proven-not-applied' && candidateRefs.length > 0)) {
    workerFail('invalid-value', ['status'])
  }
  const requestDigest = digestValue(root, 'requestDigest', [])
  if (requestDigest !== expectedRequestDigest) workerFail('invalid-value', ['requestDigest'])
  const base: Omit<InternalMemoryReconciliationResultV1, 'resultDigest'> = {
    schema: 'datazup.memory.reconciliation-result/v1',
    status,
    reasonCode: decodeReasonCode(root, 'reasonCode', []),
    finishedAt: timestampFrom(root, 'finishedAt', []),
    requestDigest,
    candidateRefs,
    ...(reconciliationRef === undefined ? {} : { reconciliationRef }),
    providerCostMicrousd: boundedInteger(
      root,
      'providerCostMicrousd',
      [],
      0,
      1_000_000_000,
    ),
    effectState,
  }
  const resultDigest = digestValue(root, 'resultDigest', [])
  if (resultDigest !== digestWorkerValue(base)) workerFail('invalid-value', ['resultDigest'])
  return freezeWorkerValue({ ...base, resultDigest })
}

export function decodeMemoryDeadLetterV1(input: unknown): MemoryDeadLetterV1 {
  const root = objectValue(snapshotWorkerJson(input), [], [
    'schema', 'deadLetterId', 'envelopeId', 'envelopeDigest', 'jobId',
    'jobDigest', 'scopeDigest', 'attempt', 'generation', 'reasonCode',
    'deadLetteredAt', 'priorOutcomeDigest', 'deadLetterDigest',
  ])
  requireSchema(root, 'datazup.memory.dead-letter/v1')
  const base: Omit<MemoryDeadLetterV1, 'deadLetterDigest'> = {
    schema: 'datazup.memory.dead-letter/v1',
    deadLetterId: identifierValue(root, 'deadLetterId', []),
    envelopeId: identifierValue(root, 'envelopeId', []),
    envelopeDigest: digestValue(root, 'envelopeDigest', []),
    jobId: identifierValue(root, 'jobId', []),
    jobDigest: digestValue(root, 'jobDigest', []),
    scopeDigest: digestValue(root, 'scopeDigest', []),
    attempt: boundedInteger(root, 'attempt', [], 0, 16),
    generation: boundedInteger(root, 'generation', [], 0, Number.MAX_SAFE_INTEGER),
    reasonCode: decodeReasonCode(root, 'reasonCode', []),
    deadLetteredAt: timestampFrom(root, 'deadLetteredAt', []),
    ...(root['priorOutcomeDigest'] === undefined ? {} : {
      priorOutcomeDigest: digestValue(root, 'priorOutcomeDigest', []),
    }),
  }
  const deadLetterDigest = digestValue(root, 'deadLetterDigest', [])
  if (deadLetterDigest !== digestWorkerValue(base)) {
    workerFail('invalid-value', ['deadLetterDigest'])
  }
  return freezeWorkerValue({ ...base, deadLetterDigest })
}

export function sealMemoryDeadLetterV1(
  input: Omit<MemoryDeadLetterV1, 'deadLetterDigest'>,
): MemoryDeadLetterV1 {
  return decodeMemoryDeadLetterV1({ ...input, deadLetterDigest: digestWorkerValue(input) })
}

export function decodeMemoryWorkerCheckpointV1(
  input: unknown,
): MemoryWorkerCheckpointV1 {
  const root = objectValue(snapshotWorkerJson(input), [], [
    'schema', 'checkpointId', 'checkpointedAt', 'revision', 'sequence',
    'priorStateDigest', 'priorCheckpointDigest', 'counts', 'checkpointDigest',
  ])
  requireSchema(root, 'datazup.memory.worker-checkpoint/v1')
  const countsRoot = objectValue(required(root, 'counts', []), ['counts'], [
    'pending', 'leased', 'executing', 'reconciling', 'ambiguous', 'completed', 'deadLettered',
  ])
  const base: Omit<MemoryWorkerCheckpointV1, 'checkpointDigest'> = {
    schema: 'datazup.memory.worker-checkpoint/v1',
    checkpointId: identifierValue(root, 'checkpointId', []),
    checkpointedAt: timestampFrom(root, 'checkpointedAt', []),
    revision: boundedInteger(root, 'revision', [], 0, Number.MAX_SAFE_INTEGER),
    sequence: boundedInteger(root, 'sequence', [], 0, Number.MAX_SAFE_INTEGER),
    priorStateDigest: digestValue(root, 'priorStateDigest', []),
    ...(root['priorCheckpointDigest'] === undefined ? {} : {
      priorCheckpointDigest: digestValue(root, 'priorCheckpointDigest', []),
    }),
    counts: {
      pending: boundedInteger(countsRoot, 'pending', ['counts'], 0, 256),
      leased: boundedInteger(countsRoot, 'leased', ['counts'], 0, 256),
      executing: boundedInteger(countsRoot, 'executing', ['counts'], 0, 256),
      reconciling: boundedInteger(countsRoot, 'reconciling', ['counts'], 0, 256),
      ambiguous: boundedInteger(countsRoot, 'ambiguous', ['counts'], 0, 256),
      completed: boundedInteger(countsRoot, 'completed', ['counts'], 0, 256),
      deadLettered: boundedInteger(countsRoot, 'deadLettered', ['counts'], 0, 256),
    },
  }
  const checkpointDigest = digestValue(root, 'checkpointDigest', [])
  if (checkpointDigest !== digestWorkerValue(base)) {
    workerFail('invalid-value', ['checkpointDigest'])
  }
  return freezeWorkerValue({ ...base, checkpointDigest })
}

export function sealMemoryWorkerCheckpointV1(
  input: Omit<MemoryWorkerCheckpointV1, 'checkpointDigest'>,
): MemoryWorkerCheckpointV1 {
  return decodeMemoryWorkerCheckpointV1({
    ...input,
    checkpointDigest: digestWorkerValue(input),
  })
}

export function decodeMemoryWorkerOutcomeV1(input: unknown): MemoryWorkerOutcomeV1 {
  const root = objectValue(snapshotWorkerJson(input), [], [
    'schema', 'outcomeId', 'status', 'reasonCode', 'occurredAt', 'revision',
    'attempt', 'generation', 'envelopeId', 'envelopeDigest', 'jobId',
    'jobDigest', 'lease', 'candidateRefs', 'deadLetterRef', 'checkpointRef',
    'providerCostMicrousd', 'providerCostState', 'candidateReview', 'canonicalPromotion',
    'effectAuthority', 'outcomeDigest',
  ])
  requireSchema(root, 'datazup.memory.worker-outcome/v1')
  const status = enumValue(root, 'status', [], OUTCOME_STATUSES)
  const lease = root['lease'] === undefined
    ? undefined
    : decodeMemoryWorkerLeaseV1(root['lease'])
  const candidateRefs = decodeWorkerRefs(required(root, 'candidateRefs', []), ['candidateRefs'], 64)
  const deadLetterRef = root['deadLetterRef'] === undefined
    ? undefined
    : decodeWorkerRef(root['deadLetterRef'], ['deadLetterRef'])
  const checkpointRef = root['checkpointRef'] === undefined
    ? undefined
    : decodeWorkerRef(root['checkpointRef'], ['checkpointRef'])
  validateOutcomeFields(status, lease !== undefined, candidateRefs.length, {
    deadLetter: deadLetterRef !== undefined,
    checkpoint: checkpointRef !== undefined,
  })
  if (stringValue(root, 'candidateReview', []) !== 'required'
    || stringValue(root, 'canonicalPromotion', []) !== 'not-performed'
    || stringValue(root, 'effectAuthority', []) !== 'none') {
    workerFail('invalid-value', ['effectAuthority'])
  }
  const base: Omit<MemoryWorkerOutcomeV1, 'outcomeDigest'> = {
    schema: 'datazup.memory.worker-outcome/v1',
    outcomeId: identifierValue(root, 'outcomeId', []),
    status,
    reasonCode: decodeReasonCode(root, 'reasonCode', []),
    occurredAt: timestampFrom(root, 'occurredAt', []),
    revision: boundedInteger(root, 'revision', [], 0, Number.MAX_SAFE_INTEGER),
    attempt: boundedInteger(root, 'attempt', [], 0, 16),
    generation: boundedInteger(root, 'generation', [], 0, Number.MAX_SAFE_INTEGER),
    ...(root['envelopeId'] === undefined ? {} : {
      envelopeId: identifierValue(root, 'envelopeId', []),
    }),
    ...(root['envelopeDigest'] === undefined ? {} : {
      envelopeDigest: digestValue(root, 'envelopeDigest', []),
    }),
    ...(root['jobId'] === undefined ? {} : { jobId: identifierValue(root, 'jobId', []) }),
    ...(root['jobDigest'] === undefined ? {} : { jobDigest: digestValue(root, 'jobDigest', []) }),
    ...(lease === undefined ? {} : { lease }),
    candidateRefs,
    ...(deadLetterRef === undefined ? {} : { deadLetterRef }),
    ...(checkpointRef === undefined ? {} : { checkpointRef }),
    providerCostMicrousd: boundedInteger(
      root,
      'providerCostMicrousd',
      [],
      0,
      1_000_000_000,
    ),
    providerCostState: enumValue(root, 'providerCostState', [], ['known', 'unknown'] as const),
    candidateReview: 'required',
    canonicalPromotion: 'not-performed',
    effectAuthority: 'none',
  }
  const hasEnvelopeIdentity = base.envelopeId !== undefined
    && base.envelopeDigest !== undefined
    && base.jobId !== undefined
    && base.jobDigest !== undefined
  if ((status === 'idle' || status === 'checkpointed') === hasEnvelopeIdentity) {
    workerFail('invalid-value', ['envelopeId'])
  }
  if (base.providerCostState === 'unknown'
    && (base.providerCostMicrousd !== 0
      || !['ambiguous', 'dead-lettered'].includes(status))) {
    workerFail('invalid-value', ['providerCostState'])
  }
  const outcomeDigest = digestValue(root, 'outcomeDigest', [])
  if (outcomeDigest !== digestWorkerValue(base)) workerFail('invalid-value', ['outcomeDigest'])
  return freezeWorkerValue({ ...base, outcomeDigest })
}

export function sealMemoryWorkerOutcomeV1(
  input: Omit<MemoryWorkerOutcomeV1, 'outcomeDigest'>,
): MemoryWorkerOutcomeV1 {
  return decodeMemoryWorkerOutcomeV1({ ...input, outcomeDigest: digestWorkerValue(input) })
}

function validateResultFields(
  status: InternalMemoryConsolidationResultV1['status'],
  candidates: number,
  hasReconciliationRef: boolean,
  effectState: InternalMemoryConsolidationResultV1['effectState'],
): void {
  if ((status === 'ambiguous') !== hasReconciliationRef
    || ((status === 'completed' || status === 'partial') && effectState !== 'applied')
    || (status === 'retryable' && effectState !== 'not-applied')
    || (status === 'terminal' && effectState !== 'not-applied')
    || (status === 'ambiguous' && effectState !== 'unknown')
    || (['retryable', 'terminal', 'ambiguous'].includes(status) && candidates > 0)
    || (status === 'partial' && candidates === 0)) {
    workerFail('invalid-value', ['status'])
  }
}

function validateOutcomeFields(
  status: InternalMemoryWorkerOutcomeStatusV1,
  hasLease: boolean,
  candidates: number,
  refs: { readonly deadLetter: boolean; readonly checkpoint: boolean },
): void {
  if ((status === 'claimed' || status === 'renewed') !== hasLease
    || (status === 'dead-lettered') !== refs.deadLetter
    || (status === 'checkpointed') !== refs.checkpoint
    || (!['completed', 'partial', 'reconciled'].includes(status) && candidates > 0)
    || (status === 'partial' && candidates === 0)) {
    workerFail('invalid-value', ['status'])
  }
}
