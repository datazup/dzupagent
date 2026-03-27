/**
 * Result of a health check against a remote endpoint.
 */
export interface HealthCheckResult {
  healthy: boolean
  statusCode?: number
  error?: string
}

const DEFAULT_TIMEOUT_MS = 5000

/**
 * Check the health of a deployed service by hitting its health endpoint.
 *
 * Returns healthy=true if the endpoint responds with a 2xx status code
 * within the specified timeout.
 */
export async function checkHealth(
  url: string,
  timeoutMs?: number,
): Promise<HealthCheckResult> {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    })

    clearTimeout(timer)

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
