/**
 * Asynchronous connectivity checks for `forge doctor`.
 *
 * These require optional probe functions on the {@link DoctorContext} —
 * if a probe is missing, the check emits a `warn` rather than failing.
 *
 * Covers Postgres, Redis/queue backend, vector store, and OTEL telemetry.
 */

import type { CheckCategory, CheckResult, CheckStatus, DoctorContext } from './doctor-types.js'

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** Probe Postgres connectivity and migration state. */
export async function checkDatabaseHealth(ctx: DoctorContext): Promise<CheckCategory> {
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

// ---------------------------------------------------------------------------
// Queue backend (Redis / BullMQ)
// ---------------------------------------------------------------------------

/** Probe Redis connectivity and BullMQ queue stats. */
export async function checkQueueBackend(ctx: DoctorContext): Promise<CheckCategory> {
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

// ---------------------------------------------------------------------------
// Vector store
// ---------------------------------------------------------------------------

/** Probe the configured vector store provider. */
export async function checkVectorStore(ctx: DoctorContext): Promise<CheckCategory> {
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

// ---------------------------------------------------------------------------
// Telemetry / OTEL
// ---------------------------------------------------------------------------

/** Validate OTEL endpoint configuration and reachability. */
export async function checkTelemetry(ctx: DoctorContext): Promise<CheckCategory> {
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
