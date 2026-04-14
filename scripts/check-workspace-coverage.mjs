import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const COVERAGE_SUMMARY_NAME = 'coverage-summary.json'

export const DEFAULT_THRESHOLDS = Object.freeze({
  statements: 70,
  branches: 60,
  functions: 60,
  lines: 70,
})

function normalizeThresholds(input) {
  const source = input ?? DEFAULT_THRESHOLDS
  return {
    statements: numberOrDefault(source.statements, DEFAULT_THRESHOLDS.statements),
    branches: numberOrDefault(source.branches, DEFAULT_THRESHOLDS.branches),
    functions: numberOrDefault(source.functions, DEFAULT_THRESHOLDS.functions),
    lines: numberOrDefault(source.lines, DEFAULT_THRESHOLDS.lines),
  }
}

function numberOrDefault(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readJson(filePath) {
  const raw = readFileSync(filePath, 'utf8')
  return JSON.parse(raw)
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function fileExists(filePath) {
  try {
    return existsSync(filePath)
  } catch {
    return false
  }
}

export function loadCoverageThresholdConfig(repoRoot, configPath = join(repoRoot, 'coverage-thresholds.json')) {
  const base = {
    defaultThresholds: { ...DEFAULT_THRESHOLDS },
    trackedPackages: [],
    packages: {},
  }

  if (!fileExists(configPath)) {
    return base
  }

  const raw = readJson(configPath)
  const packages = raw?.packages && typeof raw.packages === 'object' ? raw.packages : {}

  return {
    defaultThresholds: normalizeThresholds(raw?.defaultThresholds),
    trackedPackages: Array.isArray(raw?.trackedPackages)
      ? raw.trackedPackages.filter((name) => typeof name === 'string' && name.trim().length > 0)
      : [],
    packages,
  }
}

export function discoverTrackedPackages(repoRoot) {
  const packagesDir = join(repoRoot, 'packages')
  if (!fileExists(packagesDir)) return []

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      const packageJsonPath = join(packagesDir, name, 'package.json')
      if (!fileExists(packageJsonPath)) return false
      try {
        const pkg = readJson(packageJsonPath)
        return Boolean(pkg?.scripts?.['test:coverage'])
      } catch {
        return false
      }
    })
    .sort()
}

export function getCoverageSummaryPath(repoRoot, packageName) {
  return join(repoRoot, 'packages', packageName, 'coverage', COVERAGE_SUMMARY_NAME)
}

function readCoverageSummary(filePath) {
  const summary = readJson(filePath)
  if (!summary || typeof summary !== 'object' || !summary.total || typeof summary.total !== 'object') {
    throw new Error(`Invalid coverage summary at ${filePath}`)
  }
  return summary
}

function extractMetricPct(metricSummary, metricName) {
  if (!metricSummary || typeof metricSummary !== 'object') {
    throw new Error(`Missing ${metricName} coverage summary`)
  }

  const total = Number(metricSummary.total)
  const covered = Number(metricSummary.covered)
  const pct = Number(metricSummary.pct)

  if (Number.isFinite(pct)) return pct
  if (!Number.isFinite(total) || !Number.isFinite(covered)) {
    throw new Error(`Invalid ${metricName} coverage summary`)
  }
  if (total <= 0) return 100
  return (covered / total) * 100
}

function extractCoverage(summary) {
  return {
    statements: extractMetricPct(summary.total.statements, 'statements'),
    branches: extractMetricPct(summary.total.branches, 'branches'),
    functions: extractMetricPct(summary.total.functions, 'functions'),
    lines: extractMetricPct(summary.total.lines, 'lines'),
  }
}

function resolvePackageRule(config, packageName) {
  const rule = config.packages?.[packageName]
  if (!rule || typeof rule !== 'object') {
    return {
      thresholds: { ...config.defaultThresholds },
      waiver: null,
    }
  }

  const thresholds = normalizeThresholds({
    ...config.defaultThresholds,
    ...(rule.thresholds && typeof rule.thresholds === 'object' ? rule.thresholds : {}),
  })

  const waiver = rule.waiver && typeof rule.waiver === 'object'
    ? {
        reason: typeof rule.waiver.reason === 'string' ? rule.waiver.reason : '',
        until: typeof rule.waiver.until === 'string' ? rule.waiver.until : null,
      }
    : null

  return { thresholds, waiver }
}

