/**
 * HONO-SECURITY-20261111-R1 (H2): regression for GHSA-h7mg-cq63-vhpq.
 *
 * Hono's default SmartRouter selects RegExpRouter, which (before 4.13.16) did not
 * match any wildcard middleware for a path carrying an encoded line terminator
 * (%0A, %0D, %E2%80%A8, %E2%80%A9). The request then reached the not-found handler
 * with none of the wildcard middleware (authentication, RBAC, ...) applied.
 * DzupAgent registers its guards on prefix wildcards, so the guard must run for
 * these paths and answer 401, never fall through to a 404.
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import { createForgeApp, type ForgeServerConfig } from '../app.js'

const LINE_TERMINATORS = ['%0A', '%0D', '%E2%80%A8', '%E2%80%A9'] as const

describe('wildcard middleware runs for paths with an encoded line terminator (GHSA-h7mg-cq63-vhpq)', () => {
  describe('a default-router Hono app with a prefix-wildcard guard', () => {
    for (const lt of LINE_TERMINATORS) {
      it(`runs the guard for /api/items${lt}`, async () => {
        const app = new Hono()
        let guardRan = false
        app.use('/api/*', async (c) => {
          guardRan = true
          return c.json({ error: 'UNAUTHORIZED' }, 401)
        })
        app.get('/api/items', (c) => c.json({ ok: true }))

        const res = await app.request(`/api/items${lt}`)

        expect(guardRan).toBe(true)
        expect(res.status).toBe(401)
      })
    }
  })

  // Non-discriminating guard: measured green on hono 4.12.27 as well (the real app answers 401 on
  // base), so only the plain-router cases above are red on base. Kept to pin the real route family.
  describe('the real DzupAgent app factory with api-key auth on /api/*', () => {
    const config: ForgeServerConfig = {
      runStore: new InMemoryRunStore(),
      agentStore: new InMemoryAgentStore(),
      eventBus: createEventBus(),
      modelRegistry: new ModelRegistry(),
      auth: { mode: 'api-key', validateKey: async () => null },
    }

    it('control: an unauthenticated request to a normal /api path is 401', async () => {
      const app = createForgeApp(config)
      const res = await app.request('/api/agent-definitions')
      expect(res.status).toBe(401)
    })

    for (const lt of LINE_TERMINATORS) {
      it(`answers 401, not 404, for an unauthenticated /api/agent-definitions${lt}`, async () => {
        const app = createForgeApp(config)
        const res = await app.request(`/api/agent-definitions${lt}`)
        expect(res.status).toBe(401)
      })
    }
  })
})
