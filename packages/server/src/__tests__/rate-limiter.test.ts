import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'

import { applyMiddleware } from '../composition/middleware.js'
import { extractDefaultRateLimitKey } from '../middleware/rate-limiter.js'
import type { ForgeServerConfig } from '../composition/types.js'

function baseConfig(overrides: Partial<ForgeServerConfig>): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    ...overrides,
  }
}

describe('DZUPAGENT-SEC-H-20 rate limiter ordering and keys', () => {
  it('throttles rotating invalid bearer tokens before another auth lookup', async () => {
    const validateKey = vi.fn(async () => null)
    const app = new Hono()
    applyMiddleware(
      app,
      baseConfig({
        auth: { mode: 'api-key', validateKey },
        rateLimit: {
          maxRequests: 2,
          windowMs: 60_000,
          trustForwardedFor: true,
        },
      }),
    )
    app.get('/api/runs', (c) => c.json({ ok: true }))

    const statuses: number[] = []
    for (const token of ['invalid-a', 'invalid-b', 'invalid-c']) {
      const response = await app.request('/api/runs', {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Forwarded-For': '203.0.113.10',
        },
      })
      statuses.push(response.status)
    }

    expect(statuses).toEqual([401, 401, 429])
    expect(validateKey).toHaveBeenCalledTimes(2)
  })

  it('uses the resolved principal post-auth and never the presented token', () => {
    const context = {
      req: {
        header: (name: string) =>
          name === 'Authorization' ? 'Bearer attacker-controlled' : undefined,
      },
      get: () => ({ id: 'key-record-42' }),
    }

    expect(extractDefaultRateLimitKey(context)).toBe('principal:key-record-42')
  })

  it('hashes the trusted client IP for pre-auth buckets', () => {
    const key = extractDefaultRateLimitKey(
      {
        req: {
          header: (name: string) =>
            name === 'X-Forwarded-For' ? '203.0.113.10' : undefined,
        },
      },
      { trustForwardedFor: true },
    )

    expect(key).toMatch(/^ip:[a-f0-9]{64}$/)
    expect(key).not.toContain('203.0.113.10')
  })
})
