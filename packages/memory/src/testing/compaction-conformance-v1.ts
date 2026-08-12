import {
  snapshotSafeJson,
  type SafeJson,
} from '../records/safe-json.js'
import type { MemoryBenchmarkProfileV1 } from './benchmark-profile-v1.js'
import {
  createMemoryConformanceSuiteV1,
  type MemoryConformanceSuiteV1,
} from './conformance-core-v1.js'
import { MEMORY_CONFORMANCE_FIXTURE_VERSION } from './fixtures-v1.js'

type CompactionScenarioV1 =
  | 'complete-pairs'
  | 'incomplete-pairs'
  | 'malformed-pairs'
  | 'metadata-and-canary'
  | 'measurement-provenance'
  | 'idempotence'
  | 'bounded-target'
  | 'hostile-input'

interface CompactionConformanceRequestV1 {
  readonly schema: 'datazup.memory.compaction-conformance-request/v1'
  readonly scenario: CompactionScenarioV1
  readonly fixtureVersion: string
  readonly tokenizer: {
    readonly id: string
    readonly version: string
  }
}

interface CompactionConformanceObservationV1 {
  readonly schema: 'datazup.memory.compaction-conformance-observation/v1'
  readonly scenario: CompactionScenarioV1
  readonly statuses: readonly ('completed' | 'partial' | 'unchanged' | 'rejected')[]
  readonly reasons: readonly string[]
  readonly measurementMethods: readonly string[]
  readonly inputUnchanged: boolean
  readonly structurePreserved: boolean
  readonly metadataPreserved: boolean
  readonly idempotent: boolean
  readonly canaryAbsent: boolean
  readonly beforeTokens: number
  readonly afterTokens: number
  readonly reclaimedTokens: number
  readonly compactedCount: number
}

interface MemoryCompactionConformancePortV1 {
  run(input: CompactionConformanceRequestV1): Promise<unknown>
}

/**
 * Build the provider-neutral compaction suite around a host adapter.
 * The adapter returns only content-free observations; transcript custody stays
 * with the context package that owns the concrete message representation.
 */
export function createMemoryCompactionConformanceSuite(
  profile: MemoryBenchmarkProfileV1,
  port: MemoryCompactionConformancePortV1,
): MemoryConformanceSuiteV1 {
  return createMemoryConformanceSuiteV1({
    suiteId: 'memory-compaction-conformance',
    suiteVersion: 'v1',
    domain: 'compaction',
    fixtureSetId: 'invented-completed-tool-transcripts',
    fixtureVersion: MEMORY_CONFORMANCE_FIXTURE_VERSION,
    profile,
    cases: [{
      id: 'compaction.complete-pairs',
      capability: 'complete-pair-rewrite',
      expected: 'pass',
      run: async () => checkCompletePairs(
        await observe(port, profile, 'complete-pairs'),
        profile.thresholds.minimumReclaimedTokens,
      ),
    }, {
      id: 'compaction.incomplete-pairs',
      capability: 'incomplete-pair-preservation',
      expected: 'pass',
      run: async () => checkIncomplete(await observe(port, profile, 'incomplete-pairs')),
    }, {
      id: 'compaction.malformed-pairs',
      capability: 'atomic-pairing-rejection',
      expected: 'pass',
      run: async () => checkMalformed(await observe(port, profile, 'malformed-pairs')),
    }, {
      id: 'compaction.metadata-and-canary',
      capability: 'metadata-and-content-custody',
      expected: 'pass',
      run: async () => checkMetadata(
        await observe(port, profile, 'metadata-and-canary'),
        profile.thresholds.minimumReclaimedTokens,
      ),
    }, {
      id: 'compaction.measurement-provenance',
      capability: 'tokenizer-truthfulness',
      expected: 'pass',
      run: async () => checkMeasurement(
        await observe(port, profile, 'measurement-provenance'),
        profile.thresholds.minimumReclaimedTokens,
      ),
    }, {
      id: 'compaction.idempotence',
      capability: 'idempotent-rewrite',
      expected: 'pass',
      run: async () => checkIdempotence(
        await observe(port, profile, 'idempotence'),
        profile.thresholds.minimumReclaimedTokens,
      ),
    }, {
      id: 'compaction.bounded-target',
      capability: 'bounded-target-reclamation',
      expected: 'pass',
      run: async () => checkBoundedTarget(
        await observe(port, profile, 'bounded-target'),
        profile.thresholds.minimumReclaimedTokens,
      ),
    }, {
      id: 'compaction.hostile-input',
      capability: 'hostile-boundary',
      expected: 'pass',
      run: async () => checkHostile(await observe(port, profile, 'hostile-input')),
    }],
  })
}

