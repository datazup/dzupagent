import {
  deepFreezeSafeJson,
  digestSafeJson,
  snapshotSafeJson,
  type SafeJson,
} from '../records/safe-json.js'
import {
  decodeMemoryBenchmarkProfileV1,
  digestMemoryBenchmarkProfileV1,
  type MemoryBenchmarkProfileV1,
} from './benchmark-profile-v1.js'

export type MemoryConformanceDomainV1 =
  | 'record'
  | 'lifecycle'
  | 'store'
  | 'retrieval'
  | 'compaction'
  | 'deletion'
  | 'worker'

export type MemoryMetricComparisonV1 = 'at-least' | 'at-most' | 'exact'

export interface InternalMemoryMetricV1 {
  readonly name: string
  readonly value: number
  readonly unit: 'ratio' | 'count' | 'tokens' | 'milliseconds' | 'microusd'
  readonly threshold: number
  readonly comparison: MemoryMetricComparisonV1
}

export interface InternalMemoryCaseOutcomeV1 {
  readonly passed: boolean
  readonly reasonCode: string
  readonly metrics?: readonly InternalMemoryMetricV1[]
  readonly evidenceDigests?: readonly `sha256:${string}`[]
}

export interface InternalMemoryConformanceCaseV1 {
  readonly id: string
  readonly capability: string
  readonly expected: 'pass' | 'red'
  readonly run: () => Promise<InternalMemoryCaseOutcomeV1>
}

export interface MemoryConformanceReportV1 {
  readonly schema: 'datazup.memory.conformance-report/v1'
  readonly suiteId: string
  readonly suiteVersion: string
  readonly domain: MemoryConformanceDomainV1
  readonly harnessVersion: 'mem-p006-v1'
  readonly fixtureSetId: string
  readonly fixtureVersion: string
  readonly fixtureDigest: `sha256:${string}`
  readonly profileId: string
  readonly profileVersion: string
  readonly profileDigest: `sha256:${string}`
  readonly sourceDigest: `sha256:${string}`
  readonly environment: {
    readonly schema: 'datazup.memory.conformance-environment/v1'
    readonly network: 'disabled'
    readonly clock: 'injected'
    readonly provider: MemoryBenchmarkProfileV1['provider']['mode']
    readonly seed: string
  }
  readonly status: 'passed' | 'completed-with-expected-red' | 'failed'
  readonly counts: {
    readonly total: number
    readonly passed: number
    readonly failed: number
    readonly expectedRed: number
    readonly unexpectedPass: number
  }
  readonly cases: readonly {
    readonly schema: 'datazup.memory.conformance-case-result/v1'
    readonly caseId: string
    readonly capability: string
    readonly expectation: 'pass' | 'red'
    readonly status: 'passed' | 'failed' | 'expected-red' | 'unexpected-pass'
    readonly reasonCode: string
    readonly metrics: readonly (InternalMemoryMetricV1 & { readonly passed: boolean })[]
    readonly evidenceDigests: readonly `sha256:${string}`[]
  }[]
  readonly reportDigest: `sha256:${string}`
}

export interface MemoryConformanceSuiteV1 {
  readonly schema: 'datazup.memory.conformance-suite/v1'
  readonly suiteId: string
  readonly suiteVersion: string
  readonly domain: MemoryConformanceDomainV1
  readonly fixtureSetId: string
  readonly fixtureVersion: string
  readonly fixtureDigest: `sha256:${string}`
  run(): Promise<MemoryConformanceReportV1>
}

interface CreateSuiteInputV1 {
  readonly suiteId: string
  readonly suiteVersion: string
  readonly domain: MemoryConformanceDomainV1
  readonly fixtureSetId: string
  readonly fixtureVersion: string
  readonly profile: MemoryBenchmarkProfileV1
  readonly cases: readonly InternalMemoryConformanceCaseV1[]
}

