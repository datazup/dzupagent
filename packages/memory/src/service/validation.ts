import {
  booleanValue,
  digestValue,
  enumValue,
  identifierValue,
  integerValue,
  objectValue,
  required,
  stringValue,
  timestampValue,
  type JsonObject,
} from '../records/decoder-primitives.js'
import { decodeMemoryRecordV1 } from '../records/decoder.js'
import type { SafeJson } from '../records/safe-json.js'
import { deepFreezeSafeJson } from '../records/safe-json.js'
import { decodeMemoryCommandV1 } from '../lifecycle/validation.js'
import { decodeMemoryEventV1, decodeMemoryTransitionReceiptV1 } from '../lifecycle/ledger.js'
import { transitionFail } from '../lifecycle/errors.js'
import {
  decodeMemoryScopeV1,
  decodeMemoryServiceSnapshotV1,
  digestServiceValue,
  snapshotServiceJson,
} from './snapshot.js'
import type {
  InternalMemoryCheckpointV1,
  InternalMemoryLifecycleWriteResultV1,
  InternalMemoryLifecycleQueryInputV1,
  InternalMemoryLifecycleWriteInputV1,
  InternalMemoryServiceSnapshotV1,
  InternalMemoryStoreOutcomeV1,
  MemoryAdapterCapabilitiesV1,
} from './types.js'

const REASONS = [
  'none', 'not-found', 'cas-conflict', 'checkpoint-required',
  'checkpoint-conflict', 'unsupported-capability', 'capacity-exceeded',
  'store-unavailable', 'ambiguous-outcome', 'invalid-store-snapshot',
  'compatibility-mismatch', 'invalidation-incomplete',
] as const

export function decodeMemoryAdapterCapabilitiesV1(
  input: unknown,
): MemoryAdapterCapabilitiesV1 {
  const root = objectValue(snapshotServiceJson(input), ['capabilities'], [
    'schema', 'atomicCompareAndSwap', 'transactions', 'checkpoints', 'delete',
    'purge', 'indexInvalidation', 'durableIdempotency',
    'authenticatedCustody', 'limits',
  ])
  const schema = stringValue(root, 'schema', ['capabilities'])
  if (schema !== 'datazup.memory.adapter-capabilities/v1') {
    transitionFail('invalid-state', ['capabilities', 'schema'])
  }
  const limits = objectValue(required(root, 'limits', ['capabilities']), [
    'capabilities', 'limits',
  ], ['records', 'events', 'receipts', 'checkpoints', 'tombstones'])
  const output: MemoryAdapterCapabilitiesV1 = {
    schema,
    atomicCompareAndSwap: booleanValue(root, 'atomicCompareAndSwap', ['capabilities']),
    transactions: booleanValue(root, 'transactions', ['capabilities']),
    checkpoints: booleanValue(root, 'checkpoints', ['capabilities']),
    delete: booleanValue(root, 'delete', ['capabilities']),
    purge: booleanValue(root, 'purge', ['capabilities']),
    indexInvalidation: booleanValue(root, 'indexInvalidation', ['capabilities']),
    durableIdempotency: booleanValue(root, 'durableIdempotency', ['capabilities']),
    authenticatedCustody: booleanValue(root, 'authenticatedCustody', ['capabilities']),
    limits: {
      records: boundedInteger(limits, 'records', 1, 64),
      events: boundedInteger(limits, 'events', 32, 128),
      receipts: boundedInteger(limits, 'receipts', 32, 128),
      checkpoints: boundedInteger(limits, 'checkpoints', 0, 8),
      tombstones: boundedInteger(limits, 'tombstones', 0, 32),
    },
  }
  if (output.limits.events !== output.limits.receipts
    || (output.checkpoints && output.limits.checkpoints === 0)
    || (!output.checkpoints && output.limits.checkpoints !== 0)) {
    transitionFail('invalid-state', ['capabilities', 'limits'])
  }
  return deepFreezeSafeJson(
    snapshotServiceJson(output),
  ) as unknown as MemoryAdapterCapabilitiesV1
}

