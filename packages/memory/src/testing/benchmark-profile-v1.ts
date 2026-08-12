import {
  digestValue,
  enumValue,
  identifierValue,
  integerValue,
  objectValue,
  required,
  scoreValue,
  stringValue,
  type JsonObject,
} from '../records/decoder-primitives.js'
import {
  deepFreezeSafeJson,
  digestSafeJson,
  snapshotSafeJson,
  type SafeJson,
} from '../records/safe-json.js'
import type { MemorySensitivityClassV1 } from '../records/types.js'

const PROFILE_LIMITS = {
  maxDepth: 12,
  maxTotalNodes: 4_096,
  maxTotalProperties: 2_048,
  maxObjectProperties: 64,
  maxArrayItems: 32,
  maxTotalStringBytes: 128 * 1024,
} as const

const PROVIDER_MODES = [
  'none',
  'simulated-local',
  'simulated-external',
] as const
const TOKEN_MEASUREMENTS = ['exact', 'heuristic'] as const
const SENSITIVITIES = [
  'public',
  'internal',
  'confidential',
  'restricted',
] as const

/**
 * Source-bound deterministic policy shared by the MEM-P005 conformance suites.
 * Live-provider results must use a separate profile and evidence path.
 */
export interface MemoryBenchmarkProfileV1 {
  readonly schema: 'datazup.memory.benchmark-profile/v1'
  readonly profileId: string
  readonly profileVersion: string
  readonly sourceDigest: `sha256:${string}`
  readonly seed: string
  readonly tokenizer: {
    readonly id: string
    readonly version: string
    readonly measurement: 'exact' | 'heuristic'
  }
  readonly provider: {
    readonly mode: 'none' | 'simulated-local' | 'simulated-external'
    readonly deadlineMs: number
    readonly retainsInput: false
    readonly allowQueryText: boolean
    readonly allowedInlineSensitivities: readonly MemorySensitivityClassV1[]
  }
  readonly limits: {
    readonly maxCases: number
    readonly maxRecords: number
    readonly maxResults: number
    readonly maxTokens: number
    readonly maxCostMicrousd: number
  }
  readonly thresholds: {
    readonly precisionAtK: number
    readonly recallAtK: number
    readonly mrr: number
    readonly ndcg: number
    readonly activeVersionAccuracy: number
    readonly temporalAccuracy: number
    readonly correctionAccuracy: number
    readonly abstentionAccuracy: number
    readonly groundedSelectionRate: number
    readonly minimumReclaimedTokens: number
    readonly maxLeakageRate: number
    readonly maxStaleRetrievalRate: number
    readonly maxRevokedRetrievalRate: number
    readonly maxLatencyMs: number
    readonly maxTokens: number
    readonly maxCostMicrousd: number
  }
}

export function decodeMemoryBenchmarkProfileV1(
  input: unknown,
): MemoryBenchmarkProfileV1 {
  const root = objectValue(snapshotProfile(input), [], [
    'schema',
    'profileId',
    'profileVersion',
    'sourceDigest',
    'seed',
    'tokenizer',
    'provider',
    'limits',
    'thresholds',
  ])
  if (stringValue(root, 'schema', []) !== 'datazup.memory.benchmark-profile/v1') {
    throw new Error('invalid benchmark profile schema')
  }
  const limits = decodeLimits(required(root, 'limits', []))
  const thresholds = decodeThresholds(required(root, 'thresholds', []))
  if (thresholds.maxTokens > limits.maxTokens
    || thresholds.maxCostMicrousd > limits.maxCostMicrousd) {
    throw new Error('benchmark thresholds exceed profile limits')
  }
  return freeze({
    schema: 'datazup.memory.benchmark-profile/v1' as const,
    profileId: identifierValue(root, 'profileId', []),
    profileVersion: identifierValue(root, 'profileVersion', []),
    sourceDigest: digestValue(root, 'sourceDigest', []),
    seed: identifierValue(root, 'seed', []),
    tokenizer: decodeTokenizer(required(root, 'tokenizer', [])),
    provider: decodeProvider(required(root, 'provider', [])),
    limits,
    thresholds,
  })
}

export function digestMemoryBenchmarkProfileV1(
  profile: MemoryBenchmarkProfileV1,
): `sha256:${string}` {
  return digestSafeJson(snapshotProfile(decodeMemoryBenchmarkProfileV1(profile)))
}

function decodeTokenizer(value: SafeJson): MemoryBenchmarkProfileV1['tokenizer'] {
  const root = objectValue(value, ['tokenizer'], ['id', 'version', 'measurement'])
  return freeze({
    id: identifierValue(root, 'id', ['tokenizer']),
    version: identifierValue(root, 'version', ['tokenizer']),
    measurement: enumValue(
      root,
      'measurement',
      ['tokenizer'],
      TOKEN_MEASUREMENTS,
    ),
  })
}

