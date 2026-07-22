/**
 * Tests for {@link DistributedRateLimiter} (MC-07).
 *
 * The mock client is a tiny in-memory Map with a `failAll` toggle that
 * makes every call throw — used to exercise the fallback paths.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { DistributedRateLimiter } from '../guardrails/distributed-rate-limiter.js'
import type {
  RateLimiterClient,
  LocalRateLimiter,
} from '../guardrails/distributed-rate-limiter.js'

class MockClient implements RateLimiterClient {
  private store = new Map<string, number>()
  private ttls = new Map<string, number>()
  failAll = false

  async incr(key: string): Promise<number> {
    if (this.failAll) throw new Error('redis down')
    const next = (this.store.get(key) ?? 0) + 1
    this.store.set(key, next)
    return next
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (this.failAll) throw new Error('redis down')
    this.ttls.set(key, seconds)
    return 1
  }

  async get(key: string): Promise<string | null> {
    if (this.failAll) throw new Error('redis down')
    const value = this.store.get(key)
    return value === undefined ? null : String(value)
  }

  async del(key: string): Promise<number> {
    if (this.failAll) throw new Error('redis down')
    const existed = this.store.delete(key)
    this.ttls.delete(key)
    return existed ? 1 : 0
  }

  ttlFor(key: string): number | undefined {
    return this.ttls.get(key)
  }
}

class CountingLocal implements LocalRateLimiter {
  consumed = 0
  allowNext = true

  consume(): boolean {
    this.consumed++
    return this.allowNext
  }
}

class WaitingLocal implements LocalRateLimiter {
  consumed = 0
  waited = 0
  failWait = false

  consume(): boolean {
    this.consumed++
    return true
  }

  async waitUntilAvailable(): Promise<void> {
    this.waited++
    if (this.failWait) {
      throw new Error('local bucket exhausted')
    }
  }
}

class CapturingLogger {
  warns: Array<{ message: string; meta: unknown }> = []
  debug(): void {}
  info(): void {}
  warn(message: string, meta?: unknown): void {
    this.warns.push({ message, meta })
  }
  error(): void {}
}

describe('DistributedRateLimiter', () => {
  let client: MockClient

  beforeEach(() => {
    client = new MockClient()
  })

  it('allows up to maxRequests in the window', async () => {
    const limiter = new DistributedRateLimiter({
      client,
      maxRequests: 3,
      windowMs: 60_000,
    })

    const results: boolean[] = []
    for (let i = 0; i < 3; i++) {
      results.push(await limiter.tryConsume('tenant-a', 'agent-x'))
    }

    expect(results).toEqual([true, true, true])
  })

  it('denies the (maxRequests + 1)th request', async () => {
    const limiter = new DistributedRateLimiter({
      client,
      maxRequests: 2,
      windowMs: 60_000,
    })

    expect(await limiter.tryConsume('t', 'a')).toBe(true)
    expect(await limiter.tryConsume('t', 'a')).toBe(true)
    expect(await limiter.tryConsume('t', 'a')).toBe(false)
  })

  it('sets TTL on first increment in the window', async () => {
    const limiter = new DistributedRateLimiter({
      client,
      maxRequests: 5,
      windowMs: 30_000,
      keyPrefix: 'test:rl',
    })

    await limiter.tryConsume('tenant-a', 'agent-x')
    expect(client.ttlFor('test:rl:tenant-a:agent-x')).toBe(30)
  })

  it('namespaces by tenantId and agentId', async () => {
    const limiter = new DistributedRateLimiter({
      client,
      maxRequests: 1,
      windowMs: 60_000,
    })

    expect(await limiter.tryConsume('tenant-a', 'agent-x')).toBe(true)
    // Different tenant, fresh bucket.
    expect(await limiter.tryConsume('tenant-b', 'agent-x')).toBe(true)
    // Different agent, also fresh.
    expect(await limiter.tryConsume('tenant-a', 'agent-y')).toBe(true)
    // Same (tenant, agent) — should now be denied.
    expect(await limiter.tryConsume('tenant-a', 'agent-x')).toBe(false)
  })

  it('falls back to the local limiter when Redis throws', async () => {
    const local = new CountingLocal()
    const limiter = new DistributedRateLimiter(
      { client, maxRequests: 5, fallbackToLocal: true },
      local,
    )

    client.failAll = true
    const allowed = await limiter.tryConsume('t', 'a')

    expect(local.consumed).toBe(1)
    expect(allowed).toBe(true)
  })

  it('uses local waitUntilAvailable when fallback supports blocking waits', async () => {
    const local = new WaitingLocal()
    const limiter = new DistributedRateLimiter(
      { client, maxRequests: 5, fallbackToLocal: true },
      local,
    )

    client.failAll = true
    const allowed = await limiter.tryConsume('t', 'a')

    expect(allowed).toBe(true)
    expect(local.waited).toBe(1)
    expect(local.consumed).toBe(0)
  })

  it('denies when blocking local fallback cannot obtain a token', async () => {
    const local = new WaitingLocal()
    local.failWait = true
    const limiter = new DistributedRateLimiter(
      { client, maxRequests: 5, fallbackToLocal: true },
      local,
    )

    client.failAll = true

    expect(await limiter.tryConsume('t', 'a')).toBe(false)
    expect(local.waited).toBe(1)
    expect(local.consumed).toBe(0)
  })

  it('local fallback can deny when its own bucket is empty', async () => {
    const local = new CountingLocal()
    local.allowNext = false
    const limiter = new DistributedRateLimiter(
      { client, maxRequests: 5, fallbackToLocal: true },
      local,
    )
    client.failAll = true

    expect(await limiter.tryConsume('t', 'a')).toBe(false)
  })

  it('fails open when fallbackToLocal is false', async () => {
    const limiter = new DistributedRateLimiter({
      client,
      maxRequests: 1,
      fallbackToLocal: false,
    })
    client.failAll = true

    // Even though no local fallback exists, the limiter must not throw —
    // it must allow the request.
    expect(await limiter.tryConsume('t', 'a')).toBe(true)
  })

  it('reset() clears the counter', async () => {
    const limiter = new DistributedRateLimiter({
      client,
      maxRequests: 1,
      windowMs: 60_000,
    })

    expect(await limiter.tryConsume('t', 'a')).toBe(true)
    expect(await limiter.tryConsume('t', 'a')).toBe(false)
    await limiter.reset('t', 'a')
    expect(await limiter.tryConsume('t', 'a')).toBe(true)
  })

  it('reset() is best-effort on Redis errors', async () => {
    const limiter = new DistributedRateLimiter({ client, maxRequests: 1 })
    client.failAll = true
    await expect(limiter.reset('t', 'a')).resolves.toBeUndefined()
  })
  it('logs a warn when Redis fails and the limiter fails open (ERR-H-07)', async () => {
    const logger = new CapturingLogger()
    const limiter = new DistributedRateLimiter({
      client,
      maxRequests: 1,
      fallbackToLocal: false,
      logger,
    })
    client.failAll = true

    // Fail-open: request still allowed...
    expect(await limiter.tryConsume('t', 'a')).toBe(true)
    // ...but the degradation must be observable.
    const incrWarn = logger.warns.find(
      (w) => (w.meta as { operation?: string })?.operation === 'ratelimit.redis.incr',
    )
    expect(incrWarn).toBeDefined()
    expect((incrWarn?.meta as { failOpen?: boolean })?.failOpen).toBe(true)
    const failOpenWarn = logger.warns.find(
      (w) => (w.meta as { operation?: string })?.operation === 'ratelimit.failOpen',
    )
    expect(failOpenWarn).toBeDefined()
  })

  it('logs a warn when reset() hits a Redis error (ERR-H-07)', async () => {
    const logger = new CapturingLogger()
    const limiter = new DistributedRateLimiter({ client, maxRequests: 1, logger })
    client.failAll = true
    await limiter.reset('t', 'a')
    expect(
      logger.warns.some(
        (w) => (w.meta as { operation?: string })?.operation === 'ratelimit.redis.del',
      ),
    ).toBe(true)
  })

})
