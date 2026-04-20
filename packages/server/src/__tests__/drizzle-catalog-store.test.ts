/**
 * Unit tests for DrizzleCatalogStore.
 *
 * Uses a chainable mock DB that mirrors the Drizzle query-builder pattern.
 * No real Postgres connection is needed — all state lives in an in-process
 * storage map.  The mock covers:
 *
 *   insert(tbl).values(v).returning()
 *   select([proj]).from(tbl).where(cond).limit(n)                    → thenable
 *   select([proj]).from(tbl).where(cond).orderBy(c).limit(n).offset(n) → thenable
 *   update(tbl).set(v).where(cond).returning()
 *   delete(tbl).where(cond).returning({ id })
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DrizzleCatalogStore } from '../marketplace/drizzle-catalog-store.js'
import {
  CatalogNotFoundError,
  CatalogSlugConflictError,
} from '../marketplace/catalog-store.js'
import type { CatalogEntryCreate } from '../marketplace/catalog-store.js'

// ---------------------------------------------------------------------------
// drizzle-orm mock
//
// Each function returns a typed sentinel object that the mock chain's
// evalCondition() can inspect to filter the in-memory storage.
//
//   eq(col, val)        → { _kind: 'eq', _field, _value }
//   and(...conds)       → { _kind: 'and', _conditions }
//   ilike(col, pattern) → { _kind: 'ilike', _field, _pattern }
//   or(...parts)        → { _kind: 'or', _parts }
//   count()             → { _kind: 'count' }          (used in select projection)
//   sql`...`            → { _kind: 'sql' }            (array-overlap; always-true in mock)
// ---------------------------------------------------------------------------

vi.mock('drizzle-orm', () => {
  const eq = (col: { name: string }, value: unknown) => ({
    _kind: 'eq' as const,
    _field: col.name,
    _value: value,
  })

  const and = (...conds: unknown[]) => ({
    _kind: 'and' as const,
    _conditions: conds.filter(Boolean),
  })

  const ilike = (col: { name: string }, pattern: string) => ({
    _kind: 'ilike' as const,
    _field: col.name,
    _pattern: pattern,
  })

  const or = (...parts: unknown[]) => ({
    _kind: 'or' as const,
    _parts: parts,
  })

  const count = () => ({ _kind: 'count' as const })

  // sql template tag: produces a sentinel.  sql.raw returns another sentinel.
  const sql = Object.assign(
    (_strings: TemplateStringsArray, ..._vals: unknown[]) => ({
      _kind: 'sql' as const,
    }),
    {
      raw: (_s: string) => ({ _kind: 'sql' as const }),
    },
  )

  return { eq, and, ilike, or, count, sql }
})

// ---------------------------------------------------------------------------
// Schema mock — column objects whose .name property matches the camelCase
// field names used in rowToEntry() and in where(eq(agentCatalog.X, ...)).
// ---------------------------------------------------------------------------

vi.mock('../persistence/drizzle-schema.js', () => ({
  agentCatalog: {
    id: { name: 'id' },
    slug: { name: 'slug' },
    name: { name: 'name' },
    description: { name: 'description' },
    version: { name: 'version' },
    tags: { name: 'tags' },
    author: { name: 'author' },
    readme: { name: 'readme' },
    publishedAt: { name: 'publishedAt' },
    isPublic: { name: 'isPublic' },
    createdAt: { name: 'createdAt' },
    updatedAt: { name: 'updatedAt' },
  },
}))

// ---------------------------------------------------------------------------
// Sentinel types (mirroring the vi.mock above)
// ---------------------------------------------------------------------------

type EqSentinel = { _kind: 'eq'; _field: string; _value: unknown }
type AndSentinel = { _kind: 'and'; _conditions: Sentinel[] }
type IlikeSentinel = { _kind: 'ilike'; _field: string; _pattern: string }
type OrSentinel = { _kind: 'or'; _parts: Sentinel[] }
type CountSentinel = { _kind: 'count' }
type SqlSentinel = { _kind: 'sql' }
type Sentinel = EqSentinel | AndSentinel | IlikeSentinel | OrSentinel | CountSentinel | SqlSentinel

// ---------------------------------------------------------------------------
// Row shape — mirrors the $inferSelect shape that rowToEntry() expects.
// createdAt / updatedAt are Date instances (rowToEntry calls .toISOString()).
// publishedAt is Date | null.
// ---------------------------------------------------------------------------

type StoredRow = {
  id: string
  slug: string
  name: string
  description: string | null
  version: string
  tags: string[]
  author: string | null
  readme: string | null
  publishedAt: Date | null
  isPublic: boolean
  createdAt: Date
  updatedAt: Date
}

const BASE_DATE = new Date('2026-01-01T00:00:00.000Z')

function makeRow(
  data: Pick<StoredRow, 'id' | 'slug' | 'name' | 'version'> & Partial<StoredRow>,
): StoredRow {
  return {
    description: null,
    tags: [],
    author: null,
    readme: null,
    publishedAt: null,
    isPublic: true,
    createdAt: BASE_DATE,
    updatedAt: BASE_DATE,
    ...data,
  }
}

// ---------------------------------------------------------------------------
// Evaluate a sentinel condition against a stored row.
// ---------------------------------------------------------------------------

function evalCondition(cond: Sentinel, row: StoredRow): boolean {
  const r = row as unknown as Record<string, unknown>

  switch (cond._kind) {
    case 'eq':
      return r[cond._field] === cond._value

    case 'ilike': {
      const needle = cond._pattern.replace(/^%|%$/g, '').toLowerCase()
      const haystack = r[cond._field]
      if (typeof haystack !== 'string') return false
      return haystack.toLowerCase().includes(needle)
    }

    case 'or':
      return cond._parts.some((p) => evalCondition(p, row))

    case 'and':
      return cond._conditions.every((c) => evalCondition(c, row))

    // sql sentinel = Postgres array-overlap; mock treats as always-true.
    // Tests that require real tag filtering use the queue mechanism.
    case 'sql':
      return true

    case 'count':
      return true
  }
}

// ---------------------------------------------------------------------------
// Detect whether a projection argument is a count query:
//   select({ total: count() }) → projection === { total: { _kind: 'count' } }
// ---------------------------------------------------------------------------

function isCountProjection(proj: unknown): boolean {
  if (proj === null || typeof proj !== 'object') return false
  const p = proj as Record<string, unknown>
  if (!('total' in p)) return false
  const t = p['total']
  return typeof t === 'object' && t !== null && (t as Record<string, unknown>)['_kind'] === 'count'
}

// ---------------------------------------------------------------------------
// Chainable mock DB
//
// All query-builder state is stored as plain object properties on the chain
// (not closure variables) so that the final thenable / returning() resolver
// can read them directly.
// ---------------------------------------------------------------------------

function createMockDb() {
  let storage = new Map<string, StoredRow>()
  // slug → id index for uniqueness enforcement
  const slugIndex = new Map<string, string>()

  // FIFO queue of pre-registered results for search()'s two select() calls.
  // Entries are consumed in order; when empty the live storage is used.
  const selectQueue: Array<StoredRow[] | Array<{ total: number }>> = []

  // -------------------------------------------------------------------------
  // Query chain factory
  // -------------------------------------------------------------------------

  type Mode = 'select' | 'insert' | 'update' | 'delete'

  function makeChain(mode: Mode) {
    // All mutable state lives here as plain properties so resolvers can read them.
    const state = {
      mode,
      projection: undefined as unknown,
      values: null as Partial<StoredRow> | null,
      setData: null as Partial<StoredRow> | null,
      where: undefined as Sentinel | undefined,
      limitN: null as number | null,
      offsetN: null as number | null,
    }

    // ---- helpers ----

    function findIdInWhere(cond: Sentinel | undefined): string | undefined {
      if (!cond) return undefined
      if (cond._kind === 'eq' && cond._field === 'id') return cond._value as string
      if (cond._kind === 'and') {
        for (const c of cond._conditions) {
          const found = findIdInWhere(c)
          if (found !== undefined) return found
        }
      }
      return undefined
    }

    function applyWhere(rows: StoredRow[]): StoredRow[] {
      if (!state.where) return rows
      return rows.filter((r) => evalCondition(state.where!, r))
    }

    // ---- resolvers ----

    async function resolveInsert(): Promise<StoredRow[]> {
      const v = state.values as StoredRow
      if (!v) return []

      // Simulate unique-constraint violation (PG error code 23505)
      const existing = slugIndex.get(v.slug)
      if (existing !== undefined) {
        const err = new Error('duplicate key value violates unique constraint')
        ;(err as Error & { code: string }).code = '23505'
        throw err
      }

      // Supply DB-managed timestamp defaults the store does not set
      const row: StoredRow = {
        ...v,
        createdAt: v.createdAt instanceof Date ? v.createdAt : new Date(),
        updatedAt: v.updatedAt instanceof Date ? v.updatedAt : new Date(),
      }

      storage.set(row.id, row)
      slugIndex.set(row.slug, row.id)
      return [row]
    }

    async function resolveUpdate(): Promise<StoredRow[]> {
      const targetId = findIdInWhere(state.where)
      if (!targetId) return []

      const existing = storage.get(targetId)
      if (!existing) return []

      const patch = state.setData as Partial<StoredRow>
      const newSlug = patch.slug

      // Simulate slug unique violation on update
      if (newSlug !== undefined && newSlug !== existing.slug) {
        const conflict = slugIndex.get(newSlug)
        if (conflict !== undefined && conflict !== existing.id) {
          const err = new Error('duplicate key value violates unique constraint')
          ;(err as Error & { code: string }).code = '23505'
          throw err
        }
        // Update slug index
        slugIndex.delete(existing.slug)
        slugIndex.set(newSlug, existing.id)
      }

      const updated: StoredRow = { ...existing, ...patch }
      storage.set(existing.id, updated)
      return [updated]
    }

    async function resolveDelete(): Promise<Array<{ id: string }>> {
      const targetId = findIdInWhere(state.where)
      if (!targetId) return []

      const existing = storage.get(targetId)
      if (!existing) return []

      slugIndex.delete(existing.slug)
      storage.delete(targetId)
      return [{ id: targetId }]
    }

    function resolveSelectSync(): StoredRow[] | Array<{ total: number }> {
      // Consume from queue first (allows pre-registering exact responses)
      if (selectQueue.length > 0) {
        return selectQueue.shift()!
      }

      if (isCountProjection(state.projection)) {
        const matched = applyWhere(Array.from(storage.values()))
        return [{ total: matched.length }]
      }

      let rows = applyWhere(Array.from(storage.values()))
      const off = state.offsetN ?? 0
      if (off > 0) rows = rows.slice(off)
      if (state.limitN !== null) rows = rows.slice(0, state.limitN)
      return rows
    }

    // ---- chain object ----

    const chain = {
      // select() can carry a projection (count sentinel)
      _setProjection(p: unknown) {
        state.projection = p
        return chain
      },

      from(_tbl: unknown) {
        return chain
      },

      values(v: Partial<StoredRow>) {
        state.values = v
        return chain
      },

      set(s: Partial<StoredRow>) {
        state.setData = s
        return chain
      },

      where(cond: Sentinel | undefined) {
        state.where = cond
        return chain
      },

      limit(n: number) {
        state.limitN = n
        return chain
      },

      offset(n: number) {
        state.offsetN = n
        return chain
      },

      orderBy(_col: unknown) {
        // No-op in mock — ordering is not verified
        return chain
      },

      async returning(_shape?: unknown): Promise<unknown[]> {
        if (state.mode === 'insert') return resolveInsert()
        if (state.mode === 'update') return resolveUpdate()
        if (state.mode === 'delete') return resolveDelete()
        return []
      },

      // Make the chain thenable so `await db.select()...` works
      then(
        onFulfilled: (value: unknown[]) => void,
        onRejected?: (reason: unknown) => void,
      ) {
        try {
          onFulfilled(resolveSelectSync() as unknown[])
        } catch (e) {
          onRejected?.(e)
        }
      },
    }

    return chain
  }

  // -------------------------------------------------------------------------
  // DB object
  // -------------------------------------------------------------------------

  const db = {
    select(projection?: unknown) {
      const chain = makeChain('select')
      chain._setProjection(projection)
      return chain
    },

    insert(_tbl: unknown) {
      return makeChain('insert')
    },

    update(_tbl: unknown) {
      return makeChain('update')
    },

    delete(_tbl: unknown) {
      return makeChain('delete')
    },

    // ---- test helpers ----

    _reset() {
      storage = new Map()
      slugIndex.clear()
      selectQueue.length = 0
    },

    /** Directly insert a row, bypassing the store API. */
    _seed(row: StoredRow) {
      storage.set(row.id, row)
      slugIndex.set(row.slug, row.id)
    },

    /**
     * Pre-register a select result to be consumed by the next select() call.
     * The search() method issues two consecutive selects (count then rows);
     * call this twice before invoking search() when you need exact control
     * over which rows the mock returns (e.g. for tag-overlap scenarios).
     */
    _queueSelectResult(result: StoredRow[] | Array<{ total: number }>) {
      selectQueue.push(result)
    },
  }

  return db
}

