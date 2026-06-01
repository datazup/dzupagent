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
 * - OPEN → HALF_OPEN: after the (jittered) resetTimeoutMs has elapsed
 * - HALF_OPEN → CLOSED: on success
 * - HALF_OPEN → OPEN: on failure
 *
 * Every transition invokes the optional `onTransition` callback (an event hook
 * consumers can bridge to an event bus) and emits a structured log line so
 * breaker behaviour is observable in production.
 */

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit (default: 3) */
  failureThreshold: number;
  /** Time in ms to wait in OPEN state before transitioning to HALF_OPEN (default: 30_000) */
  resetTimeoutMs: number;
  /** Max attempts allowed in HALF_OPEN state before re-opening (default: 1) */
  halfOpenMaxAttempts: number;
  /**
   * Bounded cooldown jitter as a fraction in [0, 1] (default: 0).
   *
   * Spreads OPEN→HALF_OPEN recovery across breakers so a fleet does not
   * stampede the recovering provider in lock-step. Jitter only *shortens* the
   * effective cooldown by up to `jitterFactor` of `resetTimeoutMs`; it never
   * extends it past `resetTimeoutMs`. With `jitterFactor: 0` the effective
   * cooldown equals `resetTimeoutMs` exactly (deterministic — used in tests).
   */
  jitterFactor?: number;
  /**
   * Alias for `resetTimeoutMs` (orchestration-flavoured name). If both are
   * set, `resetTimeoutMs` takes precedence. Kept for compatibility with
   * the former `AgentCircuitBreaker` API.
   */
  cooldownMs?: number;
  /**
   * Optional transition hook. Invoked synchronously on every state change with
   * the kind of transition. Use this to bridge breaker transitions onto an
   * application event bus (e.g. emit `circuit:open|half_open|close`). Defaults
   * to a no-op. Identifying which breaker fired is the caller's concern (pass a
   * closure that captures the key).
   */
  onTransition?: (event: CircuitTransitionEvent) => void;
}

/** Transition kinds, aligned with the `circuit:*` event vocabulary. */
export type CircuitTransitionKind =
  | "circuit:open"
  | "circuit:half_open"
  | "circuit:close";

export interface CircuitTransitionEvent {
  kind: CircuitTransitionKind;
  from: CircuitState;
  to: CircuitState;
  failureCount: number;
}

export type CircuitState = "closed" | "open" | "half-open";

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 1,
  jitterFactor: 0,
};

