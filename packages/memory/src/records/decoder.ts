import { MemoryRecordDecodeError } from './errors.js'
import {
  canonicalizeSafeJson,
  deepFreezeSafeJson,
  digestSafeJson,
  snapshotSafeJson,
  type SafeJson,
} from './safe-json.js'
import {
  actorRefValue,
  booleanValue,
  boundedText,
  digestValue,
  enumValue,
  fail,
  identifierValue,
  integerValue,
  objectValue,
  optional,
  optionalActorRef,
  optionalIdentifierFields,
  optionalTimestampFields,
  required,
  score,
  scoreValue,
  sensitivityValue,
  stringValue,
  timestampValue,
  type JsonObject,
} from './decoder-primitives.js'
import type {
  MemoryContentRefV1,
  MemoryEvidenceRefV1,
  MemoryGovernanceV1,
  MemoryKindV1,
  MemoryLifecycleV1,
  MemoryProvenanceV1,
  MemoryQualityV1,
  MemoryRecordV1,
  MemoryScopeV1,
  MemorySensitivityClassV1,
  MemoryStatusV1,
  MemoryTemporalV1,
} from './types.js'

const RECORD_SCHEMA = 'datazup.memory.record/v1' as const
const CONTENT_REF_SCHEMA = 'datazup.memory.content-ref/v1' as const
const EVIDENCE_REF_SCHEMA = 'datazup.memory.evidence-ref/v1' as const
const MAX_INLINE_CONTENT_BYTES = 16 * 1024
const MAX_TAGS = 32
const MAX_EVIDENCE_REFS = 32

type SafeDecodeResult =
  | { readonly success: true; readonly data: MemoryRecordV1 }
  | { readonly success: false; readonly error: MemoryRecordDecodeError }

export function decodeMemoryRecordV1(input: unknown): MemoryRecordV1
export function decodeMemoryRecordV1(
  input: unknown,
  options: { readonly safe: true },
): SafeDecodeResult
export function decodeMemoryRecordV1(
  input: unknown,
  options?: { readonly safe: true },
): MemoryRecordV1 | SafeDecodeResult {
  try {
    const record = decodeRecord(snapshotSafeJson(input))
    return options?.safe === true
      ? Object.freeze({ success: true as const, data: record })
      : record
  } catch (cause) {
    const error = cause instanceof MemoryRecordDecodeError
      ? cause
      : new MemoryRecordDecodeError('unsafe-object', [])
    if (options?.safe === true) {
      return Object.freeze({ success: false as const, error })
    }
    throw error
  }
}

function decodeRecord(value: SafeJson): MemoryRecordV1 {
  const root = objectValue(value, [], [
    'schema', 'memoryId', 'versionId', 'kind', 'scope', 'lifecycle', 'temporal',
    'provenance', 'governance', 'quality', 'contentDigest', 'content',
    'contentRef', 'searchTextRef', 'tags',
  ])
  const schema = stringValue(root, 'schema', [])
  if (schema !== RECORD_SCHEMA) fail('invalid-schema', ['schema'])

  const memoryId = identifierValue(root, 'memoryId', [])
  const versionId = identifierValue(root, 'versionId', [])
  const kind = enumValue(root, 'kind', [], [
    'fact', 'preference', 'decision', 'episode', 'lesson', 'procedure',
    'summary', 'document-ref',
  ] satisfies readonly MemoryKindV1[])
  const scope = decodeScope(required(root, 'scope', []), ['scope'])
  const lifecycle = decodeLifecycle(required(root, 'lifecycle', []), ['lifecycle'])
  const temporal = decodeTemporal(required(root, 'temporal', []), ['temporal'])
  const provenance = decodeProvenance(required(root, 'provenance', []), ['provenance'])
  const governance = decodeGovernance(required(root, 'governance', []), ['governance'])
  const quality = decodeQuality(required(root, 'quality', []), ['quality'])
  const contentDigest = digestValue(root, 'contentDigest', [])
  const tags = decodeTags(required(root, 'tags', []), ['tags'])

  validateTemporalOrder(temporal, lifecycle)
  validateVersionRefs(versionId, lifecycle)

  const contentValue = optional(root, 'content')
  const content = contentValue === undefined
    ? undefined
    : objectValue(contentValue, ['content'])
  const contentRefValue = optional(root, 'contentRef')
  const contentRef = contentRefValue === undefined
    ? undefined
    : decodeContentRef(contentRefValue, ['contentRef'])
  const searchTextRefValue = optional(root, 'searchTextRef')
  const searchTextRef = searchTextRefValue === undefined
    ? undefined
    : decodeContentRef(searchTextRefValue, ['searchTextRef'])

  validatePayload({
    kind,
    status: lifecycle.status,
    sensitivity: governance.sensitivity,
    contentDigest,
    ...(content === undefined ? {} : { content }),
    ...(contentRef === undefined ? {} : { contentRef }),
    ...(searchTextRef === undefined ? {} : { searchTextRef }),
  })

  const record: MemoryRecordV1 = {
    schema,
    memoryId,
    versionId,
    kind,
    scope,
    lifecycle,
    temporal,
    provenance,
    governance,
    quality,
    contentDigest,
    ...(content === undefined ? {} : { content }),
    ...(contentRef === undefined ? {} : { contentRef }),
    ...(searchTextRef === undefined ? {} : { searchTextRef }),
    tags,
  }
  return deepFreezeSafeJson(record as unknown as SafeJson) as unknown as MemoryRecordV1
}