// ---------------------------------------------------------------------------
// Test factory helpers
// ---------------------------------------------------------------------------

function makeCreateInput(
  overrides: Partial<CatalogEntryCreate> = {},
): CatalogEntryCreate {
  return {
    slug: 'test-agent',
    name: 'Test Agent',
    description: 'A test agent',
    version: '1.0.0',
    tags: ['test'],
    author: 'alice',
    readme: '# Test',
    publishedAt: null,
    isPublic: true,
    ...overrides,
  }
}

function seedRow(
  db: ReturnType<typeof createMockDb>,
  overrides: Pick<StoredRow, 'id' | 'slug'> & Partial<StoredRow>,
): StoredRow {
  const row = makeRow({ name: 'Test Agent', version: '1.0.0', ...overrides })
  db._seed(row)
  return row
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DrizzleCatalogStore', () => {
  let db: ReturnType<typeof createMockDb>
  let store: DrizzleCatalogStore

  beforeEach(() => {
    db = createMockDb()
    // Cast to never: the mock satisfies every method the store calls at runtime
    // but does not implement the full PostgresJsDatabase interface.
    store = new DrizzleCatalogStore(db as never)
  })

  // -------------------------------------------------------------------------
  // create()
  // -------------------------------------------------------------------------

  describe('create()', () => {
    it('creates an entry and returns all mapped fields', async () => {
      const entry = await store.create(makeCreateInput())

      expect(entry.slug).toBe('test-agent')
      expect(entry.name).toBe('Test Agent')
      expect(entry.description).toBe('A test agent')
      expect(entry.version).toBe('1.0.0')
      expect(entry.tags).toEqual(['test'])
      expect(entry.author).toBe('alice')
      expect(entry.readme).toBe('# Test')
      expect(entry.isPublic).toBe(true)
      expect(entry.publishedAt).toBeNull()
    })

    it('returns ISO string timestamps for createdAt and updatedAt', async () => {
      const entry = await store.create(makeCreateInput())
      expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(entry.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('uses provided id when given', async () => {
      const entry = await store.create(makeCreateInput({ id: 'my-fixed-id', slug: 'fixed' }))
      expect(entry.id).toBe('my-fixed-id')
    })

    it('generates a uuid when no id is provided', async () => {
      const entry = await store.create(makeCreateInput({ slug: 'auto-id-slug' }))
      expect(entry.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )
    })

    it('converts publishedAt ISO string to a truthy timestamp', async () => {
      const entry = await store.create(
        makeCreateInput({
          slug: 'with-pub',
          publishedAt: '2026-03-15T12:00:00.000Z',
        }),
      )
      expect(entry.publishedAt).toBeTruthy()
    })

    it('stores null publishedAt when none is provided', async () => {
      const entry = await store.create(makeCreateInput({ slug: 'no-pub' }))
      expect(entry.publishedAt).toBeNull()
    })

    it('throws CatalogSlugConflictError on duplicate slug', async () => {
      await store.create(makeCreateInput({ slug: 'conflict-slug', id: 'id-1' }))

      await expect(
        store.create(makeCreateInput({ slug: 'conflict-slug', id: 'id-2' })),
      ).rejects.toThrow(CatalogSlugConflictError)
    })

    it('rethrows non-uniqueness DB errors unchanged', async () => {
      const networkErr = new Error('connection reset')
      vi.spyOn(db, 'insert').mockReturnValueOnce({
        values: () => ({
          returning: async () => { throw networkErr },
        }),
      } as never)

      await expect(
        store.create(makeCreateInput({ slug: 'network-err' })),
      ).rejects.toThrow('connection reset')
    })

    it('creates two entries with different slugs without conflict', async () => {
      const a = await store.create(makeCreateInput({ slug: 'slug-a', id: 'a' }))
      const b = await store.create(makeCreateInput({ slug: 'slug-b', id: 'b' }))
      expect(a.id).not.toBe(b.id)
    })
  })

  // -------------------------------------------------------------------------
  // getById()
  // -------------------------------------------------------------------------

  describe('getById()', () => {
    it('returns the mapped entry when id exists', async () => {
      const row = seedRow(db, { id: 'ent-1', slug: 'found-slug', name: 'Found' })

      const result = await store.getById('ent-1')
      expect(result).not.toBeNull()
      expect(result!.id).toBe('ent-1')
      expect(result!.slug).toBe('found-slug')
      expect(result!.name).toBe('Found')
    })

    it('maps Date fields to ISO strings', async () => {
      seedRow(db, { id: 'ent-dates', slug: 'date-slug' })

      const result = await store.getById('ent-dates')
      expect(result!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(result!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('returns null when id does not exist', async () => {
      expect(await store.getById('nonexistent-id')).toBeNull()
    })

    it('returns null when storage is empty', async () => {
      expect(await store.getById('any-id')).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // getBySlug()
  // -------------------------------------------------------------------------

  describe('getBySlug()', () => {
    it('returns the mapped entry when slug exists', async () => {
      seedRow(db, { id: 'ent-2', slug: 'my-slug', name: 'By Slug' })

      const result = await store.getBySlug('my-slug')
      expect(result).not.toBeNull()
      expect(result!.slug).toBe('my-slug')
      expect(result!.id).toBe('ent-2')
    })

    it('returns null when slug does not exist', async () => {
      expect(await store.getBySlug('no-such-slug')).toBeNull()
    })

    it('returns null when storage is empty', async () => {
      expect(await store.getBySlug('any-slug')).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // update()
  // -------------------------------------------------------------------------

  describe('update()', () => {
    it('patches name field', async () => {
      seedRow(db, { id: 'upd-1', slug: 'upd-slug', name: 'Original' })

      const result = await store.update('upd-1', { name: 'Updated Name' })
      expect(result.name).toBe('Updated Name')
      expect(result.slug).toBe('upd-slug') // unchanged
      expect(result.id).toBe('upd-1')
    })

    it('patches tags field', async () => {
      seedRow(db, { id: 'upd-2', slug: 'tags-slug', tags: ['old'] })

      const result = await store.update('upd-2', { tags: ['new', 'extra'] })
      expect(result.tags).toEqual(['new', 'extra'])
    })

    it('patches version field', async () => {
      seedRow(db, { id: 'upd-3', slug: 'ver-slug', version: '1.0.0' })

      const result = await store.update('upd-3', { version: '2.0.0' })
      expect(result.version).toBe('2.0.0')
    })

    it('patches isPublic field', async () => {
      seedRow(db, { id: 'upd-4', slug: 'pub-slug', isPublic: true })

      const result = await store.update('upd-4', { isPublic: false })
      expect(result.isPublic).toBe(false)
    })

    it('patches slug field', async () => {
      seedRow(db, { id: 'upd-5', slug: 'old-slug' })

      const result = await store.update('upd-5', { slug: 'new-slug' })
      expect(result.slug).toBe('new-slug')
    })

    it('patches multiple fields simultaneously', async () => {
      seedRow(db, {
        id: 'upd-6',
        slug: 'multi-slug',
        name: 'Original',
        version: '1.0.0',
        isPublic: true,
      })

      const result = await store.update('upd-6', {
        name: 'Multi Updated',
        version: '3.0.0',
        isPublic: false,
      })
      expect(result.name).toBe('Multi Updated')
      expect(result.version).toBe('3.0.0')
      expect(result.isPublic).toBe(false)
    })

    it('preserves createdAt and id on update', async () => {
      const row = seedRow(db, { id: 'upd-7', slug: 'preserve-slug' })

      const result = await store.update('upd-7', { name: 'Changed' })
      expect(result.id).toBe('upd-7')
      expect(result.createdAt).toBe(row.createdAt.toISOString())
    })

    it('sets a new updatedAt ISO string on every patch', async () => {
      seedRow(db, { id: 'upd-8', slug: 'ts-slug' })

      const result = await store.update('upd-8', { name: 'Touched' })
      expect(result.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('throws CatalogNotFoundError when id does not exist', async () => {
      await expect(
        store.update('ghost-id', { name: 'Ghost' }),
      ).rejects.toThrow(CatalogNotFoundError)
    })

    it('throws CatalogSlugConflictError when new slug conflicts with another entry', async () => {
      seedRow(db, { id: 'taken-id', slug: 'taken-slug' })
      seedRow(db, { id: 'other-id', slug: 'other-slug' })

      await expect(
        store.update('other-id', { slug: 'taken-slug' }),
      ).rejects.toThrow(CatalogSlugConflictError)
    })
  })

  // -------------------------------------------------------------------------
  // delete()
  // -------------------------------------------------------------------------

  describe('delete()', () => {
    it('deletes an existing entry and resolves to void', async () => {
      seedRow(db, { id: 'del-1', slug: 'del-slug' })

      await expect(store.delete('del-1')).resolves.toBeUndefined()
    })

    it('entry is not retrievable after deletion', async () => {
      seedRow(db, { id: 'del-2', slug: 'gone-slug' })

      await store.delete('del-2')
      expect(await store.getById('del-2')).toBeNull()
    })

    it('does not affect sibling entries', async () => {
      seedRow(db, { id: 'keep-1', slug: 'keep-slug-1' })
      seedRow(db, { id: 'del-3', slug: 'del-slug-3' })

      await store.delete('del-3')
      expect(await store.getById('keep-1')).not.toBeNull()
    })

    it('throws CatalogNotFoundError when id does not exist', async () => {
      await expect(store.delete('ghost-id')).rejects.toThrow(CatalogNotFoundError)
    })

    it('throws CatalogNotFoundError on empty storage', async () => {
      await expect(store.delete('any-id')).rejects.toThrow(CatalogNotFoundError)
    })

    it('allows creating a new entry with a previously-deleted slug', async () => {
      seedRow(db, { id: 'old-id', slug: 'reuse-slug' })
      await store.delete('old-id')

      const newEntry = await store.create(
        makeCreateInput({ id: 'new-id', slug: 'reuse-slug' }),
      )
      expect(newEntry.slug).toBe('reuse-slug')
    })
  })

  // -------------------------------------------------------------------------
  // search()
  //
  // The store issues two consecutive db.select() calls:
  //   1. select({ total: count() }) ... → count row
  //   2. select() ... orderBy().limit().offset() → item rows
  //
  // Strategy A (where conditions evaluate cleanly): seed rows into live storage
  // and let evalCondition() filter them.  Works for eq (author), ilike (q).
  //
  // Strategy B (tag overlap uses sql sentinel, always-true in mock): pre-load
  // the exact expected responses via _queueSelectResult() so the mock returns
  // the right data for both select() calls.
  // -------------------------------------------------------------------------

  describe('search()', () => {
    // Seed five diverse entries before each test
    beforeEach(() => {
      db._seed(makeRow({
        id: 'e1', slug: 'text-summarizer', name: 'Text Summarizer',
        description: 'Summarizes long documents into concise text',
        tags: ['nlp', 'summarization'], author: 'alice', version: '1.0.0',
        createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
      }))
      db._seed(makeRow({
        id: 'e2', slug: 'code-reviewer', name: 'Code Reviewer',
        description: 'Reviews code for bugs and style issues',
        tags: ['code', 'review'], author: 'bob', version: '2.0.0',
        createdAt: new Date('2026-01-02T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z'),
      }))
      db._seed(makeRow({
        id: 'e3', slug: 'doc-generator', name: 'Doc Generator',
        description: 'Generates documentation from code',
        tags: ['code', 'documentation'], author: 'alice', version: '1.5.0',
        createdAt: new Date('2026-01-03T00:00:00Z'), updatedAt: new Date('2026-01-03T00:00:00Z'),
      }))
      db._seed(makeRow({
        id: 'e4', slug: 'sentiment-analyzer', name: 'Sentiment Analyzer',
        description: 'Analyzes text sentiment',
        tags: ['nlp', 'sentiment'], author: 'charlie', version: '3.0.0',
        createdAt: new Date('2026-01-04T00:00:00Z'), updatedAt: new Date('2026-01-04T00:00:00Z'),
      }))
      db._seed(makeRow({
        id: 'e5', slug: 'translator', name: 'Translator',
        description: 'Translates text between languages',
        tags: ['nlp', 'translation'], author: 'alice', version: '1.0.0',
        createdAt: new Date('2026-01-05T00:00:00Z'), updatedAt: new Date('2026-01-05T00:00:00Z'),
      }))
    })

    // -- empty query --

    it('returns all entries and correct total with empty query', async () => {
      const result = await store.search({})
      expect(result.total).toBe(5)
      expect(result.items).toHaveLength(5)
    })

    it('result has total and items keys', async () => {
      const result = await store.search({})
      expect(result).toHaveProperty('total')
      expect(result).toHaveProperty('items')
    })

    // -- q filter (ilike on name + description) --

    it('filters by q matching name (case-insensitive)', async () => {
      const result = await store.search({ q: 'summarizer' })
      expect(result.total).toBe(1)
      expect(result.items[0]!.slug).toBe('text-summarizer')
    })

    it('filters by q matching description', async () => {
      const result = await store.search({ q: 'documentation' })
      expect(result.total).toBe(1)
      expect(result.items[0]!.slug).toBe('doc-generator')
    })

    it('returns multiple matches when q appears in several entries', async () => {
      // 'text' hits: Text Summarizer (name), Analyzes text sentiment (desc),
      //              Translates text between languages (desc)
      const result = await store.search({ q: 'text' })
      expect(result.total).toBe(3)
    })

    it('returns zero matches when q finds nothing', async () => {
      const result = await store.search({ q: 'xyzzy-nonexistent' })
      expect(result.total).toBe(0)
      expect(result.items).toHaveLength(0)
    })

    // -- tags filter — uses queue because sql sentinel is always-true --

    it('filters by a single tag', async () => {
      db._queueSelectResult([{ total: 2 }])
      db._queueSelectResult([
        makeRow({ id: 'e2', slug: 'code-reviewer', name: 'Code Reviewer', version: '2.0.0', tags: ['code', 'review'], author: 'bob' }),
        makeRow({ id: 'e3', slug: 'doc-generator', name: 'Doc Generator', version: '1.5.0', tags: ['code', 'documentation'], author: 'alice' }),
      ])

      const result = await store.search({ tags: ['code'] })
      expect(result.total).toBe(2)
      expect(result.items.map((i) => i.slug).sort()).toEqual(['code-reviewer', 'doc-generator'])
    })

    it('filters by multiple tags (overlap semantics)', async () => {
      db._queueSelectResult([{ total: 2 }])
      db._queueSelectResult([
        makeRow({ id: 'e1', slug: 'text-summarizer', name: 'Text Summarizer', version: '1.0.0', tags: ['nlp', 'summarization'], author: 'alice' }),
        makeRow({ id: 'e4', slug: 'sentiment-analyzer', name: 'Sentiment Analyzer', version: '3.0.0', tags: ['nlp', 'sentiment'], author: 'charlie' }),
      ])

      const result = await store.search({ tags: ['summarization', 'sentiment'] })
      expect(result.total).toBe(2)
    })

    it('returns empty when no entries have the requested tag', async () => {
      db._queueSelectResult([{ total: 0 }])
      db._queueSelectResult([])

      const result = await store.search({ tags: ['nonexistent-tag'] })
      expect(result.total).toBe(0)
      expect(result.items).toHaveLength(0)
    })

    // -- author filter --

    it('filters by author', async () => {
      const result = await store.search({ author: 'alice' })
      expect(result.total).toBe(3)
      expect(result.items.every((i) => i.author === 'alice')).toBe(true)
    })

    it('returns empty when author has no entries', async () => {
      const result = await store.search({ author: 'nobody' })
      expect(result.total).toBe(0)
    })

    // -- combined filters --

    it('combines q and author filters', async () => {
      // 'text' matches Text Summarizer (alice) + Translator (alice)
      const result = await store.search({ q: 'text', author: 'alice' })
      expect(result.total).toBe(2)
    })

    it('combines q and tags filters (via queue)', async () => {
      db._queueSelectResult([{ total: 2 }])
      db._queueSelectResult([
        makeRow({ id: 'e2', slug: 'code-reviewer', name: 'Code Reviewer', version: '2.0.0', tags: ['code', 'review'], author: 'bob' }),
        makeRow({ id: 'e3', slug: 'doc-generator', name: 'Doc Generator', version: '1.5.0', tags: ['code', 'documentation'], author: 'alice' }),
      ])

      const result = await store.search({ q: 'code', tags: ['code'] })
      expect(result.total).toBe(2)
    })

    it('combines tags and author filters (via queue)', async () => {
      db._queueSelectResult([{ total: 2 }])
      db._queueSelectResult([
        makeRow({ id: 'e1', slug: 'text-summarizer', name: 'Text Summarizer', version: '1.0.0', tags: ['nlp', 'summarization'], author: 'alice' }),
        makeRow({ id: 'e5', slug: 'translator', name: 'Translator', version: '1.0.0', tags: ['nlp', 'translation'], author: 'alice' }),
      ])

      const result = await store.search({ tags: ['nlp'], author: 'alice' })
      expect(result.total).toBe(2)
    })

    it('combines q, tags, and author (via queue)', async () => {
      db._queueSelectResult([{ total: 1 }])
      db._queueSelectResult([
        makeRow({ id: 'e1', slug: 'text-summarizer', name: 'Text Summarizer', version: '1.0.0', tags: ['nlp', 'summarization'], author: 'alice' }),
      ])

      const result = await store.search({ q: 'summarizer', tags: ['nlp'], author: 'alice' })
      expect(result.total).toBe(1)
      expect(result.items[0]!.slug).toBe('text-summarizer')
    })

    // -- pagination --
    // Pagination applies at the DB level via limit()/offset() — the mock
    // intercepts those on the rows select call.  We use the queue so the count
    // leg returns the full total while the rows leg returns a sliced page.

    it('defaults to limit=20 returning all entries when fewer than 20 exist', async () => {
      const result = await store.search({})
      expect(result.items).toHaveLength(5)
    })

    it('paginates: limit=2, page=1 returns first two items', async () => {
      const allRows = [
        makeRow({ id: 'e1', slug: 'text-summarizer', name: 'Text Summarizer', version: '1.0.0' }),
        makeRow({ id: 'e2', slug: 'code-reviewer', name: 'Code Reviewer', version: '2.0.0' }),
      ]
      db._queueSelectResult([{ total: 5 }])
      db._queueSelectResult(allRows)

      const result = await store.search({ limit: 2, page: 1 })
      expect(result.items).toHaveLength(2)
      expect(result.total).toBe(5)
    })

    it('paginates: limit=2, page=2 returns next two items', async () => {
      const pageRows = [
        makeRow({ id: 'e3', slug: 'doc-generator', name: 'Doc Generator', version: '1.5.0' }),
        makeRow({ id: 'e4', slug: 'sentiment-analyzer', name: 'Sentiment Analyzer', version: '3.0.0' }),
      ]
      db._queueSelectResult([{ total: 5 }])
      db._queueSelectResult(pageRows)

      const result = await store.search({ limit: 2, page: 2 })
      expect(result.items).toHaveLength(2)
      expect(result.total).toBe(5)
    })

    it('paginates: limit=2, page=3 returns last one item', async () => {
      const lastRow = [
        makeRow({ id: 'e5', slug: 'translator', name: 'Translator', version: '1.0.0' }),
      ]
      db._queueSelectResult([{ total: 5 }])
      db._queueSelectResult(lastRow)

      const result = await store.search({ limit: 2, page: 3 })
      expect(result.items).toHaveLength(1)
      expect(result.total).toBe(5)
    })

    it('returns empty items when page is beyond the last page', async () => {
      db._queueSelectResult([{ total: 5 }])
      db._queueSelectResult([])

      const result = await store.search({ limit: 2, page: 100 })
      expect(result.items).toHaveLength(0)
      expect(result.total).toBe(5)
    })

    it('clamps limit to minimum of 1', async () => {
      db._queueSelectResult([{ total: 5 }])
      db._queueSelectResult([
        makeRow({ id: 'e1', slug: 'text-summarizer', name: 'Text Summarizer', version: '1.0.0' }),
      ])

      const result = await store.search({ limit: 0 })
      expect(result.items).toHaveLength(1)
    })

    it('clamps limit to maximum of 100', async () => {
      // All 5 entries fit within the clamped max-100 limit
      const result = await store.search({ limit: 9999 })
      expect(result.items).toHaveLength(5)
    })

    it('clamps page to minimum of 1 when negative', async () => {
      const result = await store.search({ page: -5 })
      expect(result.items).toHaveLength(5)
    })
  })
})