const TRANSITION_KIND: Record<CircuitState, CircuitTransitionKind> = {
  open: "circuit:open",
  "half-open": "circuit:half_open",
  closed: "circuit:close",
};

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private halfOpenAttempts = 0;
  private lastFailureAt = 0;
  /** Effective (possibly jittered) cooldown for the current OPEN window. */
  private currentCooldownMs = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    // Honor `cooldownMs` as an alias for `resetTimeoutMs` when the caller
    // uses the orchestration-flavoured name. Explicit `resetTimeoutMs`
    // always wins.
    const merged: CircuitBreakerConfig = { ...DEFAULT_CONFIG, ...config };
    if (
      config?.cooldownMs !== undefined &&
      config.resetTimeoutMs === undefined
    ) {
      merged.resetTimeoutMs = config.cooldownMs;
    }
    // Clamp jitter into [0, 1].
    merged.jitterFactor = Math.min(Math.max(merged.jitterFactor ?? 0, 0), 1);
    this.config = merged;
    this.currentCooldownMs = merged.resetTimeoutMs;
  }

  /**
   * Compute the effective cooldown for a freshly opened circuit. Jitter only
   * shortens the wait (by up to `jitterFactor` of `resetTimeoutMs`), so it is
   * always within `[resetTimeoutMs * (1 - jitterFactor), resetTimeoutMs]`.
   */
  private computeCooldownMs(): number {
    const { resetTimeoutMs, jitterFactor = 0 } = this.config;
    if (jitterFactor <= 0) return resetTimeoutMs;
    const reduction = resetTimeoutMs * jitterFactor * Math.random();
    return Math.max(0, resetTimeoutMs - reduction);
  }

  /** Centralised state change: applies the transition, notifies, and logs. */
  private transitionTo(next: CircuitState): void {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;

    if (next === "open") {
      // Lock in the (jittered) cooldown for this OPEN window.
      this.currentCooldownMs = this.computeCooldownMs();
    }

    const event: CircuitTransitionEvent = {
      kind: TRANSITION_KIND[next],
      from,
      to: next,
      failureCount: this.failureCount,
    };

    // Structured, observable log on every transition.
    console.warn(
      JSON.stringify({
        level: "warn",
        component: "circuit-breaker",
        event: event.kind,
        from,
        to: next,
        failureCount: this.failureCount,
        cooldownMs:
          next === "open" ? Math.round(this.currentCooldownMs) : undefined,
        timestamp: new Date().toISOString(),
      })
    );

    this.config.onTransition?.(event);
  }

  /** Check if a request can proceed. Returns false if circuit is OPEN. */
  canExecute(): boolean {
    switch (this.state) {
      case "closed":
        return true;

      case "open": {
        // Check if enough time has passed to try again
        const elapsed = Date.now() - this.lastFailureAt;
        if (elapsed >= this.currentCooldownMs) {
          this.transitionTo("half-open");
          this.halfOpenAttempts = 0;
          return true;
        }
        return false;
      }

      case "half-open":
        return this.halfOpenAttempts < this.config.halfOpenMaxAttempts;
    }
  }

  /** Record a successful call. Resets failure count and closes circuit. */
  recordSuccess(): void {
    this.failureCount = 0;
    this.halfOpenAttempts = 0;
    this.transitionTo("closed");
  }

  /** Record a failed call. May open the circuit if threshold is reached. */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureAt = Date.now();

    if (this.state === "half-open") {
      // Failure during probe — re-open
      this.transitionTo("open");
      return;
    }

    if (this.failureCount >= this.config.failureThreshold) {
      this.transitionTo("open");
    }
  }

  /** Get current state for diagnostics */
  getState(): CircuitState {
    // Re-check open→half-open transition on read
    if (this.state === "open") {
      const elapsed = Date.now() - this.lastFailureAt;
      if (elapsed >= this.currentCooldownMs) {
        this.transitionTo("half-open");
        this.halfOpenAttempts = 0;
      }
    }
    return this.state;
  }

  /** Reset to initial state (useful for testing) */
  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.halfOpenAttempts = 0;
    this.lastFailureAt = 0;
    this.currentCooldownMs = this.config.resetTimeoutMs;
  }
}

/**
 * Keyed circuit breaker registry — maintains one `CircuitBreaker` per key
 * (e.g. per agent id, per provider id). Replaces the former
 * `AgentCircuitBreaker` in the agent package.
 */
export class KeyedCircuitBreaker {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly config: Partial<CircuitBreakerConfig>;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = config;
  }

  /** Get or create a breaker for the given key. */
  private forKey(key: string): CircuitBreaker {
    const existing = this.breakers.get(key);
    if (existing) return existing;
    const fresh = new CircuitBreaker(this.config);
    this.breakers.set(key, fresh);
    return fresh;
  }

  /** Record a timeout/failure for a specific key. */
  recordFailure(key: string): void {
    this.forKey(key).recordFailure();
  }

  /** Alias for `recordFailure` to match the legacy AgentCircuitBreaker API. */
  recordTimeout(key: string): void {
    this.recordFailure(key);
  }

  /** Record a successful call for a specific key. */
  recordSuccess(key: string): void {
    this.forKey(key).recordSuccess();
  }

  /** Check whether the key's breaker allows traffic right now. */
  isAvailable(key: string): boolean {
    const breaker = this.breakers.get(key);
    if (!breaker) return true;
    return breaker.canExecute();
  }

  /** Filter a list of objects with `id` down to those whose circuit is closed/half-open. */
  filterAvailable<T extends { id: string }>(items: T[]): T[] {
    return items.filter((i) => this.isAvailable(i.id));
  }

  /** Get the current state of a specific key. */
  getState(key: string): CircuitState {
    return this.breakers.get(key)?.getState() ?? "closed";
  }

  /** Reset all breakers (useful for testing). */
  reset(): void {
    this.breakers.clear();
  }
}
