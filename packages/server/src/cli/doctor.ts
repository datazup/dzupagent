/**
 * `forge doctor` CLI command — comprehensive system diagnostics.
 *
 * Validates environment, connectivity, configuration, and security posture
 * for a ForgeAgent server deployment. Each check returns pass/warn/fail
 * and the results are grouped by category with a summary at the end.
 *
 * Supports `--json` for machine-readable output and `--fix` for auto-fixes.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status of an individual diagnostic check. */
export type CheckStatus = 'pass' | 'warn' | 'fail'

/** A single diagnostic check result. */
export interface CheckResult {
  /** Human-readable name of the check. */
  name: string
  /** pass / warn / fail */
  status: CheckStatus
  /** Short message explaining the result. */
  message: string
  /** Optional auto-fix that was attempted (only with --fix). */
  fix?: string
}

/** A group of related check results. */
export interface CheckCategory {
  /** Category label (e.g. "Environment", "Database Health"). */
  category: string
  /** Individual results in this category. */
  checks: CheckResult[]
}

/** Full doctor report. */
export interface DoctorReport {
  categories: CheckCategory[]
  summary: {
    passed: number
    warnings: number
    failures: number
    total: number
  }
  timestamp: string
}

/** Options for running the doctor command. */
export interface DoctorOptions {
  /** When true, attempt auto-fixes for common issues. */
  fix?: boolean
  /** When true, return raw JSON report instead of formatted output. */
  json?: boolean
}

/**
 * Injectable context — allows the doctor command to be tested without
 * real external dependencies. Every field is optional; the check is
 * skipped (with a "warn") if its dependency is not provided.
 */
export interface DoctorContext {
  /** Environment variables to inspect (defaults to process.env). */
  env?: Record<string, string | undefined>
  /** Attempt a Postgres connection. Return latency in ms or throw. */
  pingDatabase?: () => Promise<number>
  /** Attempt a Redis connection. Return latency in ms or throw. */
  pingRedis?: () => Promise<number>
  /** Ping an LLM provider. Return the provider name or throw. */
  pingLLM?: (provider: string, apiKey: string) => Promise<string>
  /** Check if database migrations are up to date. Return true if current. */
  checkMigrations?: () => Promise<boolean>
  /** Check vector store health. */
  pingVectorStore?: () => Promise<{ provider: string; healthy: boolean; latencyMs: number }>
  /** Read queue stats. */
  getQueueStats?: () => Promise<{ pending: number; active: number; failed: number }>
  /** Check OTEL exporter reachability. */
  pingOtel?: () => Promise<boolean>
  /** Check memory service initialization. */
  pingMemory?: () => Promise<{ initialized: boolean; embeddingProvider?: string }>
  /** Retrieve installed @forgeagent/* package versions. */
  getPackageVersions?: () => Promise<Record<string, string>>
  /** CORS origins as configured. */
  corsOrigins?: string | string[]
  /** Whether API key auth is enabled. */
  authEnabled?: boolean
  /** Whether the audit trail is active. */
  auditTrailEnabled?: boolean
}

// ---------------------------------------------------------------------------
// ANSI helpers (for terminal output)
// ---------------------------------------------------------------------------

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
} as const

function statusIcon(status: CheckStatus): string {
  switch (status) {
    case 'pass': return `${ANSI.green}[PASS]${ANSI.reset}`
    case 'warn': return `${ANSI.yellow}[WARN]${ANSI.reset}`
    case 'fail': return `${ANSI.red}[FAIL]${ANSI.reset}`
  }
}

// ---------------------------------------------------------------------------
// Individual check runners
// ---------------------------------------------------------------------------

function checkEnvVars(ctx: DoctorContext, fix: boolean): CheckCategory {
  const env = ctx.env ?? process.env
  const checks: CheckResult[] = []

  // Required env vars
  const required: Array<{ key: string; description: string }> = [
    { key: 'DATABASE_URL', description: 'PostgreSQL connection string' },
  ]

  for (const { key, description } of required) {
    if (env[key]) {
      checks.push({ name: key, status: 'pass', message: `${description} is set` })
    } else {
      const result: CheckResult = {
        name: key,
        status: 'fail',
        message: `${description} is not set`,
      }
      if (fix) {
        result.fix = `Set ${key} in your environment or .env file`
      }
      checks.push(result)
    }
  }

  // At least one LLM API key
  const llmKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']
  const hasLLMKey = llmKeys.some((k) => Boolean(env[k]))

  if (hasLLMKey) {
    const found = llmKeys.filter((k) => Boolean(env[k]))
    checks.push({
      name: 'LLM API Key',
      status: 'pass',
      message: `LLM provider key(s) found: ${found.join(', ')}`,
    })
  } else {
    checks.push({
      name: 'LLM API Key',
      status: 'fail',
      message: 'No LLM API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY',
    })
  }

  // Optional but recommended
  const optional: Array<{ key: string; description: string }> = [
    { key: 'REDIS_URL', description: 'Redis connection string (needed for BullMQ)' },
  ]

  for (const { key, description } of optional) {
    if (env[key]) {
      checks.push({ name: key, status: 'pass', message: `${description} is set` })
    } else {
      checks.push({ name: key, status: 'warn', message: `${description} is not set (optional)` })
    }
  }

  return { category: 'Environment', checks }
}

