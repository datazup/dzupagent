export interface RateLimiterProviderConfig {
  requestsPerMinute?: number;
  burst?: number;
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

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs?: number;
  reason?: string;
}

export class RateLimiter {
  readonly config: RateLimiterConfig;

  constructor(config: RateLimiterConfig = {}) {
    this.config = config;
  }

  check(_request: RateLimitRequest): RateLimitDecision {
    throw new Error("RateLimiter is a compile stub; production behavior is not implemented.");
  }

  consume(_request: RateLimitRequest): RateLimitDecision {
    throw new Error("RateLimiter is a compile stub; production behavior is not implemented.");
  }

  reset(): void {
    throw new Error("RateLimiter is a compile stub; production behavior is not implemented.");
  }
}