async function observe(
  port: MemoryCompactionConformancePortV1,
  profile: MemoryBenchmarkProfileV1,
  scenario: CompactionScenarioV1,
): Promise<CompactionConformanceObservationV1> {
  return decodeObservation(await port.run(Object.freeze({
    schema: 'datazup.memory.compaction-conformance-request/v1',
    scenario,
    fixtureVersion: MEMORY_CONFORMANCE_FIXTURE_VERSION,
    tokenizer: {
      id: profile.tokenizer.id,
      version: profile.tokenizer.version,
    },
  })))
}

function checkCompletePairs(
  value: CompactionConformanceObservationV1,
  minimumReclaimedTokens: number,
) {
  const passed = value.statuses.join(',') === 'completed'
    && value.reasons.join(',') === 'compacted'
    && value.compactedCount === 1
    && value.beforeTokens > value.afterTokens
    && value.reclaimedTokens === value.beforeTokens - value.afterTokens
    && value.inputUnchanged && value.structurePreserved
  return outcome(
    value, passed, 'complete-pairs-compacted', 'complete-pairs-mismatch',
    minimumReclaimedTokens,
  )
}

function checkIncomplete(value: CompactionConformanceObservationV1) {
  const passed = value.statuses.join(',') === 'unchanged'
    && value.reasons.join(',') === 'no-eligible-results'
    && value.compactedCount === 0
    && value.reclaimedTokens === 0
    && value.inputUnchanged && value.structurePreserved
  return outcome(value, passed, 'incomplete-pairs-preserved', 'incomplete-pairs-rewritten')
}

function checkMalformed(value: CompactionConformanceObservationV1) {
  const passed = value.statuses.length === 4
    && value.statuses.every(status => status === 'rejected')
    && value.reasons.every(reason => reason === 'invalid-tool-pairing')
    && value.compactedCount === 0
    && value.inputUnchanged && value.structurePreserved
  return outcome(value, passed, 'malformed-pairs-rejected', 'malformed-pair-admitted')
}

function checkMetadata(
  value: CompactionConformanceObservationV1,
  minimumReclaimedTokens: number,
) {
  const passed = value.statuses.join(',') === 'completed'
    && value.metadataPreserved
    && value.canaryAbsent
    && value.inputUnchanged && value.structurePreserved
  return outcome(
    value, passed, 'metadata-preserved-canary-removed',
    'metadata-or-canary-mismatch', minimumReclaimedTokens,
  )
}

function checkMeasurement(
  value: CompactionConformanceObservationV1,
  minimumReclaimedTokens: number,
) {
  const passed = value.statuses.join(',') === 'completed,completed,rejected'
    && value.reasons.join(',') === 'compacted,compacted,token-measurement-unproven'
    && value.measurementMethods.join(',') === 'exact,heuristic,exact'
    && value.inputUnchanged
  return outcome(
    value, passed, 'measurement-provenance-truthful',
    'measurement-provenance-mismatch', minimumReclaimedTokens,
  )
}

