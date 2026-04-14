import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { ScorecardProbeInput } from './integration-scorecard.js'

export type ScorecardProbeField = keyof ScorecardProbeInput

export interface ScorecardProbeFieldMetadata {
  source: 'auto' | 'input'
  reason: string
  rootDir?: string
  evidence?: string[]
  diagnostic?: string
}

export interface ScorecardProbeCollectionOptions {
  rootDir?: string
  env?: NodeJS.ProcessEnv
}

export interface ScorecardProbeCollection {
  probe: ScorecardProbeInput
  metadata: Partial<Record<ScorecardProbeField, ScorecardProbeFieldMetadata>>
}

const IGNORED_DIRS = new Set(['.git', '.turbo', 'dist', 'node_modules'])
const MAX_EVIDENCE = 5
const TEST_FILE_PATTERN = /(?:^|\/)[^/]+\.(?:integration\.)?test\.[cm]?[jt]sx?$/i
const INTEGRATION_TEST_PATTERN = /(?:^|\/)[^/]+(?:\.integration\.test|integration[-_.].*\.test)\.[cm]?[jt]sx?$/i
const CRITICAL_PATH_TEST_PATTERN = /(?:run|queue|worker|pipeline|route|auth|server|health|app)/i
const SECRET_TOOL_PATTERN = /(gitleaks|secretlint|detect-secrets|trufflehog)/i

interface TestInventory {
  allTests: string[]
  integrationTests: string[]
  criticalPathTests: string[]
}

export function collectScorecardProbes(options?: ScorecardProbeCollectionOptions): ScorecardProbeCollection {
  const rootDir = options?.rootDir ?? process.cwd()
  const env = options?.env ?? process.env
  const probe: ScorecardProbeInput = {}
  const metadata: Partial<Record<ScorecardProbeField, ScorecardProbeFieldMetadata>> = {}

  collectCoverageProbe(rootDir, probe, metadata)
  collectTestProbes(rootDir, probe, metadata)
  collectSecretDetectionProbe(rootDir, probe, metadata)
  collectEnvironmentProbe(
    env,
    'otelExporterConfigured',
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'],
    probe,
    metadata,
    rootDir,
    'Inspected OpenTelemetry exporter environment variables',
  )
  collectEnvironmentProbe(
    env,
    'errorAlertingConfigured',
    ['SENTRY_DSN', 'PAGERDUTY_INTEGRATION_KEY', 'PAGERDUTY_ROUTING_KEY', 'SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL'],
    probe,
    metadata,
    rootDir,
    'Inspected error alerting environment variables',
  )

  return { probe, metadata }
}

function collectCoverageProbe(
  rootDir: string,
  probe: ScorecardProbeInput,
  metadata: Partial<Record<ScorecardProbeField, ScorecardProbeFieldMetadata>>,
): void {
  try {
    const coverageSummaryPath = findFirstFile(rootDir, (relativePath) => relativePath.endsWith('coverage-summary.json'))
    if (coverageSummaryPath) {
      const parsed = JSON.parse(readFileSync(coverageSummaryPath, 'utf-8')) as {
        total?: {
          lines?: { pct?: unknown }
          statements?: { pct?: unknown }
        }
      }
      const pct = coerceCoveragePercent(parsed.total?.lines?.pct ?? parsed.total?.statements?.pct)
      if (pct !== undefined) {
        probe.testCoveragePercent = pct
        metadata.testCoveragePercent = {
          source: 'auto',
          reason: 'Loaded coverage percentage from coverage summary',
          rootDir,
          evidence: [relative(rootDir, coverageSummaryPath)],
        }
        return
      }

      metadata.testCoveragePercent = {
        source: 'auto',
        reason: 'Coverage summary file did not contain a usable percentage',
        rootDir,
        evidence: [relative(rootDir, coverageSummaryPath)],
      }
      return
    }

    const lcovPath = findFirstFile(rootDir, (relativePath) => relativePath.endsWith('lcov.info'))
    if (lcovPath) {
      const lcovContent = readFileSync(lcovPath, 'utf-8')
      const pct = parseLcovPercent(lcovContent)
      if (pct !== undefined) {
        probe.testCoveragePercent = pct
        metadata.testCoveragePercent = {
          source: 'auto',
          reason: 'Computed coverage percentage from LCOV totals',
          rootDir,
          evidence: [relative(rootDir, lcovPath)],
        }
        return
      }

      metadata.testCoveragePercent = {
        source: 'auto',
        reason: 'LCOV file was found but did not expose valid totals',
        rootDir,
        evidence: [relative(rootDir, lcovPath)],
      }
    }
  } catch (error) {
    metadata.testCoveragePercent = {
      source: 'auto',
      reason: 'Automatic coverage probe failed',
      rootDir,
      diagnostic: formatError(error),
    }
  }
}

function collectTestProbes(
  rootDir: string,
  probe: ScorecardProbeInput,
  metadata: Partial<Record<ScorecardProbeField, ScorecardProbeFieldMetadata>>,
): void {
  try {
    const inventory = collectTestInventory(rootDir)
    const allTests = inventory.allTests.slice(0, MAX_EVIDENCE)

    probe.hasIntegrationTests = inventory.integrationTests.length > 0
    metadata.hasIntegrationTests = {
      source: 'auto',
      reason: inventory.integrationTests.length > 0
        ? 'Found integration-style test files'
        : inventory.allTests.length > 0
          ? 'Scanned test files but found no integration-style test names'
          : 'Scanned repository and found no test files',
      rootDir,
      evidence: (inventory.integrationTests.length > 0 ? inventory.integrationTests : allTests).slice(0, MAX_EVIDENCE),
    }

    probe.hasCriticalPathTests = inventory.criticalPathTests.length > 0
    metadata.hasCriticalPathTests = {
      source: 'auto',
      reason: inventory.criticalPathTests.length > 0
        ? 'Found test files matching critical-path runtime keywords'
        : inventory.allTests.length > 0
          ? 'Scanned test files but found no critical-path runtime test names'
          : 'Scanned repository and found no test files',
      rootDir,
      evidence: (inventory.criticalPathTests.length > 0 ? inventory.criticalPathTests : allTests).slice(0, MAX_EVIDENCE),
    }
  } catch (error) {
    const diagnostic = formatError(error)
    metadata.hasIntegrationTests = {
      source: 'auto',
      reason: 'Automatic integration test probe failed',
      rootDir,
      diagnostic,
    }
    metadata.hasCriticalPathTests = {
      source: 'auto',
      reason: 'Automatic critical-path test probe failed',
      rootDir,
      diagnostic,
    }
  }
}

