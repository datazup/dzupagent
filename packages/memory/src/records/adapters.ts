import type { MemoryRecord } from '@dzupagent/agent-types'

import type { StagedRecord } from '../staged-writer.js'
import { validateInlineContent, decodeMemoryRecordV1 } from './decoder.js'
import {
  fail,
  objectValue,
  required,
  type JsonObject,
} from './decoder-primitives.js'
import {
  digestSafeJson,
  snapshotSafeJson,
  type SafeJson,
} from './safe-json.js'
import type {
  MemoryContentRefV1,
  MemoryGovernanceV1,
  MemoryKindV1,
  MemoryLifecycleV1,
  MemoryProvenanceV1,
  MemoryQualityV1,
  MemoryRecordV1,
  MemoryScopeV1,
  MemoryTemporalV1,
} from './types.js'

type AdapterTemporalInput = Omit<MemoryTemporalV1, 'recordedAt' | 'updatedAt'>

interface AdapterInputs {
  readonly versionId: string
  readonly kind: MemoryKindV1
  readonly scope: MemoryScopeV1
  readonly lifecycle: MemoryLifecycleV1
  readonly temporal: AdapterTemporalInput
  readonly provenance: MemoryProvenanceV1
  readonly governance: MemoryGovernanceV1
  readonly quality: MemoryQualityV1
  readonly contentRef?: MemoryContentRefV1
  readonly searchTextRef?: MemoryContentRefV1
  readonly tags?: readonly string[]
}

interface StagedAdapterInputs extends Omit<AdapterInputs, 'quality'> {
  readonly quality: Omit<MemoryQualityV1, 'confidence'>
}

const ADAPTER_FIELDS = [
  'versionId', 'kind', 'scope', 'lifecycle', 'temporal', 'provenance',
  'governance', 'quality', 'contentRef', 'searchTextRef', 'tags',
] as const
const SCOPE_FIELDS = [
  'tenantId', 'workspaceId', 'projectId', 'repositoryId', 'taskId', 'threadId',
  'userId', 'agentId', 'personaId', 'namespace',
] as const
const TEMPORAL_INPUT_FIELDS = [
  'observedAt', 'validFrom', 'validTo', 'lastVerifiedAt', 'expiresAt',
  'sourceEventTime',
] as const

/**
 * Adapt the Layer-0 CRUD transport record without changing that public shape.
 * Policy, provenance, semantic kind, and observation time remain required.
 */
export function adaptMemoryRecordToV1(
  record: MemoryRecord,
  inputs: AdapterInputs,
): MemoryRecordV1 {
  const envelope = adapterEnvelope(record, inputs)
  const legacy = objectValue(required(envelope, 'record', []), ['record'], [
    'id', 'namespace', 'scope', 'content', 'metadata', 'createdAt', 'updatedAt',
  ])
  const options = adapterOptions(envelope)
  const scope = objectValue(required(legacy, 'scope', ['record']), ['record', 'scope'], [
    'tenantId', 'workspaceId', 'projectId', 'taskId',
  ])
  const canonicalScope = canonicalScopeFrom(options)
  assertScopeMatches(scope, canonicalScope, ['record', 'scope'])
  assertEqual(required(legacy, 'namespace', ['record']), required(canonicalScope, 'namespace', ['scope']), [
    'record', 'namespace',
  ])

  const createdAt = epochMillis(required(legacy, 'createdAt', ['record']), ['record', 'createdAt'])
  const updatedAt = epochMillis(required(legacy, 'updatedAt', ['record']), ['record', 'updatedAt'])
  if (createdAt > updatedAt) fail('invalid-time-order', ['record', 'updatedAt'])

  const content = transportContent(legacy)
  return buildRecord(
    required(legacy, 'id', ['record']),
    content,
    createdAt,
    updatedAt,
    options,
  )
}

/** Adapt the legacy staged envelope while requiring missing canonical policy. */
export function adaptStagedRecordToV1(
  record: StagedRecord,
  inputs: StagedAdapterInputs,
): MemoryRecordV1 {
  const envelope = adapterEnvelope(record, inputs)
  const legacy = objectValue(required(envelope, 'record', []), ['record'], [
    'key', 'namespace', 'scope', 'value', 'stage', 'captureReason', 'confidence',
    'createdAt', 'promotedAt', 'confirmedAt',
  ])
  const options = adapterOptions(envelope)
  const scope = objectValue(required(legacy, 'scope', ['record']), ['record', 'scope'], SCOPE_FIELDS)
  const canonicalScope = canonicalScopeFrom(options)
  assertScopeMatches(scope, canonicalScope, ['record', 'scope'])
  assertEqual(required(legacy, 'namespace', ['record']), required(canonicalScope, 'namespace', ['scope']), [
    'record', 'namespace',
  ])

  const createdAt = epochMillis(required(legacy, 'createdAt', ['record']), ['record', 'createdAt'])
  const lifecycle = objectValue(required(options, 'lifecycle', ['inputs']), ['inputs', 'lifecycle'])
  const transitionAt = canonicalInstant(required(lifecycle, 'lastTransitionAt', ['inputs', 'lifecycle']), [
    'inputs', 'lifecycle', 'lastTransitionAt',
  ])
  validateStagedLifecycle(legacy, lifecycle, transitionAt)
  if (transitionAt < createdAt) fail('invalid-time-order', ['inputs', 'lifecycle', 'lastTransitionAt'])

  const qualityInput = objectValue(required(options, 'quality', ['inputs']), ['inputs', 'quality'], [
    'sourceTrust', 'extractionQuality', 'freshnessState', 'contradictionState',
    'verificationState',
  ])
  const quality = {
    ...qualityInput,
    confidence: required(legacy, 'confidence', ['record']),
  }
  const adjustedOptions: JsonObject = {
    ...options,
    quality: snapshotSafeJson(quality),
  }
  const content = stagedContent(legacy)
  return buildRecord(
    required(legacy, 'key', ['record']),
    content,
    createdAt,
    transitionAt,
    adjustedOptions,
  )
}

