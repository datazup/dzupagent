/**
 * Drizzle-backed CatalogStore implementation for PostgreSQL.
 *
 * Uses the `agent_catalog` table defined in the Drizzle schema and
 * implements full-text ILIKE search and Postgres array overlap filtering.
 */
import { eq, and, ilike, or, count, arrayOverlaps } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { agentCatalog } from '../persistence/drizzle-schema.js'
import type {
  CatalogStore,
  CatalogEntry,
  CatalogEntryCreate,
  CatalogEntryPatch,
  CatalogSearchQuery,
  CatalogSearchResult,
} from './catalog-store.js'
import { CatalogNotFoundError, CatalogSlugConflictError } from './catalog-store.js'

function rowToEntry(row: typeof agentCatalog.$inferSelect): CatalogEntry {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    version: row.version,
    tags: row.tags ?? [],
    author: row.author,
    readme: row.readme,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    isPublic: row.isPublic,
    tenantId: row.tenantId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export class DrizzleCatalogStore implements CatalogStore {
  constructor(private readonly db: PostgresJsDatabase) {}

  async create(entry: CatalogEntryCreate): Promise<CatalogEntry> {
    const id = entry.id ?? crypto.randomUUID()

    try {
      const [row] = await this.db
        .insert(agentCatalog)
        .values({
          id,
          slug: entry.slug,
          name: entry.name,
          description: entry.description,
          version: entry.version,
          tags: entry.tags ?? [],
          author: entry.author,
          readme: entry.readme,
          publishedAt: entry.publishedAt ? new Date(entry.publishedAt) : null,
          isPublic: entry.isPublic ?? true,
          tenantId: entry.tenantId ?? 'default',
        })
        .returning()

      return rowToEntry(row!)
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new CatalogSlugConflictError(entry.slug)
      }
      throw error
    }
  }

  async getById(id: string, tenantId?: string): Promise<CatalogEntry | null> {
    const conditions = [eq(agentCatalog.id, id)]
    if (tenantId !== undefined) conditions.push(eq(agentCatalog.tenantId, tenantId))

    const [row] = await this.db
      .select()
      .from(agentCatalog)
      .where(and(...conditions))
      .limit(1)
    return row ? rowToEntry(row) : null
  }

  async getBySlug(slug: string, tenantId?: string): Promise<CatalogEntry | null> {
    const conditions = [eq(agentCatalog.slug, slug)]
    if (tenantId !== undefined) conditions.push(eq(agentCatalog.tenantId, tenantId))

    const [row] = await this.db
      .select()
      .from(agentCatalog)
      .where(and(...conditions))
      .limit(1)
    return row ? rowToEntry(row) : null
  }

  async update(id: string, patch: CatalogEntryPatch, tenantId?: string): Promise<CatalogEntry> {
    const values: Record<string, unknown> = { updatedAt: new Date() }

    if (patch.slug !== undefined) values['slug'] = patch.slug
    if (patch.name !== undefined) values['name'] = patch.name
    if (patch.description !== undefined) values['description'] = patch.description
    if (patch.version !== undefined) values['version'] = patch.version
    if (patch.tags !== undefined) values['tags'] = patch.tags
    if (patch.author !== undefined) values['author'] = patch.author
    if (patch.readme !== undefined) values['readme'] = patch.readme
    if (patch.publishedAt !== undefined) {
      values['publishedAt'] = patch.publishedAt ? new Date(patch.publishedAt) : null
    }
    if (patch.isPublic !== undefined) values['isPublic'] = patch.isPublic
    if (patch.tenantId !== undefined) values['tenantId'] = patch.tenantId

    const conditions = [eq(agentCatalog.id, id)]
    if (tenantId !== undefined) conditions.push(eq(agentCatalog.tenantId, tenantId))

    try {
      const [row] = await this.db
        .update(agentCatalog)
        .set(values)
        .where(and(...conditions))
        .returning()

      if (!row) throw new CatalogNotFoundError(id)
      return rowToEntry(row)
    } catch (error: unknown) {
      if (error instanceof CatalogNotFoundError) throw error
      if (isUniqueViolation(error)) {
        throw new CatalogSlugConflictError(patch.slug ?? '')
      }
      throw error
    }
  }

  async delete(id: string, tenantId?: string): Promise<void> {
    const conditions = [eq(agentCatalog.id, id)]
    if (tenantId !== undefined) conditions.push(eq(agentCatalog.tenantId, tenantId))

    const result = await this.db
      .delete(agentCatalog)
      .where(and(...conditions))
      .returning({ id: agentCatalog.id })
    if (result.length === 0) {
      throw new CatalogNotFoundError(id)
    }
  }

  async search(query: CatalogSearchQuery): Promise<CatalogSearchResult> {
    const conditions = []

    // Text search — ILIKE on name + description
    if (query.q) {
      const pattern = `%${query.q}%`
      conditions.push(
        or(
          ilike(agentCatalog.name, pattern),
          ilike(agentCatalog.description, pattern),
        ),
      )
    }

    // Tag filter — Postgres array overlap (&&)
    if (query.tags && query.tags.length > 0) {
      conditions.push(arrayOverlaps(agentCatalog.tags, query.tags))
    }

    // Author filter
    if (query.author) {
      conditions.push(eq(agentCatalog.author, query.author))
    }
    if (query.tenantId) {
      conditions.push(eq(agentCatalog.tenantId, query.tenantId))
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined

    // Count total
    const [countRow] = await this.db
      .select({ total: count() })
      .from(agentCatalog)
      .where(where)

    const total = countRow?.total ?? 0

    // Fetch page
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100)
    const page = Math.max(query.page ?? 1, 1)
    const offset = (page - 1) * limit

    const rows = await this.db
      .select()
      .from(agentCatalog)
      .where(where)
      .orderBy(agentCatalog.createdAt)
      .limit(limit)
      .offset(offset)

    return {
      items: rows.map(rowToEntry),
      total,
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === '23505'
  )
}