function checkIdempotence(
  value: CompactionConformanceObservationV1,
  minimumReclaimedTokens: number,
) {
  const passed = value.statuses.join(',') === 'completed,unchanged'
    && value.reasons.join(',') === 'compacted,no-token-reclamation'
    && value.idempotent && value.inputUnchanged && value.structurePreserved
  return outcome(
    value, passed, 'compaction-idempotent', 'compaction-grew-on-replay',
    minimumReclaimedTokens,
  )
}

function checkBoundedTarget(
  value: CompactionConformanceObservationV1,
  minimumReclaimedTokens: number,
) {
  const passed = value.statuses.join(',') === 'partial'
    && value.reasons.join(',') === 'target-not-met'
    && value.compactedCount === 1
    && value.reclaimedTokens > 0
    && value.inputUnchanged && value.structurePreserved
  return outcome(
    value, passed, 'target-remained-bounded', 'target-bound-exceeded',
    minimumReclaimedTokens,
  )
}

function checkHostile(value: CompactionConformanceObservationV1) {
  const passed = value.statuses.join(',') === 'rejected,rejected'
    && value.reasons.join(',') === 'invalid-input,invalid-profile'
    && value.compactedCount === 0
    && value.canaryAbsent
  return outcome(value, passed, 'hostile-input-rejected', 'hostile-input-admitted')
}

function outcome(
  value: CompactionConformanceObservationV1,
  passed: boolean,
  success: string,
  failure: string,
  minimumReclaimedTokens?: number,
) {
  return {
    passed,
    reasonCode: passed ? success : failure,
    metrics: minimumReclaimedTokens === undefined ? [] : [{
      name: 'reclaimed-tokens',
      value: value.reclaimedTokens,
      unit: 'tokens' as const,
      threshold: minimumReclaimedTokens,
      comparison: 'at-least' as const,
    }],
  }
}

function decodeObservation(input: unknown): CompactionConformanceObservationV1 {
  const value = snapshotSafeJson(input, {
    maxDepth: 8,
    maxTotalNodes: 256,
    maxTotalProperties: 128,
    maxObjectProperties: 24,
    maxArrayItems: 16,
    maxTotalStringBytes: 8_192,
  })
  if (!isObject(value)
    || value['schema'] !== 'datazup.memory.compaction-conformance-observation/v1'
    || !isScenario(value['scenario'])
    || !stringArray(value['statuses'], ['completed', 'partial', 'unchanged', 'rejected'])
    || !stringArray(value['reasons'])
    || !stringArray(value['measurementMethods'])
    || !booleans(value, [
      'inputUnchanged', 'structurePreserved', 'metadataPreserved',
      'idempotent', 'canaryAbsent',
    ])
    || !nonNegativeIntegers(value, [
      'beforeTokens', 'afterTokens', 'reclaimedTokens', 'compactedCount',
    ])) {
    throw new Error('invalid compaction conformance observation')
  }
  return value as unknown as CompactionConformanceObservationV1
}

function isObject(value: SafeJson): value is Record<string, SafeJson> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isScenario(value: SafeJson | undefined): value is CompactionScenarioV1 {
  return typeof value === 'string' && [
    'complete-pairs', 'incomplete-pairs', 'malformed-pairs', 'metadata-and-canary',
    'measurement-provenance', 'idempotence', 'bounded-target', 'hostile-input',
  ].includes(value)
}

function stringArray(value: SafeJson | undefined, allowed?: readonly string[]): boolean {
  return Array.isArray(value)
    && value.every(entry => typeof entry === 'string'
      && (allowed === undefined || allowed.includes(entry)))
}

function booleans(value: Record<string, SafeJson>, keys: readonly string[]): boolean {
  return keys.every(key => typeof value[key] === 'boolean')
}

function nonNegativeIntegers(
  value: Record<string, SafeJson>,
  keys: readonly string[],
): boolean {
  return keys.every(key => Number.isInteger(value[key]) && (value[key] as number) >= 0)
}