export function createMemoryConformanceSuiteV1(
  input: CreateSuiteInputV1,
): MemoryConformanceSuiteV1 {
  const profile = decodeMemoryBenchmarkProfileV1(input.profile)
  validateIdentifier(input.suiteId)
  validateIdentifier(input.suiteVersion)
  validateIdentifier(input.fixtureSetId)
  validateIdentifier(input.fixtureVersion)
  if (input.cases.length === 0 || input.cases.length > profile.limits.maxCases) {
    throw new Error('conformance case count outside profile bounds')
  }
  const ids = new Set<string>()
  for (const entry of input.cases) {
    validateIdentifier(entry.id)
    validateIdentifier(entry.capability)
    if (ids.has(entry.id)) throw new Error('duplicate conformance case id')
    ids.add(entry.id)
  }
  const cases = Object.freeze([...input.cases].sort((left, right) =>
    left.id.localeCompare(right.id)))
  const fixtureDigest = digestSafeJson(snapshot({
    schema: 'datazup.memory.conformance-fixture-set/v1',
    fixtureSetId: input.fixtureSetId,
    fixtureVersion: input.fixtureVersion,
    cases: cases.map(entry => ({
      id: entry.id,
      capability: entry.capability,
      expected: entry.expected,
    })),
  }))
  const suiteBase = {
    schema: 'datazup.memory.conformance-suite/v1' as const,
    suiteId: input.suiteId,
    suiteVersion: input.suiteVersion,
    domain: input.domain,
    fixtureSetId: input.fixtureSetId,
    fixtureVersion: input.fixtureVersion,
    fixtureDigest,
  }
  return Object.freeze({
    ...suiteBase,
    async run(): Promise<MemoryConformanceReportV1> {
      const results = []
      for (const entry of cases) {
        results.push(await runCase(entry))
      }
      const counts = Object.freeze({
        total: results.length,
        passed: results.filter(entry => entry.status === 'passed').length,
        failed: results.filter(entry => entry.status === 'failed').length,
        expectedRed: results.filter(entry => entry.status === 'expected-red').length,
        unexpectedPass: results.filter(entry => entry.status === 'unexpected-pass').length,
      })
      const status = counts.failed > 0 || counts.unexpectedPass > 0
        ? 'failed' as const
        : counts.expectedRed > 0
          ? 'completed-with-expected-red' as const
          : 'passed' as const
      const base = {
        schema: 'datazup.memory.conformance-report/v1' as const,
        suiteId: input.suiteId,
        suiteVersion: input.suiteVersion,
        domain: input.domain,
        harnessVersion: 'mem-p006-v1' as const,
        fixtureSetId: input.fixtureSetId,
        fixtureVersion: input.fixtureVersion,
        fixtureDigest,
        profileId: profile.profileId,
        profileVersion: profile.profileVersion,
        profileDigest: digestMemoryBenchmarkProfileV1(profile),
        sourceDigest: profile.sourceDigest,
        environment: Object.freeze({
          schema: 'datazup.memory.conformance-environment/v1' as const,
          network: 'disabled' as const,
          clock: 'injected' as const,
          provider: profile.provider.mode,
          seed: profile.seed,
        }),
        status,
        counts,
        cases: Object.freeze(results),
      }
      const reportDigest = digestSafeJson(snapshot(base))
      return freeze({ ...base, reportDigest })
    },
  })
}

async function runCase(entry: InternalMemoryConformanceCaseV1) {
  let outcome: InternalMemoryCaseOutcomeV1
  try {
    outcome = await entry.run()
  } catch {
    outcome = { passed: false, reasonCode: 'case-threw' }
  }
  const validReason = safeReason(outcome.reasonCode)
  const metrics = decodeMetrics(outcome.metrics ?? [])
  const evidenceDigests = decodeEvidenceDigests(outcome.evidenceDigests ?? [])
  const passed = outcome.passed && validReason && metrics.every(metric => metric.passed)
  const status = entry.expected === 'red'
    ? passed ? 'unexpected-pass' as const : 'expected-red' as const
    : passed ? 'passed' as const : 'failed' as const
  return freeze({
    schema: 'datazup.memory.conformance-case-result/v1' as const,
    caseId: entry.id,
    capability: entry.capability,
    expectation: entry.expected,
    status,
    reasonCode: validReason ? outcome.reasonCode : 'invalid-reason-code',
    metrics,
    evidenceDigests,
  })
}

function decodeMetrics(metrics: readonly InternalMemoryMetricV1[]) {
  if (!Array.isArray(metrics) || metrics.length > 64) return Object.freeze([])
  const names = new Set<string>()
  const output = metrics.map(metric => {
    validateIdentifier(metric.name)
    if (names.has(metric.name)) throw new Error('duplicate metric name')
    names.add(metric.name)
    if (!Number.isFinite(metric.value) || !Number.isFinite(metric.threshold)) {
      throw new Error('non-finite metric')
    }
    const passed = metric.comparison === 'at-least'
      ? metric.value >= metric.threshold
      : metric.comparison === 'at-most'
        ? metric.value <= metric.threshold
        : metric.value === metric.threshold
    return Object.freeze({ ...metric, passed })
  })
  return Object.freeze(output)
}

function decodeEvidenceDigests(
  values: readonly `sha256:${string}`[],
): readonly `sha256:${string}`[] {
  if (!Array.isArray(values) || values.length > 32) return Object.freeze([])
  const output = values.map(value => {
    if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
      throw new Error('invalid evidence digest')
    }
    return value
  })
  return Object.freeze([...new Set(output)].sort())
}

function safeReason(value: unknown): value is string {
  return typeof value === 'string'
    && /^[a-z][a-z0-9-]{0,95}$/.test(value)
}

function validateIdentifier(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value)) {
    throw new Error('invalid conformance identifier')
  }
}

function snapshot(value: unknown): SafeJson {
  return snapshotSafeJson(value, {
    maxDepth: 24,
    maxTotalNodes: 32_768,
    maxTotalProperties: 16_384,
    maxObjectProperties: 128,
    maxArrayItems: 512,
    maxTotalStringBytes: 2 * 1024 * 1024,
  })
}

function freeze<T>(value: T): T {
  return deepFreezeSafeJson(snapshot(value)) as unknown as T
}
