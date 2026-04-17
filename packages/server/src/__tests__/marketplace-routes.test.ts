/**
 * HTTP route tests for /api/marketplace/catalog endpoints.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import { InMemoryCatalogStore } from '../marketplace/catalog-store.js'
import type { Hono } from 'hono'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestConfig(): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    catalogStore: new InMemoryCatalogStore(),
  }
}

async function req(app: Hono, method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body) init.body = JSON.stringify(body)
  return app.request(path, init)
}

function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'test-agent',
    name: 'Test Agent',
    version: '1.0.0',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Marketplace routes', () => {
  let app: Hono

  beforeEach(() => {
    app = createForgeApp(createTestConfig())
  })

  // -------------------------------------------------------------------------
  // POST /api/marketplace/catalog — create
  // -------------------------------------------------------------------------

  describe('POST /api/marketplace/catalog', () => {
    it('creates a catalog entry (201)', async () => {
      const res = await req(app, 'POST', '/api/marketplace/catalog', validEntry())
      expect(res.status).toBe(201)
      const json = await res.json() as { data: { id: string; slug: string; name: string; version: string } }
      expect(json.data.slug).toBe('test-agent')
      expect(json.data.name).toBe('Test Agent')
      expect(json.data.version).toBe('1.0.0')
      expect(json.data.id).toBeTruthy()
    })

    it('creates entry with all optional fields', async () => {
      const res = await req(app, 'POST', '/api/marketplace/catalog', {
        slug: 'full-agent',
        name: 'Full Agent',
        description: 'A fully specified agent',
        version: '2.0.0',
        tags: ['nlp', 'test'],
        author: 'alice',
        readme: '# Full Agent',
        publishedAt: '2026-01-01T00:00:00Z',
        isPublic: false,
      })
      expect(res.status).toBe(201)
      const json = await res.json() as { data: { description: string; tags: string[]; author: string; isPublic: boolean } }
      expect(json.data.description).toBe('A fully specified agent')
      expect(json.data.tags).toEqual(['nlp', 'test'])
      expect(json.data.author).toBe('alice')
      expect(json.data.isPublic).toBe(false)
    })

    it('returns 400 without slug', async () => {
      const res = await req(app, 'POST', '/api/marketplace/catalog', { name: 'No Slug', version: '1.0.0' })
      expect(res.status).toBe(400)
      const json = await res.json() as { error: { code: string } }
      expect(json.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns 400 without name', async () => {
      const res = await req(app, 'POST', '/api/marketplace/catalog', { slug: 'no-name', version: '1.0.0' })
      expect(res.status).toBe(400)
    })

    it('returns 400 without version', async () => {
      const res = await req(app, 'POST', '/api/marketplace/catalog', { slug: 'no-ver', name: 'No Ver' })
      expect(res.status).toBe(400)
    })

    it('returns 400 for invalid semver', async () => {
      const res = await req(app, 'POST', '/api/marketplace/catalog', validEntry({ version: 'bad' }))
      expect(res.status).toBe(400)
      const json = await res.json() as { error: { message: string } }
      expect(json.error.message).toContain('semver')
    })

    it('accepts valid semver with prerelease', async () => {
      const res = await req(app, 'POST', '/api/marketplace/catalog', validEntry({ slug: 'pre', version: '1.0.0-beta.1' }))
      expect(res.status).toBe(201)
    })

    it('accepts valid semver with build metadata', async () => {
      const res = await req(app, 'POST', '/api/marketplace/catalog', validEntry({ slug: 'build', version: '1.0.0+build.123' }))
      expect(res.status).toBe(201)
    })

    it('returns 409 on duplicate slug', async () => {
      await req(app, 'POST', '/api/marketplace/catalog', validEntry())
      const res = await req(app, 'POST', '/api/marketplace/catalog', validEntry({ name: 'Different' }))
      expect(res.status).toBe(409)
      const json = await res.json() as { error: { code: string } }
      expect(json.error.code).toBe('SLUG_CONFLICT')
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/marketplace/catalog — search
  // -------------------------------------------------------------------------

  describe('GET /api/marketplace/catalog', () => {
    beforeEach(async () => {
      await req(app, 'POST', '/api/marketplace/catalog', {
        slug: 'summarizer',
        name: 'Summarizer',
        description: 'Summarizes long text',
        version: '1.0.0',
        tags: ['nlp'],
        author: 'alice',
      })
      await req(app, 'POST', '/api/marketplace/catalog', {
        slug: 'reviewer',
        name: 'Code Reviewer',
        description: 'Reviews code quality',
        version: '2.0.0',
        tags: ['code'],
        author: 'bob',
      })
      await req(app, 'POST', '/api/marketplace/catalog', {
        slug: 'translator',
        name: 'Translator',
        description: 'Translates text between languages',
        version: '1.5.0',
        tags: ['nlp', 'i18n'],
        author: 'alice',
      })
    })

    it('returns all entries without filters', async () => {
      const res = await app.request('/api/marketplace/catalog')
      expect(res.status).toBe(200)
      const json = await res.json() as { data: unknown[]; total: number }
      expect(json.total).toBe(3)
      expect(json.data).toHaveLength(3)
    })

    it('searches by q (name match)', async () => {
      const res = await app.request('/api/marketplace/catalog?q=Summarizer')
      expect(res.status).toBe(200)
      const json = await res.json() as { data: Array<{ slug: string }>; total: number }
      expect(json.total).toBe(1)
      expect(json.data[0]!.slug).toBe('summarizer')
    })

    it('searches by q (description match)', async () => {
      const res = await app.request('/api/marketplace/catalog?q=code+quality')
      const json = await res.json() as { data: Array<{ slug: string }>; total: number }
      expect(json.total).toBe(1)
      expect(json.data[0]!.slug).toBe('reviewer')
    })

    it('searches by q case-insensitively', async () => {
      const res = await app.request('/api/marketplace/catalog?q=TRANSLATOR')
      const json = await res.json() as { total: number }
      expect(json.total).toBe(1)
    })

    it('filters by tags', async () => {
      const res = await app.request('/api/marketplace/catalog?tags=nlp')
      const json = await res.json() as { data: unknown[]; total: number }
      expect(json.total).toBe(2)
    })

    it('filters by multiple tags (comma-separated)', async () => {
      const res = await app.request('/api/marketplace/catalog?tags=code,i18n')
      const json = await res.json() as { total: number }
      expect(json.total).toBe(2) // reviewer (code) + translator (i18n)
    })

    it('filters by author', async () => {
      const res = await app.request('/api/marketplace/catalog?author=alice')
      const json = await res.json() as { total: number }
      expect(json.total).toBe(2)
    })

    it('combines q and author', async () => {
      const res = await app.request('/api/marketplace/catalog?q=text&author=alice')
      const json = await res.json() as { data: Array<{ slug: string }>; total: number }
      // summarizer ('Summarizes long text') + translator ('Translates text')
      expect(json.total).toBe(2)
    })

    it('paginates with limit and page', async () => {
      const res = await app.request('/api/marketplace/catalog?limit=1&page=2')
      const json = await res.json() as { data: unknown[]; total: number; page: number; limit: number }
      expect(json.data).toHaveLength(1)
      expect(json.total).toBe(3)
      expect(json.page).toBe(2)
      expect(json.limit).toBe(1)
    })

    it('returns empty data for page beyond range', async () => {
      const res = await app.request('/api/marketplace/catalog?limit=10&page=999')
      const json = await res.json() as { data: unknown[]; total: number }
      expect(json.data).toHaveLength(0)
      expect(json.total).toBe(3)
    })

    it('returns no matches for nonexistent q', async () => {
      const res = await app.request('/api/marketplace/catalog?q=nonexistent')
      const json = await res.json() as { total: number }
      expect(json.total).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/marketplace/catalog/:id — get by ID
  // -------------------------------------------------------------------------

  describe('GET /api/marketplace/catalog/:id', () => {
    it('returns entry by ID', async () => {
      const createRes = await req(app, 'POST', '/api/marketplace/catalog', validEntry())
      const created = await createRes.json() as { data: { id: string } }
      const id = created.data.id

      const res = await app.request(`/api/marketplace/catalog/${id}`)
      expect(res.status).toBe(200)
      const json = await res.json() as { data: { id: string; slug: string } }
      expect(json.data.id).toBe(id)
      expect(json.data.slug).toBe('test-agent')
    })

    it('returns 404 for nonexistent ID', async () => {
      const res = await app.request('/api/marketplace/catalog/nonexistent-id')
      expect(res.status).toBe(404)
      const json = await res.json() as { error: { code: string } }
      expect(json.error.code).toBe('NOT_FOUND')
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/marketplace/catalog/by-slug/:slug — get by slug
  // -------------------------------------------------------------------------

  describe('GET /api/marketplace/catalog/by-slug/:slug', () => {
    it('returns entry by slug', async () => {
      await req(app, 'POST', '/api/marketplace/catalog', validEntry())
      const res = await app.request('/api/marketplace/catalog/by-slug/test-agent')
      expect(res.status).toBe(200)
      const json = await res.json() as { data: { slug: string } }
      expect(json.data.slug).toBe('test-agent')
    })

    it('returns 404 for nonexistent slug', async () => {
      const res = await app.request('/api/marketplace/catalog/by-slug/no-such-slug')
      expect(res.status).toBe(404)
      const json = await res.json() as { error: { code: string } }
      expect(json.error.code).toBe('NOT_FOUND')
    })
  })

  // -------------------------------------------------------------------------
  // PATCH /api/marketplace/catalog/:id — update
  // -------------------------------------------------------------------------

  describe('PATCH /api/marketplace/catalog/:id', () => {
    it('updates name', async () => {
      const createRes = await req(app, 'POST', '/api/marketplace/catalog', validEntry())
      const created = await createRes.json() as { data: { id: string } }

      const res = await req(app, 'PATCH', `/api/marketplace/catalog/${created.data.id}`, { name: 'Updated' })
      expect(res.status).toBe(200)
      const json = await res.json() as { data: { name: string } }
      expect(json.data.name).toBe('Updated')
    })

    it('updates version', async () => {
      const createRes = await req(app, 'POST', '/api/marketplace/catalog', validEntry())
      const created = await createRes.json() as { data: { id: string } }

      const res = await req(app, 'PATCH', `/api/marketplace/catalog/${created.data.id}`, { version: '2.0.0' })
      expect(res.status).toBe(200)
      const json = await res.json() as { data: { version: string } }
      expect(json.data.version).toBe('2.0.0')
    })

    it('updates tags', async () => {
      const createRes = await req(app, 'POST', '/api/marketplace/catalog', validEntry())
      const created = await createRes.json() as { data: { id: string } }

      const res = await req(app, 'PATCH', `/api/marketplace/catalog/${created.data.id}`, { tags: ['new-tag'] })
      expect(res.status).toBe(200)
      const json = await res.json() as { data: { tags: string[] } }
      expect(json.data.tags).toEqual(['new-tag'])
    })

    it('updates description to null', async () => {
      const createRes = await req(app, 'POST', '/api/marketplace/catalog', validEntry({ description: 'original' }))
      const created = await createRes.json() as { data: { id: string } }

      const res = await req(app, 'PATCH', `/api/marketplace/catalog/${created.data.id}`, { description: null })
      expect(res.status).toBe(200)
      const json = await res.json() as { data: { description: string | null } }
      expect(json.data.description).toBeNull()
    })

    it('returns 404 for nonexistent ID', async () => {
      const res = await req(app, 'PATCH', '/api/marketplace/catalog/nonexistent', { name: 'X' })
      expect(res.status).toBe(404)
    })

    it('returns 400 for invalid version', async () => {
      const createRes = await req(app, 'POST', '/api/marketplace/catalog', validEntry())
      const created = await createRes.json() as { data: { id: string } }

      const res = await req(app, 'PATCH', `/api/marketplace/catalog/${created.data.id}`, { version: 'invalid' })
      expect(res.status).toBe(400)
    })

    it('returns 409 when updating slug to conflict', async () => {
      await req(app, 'POST', '/api/marketplace/catalog', validEntry({ slug: 'taken' }))
      const createRes = await req(app, 'POST', '/api/marketplace/catalog', validEntry({ slug: 'other' }))
      const created = await createRes.json() as { data: { id: string } }

      const res = await req(app, 'PATCH', `/api/marketplace/catalog/${created.data.id}`, { slug: 'taken' })
      expect(res.status).toBe(409)
    })
  })

  // -------------------------------------------------------------------------
  // DELETE /api/marketplace/catalog/:id — delete
  // -------------------------------------------------------------------------

  describe('DELETE /api/marketplace/catalog/:id', () => {
    it('deletes an entry', async () => {
      const createRes = await req(app, 'POST', '/api/marketplace/catalog', validEntry())
      const created = await createRes.json() as { data: { id: string } }

      const res = await req(app, 'DELETE', `/api/marketplace/catalog/${created.data.id}`)
      expect(res.status).toBe(200)
      const json = await res.json() as { data: { id: string; deleted: boolean } }
      expect(json.data.deleted).toBe(true)

      // Verify entry is gone
      const getRes = await app.request(`/api/marketplace/catalog/${created.data.id}`)
      expect(getRes.status).toBe(404)
    })

    it('returns 404 for nonexistent ID', async () => {
      const res = await req(app, 'DELETE', '/api/marketplace/catalog/nonexistent')
      expect(res.status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // Routes not mounted when catalogStore not configured
  // -------------------------------------------------------------------------

  describe('when catalogStore is not configured', () => {
    it('returns 404 for marketplace routes', async () => {
      const noMarketplaceApp = createForgeApp({
        runStore: new InMemoryRunStore(),
        agentStore: new InMemoryAgentStore(),
        eventBus: createEventBus(),
        modelRegistry: new ModelRegistry(),
        // catalogStore intentionally omitted
      })

      const res = await noMarketplaceApp.request('/api/marketplace/catalog')
      expect(res.status).toBe(404)
    })
  })
})
