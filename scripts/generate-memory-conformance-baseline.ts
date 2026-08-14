#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { runContextCompactionConformanceScenario } from '../packages/context/src/tool-results/__tests__/memory-compaction-conformance-port.js'
import type { MemoryBenchmarkProfileV1 } from '../packages/memory/src/testing/benchmark-profile-v1.js'
import { createMemoryCompactionConformanceSuite } from '../packages/memory/src/testing/compaction-conformance-v1.js'
import type { MemoryConformanceReportV1 } from '../packages/memory/src/testing/conformance-core-v1.js'
import { createMemoryDeletionConformanceSuite } from '../packages/memory/src/testing/deletion-conformance-v1.js'
import { createMemoryLifecycleConformanceSuite } from '../packages/memory/src/testing/lifecycle-conformance-v1.js'
import { createMemoryRecordConformanceSuite } from '../packages/memory/src/testing/record-conformance-v1.js'
import { createMemoryRetrievalConformanceSuite } from '../packages/memory/src/testing/retrieval-conformance-v1.js'
import { createMemoryStoreConformanceSuite } from '../packages/memory/src/testing/store-conformance-v1.js'
import { createMemoryWorkerConformanceSuite } from '../packages/memory/src/testing/worker-conformance-v1.js'

const ROOT = resolve(import.meta.dirname, '..')
const CONFIG_PATH = 'config/memory-conformance-baseline.v1.json'
const JSON_PATH = 'docs/generated/MEMORY_CONFORMANCE_BASELINE.v1.json'
const MARKDOWN_PATH = 'docs/generated/MEMORY_CONFORMANCE_BASELINE.v1.md'
const CHECK = process.argv.slice(2).includes('--check')
const SOURCE_EXTENSION = /\.(?:c|m)?[jt]sx?$/

