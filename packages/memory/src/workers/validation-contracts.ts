import {
  digestValue,
  enumValue,
  identifierValue,
  objectValue,
  required,
  stringValue,
} from '../records/decoder-primitives.js'
import type { SafeJson } from '../records/safe-json.js'
import { decodeMemoryScopeV1 } from '../service/snapshot.js'
import {
  digestWorkerValue,
  freezeWorkerValue,
  snapshotWorkerJson,
} from './snapshot.js'
import type {
  InternalMemoryWorkerSourceRefV1,
  MemoryConsolidationJobV1,
  MemoryOutboxEnvelopeV1,
  MemoryRetryPolicyV1,
  MemoryWorkerLeaseV1,
} from './types.js'
import {
  boundedInteger,
  decodeReasonCode,
  decodeWorkerRef,
  decodeWorkerSourceRef,
  requireSchema,
  requireTimeOrder,
  timestampFrom,
  workerFail,
} from './validation-core.js'

const MAX_SOURCE_REFS = 64
const MAX_ATTEMPTS = 16
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1_000

export function decodeMemoryConsolidationJobV1(
  input: unknown,
): MemoryConsolidationJobV1 {
  const root = objectValue(snapshotWorkerJson(input), [], [
    'schema', 'jobId', 'operation', 'scope', 'sourceRevision', 'sourceRefs',
    'requestedAt', 'profileRef', 'providerMode', 'costCeilingMicrousd',
    'maxCandidateRefs', 'outputDisposition',
  ])
  requireSchema(root, 'datazup.memory.consolidation-job/v1')
  const sourceRefs = decodeSourceRefs(required(root, 'sourceRefs', []))
  const providerMode = enumValue(root, 'providerMode', [], [
    'none', 'simulated-local', 'external',
  ] as const)
  const costCeilingMicrousd = boundedInteger(
    root,
    'costCeilingMicrousd',
    [],
    0,
    1_000_000_000,
  )
  if (providerMode === 'none' && costCeilingMicrousd !== 0) {
    workerFail('invalid-value', ['costCeilingMicrousd'])
  }
  if (stringValue(root, 'outputDisposition', []) !== 'candidate-review-required') {
    workerFail('invalid-value', ['outputDisposition'])
  }
  return freezeWorkerValue({
    schema: 'datazup.memory.consolidation-job/v1' as const,
    jobId: identifierValue(root, 'jobId', []),
    operation: enumValue(root, 'operation', [], ['extract', 'consolidate'] as const),
    scope: decodeMemoryScopeV1(required(root, 'scope', [])),
    sourceRevision: boundedInteger(root, 'sourceRevision', [], 0, Number.MAX_SAFE_INTEGER),
    sourceRefs,
    requestedAt: timestampFrom(root, 'requestedAt', []),
    profileRef: decodeWorkerRef(required(root, 'profileRef', []), ['profileRef']),
    providerMode,
    costCeilingMicrousd,
    maxCandidateRefs: boundedInteger(root, 'maxCandidateRefs', [], 1, 64),
    outputDisposition: 'candidate-review-required' as const,
  })
}

export function digestMemoryConsolidationJobV1(
  input: MemoryConsolidationJobV1,
): `sha256:${string}` {
  return digestWorkerValue(decodeMemoryConsolidationJobV1(input))
}

