/**
 * Health aggregator for DzipAgent.
 *
 * Collects health status from multiple subsystems (providers, stores,
 * MCP connections) and produces a unified health report.
 */

export type HealthStatus = 'ok' | 'degraded' | 'error' | 'unconfigured'

export interface HealthCheck {
  name: string
  status: HealthStatus
  latencyMs?: number
  message?: string
  metadata?: Record<string, unknown>
}

export interface HealthReport {
  status: HealthStatus
  checks: HealthCheck[]
  timestamp: string
  uptime: number
}

export type HealthCheckFn = () => Promise<HealthCheck>

export class HealthAggregator {
  private checks: HealthCheckFn[] = []
  private readonly startTime = Date.now()

  /** Register a named health check function */
  register(checkFn: HealthCheckFn): void {
    this.checks.push(checkFn)
  }

  /** Run all health checks and produce an aggregated report */
  async check(): Promise<HealthReport> {
    const results = await Promise.allSettled(
      this.checks.map(fn => fn()),
    )

    const checks: HealthCheck[] = results.map((result, i) => {
      if (result.status === 'fulfilled') {
        return result.value
      }
      return {
        name: `check-${i}`,
        status: 'error' as HealthStatus,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      }
    })

    // Overall status: error if any critical check failed, degraded if any non-critical failed
    let status: HealthStatus = 'ok'
    for (const check of checks) {
      if (check.status === 'error') {
        status = 'error'
        break
      }
      if (check.status === 'degraded') {
        status = 'degraded'
      }
    }

    return {
      status,
      checks,
      timestamp: new Date().toISOString(),
      uptime: Date.now() - this.startTime,
    }
  }
}