interface BaselineConfig {
  readonly schema: string
  readonly harnessVersion: string
  readonly fixturePolicy: string
  readonly historySemantics: string
  readonly sourceRoots: readonly string[]
  readonly sourceFiles: readonly string[]
  readonly profile: Omit<MemoryBenchmarkProfileV1, 'sourceDigest'>
  readonly suites: readonly { readonly id: string; readonly expectedCases: number }[]
  readonly expectedRedCaseIds: readonly string[]
  readonly supplementalGates: readonly {
    readonly id: string
    readonly testFile: string
    readonly expectedTests: number
  }[]
}

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function sourceBaseIdentity(): { baseCommit: string; baseTree: string } {
  if (!CHECK) {
    return {
      baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim(),
      baseTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim(),
    }
  }

  let retained: { baseCommit?: unknown; baseTree?: unknown }
  try {
    retained = JSON.parse(readFileSync(join(ROOT, JSON_PATH), 'utf8'))
  } catch {
    throw new Error('memory conformance source binding is unavailable')
  }
  if (
    typeof retained.baseCommit !== 'string'
    || !/^[a-f0-9]{40}$/u.test(retained.baseCommit)
    || typeof retained.baseTree !== 'string'
    || !/^[a-f0-9]{40}$/u.test(retained.baseTree)
  ) {
    throw new Error('memory conformance source binding is malformed')
  }
  let resolvedTree: string
  try {
    resolvedTree = execFileSync(
      'git',
      ['rev-parse', `${retained.baseCommit}^{tree}`],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    execFileSync(
      'git',
      ['merge-base', '--is-ancestor', retained.baseCommit, 'HEAD'],
      { cwd: ROOT, stdio: 'ignore' },
    )
  } catch {
    throw new Error('memory conformance source commit is not retained in current history')
  }
  if (resolvedTree !== retained.baseTree) {
    throw new Error('memory conformance source tree does not match its retained commit')
  }
  return { baseCommit: retained.baseCommit, baseTree: retained.baseTree }
}

function portable(path: string): string {
  return path.split(sep).join('/')
}

function collectSourceFiles(config: BaselineConfig): string[] {
  const paths = new Set(config.sourceFiles)
  const visit = (absolute: string): void => {
    for (const entry of readdirSync(absolute).sort()) {
      const path = join(absolute, entry)
      if (statSync(path).isDirectory()) visit(path)
      else if (SOURCE_EXTENSION.test(entry)) paths.add(portable(relative(ROOT, path)))
    }
  }
  for (const root of config.sourceRoots) visit(join(ROOT, root))
  return [...paths].sort()
}

function sourceIdentity(paths: readonly string[]) {
  const files = paths.map(path => ({
    path,
    digest: sha256(readFileSync(join(ROOT, path))),
  }))
  const digest = sha256(files.map(file => `${file.digest}  ${file.path}\n`).join(''))
  return { digest, files }
}

async function runSuites(profile: MemoryBenchmarkProfileV1) {
  const suites = [
    createMemoryRecordConformanceSuite(profile),
    createMemoryLifecycleConformanceSuite(profile),
    createMemoryStoreConformanceSuite(profile),
    createMemoryRetrievalConformanceSuite(profile),
    createMemoryCompactionConformanceSuite(profile, {
      run: runContextCompactionConformanceScenario,
    }),
    createMemoryDeletionConformanceSuite(profile),
    createMemoryWorkerConformanceSuite(profile),
  ]
  return await Promise.all(suites.map(suite => suite.run()))
}

function metricDistributions(reports: readonly MemoryConformanceReportV1[]) {
  const grouped = new Map<string, {
    unit: string
    comparison: string
    threshold: number
    values: number[]
  }>()
  for (const report of reports) {
    for (const caseResult of report.cases) {
      for (const metric of caseResult.metrics) {
        const key = `${metric.name}\0${metric.unit}\0${metric.comparison}\0${metric.threshold}`
        const group = grouped.get(key) ?? {
          unit: metric.unit,
          comparison: metric.comparison,
          threshold: metric.threshold,
          values: [],
        }
        group.values.push(metric.value)
        grouped.set(key, group)
      }
    }
  }
  return [...grouped.entries()].map(([key, group]) => {
    const name = key.split('\0')[0]!
    const total = group.values.reduce((sum, value) => sum + value, 0)
    return {
      name,
      unit: group.unit,
      comparison: group.comparison,
      threshold: group.threshold,
      count: group.values.length,
      minimum: Math.min(...group.values),
      maximum: Math.max(...group.values),
      mean: total / group.values.length,
    }
  }).sort((left, right) => left.name.localeCompare(right.name))
}

function validatePredeclared(
  config: BaselineConfig,
  reports: readonly MemoryConformanceReportV1[],
): void {
  if (config.schema !== 'datazup.memory.conformance-baseline-config/v1') {
    throw new Error('unsupported memory conformance baseline config')
  }
  const expected = new Map(config.suites.map(suite => [suite.id, suite.expectedCases]))
  for (const report of reports) {
    if (expected.get(report.suiteId) !== report.counts.total) {
      throw new Error(`suite case count drift: ${report.suiteId}`)
    }
    expected.delete(report.suiteId)
  }
  if (expected.size > 0) throw new Error('configured suite did not run')
  const actualRed = reports.flatMap(report => report.cases)
    .filter(result => result.expectation === 'red')
    .map(result => result.caseId)
    .sort()
  if (actualRed.join('\n') !== [...config.expectedRedCaseIds].sort().join('\n')) {
    throw new Error('expected-red case identity drift')
  }
}

function markdown(result: ReturnType<typeof buildResult>): string {
  const lines = [
    '# Memory conformance baseline v1',
    '',
    `- Result: **${result.status}**`,
    `- Source digest: \`${result.source.digest}\` (${result.source.files.length} files)`,
    `- Config digest: \`${result.configDigest}\``,
    `- Profile digest: \`${result.profileDigest}\``,
    `- Result digest: \`${result.resultDigest}\``,
    `- Provider-free: **${result.qualification.providerFree}**`,
    `- Live provider: **${result.qualification.liveProvider}**`,
    `- Production: **${result.qualification.productionEnablement}**`,
    '',
    '## Suites',
    '',
    '| Suite | Status | Passed | Failed | Expected red | Digest |',
    '| --- | --- | ---: | ---: | ---: | --- |',
  ]
  for (const report of result.reports) {
    lines.push(
      `| ${report.suiteId} | ${report.status} | ${report.counts.passed} | ${report.counts.failed} | ${report.counts.expectedRed} | \`${report.reportDigest}\` |`,
    )
  }
  lines.push(
    '',
    '## Aggregate',
    '',
    `- Cases: ${result.counts.total}`,
    `- Passed: ${result.counts.passed}`,
    `- Failed: ${result.counts.failed}`,
    `- Expected red: ${result.counts.expectedRed}`,
    `- Unexpected pass: ${result.counts.unexpectedPass}`,
    `- History contract: \`${result.historySemantics}\``,
    `- Fixture policy: \`${result.fixturePolicy}\``,
    '',
    'The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.',
    '',
  )
  return lines.join('\n')
}

function buildResult(
  config: BaselineConfig,
  configDigest: `sha256:${string}`,
  source: ReturnType<typeof sourceIdentity>,
  reports: readonly MemoryConformanceReportV1[],
  baseIdentity: ReturnType<typeof sourceBaseIdentity>,
) {
  const counts = {
    total: reports.reduce((sum, report) => sum + report.counts.total, 0),
    passed: reports.reduce((sum, report) => sum + report.counts.passed, 0),
    failed: reports.reduce((sum, report) => sum + report.counts.failed, 0),
    expectedRed: reports.reduce((sum, report) => sum + report.counts.expectedRed, 0),
    unexpectedPass: reports.reduce((sum, report) => sum + report.counts.unexpectedPass, 0),
  }
  const passed = counts.failed === 0 && counts.unexpectedPass === 0
  const base = {
    schema: 'datazup.memory.conformance-baseline/v1' as const,
    harnessVersion: config.harnessVersion,
    fixturePolicy: config.fixturePolicy,
    historySemantics: config.historySemantics,
    ...baseIdentity,
    configDigest,
    source,
    profileDigest: reports[0]?.profileDigest ?? sha256('missing-profile'),
    status: passed ? 'passed' as const : 'failed' as const,
    counts,
    expectedRedCaseIds: [...config.expectedRedCaseIds].sort(),
    metricDistributions: metricDistributions(reports),
    supplementalGates: config.supplementalGates,
    qualification: {
      providerFree: passed ? 'passed' as const : 'failed' as const,
      aggregate: 'not-evaluated-by-this-artifact' as const,
      liveProvider: 'not-run' as const,
      productionEnablement: 'not-enabled' as const,
    },
    reports,
  }
  return { ...base, resultDigest: sha256(JSON.stringify(base)) }
}

function emit(path: string, value: string): void {
  const absolute = join(ROOT, path)
  if (CHECK) {
    if (readFileSync(absolute, 'utf8') !== value) {
      throw new Error(`memory conformance artifact is stale: ${path}`)
    }
    return
  }
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, value)
}

const configBytes = readFileSync(join(ROOT, CONFIG_PATH))
const config = JSON.parse(configBytes.toString('utf8')) as BaselineConfig
const source = sourceIdentity(collectSourceFiles(config))
const profile: MemoryBenchmarkProfileV1 = {
  ...config.profile,
  sourceDigest: source.digest,
}
const reports = await runSuites(profile)
validatePredeclared(config, reports)
const result = buildResult(
  config,
  sha256(configBytes),
  source,
  reports,
  sourceBaseIdentity(),
)
const json = `${JSON.stringify(result, null, 2)}\n`
const md = markdown(result)
if (json.includes('INVENTED_CANARY_') || md.includes('INVENTED_CANARY_')) {
  throw new Error('memory conformance output contains a fixture canary')
}
emit(JSON_PATH, json)
emit(MARKDOWN_PATH, md)
process.stdout.write(
  `${CHECK ? 'Verified' : 'Generated'} memory conformance baseline: ${result.counts.total} cases, ${result.resultDigest}\n`,
)