function collectSecretDetectionProbe(
  rootDir: string,
  probe: ScorecardProbeInput,
  metadata: Partial<Record<ScorecardProbeField, ScorecardProbeFieldMetadata>>,
): void {
  try {
    const evidence = new Set<string>()

    for (const candidate of ['.gitleaks.toml', '.gitleaksignore', 'gitleaks.toml', '.secretlintrc', '.secretlintrc.json', 'secretlint.config.js', 'secretlint.config.mjs']) {
      const candidatePath = join(rootDir, candidate)
      if (existsSync(candidatePath)) {
        evidence.add(candidate)
      }
    }

    const packageJsonPath = join(rootDir, 'package.json')
    if (existsSync(packageJsonPath)) {
      const packageJsonText = readFileSync(packageJsonPath, 'utf-8')
      if (SECRET_TOOL_PATTERN.test(packageJsonText)) {
        evidence.add('package.json')
      }
    }

    const workflowPaths = collectFiles(rootDir, (relativePath) => relativePath.startsWith('.github/workflows/') && relativePath.endsWith('.yml'), 20)
    for (const workflowPath of workflowPaths) {
      const content = readFileSync(join(rootDir, workflowPath), 'utf-8')
      if (SECRET_TOOL_PATTERN.test(content)) {
        evidence.add(workflowPath)
      }
    }

    const evidenceList = Array.from(evidence).slice(0, MAX_EVIDENCE)
    probe.secretDetectionActive = evidenceList.length > 0
    metadata.secretDetectionActive = {
      source: 'auto',
      reason: evidenceList.length > 0
        ? 'Found secret scanning configuration or CI references'
        : 'Checked package scripts and CI workflows for secret scanning configuration',
      rootDir,
      evidence: evidenceList,
    }
  } catch (error) {
    metadata.secretDetectionActive = {
      source: 'auto',
      reason: 'Automatic secret detection probe failed',
      rootDir,
      diagnostic: formatError(error),
    }
  }
}

function collectEnvironmentProbe(
  env: NodeJS.ProcessEnv,
  field: 'otelExporterConfigured' | 'errorAlertingConfigured',
  keys: string[],
  probe: ScorecardProbeInput,
  metadata: Partial<Record<ScorecardProbeField, ScorecardProbeFieldMetadata>>,
  rootDir: string,
  reason: string,
): void {
  try {
    const evidence = keys.filter((key) => typeof env[key] === 'string' && env[key]!.trim().length > 0)
    probe[field] = evidence.length > 0
    metadata[field] = {
      source: 'auto',
      reason,
      rootDir,
      evidence,
    }
  } catch (error) {
    metadata[field] = {
      source: 'auto',
      reason: `Automatic ${field} probe failed`,
      rootDir,
      diagnostic: formatError(error),
    }
  }
}

function collectTestInventory(rootDir: string): TestInventory {
  const allTests = collectFiles(rootDir, (relativePath) => TEST_FILE_PATTERN.test(relativePath), 200)
  const integrationTests = allTests.filter((relativePath) => INTEGRATION_TEST_PATTERN.test(relativePath)).slice(0, MAX_EVIDENCE)
  const criticalPathTests = allTests
    .filter((relativePath) => CRITICAL_PATH_TEST_PATTERN.test(relativePath.split('/').pop() ?? relativePath))
    .slice(0, MAX_EVIDENCE)

  return { allTests, integrationTests, criticalPathTests }
}

function collectFiles(rootDir: string, predicate: (relativePath: string) => boolean, maxResults: number): string[] {
  const matches: string[] = []

  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (matches.length >= maxResults) {
        return
      }

      const entryPath = join(directory, entry.name)
      const relativePath = relative(rootDir, entryPath)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          visit(entryPath)
        }
        continue
      }

      if (entry.isFile() && predicate(relativePath)) {
        matches.push(relativePath)
      }
    }
  }

  visit(rootDir)
  return matches
}

function findFirstFile(rootDir: string, predicate: (relativePath: string) => boolean): string | undefined {
  const [match] = collectFiles(rootDir, predicate, 1)
  return match ? join(rootDir, match) : undefined
}

function coerceCoveragePercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return undefined
  }

  return Math.max(0, Math.min(100, Math.round(value)))
}

function parseLcovPercent(content: string): number | undefined {
  let linesFound = 0
  let linesHit = 0

  for (const line of content.split(/\r?\n/u)) {
    if (line.startsWith('LF:')) {
      linesFound += Number(line.slice(3))
    } else if (line.startsWith('LH:')) {
      linesHit += Number(line.slice(3))
    }
  }

  if (linesFound <= 0 || Number.isNaN(linesFound) || Number.isNaN(linesHit)) {
    return undefined
  }

  return Math.max(0, Math.min(100, Math.round((linesHit / linesFound) * 100)))
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
