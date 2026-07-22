/**
 * Tests for {@link DistributedCostLedger} (MC-07).
 *
 * The mock client supports `incrByFloat` plus the base
 * RateLimiterClient surface. A `failAll` flag exercises the local
 * fallback path.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { DistributedCostLedger } from '../guardrails/distributed-budget.js'
import type { CostLedgerClient } from '../guardrails/distributed-budget.js'

class MockClient implements CostLedgerClient {
  private values = new Map<string, number>()
  private ttls = new Map<string, number>()
  failAll = false

  async incr(key: string): Promise<number> {
    if (this.failAll) throw new Error('redis down')
    const next = (this.values.get(key) ?? 0) + 1
    this.values.set(key, next)
    return next
  }

  async incrByFloat(key: string, increment: number): Promise<number> {
    if (this.failAll) throw new Error('redis down')
    const next = (this.values.get(key) ?? 0) + increment
    this.values.set(key, next)
    return next
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (this.failAll) throw new Error('redis down')
    this.ttls.set(key, seconds)
    return 1
  }

  async get(key: string): Promise<string | null> {
    if (this.failAll) throw new Error('redis down')
    const v = this.values.get(key)
    return v === undefined ? null : String(v)
  }

  async del(key: string): Promise<number> {
    if (this.failAll) throw new Error('redis down')
    const existed = this.values.delete(key)
    this.ttls.delete(key)
    return existed ? 1 : 0
  }

  ttlFor(key: string): number | undefined {
    return this.ttls.get(key)
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

describe('DistributedCostLedger', () => {
  let client: MockClient

  beforeEach(() => {
    client = new MockClient()
  })

  it('records cost and returns running total', async () => {
    const ledger = new DistributedCostLedger({ client })

    const r1 = await ledger.record('t', 'a', 0.25)
    const r2 = await ledger.record('t', 'a', 0.75)

    expect(r1.totalCostUsd).toBeCloseTo(0.25)
    expect(r2.totalCostUsd).toBeCloseTo(1.0)
    expect(r1.allowed).toBe(true)
    expect(r2.allowed).toBe(true)
  })

  it('denies when totalCostUsd reaches maxCostUsd', async () => {
    const ledger = new DistributedCostLedger({ client, maxCostUsd: 1.0 })

    expect((await ledger.record('t', 'a', 0.4)).allowed).toBe(true)
    expect((await ledger.record('t', 'a', 0.5)).allowed).toBe(true)
    // 0.4 + 0.5 + 0.2 = 1.1 → past ceiling
    const last = await ledger.record('t', 'a', 0.2)
    expect(last.allowed).toBe(false)
    expect(last.totalCostUsd).toBeCloseTo(1.1)
  })

  it('clamps negative or NaN cost inputs to zero', async () => {
    const ledger = new DistributedCostLedger({ client })
    const r1 = await ledger.record('t', 'a', -1)
    const r2 = await ledger.record('t', 'a', Number.NaN)
    expect(r1.totalCostUsd).toBe(0)
    expect(r2.totalCostUsd).toBe(0)
  })

  it('namespaces by tenantId and agentId', async () => {
    const ledger = new DistributedCostLedger({ client })
    await ledger.record('tenant-a', 'agent-x', 1)
    await ledger.record('tenant-b', 'agent-x', 2)
    await ledger.record('tenant-a', 'agent-y', 3)

    expect(await ledger.read('tenant-a', 'agent-x')).toBe(1)
    expect(await ledger.read('tenant-b', 'agent-x')).toBe(2)
    expect(await ledger.read('tenant-a', 'agent-y')).toBe(3)
  })

  it('sets TTL on every record call', async () => {
    const ledger = new DistributedCostLedger({
      client,
      keyPrefix: 'test:cost',
      ttlMs: 60_000,
    })

    await ledger.record('t', 'a', 0.5)
    expect(client.ttlFor('test:cost:t:a')).toBe(60)
  })

  it('falls back to local tracking when Redis throws', async () => {
    const ledger = new DistributedCostLedger({
      client,
      maxCostUsd: 1.0,
      fallbackToLocal: true,
    })

    client.failAll = true
    const r1 = await ledger.record('t', 'a', 0.4)
    const r2 = await ledger.record('t', 'a', 0.5)
    const r3 = await ledger.record('t', 'a', 0.5)

    expect(r1.totalCostUsd).toBeCloseTo(0.4)
    expect(r2.totalCostUsd).toBeCloseTo(0.9)
    expect(r3.totalCostUsd).toBeCloseTo(1.4)
    expect(r1.allowed).toBe(true)
    expect(r2.allowed).toBe(true)
    expect(r3.allowed).toBe(false) // crossed local ceiling
  })

  it('fails open when fallbackToLocal is false and Redis throws', async () => {
    const ledger = new DistributedCostLedger({
      client,
      maxCostUsd: 0.0001,
      fallbackToLocal: false,
    })

    client.failAll = true
    const r = await ledger.record('t', 'a', 999)
    expect(r.allowed).toBe(true)
    expect(r.totalCostUsd).toBe(0)
  })

  it('read() returns 0 when key missing', async () => {
    const ledger = new DistributedCostLedger({ client })
    expect(await ledger.read('t', 'a')).toBe(0)
  })

  it('read() falls back to local cache when Redis throws', async () => {
    const ledger = new DistributedCostLedger({ client, fallbackToLocal: true })
    await ledger.record('t', 'a', 0.5)

    client.failAll = true
    expect(await ledger.read('t', 'a')).toBeCloseTo(0.5)
  })

  it('reset() clears both Redis and local state', async () => {
    const ledger = new DistributedCostLedger({ client })
    await ledger.record('t', 'a', 5)

    await ledger.reset('t', 'a')

    expect(await ledger.read('t', 'a')).toBe(0)
    const r = await ledger.record('t', 'a', 1)
    expect(r.totalCostUsd).toBeCloseTo(1)
  })

  it('reset() is best-effort on Redis errors', async () => {
    const ledger = new DistributedCostLedger({ client })
    client.failAll = true
    await expect(ledger.reset('t', 'a')).resolves.toBeUndefined()
  })

  it('after Redis recovers, local mirror keeps cumulative total in sync', async () => {
    // Mirror goal: when Redis was last reachable and then comes back,
    // the local cache reflects the most recent Redis-served total so a
    // subsequent outage doesn't reset the agent's view to zero.
    const ledger = new DistributedCostLedger({ client, fallbackToLocal: true })

    await ledger.record('t', 'a', 0.5)
    expect(await ledger.read('t', 'a')).toBeCloseTo(0.5)

    client.failAll = true
    // Local mirror should still report the last-known total.
    expect(await ledger.read('t', 'a')).toBeCloseTo(0.5)
  })
  it('warns and reports the LOCAL total when Redis fails on record (ERR-H-08)', async () => {
    const logger = new CapturingLogger()
    const ledger = new DistributedCostLedger({
      client,
      maxCostUsd: 10,
      fallbackToLocal: true,
      logger,
    })
    client.failAll = true

    const result = await ledger.record('t', 'a', 2.5)
    // Degraded to per-process local total (not zero, not Redis).
    expect(result.totalCostUsd).toBe(2.5)
    const warn = logger.warns.find(
      (w) => (w.meta as { operation?: string })?.operation === 'budget.redis.incrByFloat',
    )
    expect(warn).toBeDefined()
    expect((warn?.meta as { capEnforced?: boolean })?.capEnforced).toBe(false)
    expect((warn?.meta as { degradedToLocal?: boolean })?.degradedToLocal).toBe(true)
  })

  it('warns when reset() hits a Redis error (ERR-H-08)', async () => {
    const logger = new CapturingLogger()
    const ledger = new DistributedCostLedger({ client, maxCostUsd: 10, logger })
    client.failAll = true
    await ledger.reset('t', 'a')
    expect(
      logger.warns.some(
        (w) => (w.meta as { operation?: string })?.operation === 'budget.redis.del',
      ),
    ).toBe(true)
  })

})
