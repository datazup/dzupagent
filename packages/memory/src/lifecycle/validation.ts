import { MemoryRecordDecodeError } from '../records/errors.js'
import { decodeMemoryRecordV1 } from '../records/decoder.js'
import {
  actorRefValue,
  digestValue,
  enumValue,
  identifierValue,
  integerValue,
  objectValue,
  required,
  sensitivityValue,
  stringValue,
  timestampValue,
  type JsonObject,
} from '../records/decoder-primitives.js'
import {
  deepFreezeSafeJson,
  digestSafeJson,
  snapshotSafeJson,
  type SafeJson,
} from '../records/safe-json.js'
import type { MemoryEvidenceRefV1, MemoryRecordV1 } from '../records/types.js'
import { MemoryTransitionError, transitionFail } from './errors.js'
import type { MemoryCommandV1 } from './types.js'

const COMMAND_SCHEMA = 'datazup.memory.command/v1' as const
const MAX_EVIDENCE_REFS = 16
const MAX_PURGE_TARGETS = 16
const LIFECYCLE_SNAPSHOT_LIMITS = {
  maxDepth: 12,
  maxTotalNodes: 16_384,
  maxTotalProperties: 8_192,
  maxObjectProperties: 128,
  maxArrayItems: 128,
  maxTotalStringBytes: 512 * 1024,
} as const

export const COMMAND_TYPES = [
  'capture', 'assess', 'require-review', 'promote', 'confirm', 'reject',
  'correct', 'dispute', 'resolve', 'revoke', 'expire', 'archive',
  'propose-purge',
] as const

const COMMON_FIELDS = [
  'schema', 'type', 'commandId', 'eventId', 'receiptId', 'idempotencyKey',
  'memoryId', 'generation', 'expectedSequence', 'transitionAt', 'actorRef',
  'decisionRef', 'reasonCode', 'evidenceRefs', 'record',
] as const

const REASON_CODES = {
  capture: [
    'explicit-remember', 'application-observation', 'model-observation', 'import',
  ],
  assess: ['deduplicated', 'novel', 'possible-conflict'],
  'require-review': ['sensitive', 'ambiguous', 'contradictory', 'policy-required'],
  promote: ['policy-admitted', 'review-not-required'],
  confirm: ['human-confirmed', 'policy-confirmed'],
  reject: ['policy-rejected', 'review-rejected', 'invalidated', 'duplicate'],
  correct: ['user-correction', 'evidence-correction', 'temporal-correction'],
  dispute: ['contradictory-evidence', 'user-dispute', 'source-dispute'],
  resolve: ['review-resolved', 'evidence-resolved'],
  revoke: ['user-forgot', 'consent-revoked', 'policy-revoked'],
  expire: ['retention-expired', 'freshness-expired'],
  archive: ['retention-archive', 'audit-archive'],
  'propose-purge': ['retention-purge', 'user-purge', 'policy-purge'],
} as const satisfies Record<(typeof COMMAND_TYPES)[number], readonly string[]>

