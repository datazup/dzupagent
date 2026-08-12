import {
  decodeMemoryEventV1,
  decodeMemoryTransitionReceiptV1,
} from '../lifecycle/ledger.js'
import type { MemoryStatusV1 } from '../records/types.js'
import {
  canonicalizeSafeJson,
  deepFreezeSafeJson,
  digestSafeJson,
  snapshotSafeJson,
} from '../records/safe-json.js'
import type { SafeJson } from '../records/safe-json.js'
import {
  projectMemoryHistoryV1,
  validateMemoryHistoryReceiptsV1,
} from '../service/history.js'
import { projectionFail } from './errors.js'
import type {
  MemoryProjectedRecordV1,
  MemoryProjectionDiffEntryV1,
  MemoryProjectionDiffV1,
  MemoryProjectionV1,
} from './types.js'

type JsonObject = { readonly [key: string]: SafeJson }
type Sha256 = `sha256:${string}`

const TOP_FIELDS = [
  'schema', 'formatVersion', 'authority', 'generatedAt', 'scope', 'scopeDigest',
  'profileDigest', 'redactionPolicyRef', 'source', 'projectionDigest', 'summary',
  'records', 'chain', 'events', 'receipts',
] as const
const RECORD_FIELDS = [
  'memoryId', 'versionId', 'kind', 'status', 'recordDigest', 'lifecycle', 'temporal',
  'provenance', 'governance', 'quality', 'tags', 'content',
] as const
const STATUS_VALUES: readonly MemoryStatusV1[] = [
  'captured', 'candidate', 'review-required', 'active', 'disputed', 'superseded',
  'revoked', 'expired', 'archived', 'purged', 'rejected',
]

/** Compare exact projections without applying or implying any mutation. */
export function diffMemoryProjections(
  baseInput: MemoryProjectionV1,
  targetInput: MemoryProjectionV1,
): MemoryProjectionDiffV1 {
  const base = decodeProjection(baseInput, 'base')
  const target = decodeProjection(targetInput, 'target')
  if (base.formatVersion !== target.formatVersion
    || base.profileDigest !== target.profileDigest
    || canonicalizeSafeJson(snapshotSafeJson(base.redactionPolicyRef))
      !== canonicalizeSafeJson(snapshotSafeJson(target.redactionPolicyRef))) {
    projectionFail('profile-mismatch')
  }
  if (base.scopeDigest !== target.scopeDigest) projectionFail('scope-mismatch')
  if (target.source.generation < base.source.generation
    || (target.source.generation === base.source.generation
      && target.source.sequence < base.source.sequence)
    || (target.source.generation === base.source.generation
      && target.source.sequence === base.source.sequence
      && target.source.sourceDigest !== base.source.sourceDigest)) {
    projectionFail('stale-base')
  }

  const changes = [
    ...diffRecords(base.records, target.records),
    ...diffHistory(base, target),
  ].sort((left, right) => left.kind.localeCompare(right.kind)
    || left.identity.localeCompare(right.identity))
  const core = {
    schema: 'datazup.memory.projection-diff/v1' as const,
    formatVersion: '1.0' as const,
    authority: 'none' as const,
    scopeDigest: base.scopeDigest,
    profileDigest: base.profileDigest,
    baseProjectionDigest: base.projectionDigest,
    targetProjectionDigest: target.projectionDigest,
    baseSourceDigest: base.source.sourceDigest,
    targetSourceDigest: target.source.sourceDigest,
    empty: changes.length === 0,
    changes,
  }
  return deepFreezeSafeJson(snapshotSafeJson({
    ...core,
    diffDigest: digestSafeJson(snapshotSafeJson(core)),
  })) as unknown as MemoryProjectionDiffV1
}

