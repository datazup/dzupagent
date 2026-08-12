import {
  actorRefValue,
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
import type { SafeJson } from '../records/safe-json.js'
import type { MemoryStatusV1 } from '../records/types.js'
import { transitionFail } from './errors.js'
import type {
  MemoryEventV1,
  MemoryLifecycleStateV1,
  MemoryTransitionReceiptV1,
} from './types.js'
import {
  COMMAND_TYPES,
  decodeEvidenceRefs,
  decodeReference,
  decodeReferences,
  digestLifecycleValue,
  freezeValue,
  snapshotLifecycleJson,
  timestampMillis,
  translateDecodeError,
  validateReasonCode,
} from './validation.js'

const EVENT_SCHEMA = 'datazup.memory.event/v1' as const
const RECEIPT_SCHEMA = 'datazup.memory.transition-receipt/v1' as const
const STATE_SCHEMA = 'datazup.memory.lifecycle-state/v1' as const
const MAX_LEDGER_ENTRIES = 32
const STATUSES = [
  'captured', 'candidate', 'review-required', 'active', 'disputed',
  'superseded', 'revoked', 'expired', 'archived', 'purged', 'rejected',
] as const satisfies readonly MemoryStatusV1[]

export function decodeMemoryEventV1(input: unknown): MemoryEventV1 {
  return translateDecodeError('invalid-event', () => {
    const root = objectValue(snapshotLifecycleJson(input), [], [
      'schema', 'eventId', 'commandId', 'idempotencyKey', 'commandDigest',
      'memoryId', 'generation', 'sequence', 'type', 'occurredAt', 'actorRef',
      'decisionRef', 'reasonCode', 'evidenceRefs', 'currentVersionId',
      'currentRecordDigest', 'currentStatus', 'recordEffects', 'effect',
    ])
    const schema = stringValue(root, 'schema', [])
    if (schema !== EVENT_SCHEMA) transitionFail('invalid-event', ['schema'])
    const type = enumValue(root, 'type', [], COMMAND_TYPES)
    const reasonCode = stringValue(root, 'reasonCode', [])
    validateReasonCode(type, reasonCode, ['reasonCode'])
    const event: MemoryEventV1 = {
      schema,
      eventId: identifierValue(root, 'eventId', []),
      commandId: identifierValue(root, 'commandId', []),
      idempotencyKey: identifierValue(root, 'idempotencyKey', []),
      commandDigest: digestValue(root, 'commandDigest', []),
      memoryId: identifierValue(root, 'memoryId', []),
      generation: positiveInteger(root, 'generation', []),
      sequence: positiveInteger(root, 'sequence', []),
      type,
      occurredAt: timestampValue(root, 'occurredAt', []),
      actorRef: actorRefValue(root, 'actorRef', []),
      decisionRef: actorRefValue(root, 'decisionRef', []),
      reasonCode,
      evidenceRefs: decodeEvidenceRefs(
        required(root, 'evidenceRefs', []),
        ['evidenceRefs'],
        'invalid-event',
      ),
      currentVersionId: identifierValue(root, 'currentVersionId', []),
      currentRecordDigest: digestValue(root, 'currentRecordDigest', []),
      currentStatus: enumValue(root, 'currentStatus', [], STATUSES),
      recordEffects: decodeRecordEffects(required(root, 'recordEffects', [])),
      effect: decodeEffect(required(root, 'effect', [])),
    }
    validateEventShape(event)
    return freezeValue(event)
  })
}

export function decodeMemoryTransitionReceiptV1(input: unknown): MemoryTransitionReceiptV1 {
  return translateDecodeError('invalid-event', () => {
    const root = objectValue(snapshotLifecycleJson(input), [], [
      'schema', 'receiptId', 'eventId', 'commandId', 'idempotencyKey',
      'commandDigest', 'memoryId', 'generation', 'sequence', 'occurredAt',
      'previousStateDigest', 'eventDigest', 'resultStateDigest', 'recordEffects',
      'effectStatus',
    ])
    const schema = stringValue(root, 'schema', [])
    if (schema !== RECEIPT_SCHEMA) transitionFail('invalid-event', ['schema'])
    const previousStateDigest = root['previousStateDigest']
    return freezeValue({
      schema,
      receiptId: identifierValue(root, 'receiptId', []),
      eventId: identifierValue(root, 'eventId', []),
      commandId: identifierValue(root, 'commandId', []),
      idempotencyKey: identifierValue(root, 'idempotencyKey', []),
      commandDigest: digestValue(root, 'commandDigest', []),
      memoryId: identifierValue(root, 'memoryId', []),
      generation: positiveInteger(root, 'generation', []),
      sequence: positiveInteger(root, 'sequence', []),
      occurredAt: timestampValue(root, 'occurredAt', []),
      ...(previousStateDigest === undefined ? {} : {
        previousStateDigest: digestValue(root, 'previousStateDigest', []),
      }),
      eventDigest: digestValue(root, 'eventDigest', []),
      resultStateDigest: digestValue(root, 'resultStateDigest', []),
      recordEffects: decodeRecordEffects(required(root, 'recordEffects', [])),
      effectStatus: enumValue(root, 'effectStatus', [], [
        'none', 'recorded', 'proposed',
      ] as const),
    })
  })
}

export function decodeMemoryLifecycleStateV1(input: unknown): MemoryLifecycleStateV1 {
  return translateDecodeError('invalid-state', () => {
    const root = objectValue(snapshotLifecycleJson(input), [], [
      'schema', 'memoryId', 'generation', 'sequence', 'versionId',
      'recordDigest', 'status', 'lastTransitionAt', 'retrievalEligible',
      'events', 'receipts',
    ])
    const schema = stringValue(root, 'schema', [])
    if (schema !== STATE_SCHEMA) transitionFail('invalid-state', ['schema'])
    const events = decodeLedgerArray(
      required(root, 'events', []),
      ['events'],
      decodeMemoryEventV1,
    )
    const receipts = decodeLedgerArray(
      required(root, 'receipts', []),
      ['receipts'],
      decodeMemoryTransitionReceiptV1,
    )
    const state: MemoryLifecycleStateV1 = {
      schema,
      memoryId: identifierValue(root, 'memoryId', []),
      generation: positiveInteger(root, 'generation', []),
      sequence: positiveInteger(root, 'sequence', []),
      versionId: identifierValue(root, 'versionId', []),
      recordDigest: digestValue(root, 'recordDigest', []),
      status: enumValue(root, 'status', [], STATUSES),
      lastTransitionAt: timestampValue(root, 'lastTransitionAt', []),
      retrievalEligible: booleanValue(root, 'retrievalEligible', []),
      events,
      receipts,
    }
    validateLedger(state)
    return freezeValue(state)
  })
}

export function digestLifecycleStateCore(input: {
  readonly memoryId: string
  readonly generation: number
  readonly sequence: number
  readonly versionId: string
  readonly recordDigest: `sha256:${string}`
  readonly status: MemoryStatusV1
  readonly lastTransitionAt: string
  readonly retrievalEligible: boolean
}): `sha256:${string}` {
  return digestLifecycleValue({
    schema: 'datazup.memory.lifecycle-state-core/v1',
    memoryId: input.memoryId,
    generation: input.generation,
    sequence: input.sequence,
    versionId: input.versionId,
    recordDigest: input.recordDigest,
    status: input.status,
    lastTransitionAt: input.lastTransitionAt,
    retrievalEligible: input.retrievalEligible,
  })
}

export function isRetrievalEligible(status: MemoryStatusV1): boolean {
  return status === 'active'
}

export function effectStatus(event: MemoryEventV1): MemoryTransitionReceiptV1['effectStatus'] {
  if (event.effect.kind === 'archive-recorded') return 'recorded'
  if (event.effect.kind === 'purge-proposed') return 'proposed'
  return 'none'
}

function decodeRecordEffects(value: SafeJson): MemoryEventV1['recordEffects'] {
  if (!Array.isArray(value)) transitionFail('invalid-event', ['recordEffects'])
  if (value.length < 1 || value.length > 2) transitionFail('limit-exceeded', ['recordEffects'])
  return value.map((entry, index) => {
    const path = ['recordEffects', String(index)]
    const record = objectValue(entry, path, [
      'versionId', 'priorDigest', 'resultDigest', 'statusFrom', 'statusTo',
      'supersedesVersionId', 'supersededByVersionId',
      'supersedingRecordDigest',
    ])
    return {
      versionId: identifierValue(record, 'versionId', path),
      ...(optionalDigest(record, 'priorDigest', path)),
      resultDigest: digestValue(record, 'resultDigest', path),
      ...(optionalStatus(record, 'statusFrom', path)),
      statusTo: enumValue(record, 'statusTo', path, STATUSES),
      ...(optionalIdentifier(record, 'supersedesVersionId', path)),
      ...(optionalIdentifier(record, 'supersededByVersionId', path)),
      ...(record['supersedingRecordDigest'] === undefined ? {} : {
        supersedingRecordDigest: digestValue(record, 'supersedingRecordDigest', path),
      }),
    }
  })
}

function decodeEffect(value: SafeJson): MemoryEventV1['effect'] {
  const root = objectValue(value, ['effect'])
  const kind = enumValue(root, 'kind', ['effect'], [
    'none', 'archive-recorded', 'purge-proposed',
  ] as const)
  if (kind === 'none') {
    objectValue(value, ['effect'], ['kind'])
    return { kind }
  }
  if (kind === 'archive-recorded') {
    objectValue(value, ['effect'], ['kind', 'receiptRef'])
    return {
      kind,
      receiptRef: decodeReference(required(root, 'receiptRef', ['effect']), [
        'effect', 'receiptRef',
      ]),
    }
  }
  objectValue(value, ['effect'], ['kind', 'targetRefs', 'tombstone'])
  return {
    kind,
    targetRefs: decodeReferences(
      required(root, 'targetRefs', ['effect']),
      ['effect', 'targetRefs'],
      16,
      'invalid-event',
    ),
    tombstone: decodeTombstone(required(root, 'tombstone', ['effect'])),
  }
}

function decodeTombstone(value: SafeJson): Extract<MemoryEventV1['effect'], {
  kind: 'purge-proposed'
}>['tombstone'] {
  const path = ['effect', 'tombstone']
  const root = objectValue(value, path, [
    'schema', 'memoryId', 'versionId', 'recordDigest', 'proposalEventId',
    'idempotencyKey',
  ])
  const schema = stringValue(root, 'schema', path)
  if (schema !== 'datazup.memory.purge-proposal-tombstone/v1') {
    transitionFail('invalid-event', [...path, 'schema'])
  }
  return {
    schema,
    memoryId: identifierValue(root, 'memoryId', path),
    versionId: identifierValue(root, 'versionId', path),
    recordDigest: digestValue(root, 'recordDigest', path),
    proposalEventId: identifierValue(root, 'proposalEventId', path),
    idempotencyKey: identifierValue(root, 'idempotencyKey', path),
  }
}

function validateEventShape(event: MemoryEventV1): void {
  const [first, second] = event.recordEffects
  if (!first) transitionFail('invalid-event', ['recordEffects'])
  if (event.type === 'correct') {
    if (!second || first.versionId === second.versionId) {
      transitionFail('invalid-event', ['recordEffects'])
    }
  } else if (second) {
    transitionFail('invalid-event', ['recordEffects'])
  }
  const current = event.recordEffects.find(effect =>
    effect.versionId === event.currentVersionId
    && effect.resultDigest === event.currentRecordDigest
    && effect.statusTo === event.currentStatus)
  if (!current) transitionFail('invalid-event', ['currentVersionId'])
  if (event.type === 'archive' && event.effect.kind !== 'archive-recorded') {
    transitionFail('invalid-event', ['effect'])
  }
  if (event.type === 'propose-purge' && event.effect.kind !== 'purge-proposed') {
    transitionFail('invalid-event', ['effect'])
  }
  if (!['archive', 'propose-purge'].includes(event.type) && event.effect.kind !== 'none') {
    transitionFail('invalid-event', ['effect'])
  }
  if (event.effect.kind === 'purge-proposed') {
    const tombstone = event.effect.tombstone
    if (tombstone.memoryId !== event.memoryId
      || tombstone.versionId !== event.currentVersionId
      || tombstone.recordDigest !== event.currentRecordDigest
      || tombstone.proposalEventId !== event.eventId
      || tombstone.idempotencyKey !== event.idempotencyKey) {
      transitionFail('invalid-event', ['effect', 'tombstone'])
    }
  }
}

function validateLedger(state: MemoryLifecycleStateV1): void {
  if (state.events.length === 0 || state.events.length !== state.receipts.length) {
    transitionFail('invalid-state', ['events'])
  }
  const identifiers = new Set<string>()
  let priorResultDigest: `sha256:${string}` | undefined
  let priorTime = -Infinity
  state.events.forEach((event, index) => {
    const receipt = state.receipts[index]!
    const sequence = index + 1
    if (event.memoryId !== state.memoryId || receipt.memoryId !== state.memoryId) {
      transitionFail('identity-mismatch', ['events', String(index), 'memoryId'])
    }
    if (event.generation !== state.generation || receipt.generation !== state.generation) {
      transitionFail('stale-generation', ['events', String(index), 'generation'])
    }
    if (event.sequence !== sequence || receipt.sequence !== sequence) {
      transitionFail('sequence-conflict', ['events', String(index), 'sequence'])
    }
    if (timestampMillis(event.occurredAt) < priorTime || receipt.occurredAt !== event.occurredAt) {
      transitionFail('time-reversal', ['events', String(index), 'occurredAt'])
    }
    priorTime = timestampMillis(event.occurredAt)
    if (receipt.eventId !== event.eventId
      || receipt.commandId !== event.commandId
      || receipt.idempotencyKey !== event.idempotencyKey
      || receipt.commandDigest !== event.commandDigest
      || receipt.eventDigest !== digestLifecycleValue(event)
      || digestLifecycleValue(receipt.recordEffects) !== digestLifecycleValue(event.recordEffects)
      || receipt.effectStatus !== effectStatus(event)) {
      transitionFail('invalid-state', ['receipts', String(index)])
    }
    if (receipt.previousStateDigest !== priorResultDigest) {
      transitionFail('invalid-state', ['receipts', String(index), 'previousStateDigest'])
    }
    const expectedResultDigest = digestLifecycleStateCore({
      memoryId: event.memoryId,
      generation: event.generation,
      sequence: event.sequence,
      versionId: event.currentVersionId,
      recordDigest: event.currentRecordDigest,
      status: event.currentStatus,
      lastTransitionAt: event.occurredAt,
      retrievalEligible: isRetrievalEligible(event.currentStatus),
    })
    if (receipt.resultStateDigest !== expectedResultDigest) {
      transitionFail('invalid-state', ['receipts', String(index), 'resultStateDigest'])
    }
    priorResultDigest = expectedResultDigest
    for (const identifier of [
      `event:${event.eventId}`, `command:${event.commandId}`,
      `idempotency:${event.idempotencyKey}`, `receipt:${receipt.receiptId}`,
    ]) {
      if (identifiers.has(identifier)) transitionFail('invalid-state', ['events', String(index)])
      identifiers.add(identifier)
    }
  })

  const last = state.events.at(-1)!
  if (state.sequence !== last.sequence
    || state.versionId !== last.currentVersionId
    || state.recordDigest !== last.currentRecordDigest
    || state.status !== last.currentStatus
    || state.lastTransitionAt !== last.occurredAt
    || state.retrievalEligible !== isRetrievalEligible(state.status)) {
    transitionFail('invalid-state')
  }
}

function decodeLedgerArray<T>(
  value: SafeJson,
  path: readonly string[],
  decode: (input: unknown) => T,
): readonly T[] {
  if (!Array.isArray(value)) transitionFail('invalid-state', path)
  if (value.length > MAX_LEDGER_ENTRIES) transitionFail('limit-exceeded', path)
  return value.map(decode)
}

function positiveInteger(record: JsonObject, key: string, path: readonly string[]): number {
  const value = integerValue(record, key, path)
  if (value < 1) transitionFail('invalid-event', [...path, key])
  return value
}

function optionalDigest(
  record: JsonObject,
  key: string,
  path: readonly string[],
): { readonly priorDigest?: `sha256:${string}` } {
  return record[key] === undefined ? {} : { priorDigest: digestValue(record, key, path) }
}

function optionalStatus(
  record: JsonObject,
  key: string,
  path: readonly string[],
): { readonly statusFrom?: MemoryStatusV1 } {
  return record[key] === undefined
    ? {}
    : { statusFrom: enumValue(record, key, path, STATUSES) }
}

function optionalIdentifier(
  record: JsonObject,
  key: 'supersedesVersionId' | 'supersededByVersionId',
  path: readonly string[],
): Partial<Record<typeof key, string>> {
  return record[key] === undefined ? {} : { [key]: identifierValue(record, key, path) }
}