export function decodeMemoryRetryPolicyV1(input: unknown): MemoryRetryPolicyV1 {
  const root = objectValue(snapshotWorkerJson(input), [], [
    'schema', 'maxAttempts', 'backoffMs', 'retryableReasonCodes',
  ])
  requireSchema(root, 'datazup.memory.retry-policy/v1')
  const maxAttempts = boundedInteger(root, 'maxAttempts', [], 1, MAX_ATTEMPTS)
  const backoffValue = required(root, 'backoffMs', [])
  if (!Array.isArray(backoffValue) || backoffValue.length !== maxAttempts - 1) {
    workerFail('invalid-value', ['backoffMs'])
  }
  const backoffMs = backoffValue.map((value, index) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)
      || value < 0 || value > MAX_BACKOFF_MS) {
      workerFail('invalid-value', ['backoffMs', String(index)])
    }
    return value
  })
  if (backoffMs.some((value, index) => index > 0 && value < backoffMs[index - 1]!)) {
    workerFail('invalid-value', ['backoffMs'])
  }
  const reasonValue = required(root, 'retryableReasonCodes', [])
  if (!Array.isArray(reasonValue) || reasonValue.length === 0 || reasonValue.length > 16) {
    workerFail('limit-exceeded', ['retryableReasonCodes'])
  }
  const retryableReasonCodes = reasonValue.map((value, index) => {
    const record = objectValue({ value } as SafeJson, [], ['value'])
    return decodeReasonCode(record, 'value', ['retryableReasonCodes', String(index)])
  })
  if (new Set(retryableReasonCodes).size !== retryableReasonCodes.length
    || retryableReasonCodes.join('\n') !== [...retryableReasonCodes].sort().join('\n')) {
    workerFail('invalid-value', ['retryableReasonCodes'])
  }
  return freezeWorkerValue({
    schema: 'datazup.memory.retry-policy/v1' as const,
    maxAttempts,
    backoffMs,
    retryableReasonCodes,
  })
}

export function decodeMemoryOutboxEnvelopeV1(
  input: unknown,
): MemoryOutboxEnvelopeV1 {
  const root = objectValue(snapshotWorkerJson(input), [], [
    'schema', 'envelopeId', 'idempotencyKey', 'job', 'jobDigest',
    'retryPolicy', 'schedulerRef', 'policyRef', 'budgetRef',
    'providerRouteRef', 'createdAt', 'notBefore', 'deadlineAt', 'envelopeDigest',
  ])
  requireSchema(root, 'datazup.memory.outbox-envelope/v1')
  const job = decodeMemoryConsolidationJobV1(required(root, 'job', []))
  const jobDigest = digestValue(root, 'jobDigest', [])
  if (jobDigest !== digestMemoryConsolidationJobV1(job)) {
    workerFail('invalid-value', ['jobDigest'])
  }
  const providerRouteRef = root['providerRouteRef'] === undefined
    ? undefined
    : decodeWorkerRef(root['providerRouteRef'], ['providerRouteRef'])
  if ((job.providerMode === 'external') !== (providerRouteRef !== undefined)) {
    workerFail('invalid-value', ['providerRouteRef'])
  }
  const createdAt = timestampFrom(root, 'createdAt', [])
  const notBefore = timestampFrom(root, 'notBefore', [])
  const deadlineAt = timestampFrom(root, 'deadlineAt', [])
  if (job.sourceRevision > Number.MAX_SAFE_INTEGER - 1) {
    workerFail('invalid-value', ['job', 'sourceRevision'])
  }
  requireTimeOrder(job.requestedAt, createdAt, ['createdAt'], true)
  requireTimeOrder(createdAt, notBefore, ['notBefore'], true)
  requireTimeOrder(notBefore, deadlineAt, ['deadlineAt'])
  const envelope: Omit<MemoryOutboxEnvelopeV1, 'envelopeDigest'> = {
    schema: 'datazup.memory.outbox-envelope/v1',
    envelopeId: identifierValue(root, 'envelopeId', []),
    idempotencyKey: identifierValue(root, 'idempotencyKey', []),
    job,
    jobDigest,
    retryPolicy: decodeMemoryRetryPolicyV1(required(root, 'retryPolicy', [])),
    schedulerRef: decodeWorkerRef(required(root, 'schedulerRef', []), ['schedulerRef']),
    policyRef: decodeWorkerRef(required(root, 'policyRef', []), ['policyRef']),
    budgetRef: decodeWorkerRef(required(root, 'budgetRef', []), ['budgetRef']),
    ...(providerRouteRef === undefined ? {} : { providerRouteRef }),
    createdAt,
    notBefore,
    deadlineAt,
  }
  const envelopeDigest = digestValue(root, 'envelopeDigest', [])
  if (envelopeDigest !== digestWorkerValue(envelope)) {
    workerFail('invalid-value', ['envelopeDigest'])
  }
  return freezeWorkerValue({ ...envelope, envelopeDigest })
}

