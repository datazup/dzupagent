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
import {
  deepFreezeSafeJson,
  digestSafeJson,
  snapshotSafeJson,
  type SafeJson,
} from '../records/safe-json.js'
import type { MemoryScopeV1, MemoryStatusV1 } from '../records/types.js'
import { MemoryRecordDecodeError } from '../records/errors.js'
import { MemoryTransitionError, transitionFail } from '../lifecycle/errors.js'
import { decodeMemoryEventV1, decodeMemoryTransitionReceiptV1 } from '../lifecycle/ledger.js'
import type { MemoryEventV1 } from '../lifecycle/types.js'
import { digestLifecycleValue, timestampMillis } from '../lifecycle/validation.js'
import { projectMemoryHistoryV1, validateMemoryHistoryReceiptsV1 } from './history.js'
import type {
  InternalMemoryCheckpointV1,
  InternalMemoryServiceSnapshotV1,
} from './types.js'

const STATUSES = [
  'captured', 'candidate', 'review-required', 'active', 'disputed',
  'superseded', 'revoked', 'expired', 'archived', 'purged', 'rejected',
] as const satisfies readonly MemoryStatusV1[]
const SCOPE_FIELDS = [
  'tenantId', 'workspaceId', 'projectId', 'repositoryId', 'taskId', 'threadId',
  'userId', 'agentId', 'personaId', 'namespace',
] as const
const SNAPSHOT_LIMITS = {
  maxDepth: 16,
  maxTotalNodes: 65_536,
  maxTotalProperties: 32_768,
  maxObjectProperties: 128,
  maxArrayItems: 128,
  maxTotalStringBytes: 2 * 1024 * 1024,
} as const

export function snapshotServiceJson(input: unknown): SafeJson {
  return snapshotSafeJson(input, SNAPSHOT_LIMITS)
}

export function digestServiceValue(input: unknown): `sha256:${string}` {
  return digestSafeJson(snapshotServiceJson(input))
}

export function decodeMemoryScopeV1(input: unknown): MemoryScopeV1 {
  return translateServiceError('invalid-command', () => {
    const root = objectValue(snapshotServiceJson(input), ['scope'], SCOPE_FIELDS)
    const output: MemoryScopeV1 = {
      tenantId: identifierValue(root, 'tenantId', ['scope']),
      namespace: identifierValue(root, 'namespace', ['scope']),
    }
    for (const key of SCOPE_FIELDS.slice(1, -1)) {
      if (root[key] !== undefined) {
        Object.assign(output, { [key]: identifierValue(root, key, ['scope']) })
      }
    }
    return deepFreezeSafeJson(output as unknown as SafeJson) as unknown as MemoryScopeV1
  })
}

export function decodeMemoryServiceSnapshotV1(
  input: unknown,
): InternalMemoryServiceSnapshotV1 {
  return translateServiceError('invalid-state', () => {
    const root = objectValue(snapshotServiceJson(input), [], [
      'schema', 'scope', 'memoryId', 'generation', 'sequence', 'revision', 'head',
      'records', 'events', 'receipts', 'checkpoints', 'tombstones',
      'snapshotDigest',
    ])
    const schema = stringValue(root, 'schema', [])
    if (schema !== 'datazup.memory.store-snapshot/v1') {
      transitionFail('invalid-state', ['schema'])
    }
    const scope = decodeMemoryScopeV1(required(root, 'scope', []))
    const memoryId = identifierValue(root, 'memoryId', [])
    const generation = positiveInteger(root, 'generation', [])
    const sequence = nonNegativeInteger(root, 'sequence', [])
    const revision = positiveInteger(root, 'revision', [])
    const head = decodeHead(required(root, 'head', []))
    const records = decodeArray(root, 'records', 64, input => decodeMemoryRecordV1(input))
    const events = decodeArray(root, 'events', 128, decodeMemoryEventV1)
    const receipts = decodeArray(root, 'receipts', 128, decodeMemoryTransitionReceiptV1)
    const checkpoints = decodeArray(root, 'checkpoints', 8, decodeCheckpoint)
    const tombstones = decodeArray(root, 'tombstones', 32, decodeTombstone)
    const snapshotDigest = digestValue(root, 'snapshotDigest', [])
    const snapshot: InternalMemoryServiceSnapshotV1 = {
      schema,
      scope,
      memoryId,
      generation,
      sequence,
      revision,
      head,
      records,
      events,
      receipts,
      checkpoints,
      tombstones,
      snapshotDigest,
    }
    validateSnapshot(snapshot)
    const expectedDigest = digestServiceValue(snapshotWithoutDigest(snapshot))
    if (snapshotDigest !== expectedDigest) transitionFail('stale-digest', ['snapshotDigest'])
    return deepFreezeSafeJson(
      snapshotServiceJson(snapshot),
    ) as unknown as InternalMemoryServiceSnapshotV1
  })
}

