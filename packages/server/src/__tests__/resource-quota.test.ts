/**
 * MC-S01 unit tests for the per-key resource quota manager.
 *
 * Covers:
 *   - Token cap enforcement (checkQuota blocks once projected > limit)
 *   - Sliding-window reset semantics
 *   - Isolation between multiple API keys
 *   - `resetExpired()` manual sweep
 *   - No-op behaviour when hourlyLimit is unset
 *   - Handler-level 429 response when a key is over budget
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createResourceQuotaManager } from '../security/resource-quota.js'
import { createForgeApp } from '../app.js'
import { InMemoryRunStore, InMemoryAgentStore, ModelRegistry, createEventBus } from '@dzupagent/core'

describe('createResourceQuotaManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows requests while under the hourly budget', () => {
    const mgr = createResourceQuotaManager()
    const decision = mgr.checkQuota('key-1', 500, 1000)
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBeUndefined()
  })

  it('rejects a request whose projected total exceeds the limit', () => {
    const mgr = createResourceQuotaManager()
    mgr.recordUsage('key-1', 900)

    const decision = mgr.checkQuota('key-1', 200, 1000)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/budget exhausted/i)
    expect(decision.reason).toMatch(/900\/1000/)
  })

  it('uses the per-run cap as the estimate when projecting a single run', () => {
    const mgr = createResourceQuotaManager()
    // A fresh key with the per-run cap equal to the hourly cap must be
    // accepted on its first request — the estimate is 1000 and the current
    // usage is 0, so projected == limit.
    const decision = mgr.checkQuota('key-1', 1000, 1000)
    expect(decision.allowed).toBe(true)
  })

  it('resets the window once the sliding interval elapses', () => {
    const mgr = createResourceQuotaManager({ windowMs: 60_000 })
    mgr.recordUsage('key-1', 1000)

    expect(mgr.checkQuota('key-1', 1, 1000).allowed).toBe(false)

    // Fast-forward past the window — the bucket rolls over on next check.
    vi.advanceTimersByTime(61_000)
    expect(mgr.checkQuota('key-1', 1, 1000).allowed).toBe(true)
    expect(mgr.getUsage('key-1')).toBeUndefined()
  })

  it('isolates usage between independent API keys', () => {
    const mgr = createResourceQuotaManager()
    mgr.recordUsage('key-a', 1000)

    // key-b has its own bucket — key-a's spend must not leak across.
    expect(mgr.checkQuota('key-a', 1, 1000).allowed).toBe(false)
    expect(mgr.checkQuota('key-b', 500, 1000).allowed).toBe(true)
  })

  it('treats a missing hourly limit as "no cap"', () => {
    const mgr = createResourceQuotaManager()
    mgr.recordUsage('key-1', 999_999)

    // hourlyLimit = null|undefined|0 means "no cap" — always allow.
    expect(mgr.checkQuota('key-1', 1_000_000).allowed).toBe(true)
    expect(mgr.checkQuota('key-1', 1_000_000, null).allowed).toBe(true)
    expect(mgr.checkQuota('key-1', 1_000_000, 0).allowed).toBe(true)
  })

  it('resetExpired() purges windows whose deadline has passed', () => {
    const mgr = createResourceQuotaManager({ windowMs: 60_000 })
    mgr.recordUsage('key-1', 100)
    mgr.recordUsage('key-2', 200)
    expect(mgr.getUsage('key-1')?.tokens).toBe(100)
    expect(mgr.getUsage('key-2')?.tokens).toBe(200)

    vi.advanceTimersByTime(70_000)
    mgr.resetExpired()

    expect(mgr.getUsage('key-1')).toBeUndefined()
    expect(mgr.getUsage('key-2')).toBeUndefined()
  })

  it('ignores non-positive token usage calls', () => {
    const mgr = createResourceQuotaManager()
    mgr.recordUsage('key-1', 0)
    mgr.recordUsage('key-1', -500)
    expect(mgr.getUsage('key-1')).toBeUndefined()
  })

  it('accumulates sequential recordings inside the window', () => {
    const mgr = createResourceQuotaManager()
    mgr.recordUsage('key-1', 100)
    mgr.recordUsage('key-1', 200)
    mgr.recordUsage('key-1', 300)
    expect(mgr.getUsage('key-1')?.tokens).toBe(600)
  })
})

describe('POST /api/runs per-key budget enforcement', () => {
  function createAppWithKey(opts: {
    hourlyLimit?: number | null
    perRunCap?: number | null
    priorUsage?: number
  }) {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    void agentStore.save({
      id: 'agent-1',
      name: 'Agent',
      instructions: 'Do the thing',
      modelTier: 'standard',
    } as never)

    const quota = createResourceQuotaManager()
    if (opts.priorUsage) {
      quota.recordUsage('key-1', opts.priorUsage)
    }

    const app = createForgeApp({
      runStore,
      agentStore,
      eventBus: createEventBus(),
      modelRegistry: new ModelRegistry(),
      auth: {
        mode: 'api-key',
        validateKey: async (key) => {
          if (key !== 'token') return null
          return {
            id: 'key-1',
            ownerId: 'user-1',
            maxTokensPerRun: opts.perRunCap ?? null,
            maxRunsPerHour: opts.hourlyLimit ?? null,
          }
        },
      },
      resourceQuota: quota,
    })
    return { app, runStore, quota }
  }

  it('rejects run creation with 429 when the key is over its hourly budget', async () => {
    const { app } = createAppWithKey({ hourlyLimit: 1000, perRunCap: 500, priorUsage: 900 })
    const res = await app.request('/api/runs', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agentId: 'agent-1', input: 'hi' }),
    })
    expect(res.status).toBe(429)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('QUOTA_EXCEEDED')
    expect(body.error.message).toMatch(/budget exhausted/i)
  })

  it('injects maxTokensPerRun into guardrails.maxTokens on the created run', async () => {
    const { app, runStore } = createAppWithKey({ hourlyLimit: 100_000, perRunCap: 1000 })
    const res = await app.request('/api/runs', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agentId: 'agent-1', input: 'hi' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { id: string } }
    const run = await runStore.get(body.data.id)
    const guardrails = (run?.metadata as Record<string, unknown>)?.['guardrails'] as
      | Record<string, unknown>
      | undefined
    expect(guardrails?.['maxTokens']).toBe(1000)
  })

  it('keeps the tighter cap when the caller already supplied a smaller guardrails.maxTokens', async () => {
    const { app, runStore } = createAppWithKey({ hourlyLimit: 100_000, perRunCap: 5000 })
    const res = await app.request('/api/runs', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agentId: 'agent-1',
        input: 'hi',
        metadata: { guardrails: { maxTokens: 2000 } },
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { id: string } }
    const run = await runStore.get(body.data.id)
    const guardrails = (run?.metadata as Record<string, unknown>)?.['guardrails'] as
      | Record<string, unknown>
      | undefined
    // Must be the smaller of the two, never larger than the key cap.
    expect(guardrails?.['maxTokens']).toBe(2000)
  })

  it('accepts runs when the key has no budget configured', async () => {
    const { app } = createAppWithKey({ hourlyLimit: null, perRunCap: null })
    const res = await app.request('/api/runs', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agentId: 'agent-1', input: 'hi' }),
    })
    expect(res.status).toBe(201)
  })
})
