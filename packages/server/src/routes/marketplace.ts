/**
 * Marketplace catalog routes — CRUD and search for agent catalog entries.
 *
 * POST   /api/marketplace/catalog            — Create catalog entry (auth)
 * GET    /api/marketplace/catalog             — Search catalog (public)
 * GET    /api/marketplace/catalog/:id         — Get by ID (public)
 * GET    /api/marketplace/catalog/by-slug/:slug — Get by slug (public)
 * PATCH  /api/marketplace/catalog/:id         — Update entry (auth)
 * DELETE /api/marketplace/catalog/:id         — Delete entry (auth)
 */
import { Hono } from 'hono'
import type { CatalogStore } from '../marketplace/catalog-store.js'
import { CatalogNotFoundError, CatalogSlugConflictError } from '../marketplace/catalog-store.js'

export interface MarketplaceRouteConfig {
  catalogStore: CatalogStore
}

// eslint-disable-next-line security/detect-unsafe-regex
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/

export function createMarketplaceRoutes(config: MarketplaceRouteConfig): Hono {
  const app = new Hono()
  const { catalogStore } = config

  // --- Create catalog entry ---
  app.post('/catalog', async (c) => {
    const body = await c.req.json<{
      slug?: string
      name?: string
      description?: string
      version?: string
      tags?: string[]
      author?: string
      readme?: string
      publishedAt?: string
      isPublic?: boolean
    }>()

    if (!body.slug || !body.name || !body.version) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'slug, name, and version are required' } },
        400,
      )
    }

    if (!SEMVER_RE.test(body.version)) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'version must be valid semver (e.g. 1.0.0)' } },
        400,
      )
    }

    try {
      const entry = await catalogStore.create({
        slug: body.slug,
        name: body.name,
        description: body.description ?? null,
        version: body.version,
        tags: body.tags ?? [],
        author: body.author ?? null,
        readme: body.readme ?? null,
        publishedAt: body.publishedAt ?? null,
        isPublic: body.isPublic ?? true,
      })
      return c.json({ data: entry }, 201)
    } catch (error) {
      if (error instanceof CatalogSlugConflictError) {
        return c.json(
          { error: { code: 'SLUG_CONFLICT', message: error.message } },
          409,
        )
      }
      throw error
    }
  })

  // --- Search catalog ---
  app.get('/catalog', async (c) => {
    const q = c.req.query('q') ?? undefined
    const tagsParam = c.req.query('tags')
    const tags = tagsParam ? tagsParam.split(',').map((t) => t.trim()).filter(Boolean) : undefined
    const author = c.req.query('author') ?? undefined
    const page = c.req.query('page') ? parseInt(c.req.query('page')!, 10) : undefined
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined

    const result = await catalogStore.search({ q, tags, author, page, limit })
    return c.json({
      data: result.items,
      total: result.total,
      page: Math.max(page ?? 1, 1),
      limit: Math.min(Math.max(limit ?? 20, 1), 100),
    })
  })

  // --- Get by slug (before :id to avoid conflict) ---
  app.get('/catalog/by-slug/:slug', async (c) => {
    const entry = await catalogStore.getBySlug(c.req.param('slug'))
    if (!entry) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Catalog entry not found' } },
        404,
      )
    }
    return c.json({ data: entry })
  })

  // --- Get by ID ---
  app.get('/catalog/:id', async (c) => {
    const entry = await catalogStore.getById(c.req.param('id'))
    if (!entry) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Catalog entry not found' } },
        404,
      )
    }
    return c.json({ data: entry })
  })

  // --- Update ---
  app.patch('/catalog/:id', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json<{
      slug?: string
      name?: string
      description?: string | null
      version?: string
      tags?: string[]
      author?: string | null
      readme?: string | null
      publishedAt?: string | null
      isPublic?: boolean
    }>()

    if (body.version !== undefined && !SEMVER_RE.test(body.version)) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'version must be valid semver (e.g. 1.0.0)' } },
        400,
      )
    }

    try {
      const entry = await catalogStore.update(id, body)
      return c.json({ data: entry })
    } catch (error) {
      if (error instanceof CatalogNotFoundError) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: 'Catalog entry not found' } },
          404,
        )
      }
      if (error instanceof CatalogSlugConflictError) {
        return c.json(
          { error: { code: 'SLUG_CONFLICT', message: error.message } },
          409,
        )
      }
      throw error
    }
  })

  // --- Delete ---
  app.delete('/catalog/:id', async (c) => {
    const id = c.req.param('id')
    try {
      await catalogStore.delete(id)
      return c.json({ data: { id, deleted: true } })
    } catch (error) {
      if (error instanceof CatalogNotFoundError) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: 'Catalog entry not found' } },
          404,
        )
      }
      throw error
    }
  })

  return app
}