function decodeProvider(value: SafeJson): MemoryBenchmarkProfileV1['provider'] {
  const path = ['provider'] as const
  const root = objectValue(value, path, [
    'mode',
    'deadlineMs',
    'retainsInput',
    'allowQueryText',
    'allowedInlineSensitivities',
  ])
  if (root['retainsInput'] !== false || typeof root['allowQueryText'] !== 'boolean') {
    throw new Error('provider profile must be non-retaining and explicit')
  }
  const sensitivities = decodeSensitivities(
    required(root, 'allowedInlineSensitivities', path),
  )
  const mode = enumValue(root, 'mode', path, PROVIDER_MODES)
  if (mode === 'none' && (root['allowQueryText'] || sensitivities.length > 0)) {
    throw new Error('provider-free profile cannot disclose input')
  }
  return freeze({
    mode,
    deadlineMs: boundedInteger(root, 'deadlineMs', 1, 60_000, path),
    retainsInput: false as const,
    allowQueryText: root['allowQueryText'],
    allowedInlineSensitivities: sensitivities,
  })
}

function decodeSensitivities(value: SafeJson): readonly MemorySensitivityClassV1[] {
  if (!Array.isArray(value) || value.length > SENSITIVITIES.length) {
    throw new Error('invalid sensitivity list')
  }
  const output = value.map((entry, index) => {
    if (typeof entry !== 'string' || !SENSITIVITIES.includes(entry as never)) {
      throw new Error(`invalid sensitivity at ${index}`)
    }
    return entry as MemorySensitivityClassV1
  })
  if (new Set(output).size !== output.length) {
    throw new Error('duplicate sensitivity')
  }
  return Object.freeze(output)
}

function decodeLimits(value: SafeJson): MemoryBenchmarkProfileV1['limits'] {
  const path = ['limits'] as const
  const root = objectValue(value, path, [
    'maxCases',
    'maxRecords',
    'maxResults',
    'maxTokens',
    'maxCostMicrousd',
  ])
  return freeze({
    maxCases: boundedInteger(root, 'maxCases', 1, 256, path),
    maxRecords: boundedInteger(root, 'maxRecords', 1, 4_096, path),
    maxResults: boundedInteger(root, 'maxResults', 1, 256, path),
    maxTokens: boundedInteger(root, 'maxTokens', 1, 1_000_000, path),
    maxCostMicrousd: boundedInteger(root, 'maxCostMicrousd', 0, 1_000_000_000, path),
  })
}

function decodeThresholds(
  value: SafeJson,
): MemoryBenchmarkProfileV1['thresholds'] {
  const path = ['thresholds'] as const
  const root = objectValue(value, path, [
    'precisionAtK',
    'recallAtK',
    'mrr',
    'ndcg',
    'activeVersionAccuracy',
    'temporalAccuracy',
    'correctionAccuracy',
    'abstentionAccuracy',
    'groundedSelectionRate',
    'minimumReclaimedTokens',
    'maxLeakageRate',
    'maxStaleRetrievalRate',
    'maxRevokedRetrievalRate',
    'maxLatencyMs',
    'maxTokens',
    'maxCostMicrousd',
  ])
  return freeze({
    precisionAtK: scoreValue(root, 'precisionAtK', path),
    recallAtK: scoreValue(root, 'recallAtK', path),
    mrr: scoreValue(root, 'mrr', path),
    ndcg: scoreValue(root, 'ndcg', path),
    activeVersionAccuracy: scoreValue(root, 'activeVersionAccuracy', path),
    temporalAccuracy: scoreValue(root, 'temporalAccuracy', path),
    correctionAccuracy: scoreValue(root, 'correctionAccuracy', path),
    abstentionAccuracy: scoreValue(root, 'abstentionAccuracy', path),
    groundedSelectionRate: scoreValue(root, 'groundedSelectionRate', path),
    minimumReclaimedTokens: boundedInteger(
      root,
      'minimumReclaimedTokens',
      1,
      1_000_000,
      path,
    ),
    maxLeakageRate: scoreValue(root, 'maxLeakageRate', path),
    maxStaleRetrievalRate: scoreValue(root, 'maxStaleRetrievalRate', path),
    maxRevokedRetrievalRate: scoreValue(root, 'maxRevokedRetrievalRate', path),
    maxLatencyMs: boundedInteger(root, 'maxLatencyMs', 1, 60_000, path),
    maxTokens: boundedInteger(root, 'maxTokens', 1, 1_000_000, path),
    maxCostMicrousd: boundedInteger(
      root,
      'maxCostMicrousd',
      0,
      1_000_000_000,
      path,
    ),
  })
}

function boundedInteger(
  root: JsonObject,
  key: string,
  minimum: number,
  maximum: number,
  path: readonly string[],
): number {
  const value = integerValue(root, key, path)
  if (value < minimum || value > maximum) {
    throw new Error(`benchmark integer outside bounds: ${key}`)
  }
  return value
}

function snapshotProfile(input: unknown): SafeJson {
  return snapshotSafeJson(input, PROFILE_LIMITS)
}

function freeze<T>(value: T): T {
  return deepFreezeSafeJson(snapshotProfile(value)) as unknown as T
}
