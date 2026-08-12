import {
  digestValue,
  enumValue,
  identifierValue,
  integerValue,
  objectValue,
  required,
  scoreValue,
  stringValue,
  timestampValue,
  type JsonObject,
} from '../records/decoder-primitives.js'
import { decodeMemoryRecordV1 } from '../records/decoder.js'
import { digestMemoryRecordV1 } from '../records/canonical.js'
import {
  deepFreezeSafeJson,
  digestSafeJson,
  snapshotSafeJson,
  type SafeJson,
} from '../records/safe-json.js'
import type { MemoryRecordV1, MemoryScopeV1 } from '../records/types.js'
import { MemoryRetrievalError, type MemoryRetrievalErrorCode } from './retrieval-error.js'
import type {
  InternalCandidateSetV1,
  InternalLifecycleResolutionV1,
  MemoryCandidateV1,
  MemoryQueryV1,
  MemoryRetrievalProfileV1,
} from './v1-types.js'

const CHANNELS = ['lexical', 'vector', 'graph'] as const
const LIFECYCLE_MODES = ['active', 'active-and-disputed', 'history'] as const
const PROVIDER_MODES = ['disabled', 'optional', 'required'] as const
const SENSITIVITIES = ['public', 'internal', 'confidential', 'restricted'] as const
const SCOPE_FIELDS = [
  'tenantId', 'workspaceId', 'projectId', 'repositoryId', 'taskId', 'threadId',
  'userId', 'agentId', 'personaId', 'namespace',
] as const
const RETRIEVAL_SNAPSHOT_LIMITS = {
  maxDepth: 16,
  maxTotalNodes: 65_536,
  maxTotalProperties: 32_768,
  maxObjectProperties: 128,
  maxArrayItems: 512,
  maxTotalStringBytes: 8 * 1024 * 1024,
} as const

export function decodeMemoryQueryV1(input: unknown): MemoryQueryV1 {
  return translate('invalid-query', () => {
    const root = objectValue(snapshotRetrievalJson(input), [], [
      'schema', 'scope', 'text', 'asOf',
    ])
    if (stringValue(root, 'schema', []) !== 'datazup.memory.query/v1') {
      fail('invalid-query', ['schema'])
    }
    const query: MemoryQueryV1 = {
      schema: 'datazup.memory.query/v1',
      scope: decodeScope(required(root, 'scope', []), ['scope']),
      text: queryText(required(root, 'text', []), ['text']),
      asOf: timestampValue(root, 'asOf', []),
    }
    return freeze(query)
  })
}

export function decodeMemoryRetrievalProfileV1(
  input: unknown,
): MemoryRetrievalProfileV1 {
  return translate('invalid-profile', () => {
    const root = objectValue(snapshotRetrievalJson(input), [], [
      'schema', 'profileId', 'profileVersion', 'channels', 'lifecycleMode',
      'queryRewrite', 'rerank', 'candidateLimit', 'resultLimit', 'tokenBudget',
      'maxRecordTokens', 'maxPerKind', 'rrfK', 'minimumScore',
      'minimumSourceTrust', 'freshnessHalfLifeDays', 'weights',
      'stageDeadlineMs', 'externalProviderPolicy',
    ])
    if (stringValue(root, 'schema', []) !== 'datazup.memory.retrieval-profile/v1') {
      fail('invalid-profile', ['schema'])
    }
    const channels = decodeChannels(required(root, 'channels', []))
    const candidateLimit = boundedInteger(root, 'candidateLimit', 1, 256)
    const resultLimit = boundedInteger(root, 'resultLimit', 1, 64)
    const tokenBudget = boundedInteger(root, 'tokenBudget', 1, 100_000)
    const maxRecordTokens = boundedInteger(root, 'maxRecordTokens', 1, 32_000)
    const maxPerKind = boundedInteger(root, 'maxPerKind', 1, 64)
    const rrfK = boundedInteger(root, 'rrfK', 1, 1_000)
    const freshnessHalfLifeDays = boundedInteger(root, 'freshnessHalfLifeDays', 1, 3_650)
    if (resultLimit > candidateLimit || maxPerKind > resultLimit
      || maxRecordTokens > tokenBudget) {
      fail('invalid-profile', ['limits'])
    }
    const weights = decodeWeights(required(root, 'weights', []))
    const profile: MemoryRetrievalProfileV1 = {
      schema: 'datazup.memory.retrieval-profile/v1',
      profileId: identifierValue(root, 'profileId', []),
      profileVersion: identifierValue(root, 'profileVersion', []),
      channels,
      lifecycleMode: enumValue(root, 'lifecycleMode', [], LIFECYCLE_MODES),
      queryRewrite: enumValue(root, 'queryRewrite', [], PROVIDER_MODES),
      rerank: enumValue(root, 'rerank', [], PROVIDER_MODES),
      ...(root['stageDeadlineMs'] === undefined ? {} : {
        stageDeadlineMs: boundedInteger(root, 'stageDeadlineMs', 1, 60_000),
      }),
      ...(root['externalProviderPolicy'] === undefined ? {} : {
        externalProviderPolicy: decodeExternalProviderPolicy(
          required(root, 'externalProviderPolicy', []),
        ),
      }),
      candidateLimit,
      resultLimit,
      tokenBudget,
      maxRecordTokens,
      maxPerKind,
      rrfK,
      minimumScore: scoreValue(root, 'minimumScore', []),
      minimumSourceTrust: scoreValue(root, 'minimumSourceTrust', []),
      freshnessHalfLifeDays,
      weights,
    }
    return freeze(profile)
  })
}

