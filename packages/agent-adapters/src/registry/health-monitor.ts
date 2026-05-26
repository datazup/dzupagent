/**
 * AdapterHealthMonitor — health and circuit-breaker bookkeeping for the
 * provider adapter registry.
 *
 * Owns:
 *  - per-adapter `CircuitBreaker` instances (delegated to via the keyed
 *    breaker primitive in `@dzupagent/core`).
 *  - last success / last failure timestamps.
 *  - consecutive-failure counters.
 *
 * Pure with respect to routing — emits no events directly. Callers (the
 * router and the registry facade) read its state via the public methods
 * and perform event-bus emission.
 */

import type { AdapterProviderId, AgentCLIAdapter, HealthStatus } from '../types.js'
import { getDefaultMonitorStatus } from '../provider-catalog.js'

export interface CircuitBreakerConfig {
  failureThreshold: number
  resetTimeout: number
  halfOpenMaxCalls: number
}

export type CircuitState = 'closed' | 'open' | 'half-open'

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeout: 60_000,
  halfOpenMaxCalls: 1,
}

class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failures = 0
  private lastFailureAt = 0
  private halfOpenCalls = 0
  private readonly config: CircuitBreakerConfig

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  canExecute(): boolean {
    if (this.state === 'closed') return true
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureAt >= this.config.resetTimeout) {
        this.state = 'half-open'
        this.halfOpenCalls = 0
      } else {
        return false
      }
    }
    if (this.halfOpenCalls >= this.config.halfOpenMaxCalls) return false
    this.halfOpenCalls += 1
    return true
  }

  recordSuccess(): void {
    this.state = 'closed'
    this.failures = 0
    this.halfOpenCalls = 0
  }

  recordFailure(): void {
    this.failures += 1
    this.lastFailureAt = Date.now()
    this.halfOpenCalls = 0
    if (this.state === 'half-open' || this.failures >= this.config.failureThreshold) {
      this.state = 'open'
    }
  }

  getState(): CircuitState {
    if (this.state === 'open' && Date.now() - this.lastFailureAt >= this.config.resetTimeout) {
      return 'half-open'
    }
    return this.state
  }
}

/** Detailed per-adapter health including circuit breaker diagnostics. */
export interface ProviderAdapterHealthDetail {
  healthy: boolean
  providerId: string
  sdkInstalled: boolean
  cliAvailable: boolean
  lastError?: string | undefined
  /** Circuit breaker state */
  circuitState: CircuitState
  /** Number of consecutive failures */
  consecutiveFailures: number
  /** Last successful execution timestamp */
  lastSuccessAt?: number | undefined
  /** Last failure timestamp */
  lastFailureAt?: number | undefined
  /** Optional artifact/config monitor status for this provider. */
  monitorStatus?: HealthStatus['monitorStatus'] | undefined
}

/** Aggregated detailed health status for all registered adapters. */
export interface ProviderAdapterRegistryHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy'
  adapters: Record<string, ProviderAdapterHealthDetail>
  timestamp: number
}

/** Outcome returned by `recordSuccess`/`recordFailure` so callers can emit events. */
export interface CircuitTransition {
  /** Circuit transitioned closed → open during this record call. */
  opened: boolean
  /** Circuit transitioned open|half-open → closed during this record call. */
  closed: boolean
}

export class AdapterHealthMonitor {
  private readonly breakers = new Map<AdapterProviderId, CircuitBreaker>()
  private readonly lastSuccess = new Map<AdapterProviderId, number>()
  private readonly lastFailure = new Map<AdapterProviderId, number>()
  private readonly consecutiveFailures = new Map<AdapterProviderId, number>()
  private readonly cbConfig: Partial<CircuitBreakerConfig> | undefined

  constructor(cbConfig?: Partial<CircuitBreakerConfig>) {
    this.cbConfig = cbConfig
  }

  /** Lazily create a breaker for the given provider id. */
  ensureBreaker(providerId: AdapterProviderId): CircuitBreaker {
    let breaker = this.breakers.get(providerId)
    if (!breaker) {
      breaker = new CircuitBreaker(this.cbConfig)
      this.breakers.set(providerId, breaker)
    }
    return breaker
  }

  /** Drop all bookkeeping for a provider that is being unregistered. */
  forget(providerId: AdapterProviderId): void {
    this.breakers.delete(providerId)
    this.lastSuccess.delete(providerId)
    this.lastFailure.delete(providerId)
    this.consecutiveFailures.delete(providerId)
  }

