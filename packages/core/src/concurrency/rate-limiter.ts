/**
 * Per-scope rate limiter combining a token bucket, a sliding window and an
 * adaptive backoff.
 *
 * Every request is scoped by `provider:key`, so one tenant exhausting its
 * allowance never affects another tenant or another provider.
 *
 * Checks run in a fixed precedence order:
 *   1. backoff        - a previous denial armed a cooldown for this scope
 *   2. token bucket   - continuous fractional refill up to `capacity + burst`
 *   3. sliding window - at most `maxInWindow` admissions per `windowMs`
 */

/**
 * Per-provider limit configuration.
 *
 * `requestsPerMinute` is ergonomic sugar: it derives `refillPerMs`
 * (`requestsPerMinute / 60_000`) and, when `capacity` is not given, a capacity
 * equal to one minute of that rate. Any explicit `capacity`, `refillPerMs`,
 * `windowMs` or `maxInWindow` always overrides the derived value, so the sugar
 * is a starting point rather than a constraint.
 */
export interface RateLimiterProviderConfig {
  /** Ergonomic sugar; derives `refillPerMs` and a default `capacity`. */
  requestsPerMinute?: number;
  /** Maximum tokens held by the bucket, excluding burst. */
  capacity?: number;
  /** Tokens restored per millisecond. Fractional values are preserved. */
  refillPerMs?: number;
  /** Sliding window width in milliseconds. */
  windowMs?: number;
  /** Maximum admissions inside one window. */
  maxInWindow?: number;
  /** Extra tokens above `capacity` available to absorb spikes. */
  burst?: number;
  /** Cooldown armed after a non-backoff denial. */
  backoffMs?: number;
}

export interface RateLimiterConfig {
  providers?: Record<string, RateLimiterProviderConfig>;
}

export interface RateLimitRequest {
  provider: string;
  key: string;
  cost?: number;
}

export type RateLimitReason = "token_bucket" | "sliding_window" | "backoff";

export interface RateLimitDecision {
  allowed: boolean;
  reason?: RateLimitReason;
  /** Milliseconds until the caller should retry. Zero when allowed. */
  retryAfterMs: number;
  remainingTokens: number;
  windowCount: number;
}

/** Fully resolved limit used internally once defaults and sugar are applied. */
interface ResolvedLimit {
  capacity: number;
  refillPerMs: number;
  windowMs: number;
  maxInWindow: number;
  burst?: number | undefined;
  backoffMs?: number | undefined;
}

const DEFAULT_LIMIT: ResolvedLimit = {
  capacity: 3,
  refillPerMs: 0.01,
  windowMs: 1_000,
  maxInWindow: 3,
};

/**
 * Resolves the public config onto the internal shape, applying
 * `requestsPerMinute` sugar only where an explicit field is absent.
 */
