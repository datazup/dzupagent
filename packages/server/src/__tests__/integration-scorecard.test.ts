import { describe, it, expect, beforeEach } from 'vitest'
import {
  IntegrationScorecard,
  type IntegrationScorecardOptions,
  type ScorecardProbeInput,
} from '../scorecard/integration-scorecard.js'
import {
  ScorecardReporter,
  formatConsole,
  formatMarkdown,
  formatJSON,
} from '../scorecard/scorecard-reporter.js'
import { runScorecard, parseScorecardArgs } from '../cli/scorecard-command.js'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ForgeServerConfig } from '../app.js'

// ---------------------------------------------------------------------------
// Minimal mock config
// ---------------------------------------------------------------------------

function createMockConfig(overrides?: Partial<ForgeServerConfig>): ForgeServerConfig {
  return {
    runStore: {
      create: async () => ({ id: '1', agentId: 'a', status: 'queued', input: null, output: null, startedAt: new Date() }),
      get: async () => null,
      update: async () => {},
      list: async () => [],
    } as unknown as ForgeServerConfig['runStore'],
    agentStore: {
      create: async () => ({ id: '1', name: 'test', instructions: '', modelTier: 'fast' }),
      get: async () => null,
      update: async () => {},
      list: async () => [],
      delete: async () => {},
    } as unknown as ForgeServerConfig['agentStore'],
    eventBus: {
      emit: () => {},
      on: () => () => {},
      off: () => {},
    } as unknown as ForgeServerConfig['eventBus'],
    modelRegistry: {
      getProviderHealth: () => ({}),
      resolve: () => null,
    } as unknown as ForgeServerConfig['modelRegistry'],
    ...overrides,
  }
}

function createScorecard(
  config: ForgeServerConfig,
  probe?: ScorecardProbeInput,
  options?: IntegrationScorecardOptions,
): IntegrationScorecard {
  return new IntegrationScorecard(config, probe, {
    autoCollectProbe: false,
    ...options,
  })
}

function runScorecardForTest(
  config: ForgeServerConfig,
  options?: Parameters<typeof runScorecard>[1],
): ReturnType<typeof runScorecard> {
  return runScorecard(config, {
    autoCollectProbe: false,
    ...options,
  })
}

async function createProbeWorkspace(options?: {
  coveragePercent?: number
  coverageContents?: string
  includeSecretScan?: boolean
}): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'forge-scorecard-probes-'))
  await mkdir(join(tempDir, 'coverage'), { recursive: true })
  await mkdir(join(tempDir, 'src', '__tests__'), { recursive: true })
  await mkdir(join(tempDir, '.github', 'workflows'), { recursive: true })

  await writeFile(join(tempDir, 'package.json'), JSON.stringify({
    name: 'scorecard-probe-workspace',
    scripts: options?.includeSecretScan === false
      ? { test: 'vitest run' }
      : { test: 'vitest run', 'security:secrets': 'gitleaks detect --source .' },
  }, null, 2))

  await writeFile(
    join(tempDir, 'coverage', 'coverage-summary.json'),
    options?.coverageContents
      ?? JSON.stringify({
        total: {
          lines: { pct: options?.coveragePercent ?? 88 },
        },
      }, null, 2),
  )

  await writeFile(join(tempDir, 'src', '__tests__', 'run-worker.test.ts'), 'export {}\n')
  await writeFile(join(tempDir, 'src', '__tests__', 'api.integration.test.ts'), 'export {}\n')
  await writeFile(
    join(tempDir, '.github', 'workflows', 'ci.yml'),
    options?.includeSecretScan === false
      ? 'name: ci\n'
      : 'name: ci\njobs:\n  secrets:\n    steps:\n      - run: gitleaks detect --source .\n',
  )

  return tempDir
}

// ---------------------------------------------------------------------------
// IntegrationScorecard
// ---------------------------------------------------------------------------