function decodeScope(value: SafeJson, path: readonly string[]): MemoryScopeV1 {
  const record = objectValue(value, path, [
    'tenantId', 'workspaceId', 'projectId', 'repositoryId', 'taskId', 'threadId',
    'userId', 'agentId', 'personaId', 'namespace',
  ])
  return {
    tenantId: identifierValue(record, 'tenantId', path),
    ...optionalIdentifierFields(record, path, [
      'workspaceId', 'projectId', 'repositoryId', 'taskId', 'threadId',
      'userId', 'agentId', 'personaId',
    ]),
    namespace: identifierValue(record, 'namespace', path),
  }
}

function decodeLifecycle(value: SafeJson, path: readonly string[]): MemoryLifecycleV1 {
  const record = objectValue(value, path, [
    'status', 'priorVersionId', 'supersedesVersionId', 'supersededByVersionId',
    'revokesVersionId', 'reasonCode', 'transitionSequence', 'lastTransitionAt',
  ])
  return {
    status: enumValue(record, 'status', path, [
      'captured', 'candidate', 'review-required', 'active', 'disputed',
      'superseded', 'revoked', 'expired', 'archived', 'purged', 'rejected',
    ] satisfies readonly MemoryStatusV1[]),
    ...optionalIdentifierFields(record, path, [
      'priorVersionId', 'supersedesVersionId', 'supersededByVersionId',
      'revokesVersionId',
    ]),
    reasonCode: identifierValue(record, 'reasonCode', path),
    transitionSequence: integerValue(record, 'transitionSequence', path),
    lastTransitionAt: timestampValue(record, 'lastTransitionAt', path),
  }
}

function decodeTemporal(value: SafeJson, path: readonly string[]): MemoryTemporalV1 {
  const record = objectValue(value, path, [
    'observedAt', 'recordedAt', 'updatedAt', 'validFrom', 'validTo',
    'lastVerifiedAt', 'expiresAt', 'sourceEventTime',
  ])
  return {
    observedAt: timestampValue(record, 'observedAt', path),
    recordedAt: timestampValue(record, 'recordedAt', path),
    updatedAt: timestampValue(record, 'updatedAt', path),
    ...optionalTimestampFields(record, path, [
      'validFrom', 'validTo', 'lastVerifiedAt', 'expiresAt', 'sourceEventTime',
    ]),
  }
}

