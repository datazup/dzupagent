import { describe, it, expect } from 'vitest'
import {
  runDoctor,
  formatDoctorReport,
  formatDoctorReportJSON,
} from '../cli/doctor.js'
import type {
  DoctorContext,
  DoctorReport,
  CheckStatus,
} from '../cli/doctor.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flatten all checks from a report into a simple array. */
function allChecks(report: DoctorReport) {
  return report.categories.flatMap((c) => c.checks)
}

/** Find a check by name (partial match). */
function findCheck(report: DoctorReport, name: string) {
  return allChecks(report).find((c) => c.name.includes(name))
}

/** Find all checks in a category. */
function findCategory(report: DoctorReport, category: string) {
  return report.categories.find((c) => c.category === category)
}

// ---------------------------------------------------------------------------
// Environment checks
// ---------------------------------------------------------------------------

describe('doctor — Environment', () => {
  it('passes when all required env vars are set', async () => {
    const ctx: DoctorContext = {
      env: {
        DATABASE_URL: 'postgres://localhost/forge',
        ANTHROPIC_API_KEY: 'sk-ant-test',
        REDIS_URL: 'redis://localhost:6379',
      },
    }
    const report = await runDoctor(ctx)
    const cat = findCategory(report, 'Environment')!

    expect(cat).toBeDefined()
    expect(cat.checks.every((c) => c.status === 'pass')).toBe(true)
  })

  it('fails when DATABASE_URL is missing', async () => {
    const ctx: DoctorContext = {
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'DATABASE_URL')!

    expect(check.status).toBe('fail')
    expect(check.message).toContain('not set')
  })

  it('fails when no LLM API key is present', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'postgres://localhost/forge' },
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'LLM API Key')!

    expect(check.status).toBe('fail')
  })

  it('passes with OPENAI_API_KEY as alternative LLM key', async () => {
    const ctx: DoctorContext = {
      env: {
        DATABASE_URL: 'postgres://localhost/forge',
        OPENAI_API_KEY: 'sk-openai-test',
      },
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'LLM API Key')!

    expect(check.status).toBe('pass')
    expect(check.message).toContain('OPENAI_API_KEY')
  })

  it('warns when REDIS_URL is missing', async () => {
    const ctx: DoctorContext = {
      env: {
        DATABASE_URL: 'postgres://localhost/forge',
        ANTHROPIC_API_KEY: 'sk-ant-test',
      },
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'REDIS_URL')!

    expect(check.status).toBe('warn')
  })

  it('includes fix suggestions with --fix flag', async () => {
    const ctx: DoctorContext = { env: {} }
    const report = await runDoctor(ctx, { fix: true })
    const check = findCheck(report, 'DATABASE_URL')!

    expect(check.fix).toBeDefined()
    expect(check.fix).toContain('DATABASE_URL')
  })
})

// ---------------------------------------------------------------------------
// Model Configuration
// ---------------------------------------------------------------------------

describe('doctor — Model Configuration', () => {
  it('passes when API key is present and ping succeeds', async () => {
    const ctx: DoctorContext = {
      env: {
        DATABASE_URL: 'postgres://localhost/forge',
        ANTHROPIC_API_KEY: 'sk-ant-test',
      },
      pingLLM: async (_provider: string, _key: string) => 'claude-3-haiku',
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'anthropic provider')!

    expect(check.status).toBe('pass')
    expect(check.message).toContain('claude-3-haiku')
  })

  it('fails when ping throws', async () => {
    const ctx: DoctorContext = {
      env: {
        DATABASE_URL: 'postgres://localhost/forge',
        ANTHROPIC_API_KEY: 'sk-ant-test',
      },
      pingLLM: async () => { throw new Error('Unauthorized') },
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'anthropic provider')!

    expect(check.status).toBe('fail')
    expect(check.message).toContain('Unauthorized')
  })

  it('shows masked key when no ping function provided', async () => {
    const ctx: DoctorContext = {
      env: {
        DATABASE_URL: 'postgres://localhost/forge',
        ANTHROPIC_API_KEY: 'sk-ant-1234567890',
      },
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'anthropic provider')!

    expect(check.status).toBe('pass')
    expect(check.message).toContain('sk-ant-1...')
  })

  it('warns when provider key is not set', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'postgres://localhost/forge' },
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'anthropic provider')!

    expect(check.status).toBe('warn')
    expect(check.message).toContain('unavailable')
  })
})

