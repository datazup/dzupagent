import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter } from "../concurrency/rate-limiter.js";
import type {
  RateLimiterProviderConfig,
  RateLimitRequest,
} from "../concurrency/rate-limiter.js";

const limiterFor = (providers: Record<string, RateLimiterProviderConfig>) =>
  new RateLimiter({ providers });

const request = (provider = "openai", key = "default", cost = 1): RateLimitRequest => ({
  provider,
  key,
  cost,
});

const consume = (limiter: RateLimiter, count: number, req = request()) =>
  Array.from({ length: count }, () => limiter.check(req));

describe("RateLimiter construction and reset", () => {
  it("can be constructed without provider configuration", () => {
    expect(new RateLimiter()).toBeInstanceOf(RateLimiter);
  });

  it("retains constructor configuration for callers that inspect it", () => {
    const limiter = new RateLimiter({ providers: { openai: { requestsPerMinute: 60 } } });
    expect(limiter.config.providers?.openai?.requestsPerMinute).toBe(60);
  });

  it("implements check behavior without throwing", () => {
    const limiter = new RateLimiter();
    const decision = limiter.check(request());
    expect(decision.allowed).toBe(true);
    expect(decision.remainingTokens).toBe(2);
    expect(decision.windowCount).toBe(1);
  });

  it("implements consume behavior as a mutating admission call", () => {
    const limiter = limiterFor({ openai: { capacity: 2, maxInWindow: 20 } });
    expect(limiter.consume(request()).remainingTokens).toBe(1);
    expect(limiter.consume(request()).remainingTokens).toBe(0);
    const denied = limiter.consume(request());
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("token_bucket");
  });

  it("implements reset behavior without throwing", () => {
    const limiter = new RateLimiter();
    expect(() => limiter.reset()).not.toThrow();
  });

  it("restores the token bucket and sliding window after reset", () => {
    const limiter = limiterFor({ openai: { capacity: 3, maxInWindow: 3 } });
    consume(limiter, 3);
    expect(limiter.check(request()).allowed).toBe(false);

    limiter.reset();

    const afterReset = limiter.check(request());
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remainingTokens).toBe(2);
    expect(afterReset.windowCount).toBe(1);
  });

  it("clears an armed backoff on reset", () => {
    const limiter = limiterFor({
      openai: { capacity: 1, refillPerMs: 0.001, maxInWindow: 20, backoffMs: 500 },
    });
    consume(limiter, 1);
    expect(limiter.check(request()).allowed).toBe(false);
    expect(limiter.check(request()).reason).toBe("backoff");

    limiter.reset();

    expect(limiter.check(request()).allowed).toBe(true);
  });

  it("reports backoff ahead of the token bucket when both would deny", () => {
    // Backoff must win the precedence race even when tokens are also available:
    // drain to arm the backoff, then refill the bucket while the cooldown runs.
    const limiter = limiterFor({
      openai: { capacity: 1, refillPerMs: 0.01, maxInWindow: 20, backoffMs: 500 },
    });
    consume(limiter, 1);
    expect(limiter.check(request()).reason).toBe("token_bucket");

    // 200ms restores two tokens, so only the armed backoff can deny here.
    vi.advanceTimersByTime(200);
    const denied = limiter.check(request());
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("backoff");
    expect(denied.retryAfterMs).toBe(300);
    // A backoff denial short-circuits before the bucket is touched, so the
    // bucket's refill is NOT applied and remainingTokens stays at the last
    // recorded value rather than the mid-cooldown refilled value.
    expect(denied.remainingTokens).toBe(0);
  });

  it("derives refill and capacity from requestsPerMinute sugar", () => {
    const limiter = limiterFor({ openai: { requestsPerMinute: 60, maxInWindow: 100 } });
    const drained = consume(limiter, 60);
    expect(drained[59]!.allowed).toBe(true);
    expect(drained[59]!.remainingTokens).toBe(0);
    expect(limiter.check(request()).allowed).toBe(false);

    // 60 rpm == 0.001 tokens/ms, so one token returns after 1_000ms.
    vi.advanceTimersByTime(1_000);
    expect(limiter.check(request()).allowed).toBe(true);
  });

  it("lets explicit fields override requestsPerMinute sugar", () => {
    const limiter = limiterFor({
      openai: { requestsPerMinute: 60, capacity: 2, refillPerMs: 0.01, maxInWindow: 20 },
    });
    expect(consume(limiter, 2)[1]!.remainingTokens).toBe(0);
    expect(limiter.check(request()).allowed).toBe(false);

    vi.advanceTimersByTime(100);
    expect(limiter.check(request()).allowed).toBe(true);
  });
});