export function sealMemoryServiceSnapshotV1(
  input: Omit<InternalMemoryServiceSnapshotV1, 'snapshotDigest'>,
): InternalMemoryServiceSnapshotV1 {
  const snapshot = {
    ...input,
    snapshotDigest: digestServiceValue(input),
  }
  return decodeMemoryServiceSnapshotV1(snapshot)
}

export function memoryScopeDigestV1(scope: MemoryScopeV1): `sha256:${string}` {
  return digestServiceValue({ schema: 'datazup.memory.scope-key/v1', scope })
}

function validateSnapshot(snapshot: InternalMemoryServiceSnapshotV1): void {
  if (snapshot.records.length === 0 || snapshot.events.length === 0) {
    transitionFail('invalid-state')
  }
  const chain = projectMemoryHistoryV1(snapshot.events)
  validateMemoryHistoryReceiptsV1(snapshot.events, snapshot.receipts)
  const scopeDigest = digestServiceValue(snapshot.scope)
  const recordDigests = new Set<string>()
  for (const [index, record] of snapshot.records.entries()) {
    if (record.memoryId !== snapshot.memoryId
      || digestServiceValue(record.scope) !== scopeDigest) {
      transitionFail('identity-mismatch', ['records', String(index)])
    }
    const digest = digestLifecycleValue(record)
    if (recordDigests.has(digest)) transitionFail('invalid-state', ['records', String(index)])
    recordDigests.add(digest)
  }
  for (const [index, event] of snapshot.events.entries()) {
    if (event.memoryId !== snapshot.memoryId) {
      transitionFail('identity-mismatch', ['events', String(index)])
    }
    for (const effect of event.recordEffects) {
      if (!recordDigests.has(effect.resultDigest)) {
        transitionFail('invalid-state', ['events', String(index), 'recordEffects'])
      }
    }
  }
  const last = snapshot.events.at(-1)!
  if (snapshot.revision !== snapshot.events.length + snapshot.checkpoints.length) {
    transitionFail('invalid-state', ['revision'])
  }
  const openGeneration = snapshot.generation === last.generation + 1
  if (openGeneration) {
    if (snapshot.sequence !== 0) transitionFail('invalid-state', ['sequence'])
  } else if (snapshot.generation !== last.generation || snapshot.sequence !== last.sequence) {
    transitionFail('invalid-state', ['generation'])
  }
  if (snapshot.head.versionId !== last.currentVersionId
    || snapshot.head.recordDigest !== last.currentRecordDigest
    || snapshot.head.status !== last.currentStatus
    || snapshot.head.lastTransitionAt !== last.occurredAt
    || snapshot.head.retrievalEligible !== chain.versions.find(
      version => version.versionId === last.currentVersionId,
    )?.retrievalEligible) {
    transitionFail('invalid-state', ['head'])
  }
  validateCheckpoints(snapshot)
  validateTombstones(snapshot)
}