// ---------------------------------------------------------------------------
// Database Health
// ---------------------------------------------------------------------------

describe('doctor — Database Health', () => {
  it('passes when database ping succeeds', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'postgres://localhost/forge', ANTHROPIC_API_KEY: 'test' },
      pingDatabase: async () => 5,
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'Postgres connection')!

    expect(check.status).toBe('pass')
    expect(check.message).toContain('5ms')
  })

  it('fails when database ping throws', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'postgres://localhost/forge', ANTHROPIC_API_KEY: 'test' },
      pingDatabase: async () => { throw new Error('ECONNREFUSED') },
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'Postgres connection')!

    expect(check.status).toBe('fail')
    expect(check.message).toContain('ECONNREFUSED')
  })

  it('warns when no database probe provided', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'postgres://localhost/forge', ANTHROPIC_API_KEY: 'test' },
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'Postgres connection')!

    expect(check.status).toBe('warn')
  })

  it('reports migration status', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'postgres://localhost/forge', ANTHROPIC_API_KEY: 'test' },
      pingDatabase: async () => 3,
      checkMigrations: async () => true,
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'Migrations')!

    expect(check.status).toBe('pass')
    expect(check.message).toContain('applied')
  })

  it('warns on pending migrations', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'postgres://localhost/forge', ANTHROPIC_API_KEY: 'test' },
      pingDatabase: async () => 3,
      checkMigrations: async () => false,
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'Migrations')!

    expect(check.status).toBe('warn')
  })
})

// ---------------------------------------------------------------------------
// Queue Backend
// ---------------------------------------------------------------------------

describe('doctor — Queue Backend', () => {
  it('warns when REDIS_URL is not set', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'postgres://localhost/forge', ANTHROPIC_API_KEY: 'test' },
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'Redis connection')!

    expect(check.status).toBe('warn')
    expect(check.message).toContain('in-memory')
  })

  it('passes when Redis ping succeeds', async () => {
    const ctx: DoctorContext = {
      env: {
        DATABASE_URL: 'postgres://localhost/forge',
        ANTHROPIC_API_KEY: 'test',
        REDIS_URL: 'redis://localhost:6379',
      },
      pingRedis: async () => 2,
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'Redis connection')!

    expect(check.status).toBe('pass')
    expect(check.message).toContain('2ms')
  })

  it('fails when Redis ping throws', async () => {
    const ctx: DoctorContext = {
      env: {
        DATABASE_URL: 'postgres://localhost/forge',
        ANTHROPIC_API_KEY: 'test',
        REDIS_URL: 'redis://localhost:6379',
      },
      pingRedis: async () => { throw new Error('Connection refused') },
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'Redis connection')!

    expect(check.status).toBe('fail')
  })

  it('reports queue stats with failed job warning', async () => {
    const ctx: DoctorContext = {
      env: {
        DATABASE_URL: 'postgres://localhost/forge',
        ANTHROPIC_API_KEY: 'test',
        REDIS_URL: 'redis://localhost:6379',
      },
      pingRedis: async () => 1,
      getQueueStats: async () => ({ pending: 5, active: 2, failed: 3 }),
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'Queue status')!

    expect(check.status).toBe('warn')
    expect(check.message).toContain('failed=3')
  })

  it('passes queue stats with zero failures', async () => {
    const ctx: DoctorContext = {
      env: {
        DATABASE_URL: 'postgres://localhost/forge',
        ANTHROPIC_API_KEY: 'test',
        REDIS_URL: 'redis://localhost:6379',
      },
      pingRedis: async () => 1,
      getQueueStats: async () => ({ pending: 0, active: 1, failed: 0 }),
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'Queue status')!

    expect(check.status).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// Vector Store
// ---------------------------------------------------------------------------

describe('doctor — Vector Store', () => {
  it('passes when vector store is healthy', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'x' },
      pingVectorStore: async () => ({ provider: 'qdrant', healthy: true, latencyMs: 8 }),
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'Vector store')!

    expect(check.status).toBe('pass')
    expect(check.message).toContain('8ms')
    expect(check.name).toContain('qdrant')
  })

  it('fails when vector store is unhealthy', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'x' },
      pingVectorStore: async () => ({ provider: 'qdrant', healthy: false, latencyMs: 5000 }),
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'Vector store')!

    expect(check.status).toBe('fail')
  })

  it('warns when no vector store probe is provided', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'x' },
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'Vector store')!

    expect(check.status).toBe('warn')
  })
})