function decodeExternalProviderPolicy(
  value: SafeJson,
): NonNullable<MemoryRetrievalProfileV1['externalProviderPolicy']> {
  const path = ['externalProviderPolicy'] as const
  const root = objectValue(value, path, [
    'routeRef', 'retainsInput', 'allowQueryText', 'allowedInlineSensitivities',
  ])
  if (root['retainsInput'] !== false || typeof root['allowQueryText'] !== 'boolean') {
    fail('invalid-profile', path)
  }
  const values = required(root, 'allowedInlineSensitivities', path)
  if (!Array.isArray(values) || values.length > SENSITIVITIES.length) {
    fail('invalid-profile', [...path, 'allowedInlineSensitivities'])
  }
  const sensitivities = values.map((entry, index) => {
    if (typeof entry !== 'string' || !SENSITIVITIES.includes(entry as never)) {
      fail('invalid-profile', [...path, 'allowedInlineSensitivities', String(index)])
    }
    return entry as MemoryRecordV1['governance']['sensitivity']
  })
  if (new Set(sensitivities).size !== sensitivities.length) {
    fail('invalid-profile', [...path, 'allowedInlineSensitivities'])
  }
  return freeze({
    routeRef: identifierValue(root, 'routeRef', path),
    retainsInput: false as const,
    allowQueryText: root['allowQueryText'],
    allowedInlineSensitivities: Object.freeze(sensitivities),
  })
}

export function decodeCandidateSetV1(
  input: unknown,
  candidateLimit: number,
): InternalCandidateSetV1 {
  return translate('invalid-candidate-set', () => {
    const root = objectValue(snapshotRetrievalJson(input), [], [
      'schema', 'scope', 'candidates',
    ])
    if (stringValue(root, 'schema', []) !== 'datazup.memory.candidate-set/v1') {
      fail('invalid-candidate-set', ['schema'])
    }
    const value = required(root, 'candidates', [])
    if (!Array.isArray(value) || value.length > candidateLimit * CHANNELS.length) {
      fail('invalid-candidate-set', ['candidates'])
    }
    const candidates = value.map((entry, index) => decodeCandidate(entry, index))
    return freeze({
      schema: 'datazup.memory.candidate-set/v1' as const,
      scope: decodeScope(required(root, 'scope', []), ['scope']),
      candidates,
    })
  })
}

export function decodeLifecycleResolutionV1(
  input: unknown,
  recordLimit: number,
): InternalLifecycleResolutionV1 {
  return translate('invalid-lifecycle-resolution', () => {
    const root = objectValue(snapshotRetrievalJson(input), [], [
      'schema', 'scope', 'revisionDigest', 'records',
    ])
    if (stringValue(root, 'schema', []) !== 'datazup.memory.lifecycle-resolution/v1') {
      fail('invalid-lifecycle-resolution', ['schema'])
    }
    const value = required(root, 'records', [])
    if (!Array.isArray(value) || value.length > Math.min(512, recordLimit * 4)) {
      fail('invalid-lifecycle-resolution', ['records'])
    }
    const records = value.map((entry, index) => translate(
      'invalid-lifecycle-resolution',
      () => decodeMemoryRecordV1(entry),
      ['records', String(index)],
    ))
    return freeze({
      schema: 'datazup.memory.lifecycle-resolution/v1' as const,
      scope: decodeScope(required(root, 'scope', []), ['scope']),
      revisionDigest: digestValue(root, 'revisionDigest', []),
      records,
    })
  })
}

export function retrievalScopeDigest(scope: MemoryScopeV1): `sha256:${string}` {
  return digestSafeJson(snapshotRetrievalJson({
    schema: 'datazup.memory.scope-key/v1',
    scope,
  }))
}

export function retrievalQueryDigest(query: MemoryQueryV1): `sha256:${string}` {
  return digestSafeJson(snapshotRetrievalJson(query))
}