export function decodeLifecycleWriteInputV1(
  input: unknown,
): InternalMemoryLifecycleWriteInputV1 {
  const root = objectValue(snapshotServiceJson(input), [], [
    'scope', 'command', 'checkpoint', 'compatibility', 'invalidationTargets',
  ])
  const scope = decodeMemoryScopeV1(required(root, 'scope', []))
  const command = decodeMemoryCommandV1(required(root, 'command', []))
  if (digestServiceValue(scope) !== digestServiceValue(command.record.scope)) {
    transitionFail('identity-mismatch', ['scope'])
  }
  const checkpoint = root['checkpoint'] === undefined
    ? undefined
    : decodeCheckpointInstruction(root['checkpoint'])
  const compatibility = root['compatibility'] === undefined
    ? undefined
    : decodeCompatibilityInput(root['compatibility'])
  const invalidationTargets = root['invalidationTargets'] === undefined
    ? undefined
    : decodeInvalidationTargets(root['invalidationTargets'])
  return deepFreezeSafeJson(snapshotServiceJson({
    scope,
    command,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(compatibility === undefined ? {} : { compatibility }),
    ...(invalidationTargets === undefined ? {} : { invalidationTargets }),
  })) as unknown as InternalMemoryLifecycleWriteInputV1
}

export function decodeLifecycleQueryInputV1(
  input: unknown,
): InternalMemoryLifecycleQueryInputV1 {
  const root = objectValue(snapshotServiceJson(input), [], [
    'scope', 'memoryId', 'includeHistory', 'includeDisputed',
  ])
  const includeHistory = root['includeHistory']
  const includeDisputed = root['includeDisputed']
  return deepFreezeSafeJson(snapshotServiceJson({
    scope: decodeMemoryScopeV1(required(root, 'scope', [])),
    memoryId: identifierValue(root, 'memoryId', []),
    ...(includeHistory === undefined ? {} : {
      includeHistory: booleanValue(root, 'includeHistory', []),
    }),
    ...(includeDisputed === undefined ? {} : {
      includeDisputed: booleanValue(root, 'includeDisputed', []),
    }),
  })) as unknown as InternalMemoryLifecycleQueryInputV1
}

export function decodeMemoryStoreOutcomeV1(input: unknown): InternalMemoryStoreOutcomeV1 {
  const root = objectValue(snapshotServiceJson(input), [], [
    'schema', 'status', 'reason', 'snapshot', 'receipt', 'event', 'records',
    'checkpoint',
  ])
  const schema = stringValue(root, 'schema', [])
  if (schema !== 'datazup.memory.store-outcome/v1') {
    transitionFail('invalid-state', ['schema'])
  }
  const status = enumValue(root, 'status', [], [
    'committed', 'replayed', 'conflict', 'unsupported', 'ambiguous', 'rejected',
  ] as const)
  const reason = enumValue(root, 'reason', [], REASONS)
  const snapshot = root['snapshot'] === undefined
    ? undefined
    : decodeMemoryServiceSnapshotV1(root['snapshot'])
  const receipt = root['receipt'] === undefined
    ? undefined
    : decodeMemoryTransitionReceiptV1(root['receipt'])
  const event = root['event'] === undefined
    ? undefined
    : decodeMemoryEventV1(root['event'])
  const records = root['records'] === undefined
    ? undefined
    : decodeRecords(root['records'])
  const checkpoint = root['checkpoint'] === undefined
    ? undefined
    : checkpointFromSnapshot(root['checkpoint'], snapshot)
  if (['committed', 'replayed'].includes(status) && !snapshot) {
    transitionFail('invalid-state', ['snapshot'])
  }
  const expectedReasons: Record<typeof status, readonly (typeof REASONS)[number][]> = {
    committed: ['none'],
    replayed: ['none'],
    conflict: ['cas-conflict', 'checkpoint-conflict'],
    unsupported: ['unsupported-capability'],
    ambiguous: ['ambiguous-outcome'],
    rejected: ['capacity-exceeded', 'checkpoint-conflict'],
  }
  if (!expectedReasons[status].includes(reason)) {
    transitionFail('invalid-state', ['reason'])
  }
  if (!['committed', 'replayed'].includes(status)
    && [snapshot, receipt, event, records, checkpoint].some(value => value !== undefined)) {
    transitionFail('invalid-state')
  }
  if (checkpoint !== undefined
    && [receipt, event, records].some(value => value !== undefined)) {
    transitionFail('invalid-state', ['checkpoint'])
  }
  return deepFreezeSafeJson(snapshotServiceJson({
    schema,
    status,
    reason,
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(receipt === undefined ? {} : { receipt }),
    ...(event === undefined ? {} : { event }),
    ...(records === undefined ? {} : { records }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  })) as unknown as InternalMemoryStoreOutcomeV1
}

export function decodeMemoryInvalidationResultV1(
  input: unknown,
): NonNullable<InternalMemoryLifecycleWriteResultV1['invalidation']> {
  const root = objectValue(snapshotServiceJson(input), ['invalidation'], [
    'schema', 'status', 'outcomes',
  ])
  const schema = stringValue(root, 'schema', ['invalidation'])
  if (schema !== 'datazup.memory.invalidation-result/v1') {
    transitionFail('invalid-state', ['invalidation', 'schema'])
  }
  const status = enumValue(root, 'status', ['invalidation'], [
    'completed', 'partial', 'unsupported', 'retryable',
  ] as const)
  const value = required(root, 'outcomes', ['invalidation'])
  if (!Array.isArray(value) || value.length > 16) {
    transitionFail('limit-exceeded', ['invalidation', 'outcomes'])
  }
  const outcomes = value.map((entry, index) => {
    const path = ['invalidation', 'outcomes', String(index)]
    const item = objectValue(entry, path, ['target', 'status', 'receiptRef'])
    const receiptRef = item['receiptRef'] === undefined
      ? undefined
      : decodeReference(item['receiptRef'], [...path, 'receiptRef'])
    return {
      target: decodeInvalidationTarget(required(item, 'target', path), [...path, 'target']),
      status: enumValue(item, 'status', path, ['completed', 'unsupported', 'retryable'] as const),
      ...(receiptRef === undefined ? {} : { receiptRef }),
    }
  })
  const completed = outcomes.filter(outcome => outcome.status === 'completed').length
  if ((status === 'completed' && completed !== outcomes.length)
    || (status === 'partial' && (completed === 0 || completed === outcomes.length))
    || (status === 'unsupported'
      && outcomes.some(outcome => outcome.status !== 'unsupported'))
    || (status === 'retryable'
      && (completed > 0 || outcomes.every(outcome => outcome.status === 'unsupported')))) {
    transitionFail('invalid-state', ['invalidation', 'status'])
  }
  return deepFreezeSafeJson(
    snapshotServiceJson({ schema, status, outcomes }),
  ) as unknown as NonNullable<InternalMemoryLifecycleWriteResultV1['invalidation']>
}

function decodeCheckpointInstruction(value: SafeJson) {
  const root = objectValue(value, ['checkpoint'], ['checkpointId', 'checkpointedAt'])
  return {
    checkpointId: identifierValue(root, 'checkpointId', ['checkpoint']),
    checkpointedAt: timestampValue(root, 'checkpointedAt', ['checkpoint']),
  }
}

function decodeCompatibilityInput(value: SafeJson) {
  const root = objectValue(value, ['compatibility'], [
    'stagedRecord', 'confirmationReceipt',
  ])
  return {
    stagedRecord: required(root, 'stagedRecord', ['compatibility']),
    ...(root['confirmationReceipt'] === undefined ? {} : {
      confirmationReceipt: root['confirmationReceipt'],
    }),
  }
}

function decodeInvalidationTargets(value: SafeJson) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    transitionFail('limit-exceeded', ['invalidationTargets'])
  }
  const targets = value.map((entry, index) =>
    decodeInvalidationTarget(entry, ['invalidationTargets', String(index)]))
  const identities = targets.map(target => `${target.kind}\0${target.owner}\0${target.id}`)
  if (new Set(identities).size !== identities.length) {
    transitionFail('invalid-command', ['invalidationTargets'])
  }
  return targets
}