  /** Whether the breaker for `providerId` currently allows traffic. */
  canExecute(providerId: AdapterProviderId): boolean {
    const breaker = this.breakers.get(providerId)
    return !breaker || breaker.canExecute()
  }

  /** Current circuit state for diagnostics. */
  getCircuitState(providerId: AdapterProviderId): CircuitState {
    return this.breakers.get(providerId)?.getState() ?? 'closed'
  }

  /**
   * Record a successful execution. Returns a {@link CircuitTransition} so
   * the caller can emit the appropriate `provider:circuit_closed` event.
   */
  recordSuccess(providerId: AdapterProviderId): CircuitTransition {
    const breaker = this.ensureBreaker(providerId)
    const wasClosed = breaker.getState() === 'closed'
    breaker.recordSuccess()
    this.lastSuccess.set(providerId, Date.now())
    this.consecutiveFailures.set(providerId, 0)
    return { opened: false, closed: !wasClosed }
  }

  /**
   * Record a failed execution. Returns a {@link CircuitTransition} so
   * the caller can emit the appropriate `provider:circuit_opened` event.
   */
  recordFailure(providerId: AdapterProviderId): CircuitTransition {
    const breaker = this.ensureBreaker(providerId)
    const wasOpen = breaker.getState() === 'open'
    breaker.recordFailure()
    this.lastFailure.set(providerId, Date.now())
    this.consecutiveFailures.set(providerId, (this.consecutiveFailures.get(providerId) ?? 0) + 1)
    return { opened: !wasOpen && breaker.getState() === 'open', closed: false }
  }

  /** Health status for all registered adapters. */
  async getHealthStatus(
    adapters: ReadonlyMap<AdapterProviderId, AgentCLIAdapter>,
    disabled: ReadonlySet<AdapterProviderId>,
  ): Promise<Record<string, HealthStatus>> {
    const result: Record<string, HealthStatus> = {}

    const entries = [...adapters.entries()]
    const checks = await Promise.allSettled(
      entries.map(([id, adapter]) => adapter.healthCheck().then((h) => ({ id, health: h }))),
    )

    for (let i = 0; i < checks.length; i++) {
      const check = checks[i]!
      const entry = entries[i]
      if (check.status === 'fulfilled') {
        const { id, health } = check.value
        const healthWithMonitorStatus: HealthStatus = {
          ...health,
          monitorStatus: health.monitorStatus ?? getDefaultMonitorStatus(id),
        }
        if (disabled.has(id)) {
          result[id] = { ...healthWithMonitorStatus, healthy: false, lastError: 'disabled' }
        } else {
          result[id] = healthWithMonitorStatus
        }
      } else if (entry) {
        const [id] = entry
        result[id] = {
          healthy: false,
          providerId: id,
          sdkInstalled: false,
          cliAvailable: false,
          lastError: check.reason instanceof Error ? check.reason.message : String(check.reason),
          monitorStatus: getDefaultMonitorStatus(id),
        }
      }
    }

    return result
  }

  /**
   * Detailed health with circuit breaker state for each adapter.
   * Use for /health/detailed endpoints and Kubernetes readiness probes.
   */
  async getDetailedHealth(
    adapters: ReadonlyMap<AdapterProviderId, AgentCLIAdapter>,
    disabled: ReadonlySet<AdapterProviderId>,
  ): Promise<ProviderAdapterRegistryHealthStatus> {
    const basicHealth = await this.getHealthStatus(adapters, disabled)
    const detail: Record<string, ProviderAdapterHealthDetail> = {}

    let allHealthy = true
    let anyHealthy = false

    for (const [id, health] of Object.entries(basicHealth)) {
      const breaker = this.breakers.get(id as AdapterProviderId)
      const lastSuccessAt = this.lastSuccess.get(id as AdapterProviderId)
      const lastFailureAt = this.lastFailure.get(id as AdapterProviderId)
      const { lastError, ...healthWithoutLastError } = health
      detail[id] = {
        ...healthWithoutLastError,
        ...(lastError !== undefined ? { lastError } : {}),
        circuitState: breaker?.getState() ?? 'closed',
        consecutiveFailures: this.consecutiveFailures.get(id as AdapterProviderId) ?? 0,
        ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
        ...(lastFailureAt !== undefined ? { lastFailureAt } : {}),
      }
      if (health.healthy) anyHealthy = true
      else allHealthy = false
    }

    return {
      status: allHealthy ? 'healthy' : anyHealthy ? 'degraded' : 'unhealthy',
      adapters: detail,
      timestamp: Date.now(),
    }
  }
}
