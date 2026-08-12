import { identifierValue, objectValue, required } from '../records/decoder-primitives.js'
import { decodeMemoryScopeV1 } from '../service/snapshot.js'
import {
  freezeWorkerValue,
  snapshotWorkerJson,
} from './snapshot.js'
import type {
  InternalMemoryOutboxLimitsV1,
  InternalMemoryOutboxStateV1,
  InternalMemoryWorkerRefV1,
  MemoryWorkerLeaseV1,
} from './types.js'
import { decodeMemoryWorkerLeaseV1 } from './validation-contracts.js'
import {
  boundedInteger,
  decodeWorkerRef,
  requireSchema,
  timestampFrom,
} from './validation-core.js'

export interface InternalClaimRequestV1 {
  readonly schema: 'datazup.memory.outbox-claim/v1'
  readonly scope: ReturnType<typeof decodeMemoryScopeV1>
  readonly workerId: string
  readonly claimedAt: string
  readonly leaseDurationMs: number
}

export interface InternalRenewRequestV1 {
  readonly schema: 'datazup.memory.outbox-renew/v1'
  readonly lease: MemoryWorkerLeaseV1
  readonly renewedAt: string
  readonly extendByMs: number
}

interface InternalAdmissionRefsV1 {
  readonly schedulerRef: InternalMemoryWorkerRefV1
  readonly policyRef: InternalMemoryWorkerRefV1
  readonly budgetRef: InternalMemoryWorkerRefV1
  readonly providerRouteRef?: InternalMemoryWorkerRefV1
}

export interface InternalRunClaimedRequestV1 extends InternalAdmissionRefsV1 {
  readonly schema: 'datazup.memory.outbox-run-claimed/v1'
  readonly lease: MemoryWorkerLeaseV1
  readonly startedAt: string
  readonly deadlineMs: number
}

export interface InternalReconcileRequestV1 extends InternalAdmissionRefsV1 {
  readonly schema: 'datazup.memory.outbox-reconcile/v1'
  readonly scope: ReturnType<typeof decodeMemoryScopeV1>
  readonly envelopeId: string
  readonly expectedGeneration: number
  readonly workerId: string
  readonly startedAt: string
  readonly leaseDurationMs: number
  readonly deadlineMs: number
}

export interface InternalCheckpointRequestV1 {
  readonly schema: 'datazup.memory.outbox-checkpoint-request/v1'
  readonly checkpointId: string
  readonly checkpointedAt: string
  readonly expectedRevision: number
  readonly expectedStateDigest: `sha256:${string}`
}

export interface InternalFactoryOptionsV1 {
  readonly limits: InternalMemoryOutboxLimitsV1
  readonly seed?: InternalMemoryOutboxStateV1
}

const DEFAULT_LIMITS: InternalMemoryOutboxLimitsV1 = {
  entries: 64,
  deadLetters: 64,
  checkpoints: 8,
}

export function decodeClaimRequest(input: unknown): InternalClaimRequestV1 {
  const root = objectValue(snapshotWorkerJson(input), [], [
    'schema', 'scope', 'workerId', 'claimedAt', 'leaseDurationMs',
  ])
  requireSchema(root, 'datazup.memory.outbox-claim/v1')
  return freezeWorkerValue({
    schema: 'datazup.memory.outbox-claim/v1' as const,
    scope: decodeMemoryScopeV1(required(root, 'scope', [])),
    workerId: identifierValue(root, 'workerId', []),
    claimedAt: timestampFrom(root, 'claimedAt', []),
    leaseDurationMs: boundedInteger(root, 'leaseDurationMs', [], 1, 60 * 60 * 1_000),
  })
}

export function decodeRenewRequest(input: unknown): InternalRenewRequestV1 {
  const root = objectValue(snapshotWorkerJson(input), [], [
    'schema', 'lease', 'renewedAt', 'extendByMs',
  ])
  requireSchema(root, 'datazup.memory.outbox-renew/v1')
  return freezeWorkerValue({
    schema: 'datazup.memory.outbox-renew/v1' as const,
    lease: decodeMemoryWorkerLeaseV1(required(root, 'lease', [])),
    renewedAt: timestampFrom(root, 'renewedAt', []),
    extendByMs: boundedInteger(root, 'extendByMs', [], 1, 60 * 60 * 1_000),
  })
}