describe("RateLimiter token bucket behavior matrix", () => {
  [
    { name: "allows the first cost one request", cost: 1, remaining: 4 },
    { name: "allows cost two from a full bucket", cost: 2, remaining: 3 },
    { name: "allows cost five at exact capacity", cost: 5, remaining: 0 },
    { name: "rejects a request larger than capacity", cost: 6, allowed: false },
    { name: "rejects after the bucket is drained", drain: 5, cost: 1, allowed: false },
    { name: "allows after one token refills", drain: 5, advanceMs: 100, cost: 1, remaining: 0 },
    { name: "does not allow before enough refill accrues", drain: 5, advanceMs: 50, cost: 1, allowed: false },
    { name: "allows a two-token retry after enough refill", drain: 5, advanceMs: 200, cost: 2, remaining: 0 },
    { name: "caps refill at capacity after idle time", drain: 1, advanceMs: 10_000, cost: 5, remaining: 0 },
    { name: "tracks decimal refill without rounding early", drain: 5, advanceMs: 99, cost: 1, allowed: false },
    { name: "allows exactly when decimal refill reaches one", drain: 5, advanceMs: 100, cost: 1, remaining: 0 },
    { name: "keeps remaining tokens after partial consume", cost: 3, remaining: 2 },
    { name: "applies default cost when omitted", omitCost: true, remaining: 4 },
    { name: "isolates token accounting by key", drain: 5, otherKey: "other", cost: 1, remaining: 4 },
    { name: "reports retry delay for a token denial", drain: 5, cost: 1, allowed: false, retryAfterMs: 100 },
  ].forEach((entry) => {
    it(entry.name, () => {
      const limiter = limiterFor({ openai: { capacity: 5, maxInWindow: 20 } });
      if (entry.drain) consume(limiter, entry.drain);
      if (entry.advanceMs) vi.advanceTimersByTime(entry.advanceMs);
      const actual = limiter.check(
        entry.omitCost ? { provider: "openai", key: "default" } : request("openai", entry.otherKey ?? "default", entry.cost),
      );
      expect(actual.allowed).toBe(entry.allowed ?? true);
      if (entry.remaining !== undefined) expect(actual.remainingTokens).toBe(entry.remaining);
      if (entry.retryAfterMs !== undefined) expect(actual.retryAfterMs).toBe(entry.retryAfterMs);
    });
  });
});

