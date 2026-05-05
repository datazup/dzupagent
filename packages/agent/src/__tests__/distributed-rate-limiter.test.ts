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
})