// ---------------------------------------------------------------------------
// Telemetry Wiring
// ---------------------------------------------------------------------------

describe('doctor — Telemetry Wiring', () => {
  it('warns when OTEL endpoint is not configured', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'x' },
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'OTEL endpoint')!

    expect(check.status).toBe('warn')
    expect(check.message).toContain('disabled')
  })

  it('passes when OTEL endpoint is set', async () => {
    const ctx: DoctorContext = {
      env: {
        DATABASE_URL: 'x',
        ANTHROPIC_API_KEY: 'x',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4317',
      },
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'OTEL endpoint')!

    expect(check.status).toBe('pass')
    expect(check.message).toContain('4317')
  })

  it('checks OTEL reachability when probe is provided', async () => {
    const ctx: DoctorContext = {
      env: {
        DATABASE_URL: 'x',
        ANTHROPIC_API_KEY: 'x',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4317',
      },
      pingOtel: async () => true,
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'OTEL reachability')!

    expect(check.status).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// Memory Service
// ---------------------------------------------------------------------------

describe('doctor — Memory Service', () => {
  it('passes when memory is initialized with embedding provider', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'x' },
      pingMemory: async () => ({ initialized: true, embeddingProvider: 'openai' }),
    }
    const report = await runDoctor(ctx)
    const initCheck = findCheck(report, 'Memory initialization')!
    const embedCheck = findCheck(report, 'Embedding provider')!

    expect(initCheck.status).toBe('pass')
    expect(embedCheck.status).toBe('pass')
    expect(embedCheck.message).toContain('openai')
  })

  it('warns when no embedding provider is available', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'x' },
      pingMemory: async () => ({ initialized: true }),
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'Embedding provider')!

    expect(check.status).toBe('warn')
  })

  it('fails when memory service is not initialized', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'x' },
      pingMemory: async () => ({ initialized: false }),
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'Memory initialization')!

    expect(check.status).toBe('fail')
  })
})

// ---------------------------------------------------------------------------
// Security Posture
// ---------------------------------------------------------------------------

describe('doctor — Security Posture', () => {
  it('passes when auth is enabled and CORS is restricted', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'x' },
      authEnabled: true,
      corsOrigins: ['https://app.forge.dev'],
      auditTrailEnabled: true,
    }
    const report = await runDoctor(ctx)
    const cat = findCategory(report, 'Security Posture')!

    expect(cat.checks.every((c) => c.status === 'pass')).toBe(true)
  })

  it('warns when auth is disabled', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'x' },
      authEnabled: false,
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'API key auth')!

    expect(check.status).toBe('warn')
    expect(check.message).toContain('unprotected')
  })

  it('warns on wildcard CORS', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'x' },
      corsOrigins: '*',
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'CORS config')!

    expect(check.status).toBe('warn')
    expect(check.message).toContain('Wildcard')
  })

  it('includes fix for disabled auth with --fix', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'x' },
      authEnabled: false,
    }
    const report = await runDoctor(ctx, { fix: true })
    const check = findCheck(report, 'API key auth')!

    expect(check.fix).toBeDefined()
    expect(check.fix).toContain('auth.mode')
  })
})