export function sameScope(left: MemoryScopeV1, right: MemoryScopeV1): boolean {
  return retrievalScopeDigest(left) === retrievalScopeDigest(right)
}

export function snapshotRetrievalJson(input: unknown): SafeJson {
  return snapshotSafeJson(input, RETRIEVAL_SNAPSHOT_LIMITS)
}

function decodeCandidate(value: SafeJson, index: number): MemoryCandidateV1 {
  const path = ['candidates', String(index)]
  const root = objectValue(value, path, [
    'schema', 'channel', 'rank', 'score', 'recordDigest', 'record',
    'relationshipRef',
  ])
  if (stringValue(root, 'schema', path) !== 'datazup.memory.candidate/v1') {
    fail('invalid-candidate-set', [...path, 'schema'])
  }
  const record = translate(
    'invalid-candidate-set',
    () => decodeMemoryRecordV1(required(root, 'record', path)),
    [...path, 'record'],
  )
  const recordDigest = digestValue(root, 'recordDigest', path)
  if (recordDigest !== digestMemoryRecordV1(record)) {
    fail('invalid-candidate-set', [...path, 'recordDigest'])
  }
  const relationshipRef = root['relationshipRef'] === undefined
    ? undefined
    : identifierValue(root, 'relationshipRef', path)
  return freeze({
    schema: 'datazup.memory.candidate/v1' as const,
    channel: enumValue(root, 'channel', path, CHANNELS),
    rank: boundedInteger(root, 'rank', 1, 256, path, 'invalid-candidate-set'),
    score: scoreValue(root, 'score', path),
    recordDigest,
    record,
    ...(relationshipRef === undefined ? {} : { relationshipRef }),
  })
}

function decodeScope(
  value: SafeJson,
  path: readonly string[],
): MemoryScopeV1 {
  const root = objectValue(value, path, SCOPE_FIELDS)
  const scope: Record<string, string> = {
    tenantId: identifierValue(root, 'tenantId', path),
    namespace: identifierValue(root, 'namespace', path),
  }
  for (const key of SCOPE_FIELDS.slice(1, -1)) {
    if (root[key] !== undefined) scope[key] = identifierValue(root, key, path)
  }
  return freeze(scope) as unknown as MemoryScopeV1
}

function decodeChannels(value: SafeJson): readonly ('lexical' | 'vector' | 'graph')[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > CHANNELS.length) {
    fail('invalid-profile', ['channels'])
  }
  const channels = value.map((entry, index) => {
    if (typeof entry !== 'string' || !CHANNELS.includes(entry as never)) {
      fail('invalid-profile', ['channels', String(index)])
    }
    return entry as 'lexical' | 'vector' | 'graph'
  })
  if (new Set(channels).size !== channels.length
    || !channels.includes('lexical') || !channels.includes('vector')) {
    fail('invalid-profile', ['channels'])
  }
  return Object.freeze(channels)
}

function decodeWeights(value: SafeJson): MemoryRetrievalProfileV1['weights'] {
  const root = objectValue(value, ['weights'], ['fusion', 'sourceTrust', 'freshness'])
  const weights = {
    fusion: scoreValue(root, 'fusion', ['weights']),
    sourceTrust: scoreValue(root, 'sourceTrust', ['weights']),
    freshness: scoreValue(root, 'freshness', ['weights']),
  }
  if (Math.abs(weights.fusion + weights.sourceTrust + weights.freshness - 1) > 1e-9) {
    fail('invalid-profile', ['weights'])
  }
  return freeze(weights)
}

function queryText(value: SafeJson, path: readonly string[]): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
    || Buffer.byteLength(value, 'utf8') > 2_048
    || /[\u0000\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail('invalid-query', path)
  }
  return value
}

function boundedInteger(
  root: JsonObject,
  key: string,
  minimum: number,
  maximum: number,
  path: readonly string[] = [],
  code: MemoryRetrievalErrorCode = 'invalid-profile',
): number {
  const value = integerValue(root, key, path)
  if (value < minimum || value > maximum) fail(code, [...path, key])
  return value
}

function translate<T>(
  code: MemoryRetrievalErrorCode,
  operation: () => T,
  path: readonly string[] = [],
): T {
  try {
    return operation()
  } catch (cause) {
    if (cause instanceof MemoryRetrievalError) throw cause
    throw new MemoryRetrievalError(code, path)
  }
}

function fail(code: MemoryRetrievalErrorCode, path: readonly string[] = []): never {
  throw new MemoryRetrievalError(code, path)
}

function freeze<T>(value: T): T {
  return deepFreezeSafeJson(
    snapshotRetrievalJson(value),
  ) as unknown as T
}