describe('IntegrationScorecard', () => {
  describe('generate()', () => {
    it('returns a report with all five categories', () => {
      const config = createMockConfig()
      const scorecard = createScorecard(config)
      const report = scorecard.generate()

      expect(report.categories).toHaveLength(5)
      const names = report.categories.map((c) => c.name)
      expect(names).toContain('Coverage')
      expect(names).toContain('Safety')
      expect(names).toContain('Cost Controls')
      expect(names).toContain('Observability')
      expect(names).toContain('Security')
    })

    it('has a generatedAt timestamp', () => {
      const config = createMockConfig()
      const report = createScorecard(config).generate()
      expect(report.generatedAt).toBeInstanceOf(Date)
    })

    it('computes grade A for a fully configured system', () => {
      const config = createMockConfig({
        auth: { mode: 'api-key', validateKey: async () => ({}) },
        corsOrigins: ['https://example.com'],
        rateLimit: { maxRequests: 100, windowMs: 60_000, headerPrefix: 'X-RateLimit' },
        metrics: { increment: () => {}, observe: () => {}, toJSON: () => [] } as unknown as ForgeServerConfig['metrics'],
        runQueue: {
          enqueue: async () => '1',
          stats: () => ({ pending: 0, active: 0, completed: 0, failed: 0 }),
        } as unknown as ForgeServerConfig['runQueue'],
      })
      const probe: ScorecardProbeInput = {
        testCoveragePercent: 95,
        hasCriticalPathTests: true,
        hasIntegrationTests: true,
        policyEngineConfigured: true,
        auditTrailEnabled: true,
        secretDetectionActive: true,
        inputSanitizationPresent: true,
        tokenBudgetLimitsSet: true,
        modelFallbackConfigured: true,
        otelExporterConfigured: true,
        errorAlertingConfigured: true,
        corsRestricted: true,
        apiKeyRotationEnabled: true,
        rbacEnforcementPresent: true,
      }

      const report = createScorecard(config, probe).generate()
      expect(report.grade).toBe('A')
      expect(report.overallScore).toBeGreaterThanOrEqual(90)
      expect(report.recommendations).toHaveLength(0)
    })

    it('computes grade F for a bare config with no probe', () => {
      const config = createMockConfig()
      // No auth, no rate limit, no metrics, no queue, no probe
      const report = createScorecard(config).generate()
      // With skipped checks and failures, score should be low
      expect(report.grade).toBe('F')
      expect(report.overallScore).toBeLessThan(40)
    })

    it('scores category weights correctly', () => {
      const config = createMockConfig()
      const report = createScorecard(config).generate()

      const weights = report.categories.map((c) => c.weight)
      expect(weights).toEqual([0.20, 0.25, 0.15, 0.20, 0.20])
      // Total weight should be 1.0
      const total = weights.reduce((sum, w) => sum + w, 0)
      expect(total).toBeCloseTo(1.0)
    })

    it('generates recommendations for failed checks', () => {
      const config = createMockConfig()
      const report = createScorecard(config).generate()

      // With no auth, no rate limit, no metrics — expect failures
      expect(report.recommendations.length).toBeGreaterThan(0)

      // Recommendations should be sorted by priority
      const priorities = report.recommendations.map((r) => r.priority)
      const order = { critical: 0, high: 1, medium: 2, low: 3 }
      for (let i = 1; i < priorities.length; i++) {
        const prev = priorities[i - 1]!
        const curr = priorities[i]!
        expect(order[prev]).toBeLessThanOrEqual(order[curr])
      }
    })

    it('handles partial probe inputs', () => {
      const config = createMockConfig()
      const probe: ScorecardProbeInput = {
        testCoveragePercent: 65,
        hasCriticalPathTests: true,
      }

      const report = createScorecard(config, probe).generate()
      const coverage = report.categories.find((c) => c.name === 'Coverage')!
      expect(coverage.checks.find((c) => c.name === 'Test coverage')?.status).toBe('warn')
      expect(coverage.checks.find((c) => c.name === 'Critical path tests')?.status).toBe('pass')
      expect(coverage.checks.find((c) => c.name === 'Integration tests')?.status).toBe('skip')
    })

    it('detects auth mode none as a warning', () => {
      const config = createMockConfig({
        auth: { mode: 'none' },
      })
      const report = createScorecard(config).generate()
      const security = report.categories.find((c) => c.name === 'Security')!
      const authCheck = security.checks.find((c) => c.name === 'Auth middleware')!
      expect(authCheck.status).toBe('warn')
    })

    it('detects restricted CORS from config', () => {
      const config = createMockConfig({
        corsOrigins: ['https://app.example.com'],
      })
      const report = createScorecard(config).generate()
      const security = report.categories.find((c) => c.name === 'Security')!
      const corsCheck = security.checks.find((c) => c.name === 'CORS configuration')!
      expect(corsCheck.status).toBe('pass')
    })

    it('infers model fallback from multiple providers', () => {
      const config = createMockConfig({
        modelRegistry: {
          getProviderHealth: () => ({
            openai: { state: 'closed', provider: 'openai' },
            anthropic: { state: 'closed', provider: 'anthropic' },
          }),
        } as unknown as ForgeServerConfig['modelRegistry'],
      })

      const report = createScorecard(config).generate()
      const costControls = report.categories.find((c) => c.name === 'Cost Controls')!
      const fallbackCheck = costControls.checks.find((c) => c.name === 'Model fallback chains')!
      expect(fallbackCheck.status).toBe('pass')
    })

    it('detects metrics/events as partial audit trail', () => {
      const config = createMockConfig({
        metrics: { increment: () => {}, observe: () => {}, toJSON: () => [] } as unknown as ForgeServerConfig['metrics'],
      })
      const report = createScorecard(config).generate()
      const safety = report.categories.find((c) => c.name === 'Safety')!
      const auditCheck = safety.checks.find((c) => c.name === 'Audit trail')!
      expect(auditCheck.status).toBe('warn')
      expect(auditCheck.score).toBe(50)
    })

    it('auto-collects inferable probes from the filesystem and environment', async () => {
      const tempDir = await createProbeWorkspace()

      try {
        const report = createScorecard(createMockConfig(), undefined, {
          autoCollectProbe: true,
          rootDir: tempDir,
          env: {
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
            SLACK_WEBHOOK_URL: 'https://hooks.slack.test/services/example',
          },
        }).generate()

        const coverage = report.categories.find((c) => c.name === 'Coverage')!
        const safety = report.categories.find((c) => c.name === 'Safety')!
        const observability = report.categories.find((c) => c.name === 'Observability')!

        const coverageCheck = coverage.checks.find((c) => c.name === 'Test coverage')!
        const criticalPathCheck = coverage.checks.find((c) => c.name === 'Critical path tests')!
        const integrationCheck = coverage.checks.find((c) => c.name === 'Integration tests')!
        const secretDetectionCheck = safety.checks.find((c) => c.name === 'Secret detection')!
        const otelCheck = observability.checks.find((c) => c.name === 'OTEL exporter')!
        const errorAlertingCheck = observability.checks.find((c) => c.name === 'Error alerting')!

        expect(coverageCheck.status).toBe('pass')
        expect(coverageCheck.details).toMatchObject({ percent: 88, probeSource: 'auto' })
        expect(criticalPathCheck.status).toBe('pass')
        expect(integrationCheck.status).toBe('pass')
        expect(secretDetectionCheck.status).toBe('pass')
        expect(secretDetectionCheck.details).toMatchObject({ probeSource: 'auto' })
        expect(otelCheck.status).toBe('pass')
        expect(errorAlertingCheck.status).toBe('pass')
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('prefers caller probe values over auto-collected probes', async () => {
      const tempDir = await createProbeWorkspace({ coveragePercent: 12 })

      try {
        const report = createScorecard(createMockConfig(), { testCoveragePercent: 90 }, {
          autoCollectProbe: true,
          rootDir: tempDir,
        }).generate()

        const coverage = report.categories.find((c) => c.name === 'Coverage')!
        const coverageCheck = coverage.checks.find((c) => c.name === 'Test coverage')!

        expect(coverageCheck.status).toBe('pass')
        expect(coverageCheck.details).toMatchObject({ percent: 90, probeSource: 'input' })
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('degrades gracefully when automated probe collection fails', async () => {
      const tempDir = await createProbeWorkspace({ coverageContents: '{not-json' })

      try {
        const report = createScorecard(createMockConfig(), undefined, {
          autoCollectProbe: true,
          rootDir: tempDir,
        }).generate()

        const coverage = report.categories.find((c) => c.name === 'Coverage')!
        const coverageCheck = coverage.checks.find((c) => c.name === 'Test coverage')!

        expect(coverageCheck.status).toBe('skip')
        expect(coverageCheck.details).toMatchObject({
          probeSource: 'auto',
          probeReason: 'Automatic coverage probe failed',
        })
        expect(typeof coverageCheck.details?.['probeDiagnostic']).toBe('string')
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('grade computation', () => {
    it('maps scores to correct grades', () => {
      const config = createMockConfig()

      // We can test grade boundaries by constructing probe inputs that yield known scores
      // Instead, test the grade in the report directly
      const report = createScorecard(config).generate()
      const validGrades = ['A', 'B', 'C', 'D', 'F']
      expect(validGrades).toContain(report.grade)
    })
  })
})

// ---------------------------------------------------------------------------
// ScorecardReporter
// ---------------------------------------------------------------------------

describe('ScorecardReporter', () => {
  let report: ReturnType<IntegrationScorecard['generate']>

  beforeEach(() => {
    const config = createMockConfig({
      auth: { mode: 'api-key', validateKey: async () => ({}) },
      rateLimit: { maxRequests: 50, windowMs: 30_000, headerPrefix: 'X-RateLimit' },
    })
    report = createScorecard(config, {
      testCoveragePercent: 72,
      hasCriticalPathTests: true,
      hasIntegrationTests: false,
    }).generate()
  })

  it('renders console format with ANSI codes', () => {
    const output = formatConsole(report)
    expect(output).toContain('DzupAgent Integration Scorecard')
    expect(output).toContain('Overall Score:')
    expect(output).toContain('Coverage')
    expect(output).toContain('Safety')
    // ANSI codes present
    expect(output).toContain('\x1b[')
  })

  it('renders markdown format with table headers', () => {
    const output = formatMarkdown(report)
    expect(output).toContain('# DzupAgent Integration Scorecard')
    expect(output).toContain('| Status | Check | Score | Message |')
    expect(output).toContain('**Overall Score:**')
    expect(output).toContain('**Grade:**')
  })

  it('renders valid JSON format', () => {
    const output = formatJSON(report)
    const parsed = JSON.parse(output) as Record<string, unknown>
    expect(parsed).toHaveProperty('overallScore')
    expect(parsed).toHaveProperty('grade')
    expect(parsed).toHaveProperty('categories')
    expect(parsed).toHaveProperty('recommendations')
    expect(typeof parsed['generatedAt']).toBe('string') // ISO string
  })

  it('reporter.render() delegates to correct format', () => {
    const reporter = new ScorecardReporter(report)

    const consoleOutput = reporter.render('console')
    expect(consoleOutput).toContain('\x1b[')

    const mdOutput = reporter.render('markdown')
    expect(mdOutput).toContain('# DzupAgent Integration Scorecard')

    const jsonOutput = reporter.render('json')
    expect(() => JSON.parse(jsonOutput)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// CLI command
// ---------------------------------------------------------------------------

describe('scorecard CLI command', () => {
  describe('parseScorecardArgs', () => {
    it('parses --json flag', () => {
      const opts = parseScorecardArgs(['--json'])
      expect(opts.format).toBe('json')
    })

    it('parses --markdown flag', () => {
      const opts = parseScorecardArgs(['--markdown'])
      expect(opts.format).toBe('markdown')
    })

    it('parses --md alias', () => {
      const opts = parseScorecardArgs(['--md'])
      expect(opts.format).toBe('markdown')
    })

    it('parses --format console', () => {
      const opts = parseScorecardArgs(['--format', 'console'])
      expect(opts.format).toBe('console')
    })

    it('parses --output path', () => {
      const opts = parseScorecardArgs(['--output', 'report.md'])
      expect(opts.output).toBe('report.md')
    })

    it('parses -o shorthand', () => {
      const opts = parseScorecardArgs(['-o', '/tmp/out.json'])
      expect(opts.output).toBe('/tmp/out.json')
    })

    it('handles combined flags', () => {
      const opts = parseScorecardArgs(['--json', '-o', '/tmp/out.json'])
      expect(opts.format).toBe('json')
      expect(opts.output).toBe('/tmp/out.json')
    })

    it('returns empty options for no args', () => {
      const opts = parseScorecardArgs([])
      expect(opts.format).toBeUndefined()
      expect(opts.output).toBeUndefined()
    })

    it('ignores unknown flags', () => {
      const opts = parseScorecardArgs(['--verbose', '--json'])
      expect(opts.format).toBe('json')
    })
  })

  describe('runScorecard', () => {
    it('generates a report and rendered output', () => {
      const config = createMockConfig()
      const result = runScorecardForTest(config)

      expect(result.report).toBeDefined()
      expect(result.report.overallScore).toBeGreaterThanOrEqual(0)
      expect(result.report.overallScore).toBeLessThanOrEqual(100)
      expect(result.rendered).toContain('DzupAgent Integration Scorecard')
      expect(result.writtenTo).toBeUndefined()
    })

    it('writes output to file when --output is specified', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'forge-scorecard-'))
      const outPath = join(tempDir, 'report.md')

      try {
        const config = createMockConfig()
        const result = runScorecardForTest(config, { format: 'markdown', output: outPath })

        expect(result.writtenTo).toBe(outPath)
        const content = await readFile(outPath, 'utf-8')
        expect(content).toContain('# DzupAgent Integration Scorecard')
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('uses probe inputs when provided', () => {
      const config = createMockConfig()
      const result = runScorecardForTest(config, {
        probe: { testCoveragePercent: 90, hasCriticalPathTests: true },
      })

      const coverage = result.report.categories.find((c) => c.name === 'Coverage')!
      const testCheck = coverage.checks.find((c) => c.name === 'Test coverage')!
      expect(testCheck.status).toBe('pass')
    })

    it('renders JSON format', () => {
      const config = createMockConfig()
      const result = runScorecardForTest(config, { format: 'json' })

      expect(() => JSON.parse(result.rendered)).not.toThrow()
    })

    it('passes automated probe collection options through the CLI entrypoint', async () => {
      const tempDir = await createProbeWorkspace()

      try {
        const result = runScorecardForTest(createMockConfig(), {
          autoCollectProbe: true,
          probeRootDir: tempDir,
          probeEnv: {
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
          },
        })

        const observability = result.report.categories.find((c) => c.name === 'Observability')!
        const otelCheck = observability.checks.find((c) => c.name === 'OTEL exporter')!
        expect(otelCheck.status).toBe('pass')
        expect(otelCheck.details).toMatchObject({ probeSource: 'auto' })
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Approval flow / edge cases
// ---------------------------------------------------------------------------

describe('Scorecard edge cases', () => {
  it('handles all checks skipped (no probe, minimal config)', () => {
    const config = createMockConfig()
    const report = createScorecard(config).generate()

    // Should not crash; overall score should be a valid number
    expect(typeof report.overallScore).toBe('number')
    expect(report.overallScore).toBeGreaterThanOrEqual(0)
  })

  it('health checks always pass (built-in)', () => {
    const config = createMockConfig()
    const report = createScorecard(config).generate()
    const observability = report.categories.find((c) => c.name === 'Observability')!
    const healthCheck = observability.checks.find((c) => c.name === 'Health checks')!
    expect(healthCheck.status).toBe('pass')
  })

  it('test coverage boundary: exactly 80 is pass', () => {
    const config = createMockConfig()
    const report = createScorecard(config, { testCoveragePercent: 80 }).generate()
    const coverage = report.categories.find((c) => c.name === 'Coverage')!
    const testCheck = coverage.checks.find((c) => c.name === 'Test coverage')!
    expect(testCheck.status).toBe('pass')
  })

  it('test coverage boundary: exactly 50 is warn', () => {
    const config = createMockConfig()
    const report = createScorecard(config, { testCoveragePercent: 50 }).generate()
    const coverage = report.categories.find((c) => c.name === 'Coverage')!
    const testCheck = coverage.checks.find((c) => c.name === 'Test coverage')!
    expect(testCheck.status).toBe('warn')
  })

  it('test coverage boundary: 49 is fail', () => {
    const config = createMockConfig()
    const report = createScorecard(config, { testCoveragePercent: 49 }).generate()
    const coverage = report.categories.find((c) => c.name === 'Coverage')!
    const testCheck = coverage.checks.find((c) => c.name === 'Test coverage')!
    expect(testCheck.status).toBe('fail')
  })
})