function decodeProvenance(value: SafeJson, path: readonly string[]): MemoryProvenanceV1 {
  const record = objectValue(value, path, [
    'sourceKind', 'sourceId', 'sourceDigest', 'evidenceRefs', 'createdByRef',
    'reviewedByRef', 'extractionProfileId', 'extractionProfileVersion',
  ])
  const refsValue = required(record, 'evidenceRefs', path)
  if (!Array.isArray(refsValue)) fail('invalid-type', [...path, 'evidenceRefs'])
  if (refsValue.length > MAX_EVIDENCE_REFS) fail('limit-exceeded', [...path, 'evidenceRefs'])
  const evidenceRefs = refsValue.map((item, index) =>
    decodeEvidenceRef(item, [...path, 'evidenceRefs', String(index)]))

  return {
    sourceKind: enumValue(record, 'sourceKind', path, [
      'explicit-user', 'application', 'model-observation', 'tool-observation',
      'document', 'run-evidence', 'import',
    ] as const),
    sourceId: identifierValue(record, 'sourceId', path),
    sourceDigest: digestValue(record, 'sourceDigest', path),
    evidenceRefs,
    createdByRef: actorRefValue(record, 'createdByRef', path),
    ...(optionalActorRef(record, 'reviewedByRef', path)),
    ...optionalIdentifierFields(record, path, [
      'extractionProfileId', 'extractionProfileVersion',
    ]),
  }
}

function decodeEvidenceRef(value: SafeJson, path: readonly string[]): MemoryEvidenceRefV1 {
  const record = objectValue(value, path, [
    'schema', 'kind', 'owner', 'id', 'digest', 'observedAt', 'sensitivity',
  ])
  const schema = stringValue(record, 'schema', path)
  if (schema !== EVIDENCE_REF_SCHEMA) fail('invalid-schema', [...path, 'schema'])
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

function decodeContentRef(value: SafeJson, path: readonly string[]): MemoryContentRefV1 {
  const record = objectValue(value, path, [
    'schema', 'owner', 'id', 'digest', 'mediaType', 'byteLength',
  ])
  const schema = stringValue(record, 'schema', path)
  if (schema !== CONTENT_REF_SCHEMA) fail('invalid-schema', [...path, 'schema'])
  const mediaType = stringValue(record, 'mediaType', path)
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i.test(mediaType)) {
    fail('invalid-value', [...path, 'mediaType'])
  }
  return {
    schema,
    owner: identifierValue(record, 'owner', path),
    id: identifierValue(record, 'id', path),
    digest: digestValue(record, 'digest', path),
    mediaType,
    byteLength: integerValue(record, 'byteLength', path),
  }
}

function decodeGovernance(value: SafeJson, path: readonly string[]): MemoryGovernanceV1 {
  const record = objectValue(value, path, [
    'sensitivity', 'retentionPolicyId', 'retentionPolicyVersion', 'consentRef',
    'accessPolicyRef', 'writePolicyRef', 'legalHold', 'exportable', 'userVisible',
  ])
  return {
    sensitivity: sensitivityValue(record, 'sensitivity', path),
    retentionPolicyId: identifierValue(record, 'retentionPolicyId', path),
    retentionPolicyVersion: identifierValue(record, 'retentionPolicyVersion', path),
    ...optionalIdentifierFields(record, path, ['consentRef']),
    accessPolicyRef: identifierValue(record, 'accessPolicyRef', path),
    writePolicyRef: identifierValue(record, 'writePolicyRef', path),
    legalHold: booleanValue(record, 'legalHold', path),
    exportable: booleanValue(record, 'exportable', path),
    userVisible: booleanValue(record, 'userVisible', path),
  }
}

function decodeQuality(value: SafeJson, path: readonly string[]): MemoryQualityV1 {
  const record = objectValue(value, path, [
    'confidence', 'sourceTrust', 'extractionQuality', 'freshnessState',
    'contradictionState', 'verificationState',
  ])
  const extractionQuality = optional(record, 'extractionQuality')
  return {
    confidence: scoreValue(record, 'confidence', path),
    sourceTrust: scoreValue(record, 'sourceTrust', path),
    ...(extractionQuality === undefined ? {} : {
      extractionQuality: score(extractionQuality, [...path, 'extractionQuality']),
    }),
    freshnessState: enumValue(record, 'freshnessState', path, [
      'unknown', 'current', 'stale',
    ] as const),
    contradictionState: enumValue(record, 'contradictionState', path, [
      'none', 'possible', 'confirmed', 'resolved',
    ] as const),
    verificationState: enumValue(record, 'verificationState', path, [
      'unverified', 'machine-checked', 'human-reviewed',
    ] as const),
  }
}

function decodeTags(value: SafeJson, path: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) fail('invalid-type', path)
  if (value.length > MAX_TAGS) fail('limit-exceeded', path)
  const tags = value.map((item, index) => boundedText(item, [...path, String(index)], 64))
  if (new Set(tags).size !== tags.length) fail('invalid-value', path)
  return tags
}

