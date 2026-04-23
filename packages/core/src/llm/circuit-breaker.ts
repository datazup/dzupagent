/**
 * Circuit breaker for LLM provider health tracking.
 *
 * States:
 * - CLOSED: normal operation, requests pass through
 * - OPEN: provider is failing, requests are rejected immediately
 * - HALF_OPEN: testing if provider has recovered (allow limited requests)
 *
 * Transitions:
 * - CLOSED → OPEN: when failureCount >= failureThreshold
 * - OPEN → HALF_OPEN: after resetTimeoutMs has elapsed
 * - HALF_OPEN → CLOSED: on success
 * - HALF_OPEN → OPEN: on failure
 */

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit (default: 3) */
  failureThreshold: number
  /** Time in ms to wait in OPEN state before transitioning to HALF_OPEN (default: 30_000) */
  resetTimeoutMs: number
  /** Max attempts allowed in HALF_OPEN state before re-opening (default: 1) */
  halfOpenMaxAttempts: number
  /**
   * Alias for `resetTimeoutMs` (orchestration-flavoured name). If both are
   * set, `resetTimeoutMs` takes precedence. Kept for compatibility with
   * the former `AgentCircuitBreaker` API.
   */
  cooldownMs?: number
}

export type CircuitState = 'closed' | 'open' | 'half-open'

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 1,
}

export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failureCount = 0
  private halfOpenAttempts = 0
  private lastFailureAt = 0
  private readonly config: CircuitBreakerConfig

  constructor(config?: Partial<CircuitBreakerConfig>) {
    // Honor `cooldownMs` as an alias for `resetTimeoutMs` when the caller
    // uses the orchestration-flavoured name. Explicit `resetTimeoutMs`
    // always wins.
    const merged: CircuitBreakerConfig = { ...DEFAULT_CONFIG, ...config }
    if (config?.cooldownMs !== undefined && config.resetTimeoutMs === undefined) {
      merged.resetTimeoutMs = config.cooldownMs
    }
    this.config = merged
  }

  /** Check if a request can proceed. Returns false if circuit is OPEN. */
  canExecute(): boolean {
    switch (this.state) {
      case 'closed':
        return true

      case 'open': {
        // Check if enough time has passed to try again
        const elapsed = Date.now() - this.lastFailureAt
        if (elapsed >= this.config.resetTimeoutMs) {
          this.state = 'half-open'
          this.halfOpenAttempts = 0
          return true
        }
        return false
      }

      case 'half-open':
        return this.halfOpenAttempts < this.config.halfOpenMaxAttempts
    }
  }

  /** Record a successful call. Resets failure count and closes circuit. */
  recordSuccess(): void {
    this.failureCount = 0
    this.halfOpenAttempts = 0
    this.state = 'closed'
  }

  /** Record a failed call. May open the circuit if threshold is reached. */
  recordFailure(): void {
    this.failureCount++
    this.lastFailureAt = Date.now()

    if (this.state === 'half-open') {
      // Failure during probe — re-open
      this.state = 'open'
      return
    }

    if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'open'
    }
  }

  /** Get current state for diagnostics */
  getState(): CircuitState {
    // Re-check open→half-open transition on read
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureAt
      if (elapsed >= this.config.resetTimeoutMs) {
        this.state = 'half-open'
        this.halfOpenAttempts = 0
      }
    }
    return this.state
  }

  /** Reset to initial state (useful for testing) */
  reset(): void {
    this.state = 'closed'
    this.failureCount = 0
    this.halfOpenAttempts = 0
    this.lastFailureAt = 0
  }
}

/**
 * Keyed circuit breaker registry — maintains one `CircuitBreaker` per key
 * (e.g. per agent id, per provider id). Replaces the former
 * `AgentCircuitBreaker` in the agent package.
 */
export class KeyedCircuitBreaker {
  private readonly breakers = new Map<string, CircuitBreaker>()
  private readonly config: Partial<CircuitBreakerConfig>

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = config
  }

  /** Get or create a breaker for the given key. */
  private forKey(key: string): CircuitBreaker {
    const existing = this.breakers.get(key)
    if (existing) return existing
    const fresh = new CircuitBreaker(this.config)
    this.breakers.set(key, fresh)
    return fresh
  }

  /** Record a timeout/failure for a specific key. */
  recordFailure(key: string): void {
    this.forKey(key).recordFailure()
  }

  /** Alias for `recordFailure` to match the legacy AgentCircuitBreaker API. */
  recordTimeout(key: string): void {
    this.recordFailure(key)
  }

  /** Record a successful call for a specific key. */
  recordSuccess(key: string): void {
    this.forKey(key).recordSuccess()
  }

  /** Check whether the key's breaker allows traffic right now. */
  isAvailable(key: string): boolean {
    const breaker = this.breakers.get(key)
    if (!breaker) return true
    return breaker.canExecute()
  }

  /** Filter a list of objects with `id` down to those whose circuit is closed/half-open. */
  filterAvailable<T extends { id: string }>(items: T[]): T[] {
    return items.filter((i) => this.isAvailable(i.id))
  }

  /** Get the current state of a specific key. */
  getState(key: string): CircuitState {
    return this.breakers.get(key)?.getState() ?? 'closed'
  }

  /** Reset all breakers (useful for testing). */
  reset(): void {
    this.breakers.clear()
  }
}