function decodeProjection(input: MemoryProjectionV1, label: string): MemoryProjectionV1 {
  try {
    const snapshot = snapshotSafeJson(input, {
      maxDepth: 18,
      maxTotalNodes: 24_576,
      maxTotalProperties: 18_432,
      maxObjectProperties: 128,
      maxArrayItems: 512,
      maxTotalStringBytes: 1024 * 1024,
    })
    const projection = asObject(snapshot, [label])
    exactKeys(projection, TOP_FIELDS, [label])
    expectString(projection, 'schema', 'datazup.memory.projection/v1', [label])
    expectString(projection, 'formatVersion', '1.0', [label])
    expectString(projection, 'authority', 'none', [label])
    timestamp(projection.generatedAt, [label, 'generatedAt'])
    const scope = validateScope(projection.scope, [label, 'scope'])
    const scopeDigest = digest(projection.scopeDigest, [label, 'scopeDigest'])
    if (scopeDigest !== digestSafeJson(snapshotSafeJson(scope))) projectionFail('scope-mismatch')
    digest(projection.profileDigest, [label, 'profileDigest'])
    validatePolicyRef(projection.redactionPolicyRef, [label, 'redactionPolicyRef'])
    validateSource(projection.source, scopeDigest, [label, 'source'])
    digest(projection.projectionDigest, [label, 'projectionDigest'])

    const records = arrayValue(projection.records, [label, 'records'])
    records.forEach((record, index) => validateRecord(record, [label, 'records', String(index)]))
    assertSortedUnique(records, item => {
      const record = asObject(item, [])
      return `${record.versionId as string}\0${record.recordDigest as string}`
    }, [label, 'records'])
    const events = arrayValue(projection.events, [label, 'events']).map((event, index) => {
      try { return decodeMemoryEventV1(event) } catch {
        projectionFail('invalid-input', [label, 'events', String(index)])
      }
    })
    const receipts = arrayValue(projection.receipts, [label, 'receipts']).map((receipt, index) => {
      try { return decodeMemoryTransitionReceiptV1(receipt) } catch {
        projectionFail('invalid-input', [label, 'receipts', String(index)])
      }
    })
    assertSortedUnique(events, item => `${String(item.generation).padStart(10, '0')}:${String(item.sequence).padStart(10, '0')}:${item.eventId}`, [label, 'events'])
    assertSortedUnique(receipts, item => `${String(item.generation).padStart(10, '0')}:${String(item.sequence).padStart(10, '0')}:${item.receiptId}`, [label, 'receipts'])
    try { validateMemoryHistoryReceiptsV1(events, receipts) } catch {
      projectionFail('source-mismatch', [label, 'receipts'])
    }
    const chain = projectMemoryHistoryV1(events)
    if (canonicalizeSafeJson(snapshotSafeJson(chain))
      !== canonicalizeSafeJson(snapshotSafeJson(projection.chain))) {
      projectionFail('projection-tampered', [label, 'chain'])
    }
    validateSummary(projection.summary, records, events.length, receipts.length, chain, [label, 'summary'])
    validateProjectionSource(projection.source, events, receipts, chain, scopeDigest, [label, 'source'])
    const { projectionDigest: ignored, ...core } = projection
    void ignored
    if (projection.projectionDigest !== digestSafeJson(snapshotSafeJson(core))) {
      projectionFail('projection-tampered', [label, 'projectionDigest'])
    }
    return snapshot as unknown as MemoryProjectionV1
  } catch (error) {
    if (error instanceof Error && error.name === 'MemoryProjectionError') throw error
    projectionFail('invalid-input', [label])
  }
}