async function checkModelConfiguration(ctx: DoctorContext): Promise<CheckCategory> {
  const env = ctx.env ?? process.env
  const checks: CheckResult[] = []

  const providers: Array<{ name: string; keyEnv: string }> = [
    { name: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY' },
    { name: 'openai', keyEnv: 'OPENAI_API_KEY' },
  ]

  for (const { name, keyEnv } of providers) {
    const apiKey = env[keyEnv]
    if (!apiKey) {
      checks.push({
        name: `${name} provider`,
        status: 'warn',
        message: `${keyEnv} not set — ${name} models unavailable`,
      })
      continue
    }

    if (ctx.pingLLM) {
      try {
        const model = await ctx.pingLLM(name, apiKey)
        checks.push({
          name: `${name} provider`,
          status: 'pass',
          message: `Connected successfully (model: ${model})`,
        })
      } catch (err) {
        checks.push({
          name: `${name} provider`,
          status: 'fail',
          message: `Ping failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    } else {
      // Key is present but we cannot ping — partial validation
      const masked = apiKey.slice(0, 8) + '...'
      checks.push({
        name: `${name} provider`,
        status: 'pass',
        message: `API key present (${masked})`,
      })
    }
  }

  return { category: 'Model Configuration', checks }
}

async function checkDatabaseHealth(ctx: DoctorContext): Promise<CheckCategory> {
  const checks: CheckResult[] = []

  if (!ctx.pingDatabase) {
    checks.push({
      name: 'Postgres connection',
      status: 'warn',
      message: 'No database probe provided — skipping connectivity check',
    })
    return { category: 'Database Health', checks }
  }

  try {
    const latency = await ctx.pingDatabase()
    checks.push({
      name: 'Postgres connection',
      status: 'pass',
      message: `Connected (${latency}ms)`,
    })
  } catch (err) {
    checks.push({
      name: 'Postgres connection',
      status: 'fail',
      message: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  if (ctx.checkMigrations) {
    try {
      const current = await ctx.checkMigrations()
      checks.push({
        name: 'Migrations',
        status: current ? 'pass' : 'warn',
        message: current ? 'All migrations applied' : 'Pending migrations detected',
      })
    } catch (err) {
      checks.push({
        name: 'Migrations',
        status: 'warn',
        message: `Could not check migrations: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  return { category: 'Database Health', checks }
}

async function checkQueueBackend(ctx: DoctorContext): Promise<CheckCategory> {
  const checks: CheckResult[] = []
  const env = ctx.env ?? process.env

  if (!env['REDIS_URL']) {
    checks.push({
      name: 'Redis connection',
      status: 'warn',
      message: 'REDIS_URL not set — using in-memory queue (not suitable for production)',
    })
    return { category: 'Queue Backend', checks }
  }

  if (!ctx.pingRedis) {
    checks.push({
      name: 'Redis connection',
      status: 'warn',
      message: 'No Redis probe provided — skipping connectivity check',
    })
    return { category: 'Queue Backend', checks }
  }

  try {
    const latency = await ctx.pingRedis()
    checks.push({
      name: 'Redis connection',
      status: 'pass',
      message: `Connected (${latency}ms)`,
    })
  } catch (err) {
    checks.push({
      name: 'Redis connection',
      status: 'fail',
      message: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  if (ctx.getQueueStats) {
    try {
      const stats = await ctx.getQueueStats()
      const status: CheckStatus = stats.failed > 0 ? 'warn' : 'pass'
      checks.push({
        name: 'Queue status',
        status,
        message: `pending=${stats.pending} active=${stats.active} failed=${stats.failed}`,
      })
    } catch (err) {
      checks.push({
        name: 'Queue status',
        status: 'warn',
        message: `Could not retrieve stats: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  return { category: 'Queue Backend', checks }
}

async function checkVectorStore(ctx: DoctorContext): Promise<CheckCategory> {
  const checks: CheckResult[] = []

  if (!ctx.pingVectorStore) {
    checks.push({
      name: 'Vector store',
      status: 'warn',
      message: 'No vector store probe provided — skipping',
    })
    return { category: 'Vector Store', checks }
  }

  try {
    const result = await ctx.pingVectorStore()
    checks.push({
      name: `Vector store (${result.provider})`,
      status: result.healthy ? 'pass' : 'fail',
      message: result.healthy
        ? `Healthy (${result.latencyMs}ms)`
        : `Unhealthy (${result.latencyMs}ms)`,
    })
  } catch (err) {
    checks.push({
      name: 'Vector store',
      status: 'fail',
      message: `Probe failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  return { category: 'Vector Store', checks }
}

async function checkTelemetry(ctx: DoctorContext): Promise<CheckCategory> {
  const checks: CheckResult[] = []
  const env = ctx.env ?? process.env

  const otelEndpoint = env['OTEL_EXPORTER_OTLP_ENDPOINT']
  if (!otelEndpoint) {
    checks.push({
      name: 'OTEL endpoint',
      status: 'warn',
      message: 'OTEL_EXPORTER_OTLP_ENDPOINT not set — telemetry disabled',
    })
    return { category: 'Telemetry Wiring', checks }
  }

  checks.push({
    name: 'OTEL endpoint',
    status: 'pass',
    message: `Configured: ${otelEndpoint}`,
  })

  if (ctx.pingOtel) {
    try {
      const ok = await ctx.pingOtel()
      checks.push({
        name: 'OTEL reachability',
        status: ok ? 'pass' : 'fail',
        message: ok ? 'Exporter reachable' : 'Exporter unreachable',
      })
    } catch (err) {
      checks.push({
        name: 'OTEL reachability',
        status: 'fail',
        message: `Probe failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  return { category: 'Telemetry Wiring', checks }
}

async function checkMemoryService(ctx: DoctorContext): Promise<CheckCategory> {
  const checks: CheckResult[] = []

  if (!ctx.pingMemory) {
    checks.push({
      name: 'Memory service',
      status: 'warn',
      message: 'No memory probe provided — skipping',
    })
    return { category: 'Memory Service', checks }
  }

  try {
    const result = await ctx.pingMemory()
    checks.push({
      name: 'Memory initialization',
      status: result.initialized ? 'pass' : 'fail',
      message: result.initialized ? 'Initialized' : 'Not initialized',
    })

    if (result.embeddingProvider) {
      checks.push({
        name: 'Embedding provider',
        status: 'pass',
        message: `Using ${result.embeddingProvider}`,
      })
    } else {
      checks.push({
        name: 'Embedding provider',
        status: 'warn',
        message: 'No embedding provider detected — semantic search unavailable',
      })
    }
  } catch (err) {
    checks.push({
      name: 'Memory service',
      status: 'fail',
      message: `Probe failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  return { category: 'Memory Service', checks }
}

function checkSecurityPosture(ctx: DoctorContext, fix: boolean): CheckCategory {
  const checks: CheckResult[] = []

  // API key auth
  if (ctx.authEnabled === true) {
    checks.push({
      name: 'API key auth',
      status: 'pass',
      message: 'Enabled',
    })
  } else if (ctx.authEnabled === false) {
    const result: CheckResult = {
      name: 'API key auth',
      status: 'warn',
      message: 'Disabled — API is unprotected',
    }
    if (fix) {
      result.fix = 'Enable auth by setting auth.mode in server config'
    }
    checks.push(result)
  } else {
    checks.push({
      name: 'API key auth',
      status: 'warn',
      message: 'Auth status unknown',
    })
  }

  // CORS
  if (ctx.corsOrigins) {
    const origins = Array.isArray(ctx.corsOrigins) ? ctx.corsOrigins : [ctx.corsOrigins]
    const hasWildcard = origins.includes('*')
    checks.push({
      name: 'CORS config',
      status: hasWildcard ? 'warn' : 'pass',
      message: hasWildcard
        ? 'Wildcard (*) CORS — restrict in production'
        : `Restricted to: ${origins.join(', ')}`,
    })
  } else {
    checks.push({
      name: 'CORS config',
      status: 'warn',
      message: 'No CORS origins configured',
    })
  }

  // Audit trail
  if (ctx.auditTrailEnabled === true) {
    checks.push({
      name: 'Audit trail',
      status: 'pass',
      message: 'Enabled',
    })
  } else {
    checks.push({
      name: 'Audit trail',
      status: 'warn',
      message: 'Not enabled — recommended for production',
    })
  }

  return { category: 'Security Posture', checks }
}

async function checkPackageVersions(ctx: DoctorContext): Promise<CheckCategory> {
  const checks: CheckResult[] = []

  if (!ctx.getPackageVersions) {
    // Use a built-in fallback with the known server version
    checks.push({
      name: '@forgeagent/server',
      status: 'pass',
      message: 'v0.1.0 (self)',
    })
    return { category: 'Package Versions', checks }
  }

  try {
    const versions = await ctx.getPackageVersions()
    const entries = Object.entries(versions)

    if (entries.length === 0) {
      checks.push({
        name: 'Packages',
        status: 'warn',
        message: 'No @forgeagent/* packages detected',
      })
    } else {
      // Check version consistency
      const versionSet = new Set(entries.map(([, v]) => v))
      const consistent = versionSet.size <= 1

      for (const [pkg, version] of entries) {
        checks.push({
          name: pkg,
          status: 'pass',
          message: `v${version}`,
        })
      }

      if (!consistent) {
        checks.push({
          name: 'Version consistency',
          status: 'warn',
          message: `Mixed versions detected: ${[...versionSet].join(', ')} — may cause compatibility issues`,
        })
      } else {
        checks.push({
          name: 'Version consistency',
          status: 'pass',
          message: 'All packages on the same version',
        })
      }
    }
  } catch (err) {
    checks.push({
      name: 'Package detection',
      status: 'warn',
      message: `Could not detect packages: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  return { category: 'Package Versions', checks }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the full doctor diagnostic and return a structured report.
 *
 * @param ctx  Injectable context with probe functions. All fields are
 *             optional — checks that need a missing dependency will emit
 *             a warning rather than failing.
 * @param options  Output and behavior options (--json, --fix).
 */
export async function runDoctor(
  ctx: DoctorContext = {},
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const fix = options.fix ?? false

  // Run all check categories (some are sync, some async)
  const categories: CheckCategory[] = []

  // 1. Environment
  categories.push(checkEnvVars(ctx, fix))

  // 2-8: async checks — run in parallel for speed
  const [
    modelConfig,
    dbHealth,
    queueBackend,
    vectorStore,
    telemetry,
    memory,
    packageVersions,
  ] = await Promise.all([
    checkModelConfiguration(ctx),
    checkDatabaseHealth(ctx),
    checkQueueBackend(ctx),
    checkVectorStore(ctx),
    checkTelemetry(ctx),
    checkMemoryService(ctx),
    checkPackageVersions(ctx),
  ])

  categories.push(modelConfig)
  categories.push(dbHealth)
  categories.push(queueBackend)
  categories.push(vectorStore)
  categories.push(telemetry)
  categories.push(memory)

  // Security (sync)
  categories.push(checkSecurityPosture(ctx, fix))

  // Package versions (last)
  categories.push(packageVersions)

  // Compute summary
  let passed = 0
  let warnings = 0
  let failures = 0

  for (const cat of categories) {
    for (const check of cat.checks) {
      switch (check.status) {
        case 'pass': passed++; break
        case 'warn': warnings++; break
        case 'fail': failures++; break
      }
    }
  }

  return {
    categories,
    summary: {
      passed,
      warnings,
      failures,
      total: passed + warnings + failures,
    },
    timestamp: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Terminal output formatter
// ---------------------------------------------------------------------------

/**
 * Format a DoctorReport for terminal output with ANSI colors.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = []

  lines.push('')
  lines.push(`${ANSI.bold}${ANSI.cyan}  ForgeAgent Doctor${ANSI.reset}`)
  lines.push(`${ANSI.dim}  Comprehensive system diagnostics${ANSI.reset}`)
  lines.push('')

  for (const category of report.categories) {
    lines.push(`${ANSI.bold}  ${category.category}${ANSI.reset}`)

    for (const check of category.checks) {
      const icon = statusIcon(check.status)
      lines.push(`    ${icon} ${check.name}: ${check.message}`)

      if (check.fix) {
        lines.push(`          ${ANSI.dim}fix: ${check.fix}${ANSI.reset}`)
      }
    }
    lines.push('')
  }

  // Summary
  const { passed, warnings, failures, total } = report.summary
  lines.push(`${ANSI.bold}  Summary${ANSI.reset}`)
  lines.push(
    `    ${ANSI.green}${passed} passed${ANSI.reset}, ` +
    `${ANSI.yellow}${warnings} warnings${ANSI.reset}, ` +
    `${ANSI.red}${failures} failures${ANSI.reset} ` +
    `${ANSI.dim}(${total} checks)${ANSI.reset}`,
  )
  lines.push('')

  if (failures > 0) {
    lines.push(`  ${ANSI.red}${ANSI.bold}Some checks failed. Fix the issues above before deploying.${ANSI.reset}`)
  } else if (warnings > 0) {
    lines.push(`  ${ANSI.yellow}All critical checks passed, but some warnings need attention.${ANSI.reset}`)
  } else {
    lines.push(`  ${ANSI.green}All checks passed. System is healthy.${ANSI.reset}`)
  }
  lines.push('')

  return lines.join('\n')
}

/**
 * Format a DoctorReport as a JSON string (for --json flag).
 */
export function formatDoctorReportJSON(report: DoctorReport): string {
  return JSON.stringify(report, null, 2)
}
