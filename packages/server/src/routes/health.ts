/**
 * Health check routes.
 *
 * GET /api/health         — Liveness probe (always 200)
 * GET /api/health/ready   — Readiness probe (checks DB, providers, MCP).
 *                           Per-check status only unless
 *                           `exposeReadinessDetails` is set.
 * GET /api/health/metrics — Metrics endpoint (JSON format). Mounted only when
 *                           `prometheusMetrics.access` is configured and not
 *                           `disabled`, behind the same access guard as
 *                           `/metrics` (DZUPAGENT-SEC-H-21): the `/api/health`
 *                           prefix is exempt from auth, so the guard is the
 *                           only thing protecting it.
 */
import { Hono } from 'hono'
import { secureLogger } from '@dzupagent/core/utils'
import type { AppEnv } from '../types.js'
import type { ForgeServerConfig } from '../composition/types.js'
import { createMetricsAccessGuard } from './metrics.js'

const startTime = Date.now()

/** Default bound on each readiness store check (DZUPAGENT-ERR-H-73). */
export const DEFAULT_READINESS_CHECK_TIMEOUT_MS = 2_000

export interface HealthRouteOptions {
  /** Per-check timeout for the readiness store probes. */
  readinessCheckTimeoutMs?: number
}

interface ReadinessCheck {
  status: string
  latencyMs?: number
  metadata?: Record<string, unknown>
}

function errorClassOf(err: unknown): string {
  if (err instanceof Error) return err.name || err.constructor.name
  return typeof err
}

/**
 * Run one readiness store probe, raced against `timeoutMs`. A failure or a
 * timeout is logged once with the subsystem and the error class — never the
 * message, which can carry connection strings — and both outcomes record
 * latency so on-call can tell a slow store from a broken one.
 */
async function probeSubsystem(
  subsystem: string,
  probe: () => Promise<unknown>,
  timeoutMs: number,
): Promise<ReadinessCheck> {
  const start = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    const outcome = await Promise.race([probe().then(() => 'ok' as const), timedOut])
    const latencyMs = Date.now() - start
    if (outcome === 'timeout') {
      secureLogger.warn({
        operation: 'health.ready.check_timeout',
        subsystem,
        timeoutMs,
        latencyMs,
      })
      return { status: 'timeout', latencyMs }
    }
    return { status: 'ok', latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - start
    secureLogger.error({
      operation: 'health.ready.check_failed',
      subsystem,
      errorClass: errorClassOf(err),
      latencyMs,
    })
    return { status: 'error', latencyMs }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createHealthRoutes(
  config: ForgeServerConfig,
  options: HealthRouteOptions = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const checkTimeoutMs = options.readinessCheckTimeoutMs ?? DEFAULT_READINESS_CHECK_TIMEOUT_MS

  // Liveness — always healthy if the process is running
  app.get('/', (c) => {
    return c.json({
      status: 'ok',
      version: '0.1.0',
      uptime: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    })
  })

  // Readiness — check all subsystems
  app.get('/ready', async (c) => {
    const checks: Record<string, ReadinessCheck> = {}

    // Run store and agent store, each bounded and logged on failure.
    const [runStoreCheck, agentStoreCheck] = await Promise.all([
      probeSubsystem('runStore', () => config.runStore.list({ limit: 1 }), checkTimeoutMs),
      probeSubsystem('agentStore', () => config.agentStore.list({ limit: 1 }), checkTimeoutMs),
    ])
    checks['runStore'] = runStoreCheck
    checks['agentStore'] = agentStoreCheck

    // Check model registry — include per-provider circuit breaker status
    const providerHealth = config.modelRegistry.getProviderHealth()
    const providerEntries = Object.entries(providerHealth) as Array<[string, { state: string; provider: string }]>
    const providerCount = providerEntries.length
    const healthyProviders = providerEntries.filter(([, p]) => p.state === 'closed').length

    checks['modelRegistry'] = {
      status: providerCount === 0
        ? 'unconfigured'
        : healthyProviders === providerCount
          ? 'ok'
          : healthyProviders > 0
            ? 'degraded'
            : 'error',
      metadata: {
        providers: providerHealth,
        total: providerCount,
        healthy: healthyProviders,
      },
    }

    // Check run queue if available
    if (config.runQueue) {
      const stats = config.runQueue.stats()
      checks['runQueue'] = {
        status: 'ok',
        metadata: {
          pending: stats.pending,
          active: stats.active,
          completed: stats.completed,
          failed: stats.failed,
        },
      }
    }

    // Check graceful shutdown state
    if (config.shutdown) {
      const state = config.shutdown.getState()
      checks['shutdown'] = {
        status: state === 'running' ? 'ok' : state === 'draining' ? 'degraded' : 'error',
        metadata: { state },
      }
    }

    // Determine overall status
    const storeHealthy = checks['runStore']?.status === 'ok' && checks['agentStore']?.status === 'ok'
    const hasError = Object.values(checks).some(c => c.status === 'error' || c.status === 'timeout')
    const hasDegraded = Object.values(checks).some(c => c.status === 'degraded')

    const status = hasError ? 'error' : !storeHealthy ? 'degraded' : hasDegraded ? 'degraded' : 'ok'

    const code = status === 'ok' ? 200 : 503
    const timestamp = new Date().toISOString()
    if (config.exposeReadinessDetails === true) {
      return c.json({ status, checks, uptime: Date.now() - startTime, timestamp }, code)
    }
    // DZUPAGENT-SEC-H-21 — this path is auth-exempt for probes, so by default
    // it reveals per-check status only: no latencies, provider circuit
    // state, queue counts or shutdown state.
    const statusOnly = Object.fromEntries(
      Object.entries(checks).map(([name, check]) => [name, { status: check.status }]),
    )
    return c.json({ status, checks: statusOnly, timestamp }, code)
  })

  // Metrics — JSON format (can be scraped by Prometheus with adapter).
  // DZUPAGENT-SEC-H-21: same access control as `/metrics`; absent or
  // `disabled` access leaves the path unmounted (404).
  const metricsAccess = config.prometheusMetrics?.access
  if (metricsAccess && metricsAccess.mode !== 'disabled') {
    const guard = createMetricsAccessGuard(metricsAccess)
    if (guard) {
      app.use('/metrics', guard)
    }
    app.get('/metrics', (c) => {
      const metrics = config.metrics?.toJSON() ?? []
      return c.json({
        metrics,
        timestamp: new Date().toISOString(),
      })
    })
  }

  return app
}