function validateCheckpoints(snapshot: InternalMemoryServiceSnapshotV1): void {
  if (snapshot.checkpoints.length !== snapshot.generation - 1) {
    transitionFail('invalid-state', ['checkpoints'])
  }
  const ids = new Set<string>()
  for (const [index, checkpoint] of snapshot.checkpoints.entries()) {
    const expectedFrom = index + 1
    if (ids.has(checkpoint.checkpointId)
      || checkpoint.memoryId !== snapshot.memoryId
      || checkpoint.fromGeneration !== expectedFrom
      || checkpoint.toGeneration !== expectedFrom + 1
      || checkpoint.fromSequence !== 32) {
      transitionFail('invalid-state', ['checkpoints', String(index)])
    }
    ids.add(checkpoint.checkpointId)
    const eventIndex = lastEventIndexForGeneration(
      snapshot.events,
      checkpoint.fromGeneration,
    )
    if (eventIndex < 0) transitionFail('invalid-state', ['checkpoints', String(index)])
    const event = snapshot.events[eventIndex]!
    const receipt = snapshot.receipts[eventIndex]!
    const prefix = snapshot.events.slice(0, eventIndex + 1)
    const expectedPriorSnapshotDigest = checkpointBoundarySnapshotDigest(
      snapshot,
      prefix,
      eventIndex,
      index,
    )
    if (event.sequence !== checkpoint.fromSequence
      || checkpoint.priorSnapshotDigest !== expectedPriorSnapshotDigest
      || checkpoint.stateDigest !== receipt.resultStateDigest
      || checkpoint.chainDigest !== digestLifecycleValue(projectMemoryHistoryV1(prefix))
      || checkpoint.lastEventDigest !== digestLifecycleValue(event)
      || checkpoint.lastReceiptDigest !== digestLifecycleValue(receipt)
      || timestampMillis(checkpoint.checkpointedAt) < timestampMillis(event.occurredAt)) {
      transitionFail('invalid-state', ['checkpoints', String(index)])
    }
    const next = snapshot.events[eventIndex + 1]
    if (next && (next.generation !== checkpoint.toGeneration
      || timestampMillis(next.occurredAt) < timestampMillis(checkpoint.checkpointedAt))) {
      transitionFail('invalid-state', ['checkpoints', String(index)])
    }
  }
}

function checkpointBoundarySnapshotDigest(
  snapshot: InternalMemoryServiceSnapshotV1,
  events: readonly MemoryEventV1[],
  lastEventIndex: number,
  checkpointIndex: number,
): `sha256:${string}` {
  const last = events.at(-1)!
  const chain = projectMemoryHistoryV1(events)
  const recordDigests = new Set(events.flatMap(event =>
    event.recordEffects.map(effect => effect.resultDigest)))
  const records = snapshot.records.filter(record =>
    recordDigests.has(digestLifecycleValue(record)))
  const tombstones = events.flatMap(event =>
    event.effect.kind === 'purge-proposed' ? [event.effect.tombstone] : [])
  return sealMemoryServiceSnapshotV1({
    schema: snapshot.schema,
    scope: snapshot.scope,
    memoryId: snapshot.memoryId,
    generation: last.generation,
    sequence: last.sequence,
    revision: events.length + checkpointIndex,
    head: {
      versionId: last.currentVersionId,
      recordDigest: last.currentRecordDigest,
      status: last.currentStatus,
      lastTransitionAt: last.occurredAt,
      retrievalEligible: chain.versions.find(
        version => version.versionId === last.currentVersionId,
      )!.retrievalEligible,
    },
    records,
    events,
    receipts: snapshot.receipts.slice(0, lastEventIndex + 1),
    checkpoints: snapshot.checkpoints.slice(0, checkpointIndex),
    tombstones,
  }).snapshotDigest
}

function validateTombstones(snapshot: InternalMemoryServiceSnapshotV1): void {
  const expected = snapshot.events
    .filter((event): event is MemoryEventV1 & {
      effect: Extract<MemoryEventV1['effect'], { kind: 'purge-proposed' }>
    } => event.effect.kind === 'purge-proposed')
    .map(event => event.effect.tombstone)
  if (expected.length !== snapshot.tombstones.length
    || expected.some((entry, index) =>
      digestLifecycleValue(entry) !== digestLifecycleValue(snapshot.tombstones[index]))) {
    transitionFail('invalid-state', ['tombstones'])
  }
}

function decodeHead(value: SafeJson): InternalMemoryServiceSnapshotV1['head'] {
  const root = objectValue(value, ['head'], [
    'versionId', 'recordDigest', 'status', 'lastTransitionAt', 'retrievalEligible',
  ])
  return {
    versionId: identifierValue(root, 'versionId', ['head']),
    recordDigest: digestValue(root, 'recordDigest', ['head']),
    status: enumValue(root, 'status', ['head'], STATUSES),
    lastTransitionAt: timestampValue(root, 'lastTransitionAt', ['head']),
    retrievalEligible: booleanValue(root, 'retrievalEligible', ['head']),
  }
}