function validatePayload(input: {
  readonly kind: MemoryKindV1
  readonly status: MemoryStatusV1
  readonly sensitivity: MemorySensitivityClassV1
  readonly contentDigest: `sha256:${string}`
  readonly content?: JsonObject
  readonly contentRef?: MemoryContentRefV1
  readonly searchTextRef?: MemoryContentRefV1
}): void {
  if (input.status === 'purged') {
    if (input.content || input.contentRef || input.searchTextRef) fail('invalid-value', ['content'])
    return
  }
  if ((input.content === undefined) === (input.contentRef === undefined)) {
    fail('invalid-value', ['content'])
  }
  if (input.sensitivity === 'restricted' && input.content !== undefined) {
    fail('invalid-value', ['content'])
  }
  if (input.kind === 'document-ref' && input.contentRef === undefined) {
    fail('invalid-value', ['contentRef'])
  }
  if (input.content !== undefined) {
    validateInlineContent(input.content, ['content'])
    if (Buffer.byteLength(canonicalizeSafeJson(input.content), 'utf8') > MAX_INLINE_CONTENT_BYTES) {
      fail('limit-exceeded', ['content'])
    }
    if (digestSafeJson(input.content) !== input.contentDigest) {
      fail('invalid-content-digest', ['contentDigest'])
    }
  }
  if (input.contentRef !== undefined && input.contentRef.digest !== input.contentDigest) {
    fail('invalid-content-digest', ['contentDigest'])
  }
}

export function validateInlineContent(value: SafeJson, path: readonly string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateInlineContent(item, [...path, String(index)]))
    return
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && isRawPath(value)) fail('invalid-value', path)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (isForbiddenMetadataKey(normalized)) fail('invalid-value', [...path, key])
    if (typeof child === 'boolean' && /(authorit|authoriz|consentgrant|permissiongrant)/.test(normalized)) {
      fail('invalid-value', [...path, key])
    }
    validateInlineContent(child, [...path, key])
  }
}

function isForbiddenMetadataKey(key: string): boolean {
  return /^(password|passphrase|secret|token|cookie|credential|privatekey|rawprompt|systemprompt|prompt|rawtooloutput|tooloutput|operationalreceipt|receipt|authority|authorized|consentgrant|consentgranted)$/.test(key)
}

function isRawPath(value: string): boolean {
  return value.startsWith('/')
    || /^[a-z]:[\\/]/i.test(value)
    || value.startsWith('\\\\')
    || value.toLowerCase().startsWith('file:')
}

function validateTemporalOrder(
  temporal: MemoryTemporalV1,
  lifecycle: MemoryLifecycleV1,
): void {
  const observed = instant(temporal.observedAt)
  const recorded = instant(temporal.recordedAt)
  const updated = instant(temporal.updatedAt)
  if (observed > recorded || recorded > updated) fail('invalid-time-order', ['temporal'])
  if (instant(lifecycle.lastTransitionAt) < recorded || instant(lifecycle.lastTransitionAt) > updated) {
    fail('invalid-time-order', ['lifecycle', 'lastTransitionAt'])
  }
  if (temporal.validFrom && temporal.validTo
    && instant(temporal.validFrom) > instant(temporal.validTo)) {
    fail('invalid-time-order', ['temporal', 'validTo'])
  }
  if (temporal.lastVerifiedAt
    && (instant(temporal.lastVerifiedAt) < observed || instant(temporal.lastVerifiedAt) > updated)) {
    fail('invalid-time-order', ['temporal', 'lastVerifiedAt'])
  }
  if (temporal.expiresAt && instant(temporal.expiresAt) < observed) {
    fail('invalid-time-order', ['temporal', 'expiresAt'])
  }
  if (temporal.sourceEventTime && instant(temporal.sourceEventTime) > observed) {
    fail('invalid-time-order', ['temporal', 'sourceEventTime'])
  }
}

function validateVersionRefs(versionId: string, lifecycle: MemoryLifecycleV1): void {
  for (const [key, value] of Object.entries(lifecycle)) {
    if (key.endsWith('VersionId') && value === versionId) {
      fail('invalid-value', ['lifecycle', key])
    }
  }
}

function instant(value: string): number {
  return new Date(value).getTime()
}
