import { describe, it, expect, vi } from 'vitest'
import { DistributedCostLedger, type CostLedgerClient } from '../distributed-budget.js'

/**
 * AGENT-H-28 reachability — does a configured ceiling actually BIND?
 *
 * The surrounding cover proves the config seam (`workers.ts` forwards the
 * value, misconfiguration is rejected at boot) and that the executor reacts to
 * an `allowed: false` verdict — but the executor tests *stub* that verdict.
 * Nothing asserted that a real `maxCostUsd` produces one, which is the whole
 * point of the ceiling: the difference between "the number was forwarded" and
 * "spend stops".
 *
 * These tests exercise the real ledger against a fake Redis so the
 * ceiling -> verdict edge is pinned end-to-end at its enforcement boundary.
 */

/** In-memory stand-in for the Redis-shaped client. */
function makeClient(overrides: Partial<CostLedgerClient> = {}): CostLedgerClient {
  const totals = new Map<string, number>()
  return {
    async incrByFloat(key: string, increment: number): Promise<number> {
      const next = (totals.get(key) ?? 0) + increment
      totals.set(key, next)
      return next
    },
    async expire(): Promise<void> {},
    async get(key: string): Promise<string | null> {
      const v = totals.get(key)
      return v === undefined ? null : String(v)
    },
    async del(key: string): Promise<void> {
      totals.delete(key)
    },
    ...overrides,
  } as CostLedgerClient
}

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as never

describe('DistributedCostLedger — a configured ceiling binds', () => {
  it('allows spend below the ceiling and denies once it is reached', async () => {
    const ledger = new DistributedCostLedger({
      client: makeClient(),
      maxCostUsd: 10,
      logger: silentLogger,
    })

    const first = await ledger.record('tenant-a', 'agent-a', 4)
    expect(first).toMatchObject({ allowed: true, totalCostUsd: 4 })

    // Crossing the ceiling must flip the verdict — this is the assertion that
    // distinguishes an enforced ceiling from a merely recorded one.
    const second = await ledger.record('tenant-a', 'agent-a', 7)
    expect(second.totalCostUsd).toBe(11)
    expect(second.allowed).toBe(false)
  })

  it('denies at exactly the ceiling (the boundary is inclusive)', async () => {
    const ledger = new DistributedCostLedger({
      client: makeClient(),
      maxCostUsd: 10,
      logger: silentLogger,
    })

    const result = await ledger.record('tenant-a', 'agent-a', 10)
    // `allowed: total < max` — documented as "at or above" denies.
    expect(result).toMatchObject({ allowed: false, totalCostUsd: 10 })
  })

  it('never denies when no ceiling is configured (track-only default)', async () => {
    const ledger = new DistributedCostLedger({
      client: makeClient(),
      logger: silentLogger,
    })

    const result = await ledger.record('tenant-a', 'agent-a', 1_000_000)
    expect(result.allowed).toBe(true)
  })

  it('scopes the ceiling per tenant:agent, so one tenant cannot exhaust another', async () => {
    const ledger = new DistributedCostLedger({
      client: makeClient(),
      maxCostUsd: 10,
      logger: silentLogger,
    })

    await ledger.record('tenant-a', 'agent-a', 11)
    const other = await ledger.record('tenant-b', 'agent-a', 1)
    expect(other).toMatchObject({ allowed: true, totalCostUsd: 1 })
  })

  it('still enforces a soft ceiling from the local total when Redis is down', async () => {
    const ledger = new DistributedCostLedger({
      client: makeClient({
        incrByFloat: vi.fn(async () => {
          throw new Error('redis unreachable')
        }),
      }),
      maxCostUsd: 10,
      fallbackToLocal: true,
      logger: silentLogger,
    })

    expect((await ledger.record('tenant-a', 'agent-a', 6)).allowed).toBe(true)
    const second = await ledger.record('tenant-a', 'agent-a', 6)
    expect(second).toMatchObject({ allowed: false, totalCostUsd: 12 })
  })

  it('FAILS OPEN when Redis is down and local fallback is disabled', async () => {
    // Deliberate availability tradeoff: with no durable total and no local
    // mirror the ledger cannot know the spend, so it lets the run proceed and
    // reports `0`. Pinned because it is the one path where a configured
    // ceiling does NOT stop spend — it must stay a conscious choice.
    const ledger = new DistributedCostLedger({
      client: makeClient({
        incrByFloat: vi.fn(async () => {
          throw new Error('redis unreachable')
        }),
      }),
      maxCostUsd: 10,
      fallbackToLocal: false,
      logger: silentLogger,
    })

    const result = await ledger.record('tenant-a', 'agent-a', 500)
    expect(result).toMatchObject({ allowed: true, totalCostUsd: 0 })
  })
})