function decodeInvalidationTarget(value: SafeJson, path: readonly string[]) {
  const root = objectValue(value, path, ['kind', 'owner', 'id', 'digest'])
  return {
    kind: enumValue(root, 'kind', path, ['cache', 'index'] as const),
    owner: identifierValue(root, 'owner', path),
    id: identifierValue(root, 'id', path),
    digest: digestValue(root, 'digest', path),
  }
}

function decodeReference(value: SafeJson, path: readonly string[]) {
  const root = objectValue(value, path, ['owner', 'id', 'digest'])
  return {
    owner: identifierValue(root, 'owner', path),
    id: identifierValue(root, 'id', path),
    digest: digestValue(root, 'digest', path),
  }
}

function decodeRecords(value: SafeJson) {
  if (!Array.isArray(value) || value.length > 64) {
    transitionFail('limit-exceeded', ['records'])
  }
  return value.map(entry => decodeMemoryRecordV1(entry))
}

function checkpointFromSnapshot(
  value: SafeJson,
  snapshot: InternalMemoryServiceSnapshotV1 | undefined,
): InternalMemoryCheckpointV1 {
  if (!snapshot) transitionFail('invalid-state', ['checkpoint'])
  const digest = digestServiceValue(value)
  const checkpoint = snapshot.checkpoints.find(entry => digestServiceValue(entry) === digest)
  if (!checkpoint) transitionFail('invalid-state', ['checkpoint'])
  return checkpoint
}

function boundedInteger(
  root: JsonObject,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = integerValue(root, key, ['capabilities', 'limits'])
  if (value < minimum || value > maximum) {
    transitionFail('limit-exceeded', ['capabilities', 'limits', key])
  }
  return value
}
