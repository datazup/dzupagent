import { describe, it, expect, beforeEach } from 'vitest'
import { createPromptRoutes } from '../prompts.js'
import { InMemoryPromptStore } from '../../prompts/prompt-store.js'

function makeApp() {
  const store = new InMemoryPromptStore()
  const app = createPromptRoutes({ promptStore: store })
  return { app, store }
}

async function json(res: Response) {
  return res.json()
}

describe('Prompt routes', () => {
  describe('POST /', () => {
    it('creates a draft prompt version', async () => {
      const { app } = makeApp()
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'system-intro', type: 'system', content: 'You are helpful.' }),
      })
      expect(res.status).toBe(201)
      const body = await json(res)
      expect(body.name).toBe('system-intro')
      expect(body.type).toBe('system')
      expect(body.status).toBe('draft')
      expect(body.version).toBe(1)
    })

    it('rejects missing required fields', async () => {
      const { app } = makeApp()
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'oops' }),
      })
      expect(res.status).toBe(400)
    })

    it('increments version for same promptId', async () => {
      const { app } = makeApp()
      const first = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptId: 'p1', name: 'intro', type: 'system', content: 'v1' }),
      })
      const firstBody = await json(first)

      const second = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptId: 'p1', name: 'intro', type: 'system', content: 'v2' }),
      })
      const secondBody = await json(second)
      expect(secondBody.version).toBe(firstBody.version + 1)
    })
  })

  describe('GET /', () => {
    it('lists all prompt versions', async () => {
      const { app } = makeApp()
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'a', type: 'system', content: 'x' }),
      })
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'b', type: 'task', content: 'y' }),
      })
      const res = await app.request('/')
      const body = await json(res)
      expect(body.prompts).toHaveLength(2)
    })

    it('filters by type', async () => {
      const { app } = makeApp()
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'a', type: 'system', content: 'x' }),
      })
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'b', type: 'task', content: 'y' }),
      })
      const res = await app.request('/?type=system')
      const body = await json(res)
      expect(body.prompts).toHaveLength(1)
      expect(body.prompts[0].type).toBe('system')
    })
  })

  describe('GET /:id', () => {
    it('returns a specific version', async () => {
      const { app } = makeApp()
      const created = await json(await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x', type: 'system', content: 'hello' }),
      }))
      const res = await app.request(`/${created.id}`)
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.id).toBe(created.id)
    })

    it('returns 404 for unknown id', async () => {
      const { app } = makeApp()
      const res = await app.request('/nonexistent')
      expect(res.status).toBe(404)
    })
  })

  describe('POST /:id/publish', () => {
    it('publishes a draft version', async () => {
      const { app } = makeApp()
      const created = await json(await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x', type: 'system', content: 'hello' }),
      }))
      const res = await app.request(`/${created.id}/publish`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.status).toBe('published')
    })

    it('archives prior published version on new publish', async () => {
      const { app, store } = makeApp()
      const p1 = await json(await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptId: 'shared', name: 'x', type: 'system', content: 'v1' }),
      }))
      await app.request(`/${p1.id}/publish`, { method: 'POST' })

      const p2 = await json(await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptId: 'shared', name: 'x', type: 'system', content: 'v2' }),
      }))
      await app.request(`/${p2.id}/publish`, { method: 'POST' })

      const archived = await store.get(p1.id)
      expect(archived?.status).toBe('archived')
    })
  })

  describe('GET /active/:promptId', () => {
    it('returns the published version', async () => {
      const { app } = makeApp()
      const created = await json(await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptId: 'pid1', name: 'x', type: 'system', content: 'hello' }),
      }))
      await app.request(`/${created.id}/publish`, { method: 'POST' })
      const res = await app.request('/active/pid1')
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.status).toBe('published')
    })

    it('returns 404 when no published version', async () => {
      const { app } = makeApp()
      const res = await app.request('/active/nope')
      expect(res.status).toBe(404)
    })
  })

  describe('POST /rollback/:promptId', () => {
    it('rolls back to a prior version', async () => {
      const { app, store } = makeApp()
      const v1 = await json(await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptId: 'rb', name: 'x', type: 'system', content: 'v1' }),
      }))
      await app.request(`/${v1.id}/publish`, { method: 'POST' })

      const v2 = await json(await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptId: 'rb', name: 'x', type: 'system', content: 'v2' }),
      }))
      await app.request(`/${v2.id}/publish`, { method: 'POST' })

      const res = await app.request('/rollback/rb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: v1.id }),
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.id).toBe(v1.id)
      expect(body.status).toBe('published')
    })
  })

  describe('DELETE /:id', () => {
    it('deletes a draft version', async () => {
      const { app } = makeApp()
      const created = await json(await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x', type: 'system', content: 'hello' }),
      }))
      const res = await app.request(`/${created.id}`, { method: 'DELETE' })
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.deleted).toBe(true)
    })

    it('refuses to delete a published version', async () => {
      const { app } = makeApp()
      const created = await json(await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x', type: 'system', content: 'hello' }),
      }))
      await app.request(`/${created.id}/publish`, { method: 'POST' })
      const res = await app.request(`/${created.id}`, { method: 'DELETE' })
      expect(res.status).toBe(409)
    })
  })
})