describe("RateLimiter sliding window enforcement matrix", () => {
  [
    { name: "allows requests inside the window limit", calls: 3, allowed: [true, true, true] },
    { name: "rejects the first request over the window limit", calls: 4, allowed: [true, true, true, false] },
    { name: "allows again when the oldest hit expires", calls: 4, advanceBeforeLastMs: 1_000, allowed: [true, true, true, true] },
    { name: "does not expire the oldest hit one millisecond early", calls: 4, advanceBeforeLastMs: 999, allowed: [true, true, true, false] },
    { name: "returns retryAfter for window denial", calls: 4, retryAfterMs: 1_000, allowed: [true, true, true, false] },
    { name: "uses a shorter provider window", windowMs: 250, calls: 4, advanceBeforeLastMs: 250, allowed: [true, true, true, true] },
    { name: "uses a larger provider window", windowMs: 2_000, calls: 4, advanceBeforeLastMs: 1_000, allowed: [true, true, true, false] },
    { name: "keeps independent windows per key", calls: 4, otherKey: "secondary", allowed: [true, true, true, true] },
    { name: "keeps independent windows per provider", calls: 4, otherProvider: "anthropic", allowed: [true, true, true, true] },
    { name: "does not count denied requests toward the window", calls: 5, advanceBeforeLastMs: 1_000, allowed: [true, true, true, false, true] },
    { name: "uses a one request window", maxInWindow: 1, calls: 2, allowed: [true, false] },
    { name: "allows a one request window after expiry", maxInWindow: 1, calls: 2, advanceBeforeLastMs: 1_000, allowed: [true, true] },
    { name: "preserves token budget when the window denies", capacity: 10, calls: 4, remaining: 7 },
    { name: "reports current window count on denial", calls: 4, windowCount: 3 },
    { name: "allows under all limits after unrelated provider exhaustion", calls: 4, otherProvider: "openai", finalProvider: "anthropic", allowed: [true, true, true, true] },
  ].forEach((entry) => {
    it(entry.name, () => {
      const limiter = limiterFor({
        openai: {
          capacity: entry.capacity ?? 20,
          maxInWindow: entry.maxInWindow ?? 3,
          windowMs: entry.windowMs ?? 1_000,
        },
        anthropic: { capacity: 20, maxInWindow: 3, windowMs: 1_000 },
      });
      const results = Array.from({ length: entry.calls }, (_, index) => {
        if (entry.advanceBeforeLastMs && index === entry.calls - 1) vi.advanceTimersByTime(entry.advanceBeforeLastMs);
        const provider = index === entry.calls - 1 ? entry.finalProvider ?? entry.otherProvider ?? "openai" : "openai";
        const key = index === entry.calls - 1 ? entry.otherKey ?? "default" : "default";
        return limiter.check(request(provider, key));
      });
      if (entry.allowed) expect(results.map((result) => result.allowed)).toEqual(entry.allowed);
      const last = results[results.length - 1];
      if (entry.retryAfterMs !== undefined) expect(last!.retryAfterMs).toBe(entry.retryAfterMs);
      if (entry.remaining !== undefined) expect(last!.remainingTokens).toBe(entry.remaining);
      if (entry.windowCount !== undefined) expect(last!.windowCount).toBe(entry.windowCount);
    });
  });
});

