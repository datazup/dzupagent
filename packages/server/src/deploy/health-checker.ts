/**
 * Result of a health check against a remote endpoint.
 */
import { fetchWithOutboundUrlPolicy, type OutboundUrlSecurityPolicy } from '@dzupagent/core/security'

export interface HealthCheckResult {
  healthy: boolean
  statusCode?: number
  error?: string
}

export interface HealthCheckOptions {
  /**
   * Outbound URL policy for the probe. When omitted, the configured endpoint
   * host is treated as deployment-owned for compatibility with internal health
   * checks; redirects are still revalidated against the shared policy.
   */
  urlPolicy?: OutboundUrlSecurityPolicy
}

const DEFAULT_TIMEOUT_MS = 5000

function defaultProbePolicy(url: string, explicit?: OutboundUrlSecurityPolicy): OutboundUrlSecurityPolicy | undefined {
  if (explicit !== undefined) return explicit
  try {
    const parsed = new URL(url)
    return { allowedHosts: [parsed.host] }
  } catch {
    return undefined
  }
}

/**
 * Check the health of a deployed service by hitting its health endpoint.
 *
 * Returns healthy=true if the endpoint responds with a 2xx status code
 * within the specified timeout.
 */
export async function checkHealth(
  url: string,
  timeoutMs?: number,
  options: HealthCheckOptions = {},
): Promise<HealthCheckResult> {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    let response: Response
    try {
      response = await fetchWithOutboundUrlPolicy(url, {
        method: 'GET',
        signal: controller.signal,
      }, {
        policy: defaultProbePolicy(url, options.urlPolicy),
      })
    } finally {
      clearTimeout(timer)
    }

    const healthy = response.status >= 200 && response.status < 300

    return {
      healthy,
      statusCode: response.status,
      error: healthy ? undefined : `Unexpected status: ${response.status}`,
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { healthy: false, error: `Timeout after ${timeout}ms` }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { healthy: false, error: message }
  }
}
