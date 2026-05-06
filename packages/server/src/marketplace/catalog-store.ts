/**
 * Catalog store — interface and in-memory implementation for marketplace
 * agent catalog entries.
 *
 * A catalog entry represents a published agent definition available in the
 * marketplace for discovery and (future) installation.
 */

export interface CatalogEntry {
  id: string
  slug: string
  name: string
  description: string | null
  version: string
  tags: string[]
  author: string | null
  readme: string | null
  publishedAt: string | null
  isPublic: boolean
  tenantId?: string | null
  createdAt: string
  updatedAt: string
}

export type CatalogEntryCreate = Omit<CatalogEntry, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string
}

export type CatalogEntryPatch = Partial<Omit<CatalogEntry, 'id' | 'createdAt' | 'updatedAt'>>

export interface CatalogSearchQuery {
  /** Text search — ILIKE on name + description. */
  q?: string
  /** Filter by tag array overlap. */
  tags?: string[]
  /** Filter by author. */
  author?: string
  /** Restrict search to a single tenant scope. */
  tenantId?: string
  /** Page number (1-based). Default: 1. */
  page?: number
  /** Items per page. Default: 20, max: 100. */
  limit?: number
}

export interface CatalogSearchResult {
  items: CatalogEntry[]
  total: number
}

export interface CatalogStore {
  create(entry: CatalogEntryCreate): Promise<CatalogEntry>
  getById(id: string, tenantId?: string): Promise<CatalogEntry | null>
  getBySlug(slug: string, tenantId?: string): Promise<CatalogEntry | null>
  update(id: string, patch: CatalogEntryPatch, tenantId?: string): Promise<CatalogEntry>
  delete(id: string, tenantId?: string): Promise<void>
  search(query: CatalogSearchQuery): Promise<CatalogSearchResult>
}

const DEFAULT_TENANT_ID = 'default'

function normalizeTenantId(tenantId: string | null | undefined): string {
  return tenantId ?? DEFAULT_TENANT_ID
}

/**
 * In-memory catalog store for development and testing.
 */
export class InMemoryCatalogStore implements CatalogStore {
  private readonly entries = new Map<string, CatalogEntry>()

  async create(entry: CatalogEntryCreate): Promise<CatalogEntry> {
    const now = new Date().toISOString()
    const id = entry.id ?? crypto.randomUUID()
    const tenantId = normalizeTenantId(entry.tenantId)

    // Slugs are tenant-scoped; different tenants may publish the same slug.
    for (const existing of this.entries.values()) {
      if (existing.slug === entry.slug && normalizeTenantId(existing.tenantId) === tenantId) {
        throw new CatalogSlugConflictError(entry.slug)
      }
    }

    const record: CatalogEntry = {
      id,
      slug: entry.slug,
      name: entry.name,
      description: entry.description ?? null,
      version: entry.version,
      tags: entry.tags ?? [],
      author: entry.author ?? null,
      readme: entry.readme ?? null,
      publishedAt: entry.publishedAt ?? null,
      isPublic: entry.isPublic ?? true,
      tenantId,
      createdAt: now,
      updatedAt: now,
    }
    this.entries.set(id, record)
    return record
  }

  async getById(id: string, tenantId?: string): Promise<CatalogEntry | null> {
    const entry = this.entries.get(id) ?? null
    if (!entry) return null
    if (tenantId && (entry.tenantId ?? 'default') !== tenantId) return null
    return entry
  }

  async getBySlug(slug: string, tenantId?: string): Promise<CatalogEntry | null> {
    for (const entry of this.entries.values()) {
      if (entry.slug === slug && (tenantId === undefined || (entry.tenantId ?? 'default') === tenantId)) {
        return entry
      }
    }
    return null
  }

  async update(id: string, patch: CatalogEntryPatch, tenantId?: string): Promise<CatalogEntry> {
    const existing = await this.getById(id, tenantId)
    if (!existing) {
      throw new CatalogNotFoundError(id)
    }
    const scopedPatch: CatalogEntryPatch = tenantId === undefined
      ? patch
      : (({ tenantId: _ignoredTenantId, ...rest }) => rest)(patch)
    const targetTenantId = normalizeTenantId(scopedPatch.tenantId ?? existing.tenantId)

    // Check slug uniqueness if slug is being changed
    if (scopedPatch.slug && scopedPatch.slug !== existing.slug) {
      for (const other of this.entries.values()) {
        if (
          other.slug === scopedPatch.slug &&
          other.id !== id &&
          normalizeTenantId(other.tenantId) === targetTenantId
        ) {
          throw new CatalogSlugConflictError(scopedPatch.slug)
        }
      }
    }

    const updated: CatalogEntry = {
      ...existing,
      ...scopedPatch,
      id: existing.id,
      tenantId: targetTenantId,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }
    this.entries.set(id, updated)
    return updated
  }

  async delete(id: string, tenantId?: string): Promise<void> {
    if (!(await this.getById(id, tenantId))) {
      throw new CatalogNotFoundError(id)
    }
    this.entries.delete(id)
  }

  async search(query: CatalogSearchQuery): Promise<CatalogSearchResult> {
    let results = Array.from(this.entries.values())

    // Text search — case-insensitive on name + description
    if (query.q) {
      const q = query.q.toLowerCase()
      results = results.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          (e.description?.toLowerCase().includes(q) ?? false),
      )
    }

    // Tag filter — overlap (entry has at least one of the requested tags)
    if (query.tags && query.tags.length > 0) {
      const tagSet = new Set(query.tags)
      results = results.filter((e) => e.tags.some((t) => tagSet.has(t)))
    }

    // Author filter
    if (query.author) {
      results = results.filter((e) => e.author === query.author)
    }
    if (query.tenantId) {
      results = results.filter((e) => (e.tenantId ?? 'default') === query.tenantId)
    }

    const total = results.length
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100)
    const page = Math.max(query.page ?? 1, 1)
    const offset = (page - 1) * limit
    const items = results.slice(offset, offset + limit)

    return { items, total }
  }
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class CatalogNotFoundError extends Error {
  readonly code = 'CATALOG_NOT_FOUND'
  constructor(id: string) {
    super(`Catalog entry not found: ${id}`)
    this.name = 'CatalogNotFoundError'
  }
}

export class CatalogSlugConflictError extends Error {
  readonly code = 'SLUG_CONFLICT'
  constructor(slug: string) {
    super(`Slug already exists: ${slug}`)
    this.name = 'CatalogSlugConflictError'
  }
}