describe("RateLimiter per-provider limit matrix", () => {
  [
    { name: "provider A denial does not deny provider B", openaiCalls: 4, anthropicAllowed: true },
    { name: "provider B denial does not deny provider A", anthropicCalls: 4, openaiAllowed: true },
    { name: "provider A can have a smaller bucket", provider: "openai", capacity: 1, calls: 2, allowed: [true, false] },
    { name: "provider B can have a larger bucket", provider: "anthropic", capacity: 5, calls: 5, allowed: [true, true, true, true, true] },
    { name: "provider A can have a smaller window", provider: "openai", maxInWindow: 1, calls: 2, allowed: [true, false] },
    { name: "provider B can have a larger window", provider: "anthropic", capacity: 5, maxInWindow: 5, calls: 5, allowed: [true, true, true, true, true] },
    { name: "provider A refill rate is independent", provider: "openai", capacity: 1, refillPerMs: 1, calls: 2, advanceBeforeLastMs: 1, allowed: [true, true] },
    { name: "provider B refill rate is independent", provider: "anthropic", capacity: 1, refillPerMs: 0.001, calls: 2, advanceBeforeLastMs: 1, allowed: [true, false] },
    { name: "unknown providers use the default limit", provider: "unknown", calls: 3, allowed: [true, true, true] },
    { name: "unknown provider default denies after default window", provider: "unknown", calls: 4, allowed: [true, true, true, false] },
    { name: "same key string is isolated across providers", sameKey: "tenant", openaiCalls: 4, anthropicAllowed: true },
    { name: "same provider is isolated across keys", sameKey: "tenant", openaiCalls: 4, openaiOtherKeyAllowed: true },
    { name: "provider A retryAfter comes from provider A config", provider: "openai", capacity: 1, refillPerMs: 0.01, calls: 2, retryAfterMs: 100 },
    { name: "provider B retryAfter comes from provider B config", provider: "anthropic", capacity: 1, refillPerMs: 0.001, calls: 2, retryAfterMs: 1_000 },
    { name: "success after prior provider failure remains allowed", openaiCalls: 4, finalProvider: "anthropic", anthropicAllowed: true },
  ].forEach((entry) => {
    it(entry.name, () => {
      const limiter = limiterFor({
        openai: {
          capacity: entry.provider === "openai" && entry.capacity ? entry.capacity : 3,
          refillPerMs: entry.provider === "openai" && entry.refillPerMs ? entry.refillPerMs : 0.01,
          maxInWindow: entry.provider === "openai" && entry.maxInWindow ? entry.maxInWindow : 20,
        },
        anthropic: {
          capacity: entry.provider === "anthropic" && entry.capacity ? entry.capacity : 3,
          refillPerMs: entry.provider === "anthropic" && entry.refillPerMs ? entry.refillPerMs : 0.01,
          maxInWindow: entry.provider === "anthropic" && entry.maxInWindow ? entry.maxInWindow : 20,
        },
      });

      const provider = entry.provider ?? (entry.anthropicCalls ? "anthropic" : "openai");
      const calls = entry.calls ?? entry.openaiCalls ?? entry.anthropicCalls ?? 0;
      const results = Array.from({ length: calls }, (_, index) => {
        if (entry.advanceBeforeLastMs && index === calls - 1) vi.advanceTimersByTime(entry.advanceBeforeLastMs);
        return limiter.check(request(provider, entry.sameKey ?? "default"));
      });

      if (entry.openaiCalls) consume(limiter, entry.openaiCalls, request("openai", entry.sameKey ?? "default"));
      if (entry.anthropicCalls) consume(limiter, entry.anthropicCalls, request("anthropic", entry.sameKey ?? "default"));

      if (entry.allowed) expect(results.map((result) => result.allowed)).toEqual(entry.allowed);
      if (entry.retryAfterMs !== undefined) expect(results[results.length - 1]!.retryAfterMs).toBe(entry.retryAfterMs);
      if (entry.anthropicAllowed !== undefined) expect(limiter.check(request(entry.finalProvider ?? "anthropic", entry.sameKey ?? "default")).allowed).toBe(entry.anthropicAllowed);
      if (entry.openaiAllowed !== undefined) expect(limiter.check(request("openai", entry.sameKey ?? "default")).allowed).toBe(entry.openaiAllowed);
      if (entry.openaiOtherKeyAllowed !== undefined) expect(limiter.check(request("openai", "other")).allowed).toBe(entry.openaiOtherKeyAllowed);
    });
  });
});