// ---------------------------------------------------------------------------
// Package Versions
// ---------------------------------------------------------------------------

describe('doctor — Package Versions', () => {
  it('reports all packages and detects version consistency', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'x' },
      getPackageVersions: async () => ({
        '@dzipagent/core': '0.1.0',
        '@dzipagent/agent': '0.1.0',
        '@dzipagent/server': '0.1.0',
      }),
    }
    const report = await runDoctor(ctx)
    const cat = findCategory(report, 'Package Versions')!

    expect(cat.checks.length).toBe(4) // 3 packages + consistency
    expect(cat.checks.every((c) => c.status === 'pass')).toBe(true)
  })

  it('warns on mixed versions', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'x' },
      getPackageVersions: async () => ({
        '@dzipagent/core': '0.1.0',
        '@dzipagent/agent': '0.2.0',
      }),
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, 'Version consistency')!

    expect(check.status).toBe('warn')
    expect(check.message).toContain('Mixed')
  })

  it('falls back to self-version when no probe provided', async () => {
    const ctx: DoctorContext = {
      env: { DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'x' },
    }
    const report = await runDoctor(ctx)
    const check = findCheck(report, '@dzipagent/server')!

    expect(check.status).toBe('pass')
    expect(check.message).toContain('0.1.0')
  })
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

describe('doctor — Summary', () => {
  it('computes correct summary totals', async () => {
    const ctx: DoctorContext = {
      env: {
        DATABASE_URL: 'postgres://localhost/forge',
        ANTHROPIC_API_KEY: 'sk-ant-test',
      },
    }
    const report = await runDoctor(ctx)

    const { passed, warnings, failures, total } = report.summary
    expect(total).toBe(passed + warnings + failures)
    expect(total).toBeGreaterThan(0)
  })

  it('includes a timestamp', async () => {
    const report = await runDoctor({ env: {} })
    expect(report.timestamp).toBeTruthy()
    expect(() => new Date(report.timestamp)).not.toThrow()
  })

  it('has all expected categories', async () => {
    const report = await runDoctor({
      env: { DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'x' },
    })
    const names = report.categories.map((c) => c.category)

    expect(names).toContain('Environment')
    expect(names).toContain('Model Configuration')
    expect(names).toContain('Database Health')
    expect(names).toContain('Queue Backend')
    expect(names).toContain('Vector Store')
    expect(names).toContain('Telemetry Wiring')
    expect(names).toContain('Memory Service')
    expect(names).toContain('Security Posture')
    expect(names).toContain('Package Versions')
  })
})

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