function stagedContent(record: JsonObject): JsonObject {
  const value = objectValue(required(record, 'value', ['record']), ['record', 'value'])
  return snapshotSafeJson({
    format: 'datazup.memory.staged-content/v1',
    value,
    legacyStage: {
      stage: required(record, 'stage', ['record']),
      confidence: required(record, 'confidence', ['record']),
      createdAt: required(record, 'createdAt', ['record']),
      ...(record['captureReason'] === undefined ? {} : { captureReason: record['captureReason'] }),
      ...(record['promotedAt'] === undefined ? {} : { promotedAt: record['promotedAt'] }),
      ...(record['confirmedAt'] === undefined ? {} : { confirmedAt: record['confirmedAt'] }),
    },
  }) as JsonObject
}

function adapterEnvelope(record: unknown, inputs: unknown): JsonObject {
  return objectValue(snapshotSafeJson({ record, inputs }), [], ['record', 'inputs'])
}

function adapterOptions(envelope: JsonObject): JsonObject {
  return objectValue(required(envelope, 'inputs', []), ['inputs'], ADAPTER_FIELDS)
}

function canonicalScopeFrom(options: JsonObject): JsonObject {
  return objectValue(required(options, 'scope', ['inputs']), ['inputs', 'scope'], SCOPE_FIELDS)
}

function transportContent(record: JsonObject): JsonObject {
  const text = required(record, 'content', ['record'])
  if (typeof text !== 'string') fail('invalid-type', ['record', 'content'])
  const metadata = record['metadata']
  if (metadata !== undefined) objectValue(metadata, ['record', 'metadata'])
  return snapshotSafeJson({
    format: 'datazup.memory.transport-content/v1',
    text,
    ...(metadata === undefined ? {} : { legacyMetadata: metadata }),
  }) as JsonObject
}

function buildRecord(
  memoryId: SafeJson,
  content: JsonObject,
  recordedAt: number,
  updatedAt: number,
  options: JsonObject,
): MemoryRecordV1 {
  validateInlineContent(content, ['content'])
  const temporalInput = objectValue(required(options, 'temporal', ['inputs']), ['inputs', 'temporal'], TEMPORAL_INPUT_FIELDS)
  const contentDigest = digestSafeJson(content)
  const contentRef = options['contentRef']
  const candidate = {
    schema: 'datazup.memory.record/v1',
    memoryId,
    versionId: required(options, 'versionId', ['inputs']),
    kind: required(options, 'kind', ['inputs']),
    scope: required(options, 'scope', ['inputs']),
    lifecycle: required(options, 'lifecycle', ['inputs']),
    temporal: {
      ...temporalInput,
      recordedAt: new Date(recordedAt).toISOString(),
      updatedAt: new Date(updatedAt).toISOString(),
    },
    provenance: required(options, 'provenance', ['inputs']),
    governance: required(options, 'governance', ['inputs']),
    quality: required(options, 'quality', ['inputs']),
    contentDigest,
    ...(contentRef === undefined ? { content } : { contentRef }),
    ...(options['searchTextRef'] === undefined ? {} : { searchTextRef: options['searchTextRef'] }),
    tags: options['tags'] ?? [],
  }
  return decodeMemoryRecordV1(candidate)
}

function assertScopeMatches(
  legacy: JsonObject,
  canonical: JsonObject,
  path: readonly string[],
): void {
  for (const [key, value] of Object.entries(legacy)) {
    assertEqual(value, canonical[key], [...path, key])
  }
}

function assertEqual(left: SafeJson | undefined, right: SafeJson | undefined, path: readonly string[]): void {
  if (typeof left !== 'string' || left !== right) fail('invalid-value', path)
}

function validateStagedLifecycle(
  record: JsonObject,
  lifecycle: JsonObject,
  transitionAt: number,
): void {
  const stage = required(record, 'stage', ['record'])
  const status = required(lifecycle, 'status', ['inputs', 'lifecycle'])
  const statusByStage: Record<string, string> = {
    captured: 'captured',
    candidate: 'candidate',
    confirmed: 'active',
    rejected: 'rejected',
  }
  if (typeof stage !== 'string' || statusByStage[stage] !== status) {
    fail('invalid-value', ['inputs', 'lifecycle', 'status'])
  }
  const timestampKey = stage === 'candidate'
    ? 'promotedAt'
    : stage === 'confirmed'
      ? 'confirmedAt'
      : stage === 'captured'
        ? 'createdAt'
        : undefined
  if (timestampKey) {
    const recordedTransition = epochMillis(required(record, timestampKey, ['record']), ['record', timestampKey])
    if (recordedTransition !== transitionAt) {
      fail('invalid-time-order', ['inputs', 'lifecycle', 'lastTransitionAt'])
    }
  }
}

function epochMillis(value: SafeJson, path: readonly string[]): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0
    || !Number.isFinite(new Date(value).getTime())) {
    fail('invalid-value', path)
  }
  return value
}

function canonicalInstant(value: SafeJson, path: readonly string[]): number {
  if (typeof value !== 'string') fail('invalid-type', path)
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    fail('invalid-value', path)
  }
  return date.getTime()
}