describe("RateLimiter burst allowance matrix", () => {
  [
    { name: "allows capacity plus burst tokens", calls: 5, burst: 2, allowed: [true, true, true, true, true] },
    { name: "denies after capacity plus burst is spent", calls: 6, burst: 2, allowed: [true, true, true, true, true, false] },
    { name: "burst does not increase sliding window", calls: 5, burst: 5, maxInWindow: 3, allowed: [true, true, true, false, false] },
    { name: "burst can be provider specific", provider: "anthropic", calls: 5, burst: 2, allowed: [true, true, true, true, true] },
    { name: "provider without burst still denies at capacity", provider: "openai", calls: 4, burst: 0, allowed: [true, true, true, false] },
    { name: "burst capacity refills only to burst ceiling", burst: 2, drain: 2, advanceMs: 10_000, finalCost: 5, finalAllowed: true },
    { name: "burst supports a large initial request", burst: 2, finalCost: 5, finalAllowed: true },
    { name: "burst rejects a request above capacity plus burst", burst: 2, finalCost: 6, finalAllowed: false },
    { name: "burst isolation keeps provider B allowance", calls: 5, burst: 2, otherProvider: "anthropic", finalAllowed: true },
    { name: "burst denial reports token bucket", calls: 6, burst: 2, reason: "token_bucket" },
  ].forEach((entry) => {
    it(entry.name, () => {
      const limiter = limiterFor({
        openai: { capacity: 3, burst: entry.provider === "anthropic" ? 0 : entry.burst, maxInWindow: entry.maxInWindow ?? 20 },
        anthropic: { capacity: 3, burst: entry.provider === "anthropic" ? entry.burst : 0, maxInWindow: 20 },
      });
      const provider = entry.provider ?? "openai";
      if (entry.drain) consume(limiter, entry.drain, request(provider));
      if (entry.advanceMs) vi.advanceTimersByTime(entry.advanceMs);
      const results = entry.calls ? consume(limiter, entry.calls, request(provider)) : [];
      if (entry.finalCost) results.push(limiter.check(request(provider, "default", entry.finalCost)));
      if (entry.otherProvider) results.push(limiter.check(request(entry.otherProvider)));
      if (entry.allowed) expect(results.map((result) => result.allowed)).toEqual(entry.allowed);
      if (entry.finalAllowed !== undefined) expect(results[results.length - 1]!.allowed).toBe(entry.finalAllowed);
      if (entry.reason) expect(results[results.length - 1]!.reason).toBe(entry.reason);
    });
  });
});

describe("RateLimiter backoff-on-limit-hit matrix", () => {
  [
    { name: "starts backoff after token bucket denial", drain: 1, backoffMs: 500, retryAfterMs: 1_000 },
    { name: "blocks retry before backoff expires", drain: 1, backoffMs: 500, advanceMs: 499, allowed: false, reason: "backoff" },
    { name: "allows retry once backoff expires and token refilled", drain: 1, backoffMs: 500, advanceMs: 1_000, allowed: true },
    { name: "starts backoff after sliding window denial", calls: 2, maxInWindow: 1, backoffMs: 400, retryAfterMs: 400 },
    { name: "sliding window backoff does not pass early", calls: 2, maxInWindow: 1, backoffMs: 400, advanceMs: 399, allowed: false, reason: "backoff" },
    { name: "backoff is per provider", drain: 1, backoffMs: 500, alternateProvider: "anthropic", allowed: true },
    { name: "backoff is per key", drain: 1, backoffMs: 500, alternateKey: "other", allowed: true },
    { name: "new denial extends backoff from the later hit", drain: 1, backoffMs: 500, advanceMs: 250, retryAfterMs: 1_000 },
    { name: "zero backoff falls back to token retry delay", drain: 1, backoffMs: 0, retryAfterMs: 1_000 },
    { name: "success after prior failure consumes normally", drain: 1, backoffMs: 500, advanceMs: 1_000, allowed: true, remainingTokens: 0 },
  ].forEach((entry) => {
    it(entry.name, () => {
      const limiter = limiterFor({
        openai: {
          capacity: 1,
          refillPerMs: 0.001,
          maxInWindow: entry.maxInWindow ?? 20,
          backoffMs: entry.backoffMs,
        },
        anthropic: { capacity: 1, refillPerMs: 0.001, maxInWindow: 20, backoffMs: entry.backoffMs },
      });

      if (entry.drain) consume(limiter, entry.drain);
      if (entry.calls) consume(limiter, entry.calls);
      const firstDenied = limiter.check(request());
      if (entry.advanceMs) vi.advanceTimersByTime(entry.advanceMs);
      const retry = limiter.check(request(entry.alternateProvider ?? "openai", entry.alternateKey ?? "default"));

      if (entry.retryAfterMs !== undefined) expect(firstDenied.retryAfterMs).toBe(entry.retryAfterMs);
      if (entry.allowed !== undefined) expect(retry.allowed).toBe(entry.allowed);
      if (entry.reason) expect(retry.reason).toBe(entry.reason);
      if (entry.remainingTokens !== undefined) expect(retry.remainingTokens).toBe(entry.remainingTokens);
    });
  });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});