export function decodeMemoryCommandV1(input: unknown): MemoryCommandV1 {
  return translateDecodeError('invalid-command', () => {
    const rootSnapshot = snapshotSafeJson(input)
    const root = objectValue(rootSnapshot, [])
    const type = enumValue(root, 'type', [], COMMAND_TYPES)
    const extraFields = commandExtraFields(type)
    objectValue(rootSnapshot, [], [...COMMON_FIELDS, ...extraFields])

    const schema = stringValue(root, 'schema', [])
    if (schema !== COMMAND_SCHEMA) transitionFail('invalid-command', ['schema'])
    const generation = integerValue(root, 'generation', [])
    if (generation < 1) transitionFail('invalid-command', ['generation'])
    const reasonCode = stringValue(root, 'reasonCode', [])
    validateReasonCode(type, reasonCode, ['reasonCode'], 'invalid-command')

    const base = {
      schema,
      type,
      commandId: identifierValue(root, 'commandId', []),
      eventId: identifierValue(root, 'eventId', []),
      receiptId: identifierValue(root, 'receiptId', []),
      idempotencyKey: identifierValue(root, 'idempotencyKey', []),
      memoryId: identifierValue(root, 'memoryId', []),
      generation,
      expectedSequence: integerValue(root, 'expectedSequence', []),
      transitionAt: timestampValue(root, 'transitionAt', []),
      actorRef: actorRefValue(root, 'actorRef', []),
      decisionRef: actorRefValue(root, 'decisionRef', []),
      reasonCode,
      evidenceRefs: decodeEvidenceRefs(required(root, 'evidenceRefs', []), ['evidenceRefs']),
      record: decodeMemoryRecordV1(required(root, 'record', [])),
    }
    if (base.memoryId !== base.record.memoryId) {
      transitionFail('identity-mismatch', ['record', 'memoryId'])
    }

    if (type === 'capture') return freezeValue(base) as MemoryCommandV1

    const existing = {
      ...base,
      expectedVersionId: identifierValue(root, 'expectedVersionId', []),
      expectedRecordDigest: digestValue(root, 'expectedRecordDigest', []),
    }
    if (type === 'correct') {
      return freezeValue({
        ...existing,
        replacement: decodeMemoryRecordV1(required(root, 'replacement', [])),
      }) as MemoryCommandV1
    }
    if (type === 'resolve') {
      const resolutionStatus = enumValue(root, 'resolutionStatus', [], [
        'active', 'superseded', 'revoked',
      ] as const)
      const supersededByVersionId = root['supersededByVersionId']
      const supersedingRecordDigest = root['supersedingRecordDigest']
      if (resolutionStatus === 'superseded') {
        if (supersededByVersionId === undefined || supersedingRecordDigest === undefined) {
          transitionFail('invalid-command', ['resolutionStatus'])
        }
        return freezeValue({
          ...existing,
          resolutionStatus,
          supersededByVersionId: identifierValue(root, 'supersededByVersionId', []),
          supersedingRecordDigest: digestValue(root, 'supersedingRecordDigest', []),
        }) as MemoryCommandV1
      }
      if (supersededByVersionId !== undefined || supersedingRecordDigest !== undefined) {
        transitionFail('invalid-command', ['resolutionStatus'])
      }
      return freezeValue({ ...existing, resolutionStatus }) as MemoryCommandV1
    }
    if (type === 'archive') {
      return freezeValue({
        ...existing,
        archiveReceiptRef: decodeReference(
          required(root, 'archiveReceiptRef', []),
          ['archiveReceiptRef'],
        ),
      }) as MemoryCommandV1
    }
    if (type === 'propose-purge') {
      return freezeValue({
        ...existing,
        purgeTargetRefs: decodeReferences(
          required(root, 'purgeTargetRefs', []),
          ['purgeTargetRefs'],
          MAX_PURGE_TARGETS,
        ),
      }) as MemoryCommandV1
    }
    return freezeValue(existing) as MemoryCommandV1
  })
}

function commandExtraFields(type: (typeof COMMAND_TYPES)[number]): readonly string[] {
  if (type === 'capture') return []
  const existing = ['expectedVersionId', 'expectedRecordDigest']
  if (type === 'correct') return [...existing, 'replacement']
  if (type === 'resolve') {
    return [
      ...existing, 'resolutionStatus', 'supersededByVersionId',
      'supersedingRecordDigest',
    ]
  }
  if (type === 'archive') return [...existing, 'archiveReceiptRef']
  if (type === 'propose-purge') return [...existing, 'purgeTargetRefs']
  return existing
}

export function decodeEvidenceRefs(
  value: SafeJson,
  path: readonly string[],
  code: 'invalid-command' | 'invalid-event' = 'invalid-command',
): readonly MemoryEvidenceRefV1[] {
  if (!Array.isArray(value)) transitionFail(code, path)
  if (value.length > MAX_EVIDENCE_REFS) transitionFail('limit-exceeded', path)
  const refs = value.map((entry, index) => decodeEvidenceRef(entry, [...path, String(index)], code))
  assertUnique(refs.map(ref => `${ref.owner}\0${ref.id}`), path, code)
  return refs
}

