import {
  decodeMemoryEventV1,
  decodeMemoryTransitionReceiptV1,
} from '../lifecycle/ledger.js'
import { digestLifecycleValue } from '../lifecycle/validation.js'
import type {
  MemoryEventV1,
  MemoryTransitionReceiptV1,
  MemoryVersionChainV1,
} from '../lifecycle/types.js'
import { decodeMemoryRecordV1 } from '../records/decoder.js'
import {
  identifierValue,
  integerValue,
  objectValue,
  required,
  stringValue,
  timestampValue,
} from '../records/decoder-primitives.js'
import {
  canonicalizeSafeJson,
  digestSafeJson,
  snapshotSafeJson,
} from '../records/safe-json.js'
import type { SafeJson } from '../records/safe-json.js'
import type {
  MemoryRecordV1,
  MemoryScopeV1,
  MemorySensitivityClassV1,
} from '../records/types.js'
import {
  projectMemoryHistoryV1,
  validateMemoryHistoryReceiptsV1,
} from '../service/history.js'
import { projectionFail } from './errors.js'
import type {
  MemoryProjectionExpectedSourceV1,
  MemoryProjectionProfileV1,
  MemoryProjectionRedactionPolicyRefV1,
  MemoryProjectionRequestV1,
} from './types.js'

const REQUEST_FIELDS = [
  'schema', 'scope', 'records', 'events', 'receipts', 'expectedSource',
  'redactionPolicyRef', 'generatedAt', 'profile',
] as const
const PROFILE_FIELDS = [
  'schema', 'formatVersion', 'contentMode', 'inlineSensitivities', 'maxRecords',
  'maxEvents', 'maxReceipts', 'maxInlineContentBytes', 'maxOutputBytes',
] as const
const SOURCE_FIELDS = ['recordSetDigest', 'historyDigest', 'generation', 'sequence'] as const
const POLICY_FIELDS = ['id', 'version', 'digest'] as const
const MAXIMUMS = {
  maxRecords: 64,
  maxEvents: 256,
  maxReceipts: 256,
  maxInlineContentBytes: 16 * 1024,
  maxOutputBytes: 1024 * 1024,
} as const
const SENSITIVITIES = ['public', 'internal', 'confidential'] as const

export interface DecodedProjectionRequest {
  readonly scope: MemoryScopeV1
  readonly records: readonly MemoryRecordV1[]
  readonly events: readonly MemoryEventV1[]
  readonly receipts: readonly MemoryTransitionReceiptV1[]
  readonly expectedSource: MemoryProjectionExpectedSourceV1
  readonly redactionPolicyRef: MemoryProjectionRedactionPolicyRefV1
  readonly generatedAt: string
  readonly profile: MemoryProjectionProfileV1
  readonly scopeDigest: `sha256:${string}`
  readonly profileDigest: `sha256:${string}`
  readonly sourceDigest: `sha256:${string}`
  readonly chain: MemoryVersionChainV1
}