export function sealMemoryOutboxEnvelopeV1(input: unknown): MemoryOutboxEnvelopeV1 {
  const root = objectValue(snapshotWorkerJson(input), [], [
    'schema', 'envelopeId', 'idempotencyKey', 'job', 'retryPolicy',
    'schedulerRef', 'policyRef', 'budgetRef', 'providerRouteRef', 'createdAt',
    'notBefore', 'deadlineAt',
  ])
  requireSchema(root, 'datazup.memory.outbox-prepare/v1')
  const job = decodeMemoryConsolidationJobV1(required(root, 'job', []))
  const base = {
    schema: 'datazup.memory.outbox-envelope/v1' as const,
    envelopeId: identifierValue(root, 'envelopeId', []),
    idempotencyKey: identifierValue(root, 'idempotencyKey', []),
    job,
    jobDigest: digestMemoryConsolidationJobV1(job),
    retryPolicy: decodeMemoryRetryPolicyV1(required(root, 'retryPolicy', [])),
    schedulerRef: decodeWorkerRef(required(root, 'schedulerRef', []), ['schedulerRef']),
    policyRef: decodeWorkerRef(required(root, 'policyRef', []), ['policyRef']),
    budgetRef: decodeWorkerRef(required(root, 'budgetRef', []), ['budgetRef']),
    ...(root['providerRouteRef'] === undefined ? {} : {
      providerRouteRef: decodeWorkerRef(root['providerRouteRef'], ['providerRouteRef']),
    }),
    createdAt: timestampFrom(root, 'createdAt', []),
    notBefore: timestampFrom(root, 'notBefore', []),
    deadlineAt: timestampFrom(root, 'deadlineAt', []),
  }
  return decodeMemoryOutboxEnvelopeV1({
    ...base,
    envelopeDigest: digestWorkerValue(base),
  })
}

export function decodeMemoryWorkerLeaseV1(input: unknown): MemoryWorkerLeaseV1 {
  const root = objectValue(snapshotWorkerJson(input), [], [
    'schema', 'envelopeId', 'envelopeDigest', 'workerId', 'generation',
    'attempt', 'acquiredAt', 'expiresAt', 'leaseDigest',
  ])
  requireSchema(root, 'datazup.memory.worker-lease/v1')
  const base: Omit<MemoryWorkerLeaseV1, 'leaseDigest'> = {
    schema: 'datazup.memory.worker-lease/v1',
    envelopeId: identifierValue(root, 'envelopeId', []),
    envelopeDigest: digestValue(root, 'envelopeDigest', []),
    workerId: identifierValue(root, 'workerId', []),
    generation: boundedInteger(root, 'generation', [], 1, Number.MAX_SAFE_INTEGER),
    attempt: boundedInteger(root, 'attempt', [], 1, MAX_ATTEMPTS),
    acquiredAt: timestampFrom(root, 'acquiredAt', []),
    expiresAt: timestampFrom(root, 'expiresAt', []),
  }
  requireTimeOrder(base.acquiredAt, base.expiresAt, ['expiresAt'])
  const leaseDigest = digestValue(root, 'leaseDigest', [])
  if (leaseDigest !== digestWorkerValue(base)) workerFail('invalid-value', ['leaseDigest'])
  return freezeWorkerValue({ ...base, leaseDigest })
}

export function sealMemoryWorkerLeaseV1(
  input: Omit<MemoryWorkerLeaseV1, 'leaseDigest'>,
): MemoryWorkerLeaseV1 {
  return decodeMemoryWorkerLeaseV1({ ...input, leaseDigest: digestWorkerValue(input) })
}

function decodeSourceRefs(value: SafeJson): readonly InternalMemoryWorkerSourceRefV1[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SOURCE_REFS) {
    workerFail('limit-exceeded', ['sourceRefs'])
  }
  const refs = value.map((entry, index) =>
    decodeWorkerSourceRef(entry, ['sourceRefs', String(index)]))
  const keys = refs.map(ref => `${ref.owner}\0${ref.id}\0${ref.versionId ?? ''}\0${ref.digest}`)
  if (new Set(keys).size !== keys.length || keys.join('\n') !== [...keys].sort().join('\n')) {
    workerFail('invalid-value', ['sourceRefs'])
  }
  return Object.freeze(refs)
}