function decodeEvidenceRef(
  value: SafeJson,
  path: readonly string[],
  code: 'invalid-command' | 'invalid-event',
): MemoryEvidenceRefV1 {
  const record = objectValue(value, path, [
    'schema', 'kind', 'owner', 'id', 'digest', 'observedAt', 'sensitivity',
  ])
  const schema = stringValue(record, 'schema', path)
  if (schema !== 'datazup.memory.evidence-ref/v1') {
    transitionFail(code, [...path, 'schema'])
  }
  return {
    schema,
    kind: enumValue(record, 'kind', path, [
      'application-event', 'document', 'run-evidence', 'tool-result',
      'transition-receipt',
    ] as const),
    owner: identifierValue(record, 'owner', path),
    id: identifierValue(record, 'id', path),
    digest: digestValue(record, 'digest', path),
    observedAt: timestampValue(record, 'observedAt', path),
    sensitivity: sensitivityValue(record, 'sensitivity', path),
  }
}

export function decodeReference(value: SafeJson, path: readonly string[]): {
  readonly owner: string
  readonly id: string
  readonly digest: `sha256:${string}`
} {
  const record = objectValue(value, path, ['owner', 'id', 'digest'])
  return {
    owner: identifierValue(record, 'owner', path),
    id: identifierValue(record, 'id', path),
    digest: digestValue(record, 'digest', path),
  }
}

export function decodeReferences(
  value: SafeJson,
  path: readonly string[],
  maximum: number,
  code: 'invalid-command' | 'invalid-event' = 'invalid-command',
): readonly ReturnType<typeof decodeReference>[] {
  if (!Array.isArray(value)) transitionFail(code, path)
  if (value.length === 0 || value.length > maximum) transitionFail('limit-exceeded', path)
  const refs = value.map((entry, index) => decodeReference(entry, [...path, String(index)]))
  assertUnique(refs.map(ref => `${ref.owner}\0${ref.id}`), path, code)
  return refs
}

export function digestLifecycleValue(input: unknown): `sha256:${string}` {
  return digestSafeJson(snapshotLifecycleJson(input))
}

export function freezeValue<T>(input: T): T {
  return deepFreezeSafeJson(snapshotLifecycleJson(input)) as unknown as T
}

export function snapshotLifecycleJson(input: unknown): SafeJson {
  return snapshotSafeJson(input, LIFECYCLE_SNAPSHOT_LIMITS)
}

export function recordDigest(record: MemoryRecordV1): `sha256:${string}` {
  return digestLifecycleValue(record)
}

export function translateDecodeError<T>(
  fallback: 'invalid-command' | 'invalid-state' | 'invalid-event',
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
      if ([
        'unsafe-object', 'accessor-property', 'cyclic-value', 'unsupported-value',
      ].includes(cause.code)) {
        throw new MemoryTransitionError('unsafe-input', cause.path)
      }
      throw new MemoryTransitionError(fallback, cause.path)
    }
    throw new MemoryTransitionError('unsafe-input')
  }
}

export function timestampMillis(value: string): number {
  return new Date(value).getTime()
}

export function validateReasonCode(
  type: (typeof COMMAND_TYPES)[number],
  reasonCode: string,
  path: readonly string[],
  code: 'invalid-command' | 'invalid-event' = 'invalid-event',
): void {
  if (!(REASON_CODES[type] as readonly string[]).includes(reasonCode)) {
    transitionFail(code, path)
  }
}

function assertUnique(
  values: readonly string[],
  path: readonly string[],
  code: 'invalid-command' | 'invalid-event',
): void {
  if (new Set(values).size !== values.length) transitionFail(code, path)
}

export function asJsonObject(value: SafeJson, path: readonly string[]): JsonObject {
  return objectValue(value, path)
}