export function decodeProjectionRequest(input: MemoryProjectionRequestV1): DecodedProjectionRequest {
  try {
    const snapshot = snapshotSafeJson(input, {
      maxDepth: 16,
      maxTotalNodes: 16_384,
      maxTotalProperties: 12_288,
      maxObjectProperties: 128,
      maxArrayItems: 512,
      maxTotalStringBytes: 1024 * 1024,
    })
    const request = objectValue(snapshot, [], REQUEST_FIELDS)
    if (stringValue(request, 'schema', []) !== 'datazup.memory.projection-request/v1') {
      projectionFail('invalid-input', ['schema'])
    }
    const profile = decodeProfile(required(request, 'profile', []))
    const records = decodeArray(required(request, 'records', []), 'records')
      .map((value, index) => decodeMemoryRecordV1At(value, ['records', String(index)]))
      .sort(compareRecords)
    const events = decodeArray(required(request, 'events', []), 'events')
      .map((value, index) => decodeEventAt(value, ['events', String(index)]))
      .sort((left, right) => left.generation - right.generation
        || left.sequence - right.sequence || left.eventId.localeCompare(right.eventId))
    const receipts = decodeArray(required(request, 'receipts', []), 'receipts')
      .map((value, index) => decodeReceiptAt(value, ['receipts', String(index)]))
      .sort((left, right) => left.generation - right.generation
        || left.sequence - right.sequence || left.receiptId.localeCompare(right.receiptId))
    enforceCounts(records, events, receipts, profile)

    const scopeValue = required(request, 'scope', [])
    const scope = decodeScopeFromRecords(scopeValue, records)
    const chain = projectMemoryHistoryV1(events)
    validateIdentities(scope, records, events, receipts, chain)
    validateReceiptBindings(events, receipts)
    validateRecordHistory(records, chain)

    const expectedSource = decodeExpectedSource(required(request, 'expectedSource', []))
    const recordSetDigest = digestSafeJson(snapshotSafeJson(records))
    const historyDigest = digestSafeJson(snapshotSafeJson({ events, receipts }))
    if (expectedSource.recordSetDigest !== recordSetDigest
      || expectedSource.historyDigest !== historyDigest
      || expectedSource.generation !== chain.generation
      || expectedSource.sequence !== chain.lastSequence) {
      projectionFail('source-mismatch', ['expectedSource'])
    }

    const redactionPolicyRef = decodePolicyRef(required(request, 'redactionPolicyRef', []))
    const generatedAt = timestampValue(request, 'generatedAt', [])
    const scopeDigest = digestSafeJson(snapshotSafeJson(scope))
    const profileDigest = digestSafeJson(snapshotSafeJson(profile))
    const sourceDigest = digestSafeJson(snapshotSafeJson({
      scopeDigest,
      ...expectedSource,
    }))
    return {
      scope,
      records,
      events,
      receipts,
      expectedSource,
      redactionPolicyRef,
      generatedAt,
      profile,
      scopeDigest,
      profileDigest,
      sourceDigest,
      chain,
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'MemoryProjectionError') throw error
    projectionFail('invalid-input')
  }
}

function decodeProfile(value: SafeJson): MemoryProjectionProfileV1 {
  const profile = objectValue(value, ['profile'], PROFILE_FIELDS)
  if (stringValue(profile, 'schema', ['profile']) !== 'datazup.memory.projection-profile/v1'
    || stringValue(profile, 'formatVersion', ['profile']) !== '1.0') {
    projectionFail('invalid-input', ['profile'])
  }
  const contentMode = stringValue(profile, 'contentMode', ['profile'])
  if (contentMode !== 'reference-only' && contentMode !== 'exportable-inline') {
    projectionFail('invalid-input', ['profile', 'contentMode'])
  }
  const sensitivities = decodeArray(
    required(profile, 'inlineSensitivities', ['profile']),
    'profile.inlineSensitivities',
  ).map((item, index) => {
    if (typeof item !== 'string' || !SENSITIVITIES.includes(item as typeof SENSITIVITIES[number])) {
      projectionFail('invalid-input', ['profile', 'inlineSensitivities', String(index)])
    }
    return item as Exclude<MemorySensitivityClassV1, 'restricted'>
  }).sort()
  if (new Set(sensitivities).size !== sensitivities.length) {
    projectionFail('identity-conflict', ['profile', 'inlineSensitivities'])
  }
  const bounds = Object.fromEntries(Object.keys(MAXIMUMS).map(key => {
    const name = key as keyof typeof MAXIMUMS
    const decoded = integerValue(profile, name, ['profile'])
    if (decoded < 1 || decoded > MAXIMUMS[name]) projectionFail('limit-exceeded', ['profile', name])
    return [name, decoded]
  })) as Pick<MemoryProjectionProfileV1, keyof typeof MAXIMUMS>
  return Object.freeze({
    schema: 'datazup.memory.projection-profile/v1',
    formatVersion: '1.0',
    contentMode,
    inlineSensitivities: Object.freeze(sensitivities),
    ...bounds,
  })
}

function decodeExpectedSource(value: SafeJson): MemoryProjectionExpectedSourceV1 {
  const source = objectValue(value, ['expectedSource'], SOURCE_FIELDS)
  return Object.freeze({
    recordSetDigest: decodeDigest(source, 'recordSetDigest', ['expectedSource']),
    historyDigest: decodeDigest(source, 'historyDigest', ['expectedSource']),
    generation: positiveInteger(source, 'generation', ['expectedSource']),
    sequence: positiveInteger(source, 'sequence', ['expectedSource']),
  })
}

function decodePolicyRef(value: SafeJson): MemoryProjectionRedactionPolicyRefV1 {
  const policy = objectValue(value, ['redactionPolicyRef'], POLICY_FIELDS)
  return Object.freeze({
    id: identifierValue(policy, 'id', ['redactionPolicyRef']),
    version: identifierValue(policy, 'version', ['redactionPolicyRef']),
    digest: decodeDigest(policy, 'digest', ['redactionPolicyRef']),
  })
}