function isActiveWaiver(waiver) {
  if (!waiver) return false
  if (!waiver.reason) {
    throw new Error('Waiver entries must include a reason')
  }
  if (!waiver.until) return true
  const untilTime = Date.parse(waiver.until)
  if (Number.isNaN(untilTime)) {
    throw new Error(`Invalid waiver until date: ${waiver.until}`)
  }
  return untilTime >= Date.now()
}

function formatPct(value) {
  return `${value.toFixed(2)}%`
}

function formatThresholdFailure(packageName, thresholds, coverage) {
  const parts = []
  for (const metric of ['statements', 'branches', 'functions', 'lines']) {
    const actual = coverage[metric]
    const threshold = thresholds[metric]
    if (actual < threshold) {
      parts.push(`${metric} ${formatPct(actual)} < ${formatPct(threshold)}`)
    }
  }
  return parts.join(', ')
}

function packageWorkspaceName(packageName) {
  return `@dzupagent/${packageName}`
}

function summarizeReport(rows) {
  const totals = rows.reduce(
    (acc, row) => {
      acc.total += 1
      acc[row.status] += 1
      return acc
    },
    { total: 0, pass: 0, fail: 0, waived: 0, missing: 0, expired: 0 },
  )

  return totals
}

export function runCoverageGate({
  repoRoot = process.cwd(),
  configPath = join(repoRoot, 'coverage-thresholds.json'),
  packageFilter = null,
  reportOnly = false,
} = {}) {
  const config = loadCoverageThresholdConfig(repoRoot, configPath)
  const discovered = discoverTrackedPackages(repoRoot)
  const tracked = new Set([...discovered, ...(config.trackedPackages ?? [])])
  const packages = packageFilter && packageFilter.length > 0
    ? packageFilter.filter((name) => typeof name === 'string' && name.trim().length > 0)
    : [...tracked].sort()

  const rows = []

  for (const packageName of packages) {
    const rule = resolvePackageRule(config, packageName)
    const summaryPath = getCoverageSummaryPath(repoRoot, packageName)
    const workspaceName = packageWorkspaceName(packageName)

    if (isActiveWaiver(rule.waiver)) {
      rows.push({
        packageName,
        status: 'waived',
        message: rule.waiver.until
          ? `waived until ${rule.waiver.until}: ${rule.waiver.reason}`
          : `waived: ${rule.waiver.reason}`,
      })
      continue
    }

    if (rule.waiver && rule.waiver.until) {
      const untilTime = Date.parse(rule.waiver.until)
      if (!Number.isNaN(untilTime) && untilTime < Date.now()) {
        rows.push({
          packageName,
          status: 'expired',
          message: `waiver expired ${rule.waiver.until}: ${rule.waiver.reason}`,
        })
        continue
      }
    }

    if (!fileExists(summaryPath)) {
      rows.push({
        packageName,
        status: 'missing',
        message: `missing coverage summary at ${summaryPath} (run ${workspaceName} test:coverage)`,
      })
      continue
    }

    try {
      const summary = readCoverageSummary(summaryPath)
      const coverage = extractCoverage(summary)
      const failure = formatThresholdFailure(packageName, rule.thresholds, coverage)

      if (failure.length > 0) {
        rows.push({
          packageName,
          status: 'fail',
          message: `coverage below threshold: ${failure}`,
          coverage,
          thresholds: rule.thresholds,
        })
      } else {
        rows.push({
          packageName,
          status: 'pass',
          coverage,
          thresholds: rule.thresholds,
        })
      }
    } catch (error) {
      rows.push({
        packageName,
        status: 'missing',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const totals = summarizeReport(rows)
  const exitCode = reportOnly
    ? 0
    : totals.fail > 0 || totals.missing > 0 || totals.expired > 0
      ? 1
      : 0

  return { rows, totals, exitCode }
}

function printReport(report) {
  console.log('Workspace coverage gate:')

  if (report.rows.length === 0) {
    console.log('- no tracked coverage packages found')
    return
  }

  for (const row of report.rows) {
    if (row.status === 'pass') {
      console.log(
        `- ${row.packageName}: pass ` +
          `${formatPct(row.coverage.statements)} statements, ` +
          `${formatPct(row.coverage.branches)} branches, ` +
          `${formatPct(row.coverage.functions)} functions, ` +
          `${formatPct(row.coverage.lines)} lines`,
      )
      continue
    }

    if (row.status === 'waived') {
      console.log(`- ${row.packageName}: ${row.message}`)
      continue
    }

    if (row.status === 'expired') {
      console.error(`- ${row.packageName}: ${row.message}`)
      continue
    }

    console.error(`- ${row.packageName}: ${row.message}`)
  }

  console.log(
    `Summary: ${report.totals.total} checked, ` +
      `${report.totals.pass} passed, ` +
      `${report.totals.waived} waived, ` +
      `${report.totals.missing} missing, ` +
      `${report.totals.expired} expired, ` +
      `${report.totals.fail} failed`,
  )
}

export async function selfCheckCoverageGate() {
  const root = mkdtempSync(join(tmpdir(), 'dzupagent-coverage-self-check-'))
  const packagesDir = join(root, 'packages')
  mkdirSync(packagesDir, { recursive: true })

  const passingPackage = 'alpha'
  const waivedPackage = 'beta'

  for (const name of [passingPackage, waivedPackage]) {
    mkdirSync(join(packagesDir, name, 'coverage'), { recursive: true })
    writeJson(join(packagesDir, name, 'package.json'), {
      name: `@dzupagent/${name}`,
      private: true,
      scripts: { 'test:coverage': 'vitest run --coverage' },
    })
  }

  writeJson(join(packagesDir, passingPackage, 'coverage', COVERAGE_SUMMARY_NAME), {
    total: {
      statements: { total: 100, covered: 95, skipped: 0, pct: 95 },
      branches: { total: 100, covered: 90, skipped: 0, pct: 90 },
      functions: { total: 100, covered: 97, skipped: 0, pct: 97 },
      lines: { total: 100, covered: 96, skipped: 0, pct: 96 },
    },
  })

  writeJson(join(packagesDir, waivedPackage, 'coverage', COVERAGE_SUMMARY_NAME), {
    total: {
      statements: { total: 100, covered: 20, skipped: 0, pct: 20 },
      branches: { total: 100, covered: 10, skipped: 0, pct: 10 },
      functions: { total: 100, covered: 15, skipped: 0, pct: 15 },
      lines: { total: 100, covered: 18, skipped: 0, pct: 18 },
    },
  })

  writeJson(join(root, 'coverage-thresholds.json'), {
    defaultThresholds: { ...DEFAULT_THRESHOLDS },
    packages: {
      [waivedPackage]: {
        waiver: {
          reason: 'temporary waiver for self-check validation',
          until: '2099-01-01',
        },
      },
    },
  })

  try {
    return runCoverageGate({
      repoRoot: root,
      configPath: join(root, 'coverage-thresholds.json'),
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  const configArgIndex = args.indexOf('--config')
  const rootArgIndex = args.indexOf('--root')
  const packagesArgIndex = args.indexOf('--packages')
  const reportOnly = args.includes('--report-only')
  const selfCheck = args.includes('--self-check')

  if (selfCheck) {
    const report = await selfCheckCoverageGate()
    printReport(report)
    if (report.exitCode !== 0) {
      throw new Error('Self-check coverage gate failed')
    }
    return
  }

  const repoRoot = rootArgIndex >= 0 ? resolve(args[rootArgIndex + 1] ?? process.cwd()) : process.cwd()
  const configPath = configArgIndex >= 0
    ? resolve(args[configArgIndex + 1] ?? join(repoRoot, 'coverage-thresholds.json'))
    : join(repoRoot, 'coverage-thresholds.json')
  const packageFilter = packagesArgIndex >= 0
    ? (args[packagesArgIndex + 1] ?? '').split(',').map((name) => name.trim()).filter(Boolean)
    : null

  const report = runCoverageGate({
    repoRoot,
    configPath,
    packageFilter,
    reportOnly,
  })

  printReport(report)

  if (!reportOnly && report.exitCode !== 0) {
    process.exitCode = report.exitCode
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
