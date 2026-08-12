import {
  enumValue,
  integerValue,
  objectValue,
  required,
} from '../records/decoder-primitives.js'
import type { SafeJson } from '../records/safe-json.js'
import {
  digestWorkerValue,
  freezeWorkerValue,
  memoryWorkerScopeDigest,
  snapshotWorkerJson,
} from './snapshot.js'
import type {
  InternalMemoryOutboxEntryV1,
  InternalMemoryOutboxStateV1,
  MemoryWorkerCheckpointV1,
} from './types.js'
import {
  decodeMemoryOutboxEnvelopeV1,
  decodeMemoryWorkerLeaseV1,
} from './validation-contracts.js'
import {
  decodeMemoryDeadLetterV1,
  decodeMemoryWorkerCheckpointV1,
  decodeMemoryWorkerOutcomeV1,
} from './validation-results.js'
import {
  decodeWorkerRef,
  requireSchema,
  timestampFrom,
  workerFail,
} from './validation-core.js'

export function decodeMemoryOutboxStateV1(input: unknown): InternalMemoryOutboxStateV1 {
  const root = objectValue(snapshotWorkerJson(input), [], [
    'schema', 'revision', 'sequence', 'entries', 'checkpoints', 'stateDigest',
  ])
  requireSchema(root, 'datazup.memory.in-memory-outbox-state/v1')
  const entries = decodeEntries(required(root, 'entries', []))
  const checkpoints = decodeCheckpoints(required(root, 'checkpoints', []))
  const revision = integerValue(root, 'revision', [])
  const sequence = integerValue(root, 'sequence', [])
  if (revision !== sequence || revision < entries.length) {
    workerFail('invalid-value', ['revision'])
  }
  validateCheckpoints(checkpoints, revision, entries.length)
  for (const [index, entry] of entries.entries()) {
    if ((entry.outcome?.revision ?? 0) > revision) {
      workerFail('invalid-value', ['entries', String(index), 'outcome', 'revision'])
    }
  }
  const base: Omit<InternalMemoryOutboxStateV1, 'stateDigest'> = {
    schema: 'datazup.memory.in-memory-outbox-state/v1',
    revision,
    sequence,
    entries,
    checkpoints,
  }
  const stateDigest = root['stateDigest']
  if (typeof stateDigest !== 'string' || stateDigest !== digestWorkerValue(base)) {
    workerFail('invalid-value', ['stateDigest'])
  }
  return freezeWorkerValue({ ...base, stateDigest })
}

export function sealMemoryOutboxStateV1(
  input: Omit<InternalMemoryOutboxStateV1, 'stateDigest'>,
): InternalMemoryOutboxStateV1 {
  return decodeMemoryOutboxStateV1({ ...input, stateDigest: digestWorkerValue(input) })
}

export function emptyMemoryOutboxStateV1(): InternalMemoryOutboxStateV1 {
  return sealMemoryOutboxStateV1({
    schema: 'datazup.memory.in-memory-outbox-state/v1',
    revision: 0,
    sequence: 0,
    entries: [],
    checkpoints: [],
  })
}

export function workerStateCounts(
  entries: readonly InternalMemoryOutboxEntryV1[],
): MemoryWorkerCheckpointV1['counts'] {
  return freezeWorkerValue({
    pending: entries.filter(entry => entry.state === 'pending').length,
    leased: entries.filter(entry => entry.state === 'leased').length,
    executing: entries.filter(entry => entry.state === 'executing').length,
    reconciling: entries.filter(entry => entry.state === 'reconciling').length,
    ambiguous: entries.filter(entry => entry.state === 'ambiguous').length,
    completed: entries.filter(entry => entry.state === 'completed').length,
    deadLettered: entries.filter(entry => entry.state === 'dead-lettered').length,
  })
}

export function entryStorageKey(entry: InternalMemoryOutboxEntryV1): string {
  return `${memoryWorkerScopeDigest(entry.envelope.job.scope)}\0${entry.envelope.envelopeId}`
}

export function idempotencyStorageKey(entry: InternalMemoryOutboxEntryV1): string {
  return `${memoryWorkerScopeDigest(entry.envelope.job.scope)}\0${entry.envelope.idempotencyKey}`
}

function decodeEntries(value: SafeJson): readonly InternalMemoryOutboxEntryV1[] {
  if (!Array.isArray(value) || value.length > 256) workerFail('limit-exceeded', ['entries'])
  const entries = value.map((item, index) => decodeEntry(item, ['entries', String(index)]))
  const entryKeys = entries.map(entryStorageKey)
  const idempotencyKeys = entries.map(idempotencyStorageKey)
  if (new Set(entryKeys).size !== entryKeys.length
    || new Set(idempotencyKeys).size !== idempotencyKeys.length
    || entryKeys.join('\n') !== [...entryKeys].sort().join('\n')) {
    workerFail('invalid-value', ['entries'])
  }
  return Object.freeze(entries)
}