function diffRecords(
  baseRecords: readonly MemoryProjectedRecordV1[],
  targetRecords: readonly MemoryProjectedRecordV1[],
): MemoryProjectionDiffEntryV1[] {
  const changes: MemoryProjectionDiffEntryV1[] = []
  const base = new Map(baseRecords.map(record => [record.versionId, record]))
  const target = new Map(targetRecords.map(record => [record.versionId, record]))
  for (const identity of [...new Set([...base.keys(), ...target.keys()])].sort()) {
    const left = base.get(identity)
    const right = target.get(identity)
    if (!left || !right) {
      const record = left ?? right!
      changes.push({
        kind: left ? 'removed' : 'added',
        memoryId: record.memoryId,
        identity: `version:${identity}`,
        ...(left ? { baseDigest: left.recordDigest } : { targetDigest: right!.recordDigest }),
        fields: ['record'],
      })
      continue
    }
    const fields = changedRecordFields(left, right)
    if (fields.length === 0) continue
    const entry = (kind: MemoryProjectionDiffEntryV1['kind'], selected: readonly string[]) => {
      changes.push({
        kind,
        memoryId: right.memoryId,
        identity: `version:${identity}`,
        baseDigest: left.recordDigest,
        targetDigest: right.recordDigest,
        fields: [...selected].sort(),
      })
    }
    if (fields.includes('governance')) entry('governance', ['governance'])
    if (fields.includes('provenance')) entry('provenance', ['provenance'])
    if (right.status === 'superseded' && left.status !== 'superseded') {
      entry('superseded', fields.filter(field => ['status', 'lifecycle'].includes(field)))
    }
    const nonLifecycle = fields.filter(field => !['status', 'lifecycle', 'temporal'].includes(field))
    if (nonLifecycle.length === 0) entry('lifecycle-only', fields)
    const ordinary = nonLifecycle.filter(field => !['governance', 'provenance'].includes(field))
    if (ordinary.length > 0) entry('changed', ordinary)
  }
  return changes
}

function diffHistory(
  base: MemoryProjectionV1,
  target: MemoryProjectionV1,
): MemoryProjectionDiffEntryV1[] {
  return [
    ...diffLedger(base.events, target.events, 'event', 'lifecycle-only', base.summary.memoryId),
    ...diffLedger(base.receipts, target.receipts, 'receipt', 'receipt', base.summary.memoryId),
  ]
}

function diffLedger(
  base: readonly SafeJson[] | readonly object[],
  target: readonly SafeJson[] | readonly object[],
  identityKey: 'event' | 'receipt',
  kind: 'lifecycle-only' | 'receipt',
  memoryId: string,
): MemoryProjectionDiffEntryV1[] {
  const idField = identityKey === 'event' ? 'eventId' : 'receiptId'
  const left = new Map(base.map(item => [String((item as Record<string, unknown>)[idField]), item]))
  const right = new Map(target.map(item => [String((item as Record<string, unknown>)[idField]), item]))
  const output: MemoryProjectionDiffEntryV1[] = []
  for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const before = left.get(id)
    const after = right.get(id)
    const baseDigest = before === undefined ? undefined : digestSafeJson(snapshotSafeJson(before))
    const targetDigest = after === undefined ? undefined : digestSafeJson(snapshotSafeJson(after))
    if (baseDigest === targetDigest) continue
    output.push({
      kind,
      memoryId,
      identity: `${identityKey}:${id}`,
      ...(baseDigest === undefined ? {} : { baseDigest }),
      ...(targetDigest === undefined ? {} : { targetDigest }),
      fields: [before === undefined ? 'added' : after === undefined ? 'removed' : 'changed'],
    })
  }
  return output
}

function changedRecordFields(left: MemoryProjectedRecordV1, right: MemoryProjectedRecordV1): string[] {
  return ['kind', 'status', 'lifecycle', 'temporal', 'provenance', 'governance', 'quality', 'tags', 'content']
    .filter(field => canonicalizeSafeJson(snapshotSafeJson(left[field as keyof MemoryProjectedRecordV1]))
      !== canonicalizeSafeJson(snapshotSafeJson(right[field as keyof MemoryProjectedRecordV1])))
}

function validateRecord(value: SafeJson, path: readonly string[]): void {
  const record = asObject(value, path)
  exactKeys(record, RECORD_FIELDS, path)
  for (const key of ['memoryId', 'versionId', 'kind', 'status'] as const) text(record[key], [...path, key])
  if (!STATUS_VALUES.includes(record.status as MemoryStatusV1)) projectionFail('invalid-input', [...path, 'status'])
  digest(record.recordDigest, [...path, 'recordDigest'])
  const lifecycle = validateLifecycle(record.lifecycle, [...path, 'lifecycle'])
  if (lifecycle.status !== record.status) projectionFail('projection-tampered', [...path, 'status'])
  validateTemporal(record.temporal, [...path, 'temporal'])
  validateProvenance(record.provenance, [...path, 'provenance'])
  validateGovernance(record.governance, [...path, 'governance'])
  validateQuality(record.quality, [...path, 'quality'])
  validateStringArray(record.tags, [...path, 'tags'])
  validateContent(record.content, [...path, 'content'])
}