describe('doctor — Output Formatting', () => {
  it('formatDoctorReport produces ANSI-colored terminal output', async () => {
    const report = await runDoctor({
      env: {
        DATABASE_URL: 'postgres://localhost/forge',
        ANTHROPIC_API_KEY: 'sk-ant-test',
      },
    })
    const output = formatDoctorReport(report)

    expect(output).toContain('DzipAgent Doctor')
    expect(output).toContain('[PASS]')
    expect(output).toContain('Summary')
    expect(output).toContain('passed')
  })

  it('formatDoctorReportJSON produces valid JSON', async () => {
    const report = await runDoctor({
      env: {
        DATABASE_URL: 'postgres://localhost/forge',
        ANTHROPIC_API_KEY: 'sk-ant-test',
      },
    })
    const json = formatDoctorReportJSON(report)
    const parsed: unknown = JSON.parse(json)

    expect(typeof parsed).toBe('object')
    expect((parsed as DoctorReport).summary).toBeDefined()
    expect((parsed as DoctorReport).categories).toBeInstanceOf(Array)
  })

  it('shows fix suggestions in formatted output', async () => {
    const report = await runDoctor({ env: {} }, { fix: true })
    const output = formatDoctorReport(report)

    expect(output).toContain('fix:')
  })

  it('shows success message when all checks pass', async () => {
    const ctx: DoctorContext = {
      env: {
        DATABASE_URL: 'postgres://localhost/forge',
        ANTHROPIC_API_KEY: 'sk-ant-test',
        OPENAI_API_KEY: 'sk-openai-test',
        REDIS_URL: 'redis://localhost:6379',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4317',
      },
      pingDatabase: async () => 3,
      checkMigrations: async () => true,
      pingRedis: async () => 1,
      getQueueStats: async () => ({ pending: 0, active: 0, failed: 0 }),
      pingVectorStore: async () => ({ provider: 'qdrant', healthy: true, latencyMs: 5 }),
      pingOtel: async () => true,
      pingMemory: async () => ({ initialized: true, embeddingProvider: 'openai' }),
      pingLLM: async () => 'claude-3-haiku',
      authEnabled: true,
      corsOrigins: ['https://app.forge.dev'],
      auditTrailEnabled: true,
      getPackageVersions: async () => ({
        '@dzipagent/core': '0.1.0',
        '@dzipagent/server': '0.1.0',
      }),
    }
    const report = await runDoctor(ctx)
    const output = formatDoctorReport(report)

    expect(report.summary.failures).toBe(0)
    expect(report.summary.warnings).toBe(0)
    expect(output).toContain('All checks passed')
  })
})

// ---------------------------------------------------------------------------
// Full integration scenario
// ---------------------------------------------------------------------------

describe('doctor — Integration', () => {
  it('runs a full diagnostic with all probes and produces a valid report', async () => {
    const ctx: DoctorContext = {
      env: {
        DATABASE_URL: 'postgres://localhost/forge',
        ANTHROPIC_API_KEY: 'sk-ant-test123456',
        OPENAI_API_KEY: 'sk-openai-test',
        REDIS_URL: 'redis://localhost:6379',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4317',
      },
      pingDatabase: async () => 4,
      checkMigrations: async () => true,
      pingRedis: async () => 2,
      getQueueStats: async () => ({ pending: 3, active: 1, failed: 0 }),
      pingVectorStore: async () => ({ provider: 'qdrant', healthy: true, latencyMs: 10 }),
      pingOtel: async () => true,
      pingMemory: async () => ({ initialized: true, embeddingProvider: 'voyage' }),
      pingLLM: async (provider) => provider === 'anthropic' ? 'claude-3-haiku' : 'gpt-4o',
      authEnabled: true,
      corsOrigins: ['https://forge.dev'],
      auditTrailEnabled: true,
      getPackageVersions: async () => ({
        '@dzipagent/core': '0.1.0',
        '@dzipagent/agent': '0.1.0',
        '@dzipagent/server': '0.1.0',
        '@dzipagent/memory': '0.1.0',
      }),
    }

    const report = await runDoctor(ctx)

    // All checks should pass
    expect(report.summary.failures).toBe(0)
    expect(report.summary.warnings).toBe(0)
    expect(report.summary.passed).toBeGreaterThan(10)
    expect(report.categories.length).toBe(9)

    // JSON output should be valid
    const json = formatDoctorReportJSON(report)
    expect(() => JSON.parse(json)).not.toThrow()

    // Terminal output should be non-empty
    const terminal = formatDoctorReport(report)
    expect(terminal.length).toBeGreaterThan(100)
  })

  it('handles a degraded system gracefully', async () => {
    const ctx: DoctorContext = {
      env: {
        DATABASE_URL: 'postgres://localhost/forge',
        // No LLM key
      },
      pingDatabase: async () => { throw new Error('timeout') },
      authEnabled: false,
      corsOrigins: '*',
    }

    const report = await runDoctor(ctx)

    expect(report.summary.failures).toBeGreaterThan(0)
    expect(report.summary.warnings).toBeGreaterThan(0)

    const output = formatDoctorReport(report)
    expect(output).toContain('[FAIL]')
    expect(output).toContain('[WARN]')
    expect(output).toContain('Fix the issues')
  })
})