function decodeCheckpoint(value: unknown): InternalMemoryCheckpointV1 {
  const root = objectValue(value as SafeJson, ['checkpoints'], [
    'schema', 'checkpointId', 'checkpointedAt', 'memoryId', 'fromGeneration',
    'fromSequence', 'toGeneration', 'priorSnapshotDigest', 'stateDigest',
    'chainDigest', 'lastEventDigest', 'lastReceiptDigest',
  ])
  const schema = stringValue(root, 'schema', ['checkpoints'])
  if (schema !== 'datazup.memory.store-checkpoint-record/v1') {
    transitionFail('invalid-state', ['checkpoints', 'schema'])
  }
  return {
    schema,
    checkpointId: identifierValue(root, 'checkpointId', ['checkpoints']),
    checkpointedAt: timestampValue(root, 'checkpointedAt', ['checkpoints']),
    memoryId: identifierValue(root, 'memoryId', ['checkpoints']),
    fromGeneration: positiveInteger(root, 'fromGeneration', ['checkpoints']),
    fromSequence: positiveInteger(root, 'fromSequence', ['checkpoints']),
    toGeneration: positiveInteger(root, 'toGeneration', ['checkpoints']),
    priorSnapshotDigest: digestValue(root, 'priorSnapshotDigest', ['checkpoints']),
    stateDigest: digestValue(root, 'stateDigest', ['checkpoints']),
    chainDigest: digestValue(root, 'chainDigest', ['checkpoints']),
    lastEventDigest: digestValue(root, 'lastEventDigest', ['checkpoints']),
    lastReceiptDigest: digestValue(root, 'lastReceiptDigest', ['checkpoints']),
  }
}

function decodeTombstone(value: unknown): InternalMemoryServiceSnapshotV1['tombstones'][number] {
  const root = objectValue(value as SafeJson, ['tombstones'], [
    'schema', 'memoryId', 'versionId', 'recordDigest', 'proposalEventId',
    'idempotencyKey',
  ])
  const schema = stringValue(root, 'schema', ['tombstones'])
  if (schema !== 'datazup.memory.purge-proposal-tombstone/v1') {
    transitionFail('invalid-state', ['tombstones', 'schema'])
  }
  return {
    schema,
    memoryId: identifierValue(root, 'memoryId', ['tombstones']),
    versionId: identifierValue(root, 'versionId', ['tombstones']),
    recordDigest: digestValue(root, 'recordDigest', ['tombstones']),
    proposalEventId: identifierValue(root, 'proposalEventId', ['tombstones']),
    idempotencyKey: identifierValue(root, 'idempotencyKey', ['tombstones']),
  }
}

function decodeArray<T>(
  root: JsonObject,
  key: string,
  maximum: number,
  decode: (input: unknown) => T,
): readonly T[] {
  const value = required(root, key, [])
  if (!Array.isArray(value)) transitionFail('invalid-state', [key])
  if (value.length > maximum) transitionFail('limit-exceeded', [key])
  return value.map(decode)
}

function snapshotWithoutDigest(
  snapshot: InternalMemoryServiceSnapshotV1,
): Omit<InternalMemoryServiceSnapshotV1, 'snapshotDigest'> {
  return {
    schema: snapshot.schema,
    scope: snapshot.scope,
    memoryId: snapshot.memoryId,
    generation: snapshot.generation,
    sequence: snapshot.sequence,
    revision: snapshot.revision,
    head: snapshot.head,
    records: snapshot.records,
    events: snapshot.events,
    receipts: snapshot.receipts,
    checkpoints: snapshot.checkpoints,
    tombstones: snapshot.tombstones,
  }
}

function lastEventIndexForGeneration(
  events: readonly MemoryEventV1[],
  generation: number,
): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.generation === generation) return index
  }
  return -1
}

function positiveInteger(root: JsonObject, key: string, path: readonly string[]): number {
  const value = integerValue(root, key, path)
  if (value < 1) transitionFail('invalid-state', [...path, key])
  return value
}

function nonNegativeInteger(root: JsonObject, key: string, path: readonly string[]): number {
  const value = integerValue(root, key, path)
  if (value < 0) transitionFail('invalid-state', [...path, key])
  return value
}

function translateServiceError<T>(
  fallback: 'invalid-command' | 'invalid-state',
  operation: () => T,
): T {
  try {
    return operation()
  } catch (cause) {
    if (cause instanceof MemoryTransitionError) throw cause
    if (cause instanceof MemoryRecordDecodeError) {
      if (cause.code === 'limit-exceeded') {
        throw new MemoryTransitionError('limit-exceeded', cause.path)
      }
      if (['unsafe-object', 'accessor-property', 'cyclic-value', 'unsupported-value'].includes(
        cause.code,
      )) {
        throw new MemoryTransitionError('unsafe-input', cause.path)
      }
      throw new MemoryTransitionError(fallback, cause.path)
    }
    throw new MemoryTransitionError('unsafe-input')
  }
}