function validateLifecycle(value: SafeJson | undefined, path: readonly string[]): JsonObject {
  const object = asObject(value, path)
  exactKeys(object, [
    'status', 'priorVersionId', 'supersedesVersionId', 'supersededByVersionId',
    'revokesVersionId', 'reasonCode', 'transitionSequence', 'lastTransitionAt',
  ], path, true)
  requireKeys(object, ['status', 'reasonCode', 'transitionSequence', 'lastTransitionAt'], path)
  for (const key of Object.keys(object)) {
    if (key === 'transitionSequence') safeInteger(object[key], [...path, key])
    else if (key === 'lastTransitionAt') timestamp(object[key], [...path, key])
    else text(object[key], [...path, key])
  }
  return object
}
function validateTemporal(value: SafeJson | undefined, path: readonly string[]): void {
  const object = asObject(value, path)
  exactKeys(object, [
    'observedAt', 'recordedAt', 'updatedAt', 'validFrom', 'validTo', 'lastVerifiedAt',
    'expiresAt', 'sourceEventTime',
  ], path, true)
  requireKeys(object, ['observedAt', 'recordedAt', 'updatedAt'], path)
  for (const [key, child] of Object.entries(object)) timestamp(child, [...path, key])
}
function validateProvenance(value: SafeJson | undefined, path: readonly string[]): void {
  const object = asObject(value, path)
  exactKeys(object, [
    'sourceKind', 'sourceId', 'sourceDigest', 'evidenceRefs', 'createdByRef',
    'reviewedByRef', 'extractionProfileId', 'extractionProfileVersion',
  ], path, true)
  requireKeys(object, ['sourceKind', 'sourceId', 'sourceDigest', 'evidenceRefs', 'createdByRef'], path)
  for (const key of ['sourceKind', 'sourceId', 'createdByRef'] as const) text(object[key], [...path, key])
  digest(object.sourceDigest, [...path, 'sourceDigest'])
  for (const [index, evidence] of arrayValue(object.evidenceRefs, [...path, 'evidenceRefs']).entries()) {
    const item = asObject(evidence, [...path, 'evidenceRefs', String(index)])
    exactKeys(item, ['schema', 'kind', 'owner', 'id', 'digest', 'observedAt', 'sensitivity'], [...path, 'evidenceRefs', String(index)])
    for (const key of ['schema', 'kind', 'owner', 'id', 'sensitivity'] as const) text(item[key], [...path, key])
    digest(item.digest, [...path, 'digest'])
    timestamp(item.observedAt, [...path, 'observedAt'])
  }
}
function validateGovernance(value: SafeJson | undefined, path: readonly string[]): void {
  const object = asObject(value, path)
  exactKeys(object, [
    'sensitivity', 'consentRef', 'accessPolicyRef', 'writePolicyRef', 'legalHold',
    'exportable', 'userVisible', 'retentionPolicyId', 'retentionPolicyVersion',
  ], path, true)
  requireKeys(object, [
    'sensitivity', 'accessPolicyRef', 'writePolicyRef', 'legalHold', 'exportable',
    'userVisible', 'retentionPolicyId', 'retentionPolicyVersion',
  ], path)
  for (const [key, child] of Object.entries(object)) {
    if (['legalHold', 'exportable', 'userVisible'].includes(key)) boolean(child, [...path, key])
    else text(child, [...path, key])
  }
}
function validateQuality(value: SafeJson | undefined, path: readonly string[]): void {
  const object = asObject(value, path)
  exactKeys(object, [
    'confidence', 'sourceTrust', 'extractionQuality', 'freshnessState',
    'contradictionState', 'verificationState',
  ], path, true)
  requireKeys(object, [
    'confidence', 'sourceTrust', 'freshnessState', 'contradictionState', 'verificationState',
  ], path)
  for (const [key, child] of Object.entries(object)) {
    if (['confidence', 'sourceTrust', 'extractionQuality'].includes(key)) finiteNumber(child, [...path, key])
    else text(child, [...path, key])
  }
}
function validateContent(value: SafeJson | undefined, path: readonly string[]): void {
  const object = asObject(value, path)
  exactKeys(object, ['mode', 'reason', 'digest', 'byteLength', 'value', 'contentRef', 'searchTextRef'], path, true)
  requireKeys(object, ['mode', 'reason', 'digest', 'byteLength'], path)
  const mode = text(object.mode, [...path, 'mode'])
  text(object.reason, [...path, 'reason'])
  digest(object.digest, [...path, 'digest'])
  safeInteger(object.byteLength, [...path, 'byteLength'])
  if (mode !== 'inline' && mode !== 'reference-only') projectionFail('invalid-input', [...path, 'mode'])
  if (mode === 'inline' && object.value === undefined) projectionFail('invalid-input', [...path, 'value'])
  if (mode === 'reference-only' && object.value !== undefined) projectionFail('invalid-input', [...path, 'value'])
  for (const key of ['contentRef', 'searchTextRef'] as const) {
    if (object[key] !== undefined) validateContentRef(object[key], [...path, key])
  }
}
function validateContentRef(value: SafeJson | undefined, path: readonly string[]): void {
  const object = asObject(value, path)
  exactKeys(object, ['schema', 'owner', 'id', 'digest', 'mediaType', 'byteLength'], path)
  for (const key of ['schema', 'owner', 'id', 'mediaType'] as const) text(object[key], [...path, key])
  digest(object.digest, [...path, 'digest'])
  safeInteger(object.byteLength, [...path, 'byteLength'])
}
function validateSummary(
  value: SafeJson | undefined,
  records: readonly SafeJson[],
  eventCount: number,
  receiptCount: number,
  chain: ReturnType<typeof projectMemoryHistoryV1>,
  path: readonly string[],
): void {
  const summary = asObject(value, path)
  exactKeys(summary, [
    'memoryId', 'recordCount', 'eventCount', 'receiptCount', 'statuses',
    'activeVersionIds', 'purgeState',
  ], path)
  const memoryId = text(summary.memoryId, [...path, 'memoryId'])
  if (records.some(record => asObject(record, []).memoryId !== memoryId)) {
    projectionFail('projection-tampered', [...path, 'memoryId'])
  }
  if (summary.recordCount !== records.length || summary.eventCount !== eventCount
    || summary.receiptCount !== receiptCount) projectionFail('projection-tampered', path)
  const statuses = asObject(summary.statuses, [...path, 'statuses'])
  exactKeys(statuses, STATUS_VALUES, [...path, 'statuses'])
  for (const status of STATUS_VALUES) {
    const expected = records.filter(record => asObject(record, []).status === status).length
    if (statuses[status] !== expected) projectionFail('projection-tampered', [...path, 'statuses', status])
  }
  if (canonicalizeSafeJson(summary.activeVersionIds!)
    !== canonicalizeSafeJson(snapshotSafeJson(chain.activeVersionIds))) {
    projectionFail('projection-tampered', [...path, 'activeVersionIds'])
  }
  text(summary.purgeState, [...path, 'purgeState'])
}
function validateProjectionSource(
  value: SafeJson | undefined,
  events: readonly object[],
  receipts: readonly object[],
  chain: ReturnType<typeof projectMemoryHistoryV1>,
  scopeDigest: Sha256,
  path: readonly string[],
): void {
  const source = asObject(value, path)
  const historyDigest = digestSafeJson(snapshotSafeJson({ events, receipts }))
  if (source.historyDigest !== historyDigest || source.generation !== chain.generation
    || source.sequence !== chain.lastSequence) projectionFail('source-mismatch', path)
  const expectedSourceDigest = digestSafeJson(snapshotSafeJson({
    scopeDigest,
    recordSetDigest: source.recordSetDigest,
    historyDigest: source.historyDigest,
    generation: source.generation,
    sequence: source.sequence,
  }))
  if (source.sourceDigest !== expectedSourceDigest) projectionFail('source-mismatch', path)
}
function validateSource(value: SafeJson | undefined, scopeDigest: Sha256, path: readonly string[]): void {
  const source = asObject(value, path)
  exactKeys(source, ['recordSetDigest', 'historyDigest', 'generation', 'sequence', 'sourceDigest'], path)
  for (const key of ['recordSetDigest', 'historyDigest', 'sourceDigest'] as const) digest(source[key], [...path, key])
  safeInteger(source.generation, [...path, 'generation'])
  safeInteger(source.sequence, [...path, 'sequence'])
  void scopeDigest
}
function validatePolicyRef(value: SafeJson | undefined, path: readonly string[]): void {
  const policy = asObject(value, path)
  exactKeys(policy, ['id', 'version', 'digest'], path)
  text(policy.id, [...path, 'id'])
  text(policy.version, [...path, 'version'])
  digest(policy.digest, [...path, 'digest'])
}
function validateScope(value: SafeJson | undefined, path: readonly string[]): JsonObject {
  const scope = asObject(value, path)
  exactKeys(scope, [
    'tenantId', 'workspaceId', 'projectId', 'repositoryId', 'taskId', 'threadId',
    'userId', 'agentId', 'personaId', 'namespace',
  ], path, true)
  for (const [key, child] of Object.entries(scope)) text(child, [...path, key])
  if (scope.tenantId === undefined || scope.namespace === undefined) projectionFail('invalid-input', path)
  return scope
}
function asObject(value: SafeJson | undefined, path: readonly string[]): JsonObject {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    projectionFail('invalid-input', path)
  }
  return value as JsonObject
}
function exactKeys(
  object: JsonObject,
  allowed: readonly string[],
  path: readonly string[],
  optional = false,
): void {
  const keys = Object.keys(object)
  if (keys.some(key => !allowed.includes(key))) projectionFail('unknown-field', path)
  if (!optional && allowed.some(key => !keys.includes(key))) projectionFail('invalid-input', path)
}
function requireKeys(object: JsonObject, keys: readonly string[], path: readonly string[]): void {
  if (keys.some(key => object[key] === undefined)) projectionFail('invalid-input', path)
}
function arrayValue(value: SafeJson | undefined, path: readonly string[]): readonly SafeJson[] {
  if (!Array.isArray(value)) projectionFail('invalid-input', path)
  return value
}
function validateStringArray(value: SafeJson | undefined, path: readonly string[]): void {
  const array = arrayValue(value, path)
  array.forEach((child, index) => text(child, [...path, String(index)]))
  assertSortedUnique(array, child => String(child), path)
}
function assertSortedUnique<T>(
  values: readonly T[],
  identity: (value: T) => string,
  path: readonly string[],
): void {
  const identities = values.map(identity)
  const sorted = [...identities].sort()
  if (new Set(identities).size !== identities.length
    || identities.some((value, index) => value !== sorted[index])) {
    projectionFail('identity-conflict', path)
  }
}
function expectString(object: JsonObject, key: string, expected: string, path: readonly string[]): void {
  if (text(object[key], [...path, key]) !== expected) projectionFail('invalid-input', [...path, key])
}
function text(value: SafeJson | undefined, path: readonly string[]): string {
  if (typeof value !== 'string' || value.length === 0) projectionFail('invalid-input', path)
  return value
}
function digest(value: SafeJson | undefined, path: readonly string[]): Sha256 {
  const result = text(value, path)
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) projectionFail('invalid-input', path)
  return result as Sha256
}
function timestamp(value: SafeJson | undefined, path: readonly string[]): void {
  const result = text(value, path)
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) {
    projectionFail('invalid-input', path)
  }
}
function safeInteger(value: SafeJson | undefined, path: readonly string[]): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    projectionFail('invalid-input', path)
  }
}
function finiteNumber(value: SafeJson | undefined, path: readonly string[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) projectionFail('invalid-input', path)
}
function boolean(value: SafeJson | undefined, path: readonly string[]): void {
  if (typeof value !== 'boolean') projectionFail('invalid-input', path)
}