export function decodeRunClaimedRequest(input: unknown): InternalRunClaimedRequestV1 {
  const root = objectValue(snapshotWorkerJson(input), [], [
    'schema', 'lease', 'startedAt', 'deadlineMs', 'schedulerRef', 'policyRef',
    'budgetRef', 'providerRouteRef',
  ])
  requireSchema(root, 'datazup.memory.outbox-run-claimed/v1')
  return freezeWorkerValue({
    schema: 'datazup.memory.outbox-run-claimed/v1' as const,
    lease: decodeMemoryWorkerLeaseV1(required(root, 'lease', [])),
    startedAt: timestampFrom(root, 'startedAt', []),
    deadlineMs: boundedInteger(root, 'deadlineMs', [], 1, 60_000),
    ...decodeAdmissionRefs(root),
  })
}

export function decodeReconcileRequest(input: unknown): InternalReconcileRequestV1 {
  const root = objectValue(snapshotWorkerJson(input), [], [
    'schema', 'scope', 'envelopeId', 'expectedGeneration', 'workerId',
    'startedAt', 'leaseDurationMs', 'deadlineMs', 'schedulerRef', 'policyRef',
    'budgetRef', 'providerRouteRef',
  ])
  requireSchema(root, 'datazup.memory.outbox-reconcile/v1')
  return freezeWorkerValue({
    schema: 'datazup.memory.outbox-reconcile/v1' as const,
    scope: decodeMemoryScopeV1(required(root, 'scope', [])),
    envelopeId: identifierValue(root, 'envelopeId', []),
    expectedGeneration: boundedInteger(
      root,
      'expectedGeneration',
      [],
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    workerId: identifierValue(root, 'workerId', []),
    startedAt: timestampFrom(root, 'startedAt', []),
    leaseDurationMs: boundedInteger(root, 'leaseDurationMs', [], 1, 60 * 60 * 1_000),
    deadlineMs: boundedInteger(root, 'deadlineMs', [], 1, 60_000),
    ...decodeAdmissionRefs(root),
  })
}

export function decodeCheckpointRequest(input: unknown): InternalCheckpointRequestV1 {
  const root = objectValue(snapshotWorkerJson(input), [], [
    'schema', 'checkpointId', 'checkpointedAt', 'expectedRevision',
    'expectedStateDigest',
  ])
  requireSchema(root, 'datazup.memory.outbox-checkpoint-request/v1')
  const digest = required(root, 'expectedStateDigest', [])
  if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new TypeError('invalid-value at $.expectedStateDigest')
  }
  return freezeWorkerValue({
    schema: 'datazup.memory.outbox-checkpoint-request/v1' as const,
    checkpointId: identifierValue(root, 'checkpointId', []),
    checkpointedAt: timestampFrom(root, 'checkpointedAt', []),
    expectedRevision: boundedInteger(
      root,
      'expectedRevision',
      [],
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    expectedStateDigest: digest as `sha256:${string}`,
  })
}

export function decodeFactoryOptions(input: unknown): InternalFactoryOptionsV1 {
  const root = objectValue(snapshotWorkerJson(input ?? {}), ['options'], ['limits', 'seed'])
  const limits = root['limits'] === undefined
    ? DEFAULT_LIMITS
    : decodeLimits(root['limits'])
  return {
    limits: freezeWorkerValue(limits),
    ...(root['seed'] === undefined ? {} : {
      seed: root['seed'] as unknown as InternalMemoryOutboxStateV1,
    }),
  }
}

function decodeAdmissionRefs(root: ReturnType<typeof objectValue>): InternalAdmissionRefsV1 {
  return {
    schedulerRef: decodeWorkerRef(required(root, 'schedulerRef', []), ['schedulerRef']),
    policyRef: decodeWorkerRef(required(root, 'policyRef', []), ['policyRef']),
    budgetRef: decodeWorkerRef(required(root, 'budgetRef', []), ['budgetRef']),
    ...(root['providerRouteRef'] === undefined ? {} : {
      providerRouteRef: decodeWorkerRef(root['providerRouteRef'], ['providerRouteRef']),
    }),
  }
}

function decodeLimits(input: unknown): InternalMemoryOutboxLimitsV1 {
  const root = objectValue(input as never, ['options', 'limits'], [
    'entries', 'deadLetters', 'checkpoints',
  ])
  const limits = {
    entries: boundedInteger(root, 'entries', ['options', 'limits'], 1, 256),
    deadLetters: boundedInteger(root, 'deadLetters', ['options', 'limits'], 1, 256),
    checkpoints: boundedInteger(root, 'checkpoints', ['options', 'limits'], 0, 32),
  }
  if (limits.deadLetters < limits.entries) {
    throw new TypeError('dead-letter capacity must cover every retained entry')
  }
  return limits
}