function decodeScopeFromRecords(value: SafeJson, records: readonly MemoryRecordV1[]): MemoryScopeV1 {
  if (records.length === 0) projectionFail('invalid-input', ['records'])
  const scope = records[0]!.scope
  if (canonicalizeSafeJson(snapshotSafeJson(scope)) !== canonicalizeSafeJson(value)) {
    projectionFail('scope-mismatch', ['scope'])
  }
  return scope
}

function validateIdentities(
  scope: MemoryScopeV1,
  records: readonly MemoryRecordV1[],
  events: readonly MemoryEventV1[],
  receipts: readonly MemoryTransitionReceiptV1[],
  chain: MemoryVersionChainV1,
): void {
  const scopeText = canonicalizeSafeJson(snapshotSafeJson(scope))
  const memoryId = records[0]!.memoryId
  const versionIds = new Set<string>()
  for (const record of records) {
    if (record.memoryId !== memoryId) projectionFail('identity-conflict', ['records', 'memoryId'])
    if (canonicalizeSafeJson(snapshotSafeJson(record.scope)) !== scopeText) {
      projectionFail('scope-mismatch', ['records', record.versionId, 'scope'])
    }
    if (versionIds.has(record.versionId)) projectionFail('identity-conflict', ['records', record.versionId])
    versionIds.add(record.versionId)
  }
  if (chain.memoryId !== memoryId
    || events.some(event => event.memoryId !== memoryId)
    || receipts.some(receipt => receipt.memoryId !== memoryId)) {
    projectionFail('identity-conflict', ['history', 'memoryId'])
  }
}

function validateReceiptBindings(
  events: readonly MemoryEventV1[],
  receipts: readonly MemoryTransitionReceiptV1[],
): void {
  try { validateMemoryHistoryReceiptsV1(events, receipts) } catch {
    projectionFail('source-mismatch', ['receipts'])
  }
}

function validateRecordHistory(
  records: readonly MemoryRecordV1[],
  chain: MemoryVersionChainV1,
): void {
  for (const record of records) {
    const version = chain.versions.find(candidate => candidate.versionId === record.versionId)
    if (!version || !version.recordDigests.includes(digestLifecycleValue(record))) {
      projectionFail('source-mismatch', ['records', record.versionId])
    }
  }
}

function enforceCounts(
  records: readonly unknown[],
  events: readonly unknown[],
  receipts: readonly unknown[],
  profile: MemoryProjectionProfileV1,
): void {
  for (const [name, count, maximum] of [
    ['records', records.length, profile.maxRecords],
    ['events', events.length, profile.maxEvents],
    ['receipts', receipts.length, profile.maxReceipts],
  ] as const) {
    if (count === 0 || count > maximum) projectionFail('limit-exceeded', [name])
  }
}

function decodeArray(value: SafeJson, path: string): readonly SafeJson[] {
  if (!Array.isArray(value)) projectionFail('invalid-input', path.split('.'))
  return value
}

function decodeMemoryRecordV1At(value: SafeJson, path: readonly string[]): MemoryRecordV1 {
  try { return decodeMemoryRecordV1(value) } catch { projectionFail('invalid-input', path) }
}

function decodeEventAt(value: SafeJson, path: readonly string[]): MemoryEventV1 {
  try { return decodeMemoryEventV1(value) } catch { projectionFail('invalid-input', path) }
}

function decodeReceiptAt(value: SafeJson, path: readonly string[]): MemoryTransitionReceiptV1 {
  try { return decodeMemoryTransitionReceiptV1(value) } catch { projectionFail('invalid-input', path) }
}

function decodeDigest(
  record: ReturnType<typeof objectValue>,
  key: string,
  path: readonly string[],
): `sha256:${string}` {
  const value = stringValue(record, key, path)
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) projectionFail('invalid-input', [...path, key])
  return value as `sha256:${string}`
}

function positiveInteger(
  record: ReturnType<typeof objectValue>,
  key: string,
  path: readonly string[],
): number {
  const value = integerValue(record, key, path)
  if (value < 1) projectionFail('invalid-input', [...path, key])
  return value
}

function compareRecords(left: MemoryRecordV1, right: MemoryRecordV1): number {
  return left.versionId.localeCompare(right.versionId)
    || digestLifecycleValue(left).localeCompare(digestLifecycleValue(right))
}