function resolveLimit(config: RateLimiterProviderConfig): ResolvedLimit {
  const derivedRefill =
    config.requestsPerMinute !== undefined ? config.requestsPerMinute / 60_000 : undefined;
  const derivedCapacity = config.requestsPerMinute;

  return {
    capacity: config.capacity ?? derivedCapacity ?? DEFAULT_LIMIT.capacity,
    refillPerMs: config.refillPerMs ?? derivedRefill ?? DEFAULT_LIMIT.refillPerMs,
    windowMs: config.windowMs ?? DEFAULT_LIMIT.windowMs,
    maxInWindow: config.maxInWindow ?? DEFAULT_LIMIT.maxInWindow,
    burst: config.burst,
    backoffMs: config.backoffMs,
  };
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  readonly config: RateLimiterConfig;

  private readonly providers: Record<string, ResolvedLimit>;
  private readonly buckets = new Map<string, Bucket>();
  private readonly windows = new Map<string, number[]>();
  private readonly backoffs = new Map<string, number>();

  constructor(config: RateLimiterConfig = {}) {
    this.config = config;
    this.providers = Object.fromEntries(
      Object.entries(config.providers ?? {}).map(([provider, limit]) => [
        provider,
        resolveLimit(limit),
      ]),
    );
  }

  /**
   * Admission check. Mutating: an allowed request spends its tokens and is
   * recorded in the sliding window; a denied request spends nothing but may
   * arm the scope's backoff.
   */
  check(request: RateLimitRequest): RateLimitDecision {
    const now = Date.now();
    const limit = this.limitFor(request.provider);
    const scope = `${request.provider}:${request.key}`;
    const retryUntil = this.backoffs.get(scope) ?? 0;

    if (retryUntil > now) {
      return this.reject(scope, limit, "backoff", retryUntil - now);
    }

    const bucket = this.bucketFor(scope, limit, now);
    const window = this.windowFor(scope, limit, now);
    const cost = request.cost ?? 1;

    if (bucket.tokens < cost) {
      return this.reject(
        scope,
        limit,
        "token_bucket",
        this.tokenRetryAfter(limit, cost - bucket.tokens),
      );
    }

    if (window.length >= limit.maxInWindow) {
      const oldest = window[0] ?? now;
      const retryAfterMs = Math.max(0, limit.windowMs - (now - oldest));
      return this.reject(scope, limit, "sliding_window", retryAfterMs);
    }

    bucket.tokens -= cost;
    window.push(now);

    return {
      allowed: true,
      retryAfterMs: 0,
      remainingTokens: bucket.tokens,
      windowCount: window.length,
    };
  }

  /**
   * Alias of {@link check}. Both names are part of the public API; `consume`
   * reads better at admission sites that intend to spend the allowance.
   */
  consume(request: RateLimitRequest): RateLimitDecision {
    return this.check(request);
  }

  /** Clears every bucket, sliding window and armed backoff. */
  reset(): void {
    this.buckets.clear();
    this.windows.clear();
    this.backoffs.clear();
  }

  private limitFor(provider: string): ResolvedLimit {
    return this.providers[provider] ?? DEFAULT_LIMIT;
  }

  private bucketFor(scope: string, limit: ResolvedLimit, now: number): Bucket {
    const bucket = this.buckets.get(scope) ?? {
      tokens: limit.capacity + (limit.burst ?? 0),
      updatedAt: now,
    };
    const maxTokens = limit.capacity + (limit.burst ?? 0);
    const elapsed = now - bucket.updatedAt;
    bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsed * limit.refillPerMs);
    bucket.updatedAt = now;
    this.buckets.set(scope, bucket);
    return bucket;
  }

  private windowFor(scope: string, limit: ResolvedLimit, now: number): number[] {
    const window = (this.windows.get(scope) ?? []).filter(
      (timestamp) => now - timestamp < limit.windowMs,
    );
    this.windows.set(scope, window);
    return window;
  }

  private reject(
    scope: string,
    limit: ResolvedLimit,
    reason: RateLimitReason,
    retryAfterMs: number,
  ): RateLimitDecision {
    const now = Date.now();
    const backoffMs = limit.backoffMs ?? 0;
    if (backoffMs > 0 && reason !== "backoff") {
      this.backoffs.set(scope, now + backoffMs);
      retryAfterMs = Math.max(retryAfterMs, backoffMs);
    }

    // NOTE: on a `backoff` denial `check()` returns before `bucketFor()` runs,
    // so no refill has been applied and `remainingTokens` reports the last
    // stored value (or the ceiling, for a scope with no bucket yet) rather than
    // the tokens actually accrued during the cooldown. Only this reporting
    // field is affected — `allowed`, `reason` and `retryAfterMs` are exact.
    // Callers must gate on those, not on `remainingTokens`, mid-cooldown.
    return {
      allowed: false,
      reason,
      retryAfterMs,
      remainingTokens: this.buckets.get(scope)?.tokens ?? limit.capacity + (limit.burst ?? 0),
      windowCount: this.windows.get(scope)?.length ?? 0,
    };
  }

  private tokenRetryAfter(limit: ResolvedLimit, deficit: number): number {
    return limit.refillPerMs > 0 ? Math.ceil(deficit / limit.refillPerMs) : Number.POSITIVE_INFINITY;
  }
}