function decodeEntry(value: SafeJson, path: readonly string[]): InternalMemoryOutboxEntryV1 {
  const root = objectValue(value, path, [
    'envelope', 'state', 'attempt', 'generation', 'nextAvailableAt', 'lease',
    'outcome', 'reconciliationRef', 'deadLetter',
  ])
  const envelope = decodeMemoryOutboxEnvelopeV1(required(root, 'envelope', path))
  const state = enumValue(root, 'state', path, [
    'pending', 'leased', 'executing', 'reconciling', 'ambiguous', 'completed', 'dead-lettered',
  ] as const)
  const attempt = integerValue(root, 'attempt', path)
  const generation = integerValue(root, 'generation', path)
  if (attempt > envelope.retryPolicy.maxAttempts || generation > Number.MAX_SAFE_INTEGER) {
    workerFail('invalid-value', [...path, 'attempt'])
  }
  const lease = root['lease'] === undefined
    ? undefined
    : decodeMemoryWorkerLeaseV1(root['lease'])
  const outcome = root['outcome'] === undefined
    ? undefined
    : decodeMemoryWorkerOutcomeV1(root['outcome'])
  const reconciliationRef = root['reconciliationRef'] === undefined
    ? undefined
    : decodeWorkerRef(root['reconciliationRef'], [...path, 'reconciliationRef'])
  const deadLetter = root['deadLetter'] === undefined
    ? undefined
    : decodeMemoryDeadLetterV1(root['deadLetter'])
  const entry: InternalMemoryOutboxEntryV1 = {
    envelope,
    state,
    attempt,
    generation,
    nextAvailableAt: timestampFrom(root, 'nextAvailableAt', path),
    ...(lease === undefined ? {} : { lease }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(reconciliationRef === undefined ? {} : { reconciliationRef }),
    ...(deadLetter === undefined ? {} : { deadLetter }),
  }
  validateEntry(entry, path)
  return freezeWorkerValue(entry)
}

function validateEntry(entry: InternalMemoryOutboxEntryV1, path: readonly string[]): void {
  const { envelope, state, lease, outcome, reconciliationRef, deadLetter } = entry
  if (entry.nextAvailableAt < envelope.createdAt
    || entry.nextAvailableAt > envelope.deadlineAt) {
    workerFail('invalid-time-order', [...path, 'nextAvailableAt'])
  }
  if (lease && (lease.envelopeId !== envelope.envelopeId
    || lease.envelopeDigest !== envelope.envelopeDigest
    || lease.attempt !== entry.attempt
    || lease.generation !== entry.generation)) {
    workerFail('invalid-value', [...path, 'lease'])
  }
  if (outcome && (outcome.envelopeId !== envelope.envelopeId
    || outcome.envelopeDigest !== envelope.envelopeDigest
    || outcome.jobId !== envelope.job.jobId
    || outcome.jobDigest !== envelope.jobDigest
    || outcome.attempt !== entry.attempt
    || outcome.generation !== entry.generation)) {
    workerFail('invalid-value', [...path, 'outcome'])
  }
  const needsLease = state === 'leased' || state === 'executing' || state === 'reconciling'
  if (needsLease !== (lease !== undefined)
    || ((state === 'ambiguous' || state === 'reconciling')
      !== (reconciliationRef !== undefined))
    || (state === 'dead-lettered') !== (deadLetter !== undefined)) {
    workerFail('invalid-value', [...path, 'state'])
  }
  if (state === 'pending' && outcome && outcome.status !== 'retry-scheduled') {
    workerFail('invalid-value', [...path, 'outcome'])
  }
  if (state === 'ambiguous' && outcome?.status !== 'ambiguous') {
    workerFail('invalid-value', [...path, 'outcome'])
  }
  if (state === 'completed'
    && !['completed', 'partial', 'reconciled'].includes(outcome?.status ?? '')) {
    workerFail('invalid-value', [...path, 'outcome'])
  }
  if (state === 'dead-lettered' && outcome?.status !== 'dead-lettered') {
    workerFail('invalid-value', [...path, 'outcome'])
  }
  if (((state === 'leased' || state === 'executing') && outcome !== undefined)
    || (state === 'pending' && (lease !== undefined || deadLetter !== undefined))
    || (state === 'completed' && (lease !== undefined || deadLetter !== undefined))) {
    workerFail('invalid-value', [...path, 'state'])
  }
  if (deadLetter && (deadLetter.envelopeId !== envelope.envelopeId
    || deadLetter.envelopeDigest !== envelope.envelopeDigest
    || deadLetter.jobId !== envelope.job.jobId
    || deadLetter.jobDigest !== envelope.jobDigest
    || deadLetter.scopeDigest !== memoryWorkerScopeDigest(envelope.job.scope))) {
    workerFail('invalid-value', [...path, 'deadLetter'])
  }
}

function decodeCheckpoints(value: SafeJson): readonly MemoryWorkerCheckpointV1[] {
  if (!Array.isArray(value) || value.length > 32) {
    workerFail('limit-exceeded', ['checkpoints'])
  }
  const checkpoints = value.map(entry => decodeMemoryWorkerCheckpointV1(entry))
  const ids = checkpoints.map(entry => entry.checkpointId)
  if (new Set(ids).size !== ids.length) workerFail('invalid-value', ['checkpoints'])
  return Object.freeze(checkpoints)
}

function validateCheckpoints(
  checkpoints: readonly MemoryWorkerCheckpointV1[],
  revision: number,
  entryCount: number,
): void {
  for (const [index, checkpoint] of checkpoints.entries()) {
    const total = Object.values(checkpoint.counts).reduce((sum, value) => sum + value, 0)
    if (checkpoint.revision > revision || checkpoint.sequence !== checkpoint.revision
      || total !== entryCount
      || (index === 0 && checkpoint.priorCheckpointDigest !== undefined)
      || (index > 0
        && (checkpoint.priorCheckpointDigest !== checkpoints[index - 1]!.checkpointDigest
          || checkpoint.revision <= checkpoints[index - 1]!.revision
          || checkpoint.checkpointedAt < checkpoints[index - 1]!.checkpointedAt))) {
      workerFail('invalid-value', ['checkpoints', String(index)])
    }
  }
}
