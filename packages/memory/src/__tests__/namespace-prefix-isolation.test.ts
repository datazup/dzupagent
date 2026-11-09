/**
 * MC-05b (MEMCTX-PG-RETENTION-20261108-R1): segment-exact namespace isolation
 * for Postgres prefix reads and deletes.
 *
 * No database. `FakePostgresStore` reproduces the semantics of
 * `@langchain/langgraph-checkpoint-postgres` 1.0.4 that matter here
 * (`dist/store/modules/search-operations.cjs` `textSearch`,
 * `crud-operations.cjs`, `utils.cjs` `validateNamespace`):
 *
 * - rows are keyed by `namespace_path = labels.join(":")` plus `key`;
 * - `search(prefix)` is the string `LIKE '<prefix joined by ":">%'`, not a
 *   segment match;
 * - each returned namespace is rebuilt with `namespace_path.split(":")`;
 * - results are ordered `updated_at DESC` (with a query: score DESC, then
 *   `updated_at DESC`; the fake gives every match the same score);
 * - a query keeps rows whose `value::text` contains it (the `ILIKE` arm);
 * - items carry `createdAt`/`updatedAt`; `limit` defaults to 10;
 * - `delete` is a hard `DELETE ... WHERE namespace_path = $1 AND key = $2`.
 *
 * Every isolation claim holds only for labels without `:` (case g discloses
 * the colon alias as a known, unfixed defect).
 */
import { describe, it, expect } from 'vitest'
import type { BaseStore } from '@langchain/langgraph'
import { MemoryService } from '../memory-service.js'
import { getKeyedMemoryRecords } from '../memory-service-store.js'
import { MemoryPruner } from '../memory-pruner.js'
import { consolidateNamespace } from '../memory-consolidation.js'
import { TenantScopedStore } from '../tenant-scoped-store.js'
import { createStore } from '../store-factory.js'
import { namespaceEquals, namespaceUnder } from '../namespace-match.js'
import type {
  NamespaceConfig,
  SemanticMetadataFilter,
  SemanticStoreAdapter,
} from '../memory-types.js'

// ---------------------------------------------------------------------------
// Fake Postgres BaseStore
// ---------------------------------------------------------------------------

interface FakeRow {
  path: string
  key: string
  value: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

interface FakeItem {
  namespace: string[]
  key: string
  value: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

/** Mirror of `utils.cjs` `validateNamespace` (1.0.4). */
function validateNamespace(namespace: string[]): void {
  if (namespace.length === 0) throw new Error('Namespace cannot be empty.')
  for (const label of namespace) {
    if (typeof label !== 'string') throw new Error(`Invalid namespace label '${String(label)}'`)
    if (label.includes('.')) throw new Error(`Invalid namespace label '${label}': periods`)
    if (label === '') throw new Error('Namespace labels cannot be empty strings.')
    if (/[%_\\]/.test(label)) throw new Error(`Invalid namespace label '${label}': LIKE wildcard`)
  }
  if (namespace[0] === 'langgraph') throw new Error('Root label for namespace cannot be "langgraph".')
}

class FakePostgresStore {
  readonly rows = new Map<string, FakeRow>()
  readonly deletes: Array<{ path: string; key: string }> = []
  private clock = Date.now()

  private tick(): Date {
    // Strictly increasing so `updated_at DESC` is deterministic in tests.
    this.clock += 1
    return new Date(this.clock)
  }

  private static rowId(path: string, key: string): string {
    return JSON.stringify([path, key])
  }

  private static toItem(row: FakeRow): FakeItem {
    return {
      namespace: row.path.split(':'),
      key: row.key,
      value: row.value,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  async get(namespace: string[], key: string): Promise<FakeItem | null> {
    validateNamespace(namespace)
    const row = this.rows.get(FakePostgresStore.rowId(namespace.join(':'), key))
    return row ? FakePostgresStore.toItem(row) : null
  }

  async put(namespace: string[], key: string, value: Record<string, unknown> | null): Promise<void> {
    validateNamespace(namespace)
    const path = namespace.join(':')
    const id = FakePostgresStore.rowId(path, key)
    if (value === null) {
      this.rows.delete(id)
      return
    }
    const now = this.tick()
    const existing = this.rows.get(id)
    this.rows.set(id, {
      path,
      key,
      // JSONB round trip.
      value: JSON.parse(JSON.stringify(value)) as Record<string, unknown>,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
  }

  async delete(namespace: string[], key: string): Promise<void> {
    validateNamespace(namespace)
    const path = namespace.join(':')
    this.deletes.push({ path, key })
    this.rows.delete(FakePostgresStore.rowId(path, key))
  }

  async search(
    namespacePrefix: string[],
    options: { query?: string; limit?: number; offset?: number; filter?: Record<string, unknown> } = {},
  ): Promise<FakeItem[]> {
    validateNamespace(namespacePrefix)
    const like = namespacePrefix.join(':')
    const { limit = 10, offset = 0, query, filter } = options
    let rows = [...this.rows.values()].filter(r => r.path.startsWith(like))
    if (filter) {
      rows = rows.filter(r => Object.entries(filter).every(([k, v]) => r.value[k] === v))
    }
    if (query) {
      const q = query.toLowerCase()
      rows = rows.filter(r => JSON.stringify(r.value).toLowerCase().includes(q))
    }
    rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    return rows.slice(offset, offset + limit).map(FakePostgresStore.toItem)
  }

  /** Test helper: does a physical row exist at `namespace`/`key`? */
  has(namespace: string[], key: string): boolean {
    return this.rows.has(FakePostgresStore.rowId(namespace.join(':'), key))
  }

  asBaseStore(): BaseStore {
    return this as unknown as BaseStore
  }
}

/** A store that returns items without `namespace` (fail-closed fixtures). */
class NamespacelessStore extends FakePostgresStore {
  override async search(
    namespacePrefix: string[],
    options: { query?: string; limit?: number; offset?: number; filter?: Record<string, unknown> } = {},
  ): Promise<FakeItem[]> {
    const items = await super.search(namespacePrefix, options)
    return items.map(item => ({
      key: item.key,
      value: item.value,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }) as unknown as FakeItem)
  }
}

// ---------------------------------------------------------------------------
// Fake semantic store (provider-free)
// ---------------------------------------------------------------------------

function matchesSemanticFilter(
  meta: Record<string, unknown>,
  filter: SemanticMetadataFilter | undefined,
): boolean {
  if (!filter) return true
  if ('and' in filter) return filter.and.every(f => matchesSemanticFilter(meta, f))
  if ('or' in filter) return filter.or.some(f => matchesSemanticFilter(meta, f))
  if (filter.op === 'eq') return meta[filter.field] === filter.value
  throw new Error(`unsupported op in fake: ${filter.op}`)
}

class FakeSemanticStore implements SemanticStoreAdapter {
  readonly docs = new Map<string, Map<string, { text: string; metadata: Record<string, unknown> }>>()

  async ensureCollection(collection: string): Promise<void> {
    if (!this.docs.has(collection)) this.docs.set(collection, new Map())
  }

  async upsert(
    collection: string,
    docs: Array<{ id: string; text: string; metadata?: Record<string, unknown> }>,
  ): Promise<void> {
    const col = this.docs.get(collection)
    if (!col) throw new Error(`missing collection ${collection}`)
    for (const d of docs) col.set(d.id, { text: d.text, metadata: d.metadata ?? {} })
  }

  async search(
    collection: string,
    query: string,
    limit: number,
    filter?: SemanticMetadataFilter,
  ): Promise<Array<{ id: string; text: string; score: number; metadata: Record<string, unknown> }>> {
    const col = this.docs.get(collection)
    if (!col) throw new Error(`missing collection ${collection}`)
    const q = query.toLowerCase()
    return [...col.entries()]
      .filter(([, d]) => matchesSemanticFilter(d.metadata, filter) && d.text.toLowerCase().includes(q))
      .slice(0, limit)
      .map(([id, d]) => ({ id, text: d.text, score: 1, metadata: d.metadata }))
  }

  async delete(): Promise<void> { /* unused */ }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_NS: NamespaceConfig = { name: 'memories', scopeKeys: ['tenantId'], searchable: true }
const USER_NS: NamespaceConfig = { name: 'prefs', scopeKeys: ['tenantId', 'userId'], searchable: true }
/** Shares the name `memories` with TENANT_NS but has one more scope key. */
const CHILD_NS: NamespaceConfig = { name: 'memories', scopeKeys: ['tenantId', 'userId'], searchable: true }

function texts(records: Array<Record<string, unknown>>): string[] {
  return records.map(r => String(r['text'])).sort()
}

async function seedTenants(svc: MemoryService): Promise<void> {
  await svc.put('memories', { tenantId: 't1' }, 'a', { text: 'note of t1' })
  await svc.put('memories', { tenantId: 't10' }, 'b', { text: 'note of t10' })
  await svc.put('memories', { tenantId: 't10' }, 'c', { text: 'second note of t10' })
}

async function seedUsers(svc: MemoryService): Promise<void> {
  await svc.put('prefs', { tenantId: 'acme', userId: 'u1' }, 'p', { text: 'note of u1' })
  await svc.put('prefs', { tenantId: 'acme', userId: 'u10' }, 'q', { text: 'note of u10' })
}

const DAY = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Item 1: the two predicates
// ---------------------------------------------------------------------------

describe('namespace-match predicates (item 1)', () => {
  it('namespaceEquals is exact, segment by segment', () => {
    expect(namespaceEquals({ namespace: ['memories', 't1'] }, ['memories', 't1'])).toBe(true)
    expect(namespaceEquals({ namespace: ['memories', 't10'] }, ['memories', 't1'])).toBe(false)
    expect(namespaceEquals({ namespace: ['memories', 't1', 'u1'] }, ['memories', 't1'])).toBe(false)
    expect(namespaceEquals({ namespace: ['memories'] }, ['memories', 't1'])).toBe(false)
  })

  it('namespaceUnder accepts the prefix and descendants only, segment by segment', () => {
    expect(namespaceUnder({ namespace: ['memories', 't1'] }, ['memories', 't1'])).toBe(true)
    expect(namespaceUnder({ namespace: ['memories', 't1', 'u1'] }, ['memories', 't1'])).toBe(true)
    expect(namespaceUnder({ namespace: ['memories', 't10'] }, ['memories', 't1'])).toBe(false)
    expect(namespaceUnder({ namespace: ['memories', 't10', 'u1'] }, ['memories', 't1'])).toBe(false)
    expect(namespaceUnder({ namespace: ['memories'] }, ['memories', 't1'])).toBe(false)
  })

  it('f: an item without a namespace array matches neither predicate (fail closed)', () => {
    for (const item of [{}, { namespace: undefined }, { namespace: 'memories:t1' as unknown as string[] }, null, undefined]) {
      expect(namespaceEquals(item, ['memories', 't1'])).toBe(false)
      expect(namespaceUnder(item, ['memories', 't1'])).toBe(false)
      expect(namespaceUnder(item, [])).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// a. Leaf-read isolation
// ---------------------------------------------------------------------------

describe('a. leaf-read isolation on the Postgres LIKE prefix', () => {
  it('control: the fake store reproduces the LIKE hazard (t1 prefix returns t10 rows)', async () => {
    const pg = new FakePostgresStore()
    await pg.put(['memories', 't1'], 'a', { text: 'x' })
    await pg.put(['memories', 't10'], 'b', { text: 'y' })
    const raw = await pg.search(['memories', 't1'], { limit: 50 })
    expect(raw.map(i => i.namespace.join('/')).sort()).toEqual(['memories/t1', 'memories/t10'])
  })

  it('get: tenant t1 never sees t10 records (last segment)', async () => {
    const pg = new FakePostgresStore()
    const svc = new MemoryService(pg.asBaseStore(), [TENANT_NS])
    await seedTenants(svc)
    expect(texts(await svc.get('memories', { tenantId: 't1' }))).toEqual(['note of t1'])
    expect(texts(await svc.get('memories', { tenantId: 't10' }))).toEqual(['note of t10', 'second note of t10'])
  })

  it('search (keyword channel): tenant t1 never sees t10 records (last segment)', async () => {
    const pg = new FakePostgresStore()
    const svc = new MemoryService(pg.asBaseStore(), [TENANT_NS])
    await seedTenants(svc)
    expect(texts(await svc.search('memories', { tenantId: 't1' }, 'note', 10))).toEqual(['note of t1'])
    const status = await svc.searchWithStatus('memories', { tenantId: 't1' }, 'note', 10)
    expect(status.searchFailed).toBe(false)
    expect(texts(status.results)).toEqual(['note of t1'])
  })

  it('getKeyedMemoryRecords / getKeyed: tenant t1 never sees t10 keys (last segment)', async () => {
    const pg = new FakePostgresStore()
    const svc = new MemoryService(pg.asBaseStore(), [TENANT_NS])
    await seedTenants(svc)
    expect((await svc.getKeyed('memories', { tenantId: 't1' })).map(r => r.key)).toEqual(['a'])
    expect(
      (await getKeyedMemoryRecords(TENANT_NS, { tenantId: 't1' }, pg.asBaseStore())).map(r => r.key),
    ).toEqual(['a'])
  })

  it('get/search/getKeyed: user u1 never sees u10 records (last segment)', async () => {
    const pg = new FakePostgresStore()
    const svc = new MemoryService(pg.asBaseStore(), [USER_NS])
    await seedUsers(svc)
    const scope = { tenantId: 'acme', userId: 'u1' }
    expect(texts(await svc.get('prefs', scope))).toEqual(['note of u1'])
    expect(texts(await svc.search('prefs', scope, 'note', 10))).toEqual(['note of u1'])
    expect((await svc.getKeyed('prefs', scope)).map(r => r.key)).toEqual(['p'])
  })

  it('control: an earlier-segment difference (t1/u1 vs t10/u1) does not leak, even in the raw store', async () => {
    const pg = new FakePostgresStore()
    const svc = new MemoryService(pg.asBaseStore(), [USER_NS])
    await svc.put('prefs', { tenantId: 't1', userId: 'u1' }, 'p', { text: 'note of t1 u1' })
    await svc.put('prefs', { tenantId: 't10', userId: 'u1' }, 'q', { text: 'note of t10 u1' })
    const raw = await pg.search(['prefs', 't1', 'u1'], { limit: 50 })
    expect(raw.map(i => i.key)).toEqual(['p'])
    const scope = { tenantId: 't1', userId: 'u1' }
    expect(texts(await svc.get('prefs', scope))).toEqual(['note of t1 u1'])
    expect(texts(await svc.search('prefs', scope, 'note', 10))).toEqual(['note of t1 u1'])
  })

  it('a full read pages past out-of-scope rows instead of stopping early', async () => {
    const pg = new FakePostgresStore()
    // Siblings written last sort first (updated_at DESC) and fill page one.
    await pg.put(['memories', 't1'], 'own', { text: 'own' })
    for (let i = 0; i < 5; i++) await pg.put(['memories', 't10'], `s${i}`, { text: `sibling ${i}` })
    const { searchAllInNamespace } = await import('../memory-service-store.js')
    const items = await searchAllInNamespace(pg.asBaseStore(), ['memories', 't1'], 2)
    expect(items.map(i => i.key)).toEqual(['own'])
  })
})

// ---------------------------------------------------------------------------
// b. Descendants
// ---------------------------------------------------------------------------

describe('b. descendant namespaces are excluded from leaf reads (intended change)', () => {
  async function checkDescendantsExcluded(store: BaseStore): Promise<void> {
    const parent = new MemoryService(store, [TENANT_NS])
    const child = new MemoryService(store, [CHILD_NS])
    await parent.put('memories', { tenantId: 't1' }, 'own', { text: 'parent note' })
    await child.put('memories', { tenantId: 't1', userId: 'u1' }, 'kid', { text: 'child note' })

    expect(texts(await parent.get('memories', { tenantId: 't1' }))).toEqual(['parent note'])
    expect(texts(await parent.search('memories', { tenantId: 't1' }, 'note', 10))).toEqual(['parent note'])
    expect((await parent.getKeyed('memories', { tenantId: 't1' })).map(r => r.key)).toEqual(['own'])
    // The descendant is still readable at its own exact tuple.
    expect(texts(await child.get('memories', { tenantId: 't1', userId: 'u1' }))).toEqual(['child note'])
  }

  it('on the fake Postgres store', async () => {
    await checkDescendantsExcluded(new FakePostgresStore().asBaseStore())
  })

  it('on the in-memory store', async () => {
    await checkDescendantsExcluded(await createStore({ type: 'memory' }))
  })

  it('DISCLOSURE (deferred limit): a descendant vector hit matching today\'s metadata filter still returns through fusion', async () => {
    const pg = new FakePostgresStore()
    const semanticStore = new FakeSemanticStore()
    const parent = new MemoryService(pg.asBaseStore(), [TENANT_NS], { semanticStore })
    const child = new MemoryService(pg.asBaseStore(), [CHILD_NS], { semanticStore })
    await child.put('memories', { tenantId: 't1', userId: 'u1' }, 'kid', { text: 'descendant vector note' })

    // Store and keyword reads exclude the descendant ...
    expect(await parent.get('memories', { tenantId: 't1' })).toEqual([])
    expect(await parent.getKeyed('memories', { tenantId: 't1' })).toEqual([])
    // ... but the separate semanticStore channel filters by namespace name and
    // the querying config's scope keys only, so the descendant's vector hit is
    // admitted as a vector-only result. Exact-scope vector filtering is
    // deferred (MEMCTX-PG-RETENTION-20261108-R1, "Deferred").
    const results = await parent.search('memories', { tenantId: 't1' }, 'descendant', 10)
    expect(texts(results)).toEqual(['descendant vector note'])
  })
})

// ---------------------------------------------------------------------------
// c. Maintenance deletes act on the item's own namespace
// ---------------------------------------------------------------------------

describe('c. MemoryPruner deletes the real row, inside the scan prefix only', () => {
  const NOW = 10 * DAY
  const OLD = { _decay: { strength: 0.5, createdAt: 1 } }
  const FRESH = { _decay: { strength: 0.5, createdAt: NOW - 1 } }
  const prune = (pg: FakePostgresStore, extra: Record<string, unknown> = {}) =>
    new MemoryPruner().prune(pg, { namespace: ['memories', 't1'], ttlMs: DAY, now: () => NOW, ...extra })

  it('TTL pass deletes a descendant item at its own namespace', async () => {
    const pg = new FakePostgresStore()
    await pg.put(['memories', 't1', 'u1'], 'old', { text: 'x', ...OLD })
    const result = await prune(pg)
    expect(result.expired).toBe(1)
    expect(pg.has(['memories', 't1', 'u1'], 'old')).toBe(false)
  })

  it('never deletes a row outside the scan prefix (t1/t10 sibling)', async () => {
    const pg = new FakePostgresStore()
    await pg.put(['memories', 't10'], 'old', { text: 'x', ...OLD })
    await pg.put(['memories', 't1'], 'mine', { text: 'y', ...FRESH })
    const result = await prune(pg)
    expect(result.expired).toBe(0)
    expect(result.remaining).toBe(1)
    expect(pg.has(['memories', 't10'], 'old')).toBe(true)
    expect(pg.deletes).toEqual([])
  })

  it('never deletes a same-key row in the prefix namespace in place of the descendant row', async () => {
    const pg = new FakePostgresStore()
    await pg.put(['memories', 't1', 'u1'], 'k1', { text: 'old child', ...OLD })
    await pg.put(['memories', 't1'], 'k1', { text: 'fresh parent', ...FRESH })
    const result = await prune(pg)
    expect(result.expired).toBe(1)
    expect(pg.has(['memories', 't1'], 'k1')).toBe(true)
    expect(pg.has(['memories', 't1', 'u1'], 'k1')).toBe(false)
  })

  it('identical keys in different descendants are separate records (namespace plus key)', async () => {
    const pg = new FakePostgresStore()
    await pg.put(['memories', 't1', 'u1'], 'k', { text: 'a', ...OLD })
    await pg.put(['memories', 't1', 'u2'], 'k', { text: 'b', ...OLD })
    const result = await prune(pg)
    expect(result.expired).toBe(2)
    expect(pg.has(['memories', 't1', 'u1'], 'k')).toBe(false)
    expect(pg.has(['memories', 't1', 'u2'], 'k')).toBe(false)
  })

  it('capacity pass evicts the descendant row itself and ignores the sibling', async () => {
    const pg = new FakePostgresStore()
    await pg.put(['memories', 't10'], 'weakest', { text: 's', _decay: { strength: 0.01, createdAt: NOW - 1 } })
    await pg.put(['memories', 't1', 'u1'], 'weak', { text: 'd', _decay: { strength: 0.1, createdAt: NOW - 1 } })
    await pg.put(['memories', 't1'], 'strong', { text: 'p', _decay: { strength: 0.9, createdAt: NOW - 1 } })
    const result = await prune(pg, { maxEntries: 1, maxScan: 10 })
    expect(result.evicted).toBe(1)
    expect(result.remaining).toBe(1)
    expect(pg.has(['memories', 't1', 'u1'], 'weak')).toBe(false)
    expect(pg.has(['memories', 't1'], 'strong')).toBe(true)
    expect(pg.has(['memories', 't10'], 'weakest')).toBe(true)
  })

  it('a page of out-of-scope rows does not end the scan early', async () => {
    const pg = new FakePostgresStore()
    await pg.put(['memories', 't1'], 'old', { text: 'mine', ...OLD })
    // Written later, so they sort first and fill the first page.
    for (let i = 0; i < 4; i++) await pg.put(['memories', 't10'], `s${i}`, { text: `s${i}`, ...OLD })
    const result = await prune(pg, { pageSize: 2 })
    expect(result.expired).toBe(1)
    expect(pg.has(['memories', 't1'], 'old')).toBe(false)
    for (let i = 0; i < 4; i++) expect(pg.has(['memories', 't10'], `s${i}`)).toBe(true)
  })
})

describe('c. consolidateNamespace deletes the real row, inside the scan prefix only', () => {
  const old = () => new Date(Date.now() - 60 * DAY).toISOString()

  it('deletes an aged descendant item at its own namespace', async () => {
    const pg = new FakePostgresStore()
    await pg.put(['memories', 't1', 'u1'], 'old', { text: 'aged child', timestamp: old() })
    const result = await consolidateNamespace(pg.asBaseStore(), ['memories', 't1'])
    expect(result.pruned).toBe(1)
    expect(pg.has(['memories', 't1', 'u1'], 'old')).toBe(false)
  })

  it('never deletes or counts a row outside the scan prefix (t1/t10 sibling)', async () => {
    const pg = new FakePostgresStore()
    await pg.put(['memories', 't10'], 'old', { text: 'aged sibling', timestamp: old() })
    await pg.put(['memories', 't1'], 'mine', { text: 'mine' })
    const result = await consolidateNamespace(pg.asBaseStore(), ['memories', 't1'])
    expect(result.before).toBe(1)
    expect(result.pruned).toBe(0)
    expect(pg.has(['memories', 't10'], 'old')).toBe(true)
    expect(pg.deletes).toEqual([])
  })

  it('never deletes a same-key row in the prefix namespace in place of the descendant row', async () => {
    const pg = new FakePostgresStore()
    await pg.put(['memories', 't1', 'u1'], 'k1', { text: 'aged child', timestamp: old() })
    await pg.put(['memories', 't1'], 'k1', { text: 'fresh parent' })
    const result = await consolidateNamespace(pg.asBaseStore(), ['memories', 't1'])
    expect(result.pruned).toBe(1)
    expect(pg.has(['memories', 't1'], 'k1')).toBe(true)
    expect(pg.has(['memories', 't1', 'u1'], 'k1')).toBe(false)
  })

  it('identical keys in different descendants are separate records (namespace plus key)', async () => {
    const pg = new FakePostgresStore()
    await pg.put(['memories', 't1', 'u1'], 'k', { text: 'aged a', timestamp: old() })
    await pg.put(['memories', 't1', 'u2'], 'k', { text: 'aged b', timestamp: old() })
    const result = await consolidateNamespace(pg.asBaseStore(), ['memories', 't1'])
    expect(result.before).toBe(2)
    expect(result.pruned).toBe(2)
    expect(pg.has(['memories', 't1', 'u1'], 'k')).toBe(false)
    expect(pg.has(['memories', 't1', 'u2'], 'k')).toBe(false)
  })

  it('a duplicate merge deletes the older descendant row, not a prefix row', async () => {
    const pg = new FakePostgresStore()
    await pg.put(['memories', 't1', 'u1'], 'dup', { text: 'same text', timestamp: '2026-01-01T00:00:00.000Z' })
    await pg.put(['memories', 't1'], 'dup', { text: 'same text', timestamp: '2026-06-01T00:00:00.000Z' })
    const result = await consolidateNamespace(pg.asBaseStore(), ['memories', 't1'], { maxAgeMs: 10_000 * DAY })
    expect(result.merged).toBe(1)
    expect(pg.has(['memories', 't1'], 'dup')).toBe(true)
    expect(pg.has(['memories', 't1', 'u1'], 'dup')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// d. TenantScopedStore
// ---------------------------------------------------------------------------

describe('d. TenantScopedStore never returns another tenant\'s item', () => {
  it('tenant t1 does not see tenant t10 (last segment of the tenant prefix)', async () => {
    const pg = new FakePostgresStore()
    const t1 = new TenantScopedStore({ store: pg.asBaseStore(), tenantId: 't1' })
    const t10 = new TenantScopedStore({ store: pg.asBaseStore(), tenantId: 't10' })
    await t1.put(['lessons'], 'a', { text: 'lesson of t1' })
    await t10.put(['lessons'], 'b', { text: 'lesson of t10' })

    const own = await t1.search([], { limit: 50 })
    expect(own.map(r => [r.namespace, r.key])).toEqual([[['lessons'], 'a']])
    expect((await t10.search([], { limit: 50 })).map(r => r.key)).toEqual(['b'])
  })

  it('project p1 within a tenant does not see project p10', async () => {
    const pg = new FakePostgresStore()
    const p1 = new TenantScopedStore({ store: pg.asBaseStore(), tenantId: 'acme', projectId: 'p1' })
    const p10 = new TenantScopedStore({ store: pg.asBaseStore(), tenantId: 'acme', projectId: 'p10' })
    await p1.put(['lessons'], 'a', { text: 'p1' })
    await p10.put(['lessons'], 'b', { text: 'p10' })
    expect((await p1.search([], { limit: 50 })).map(r => r.key)).toEqual(['a'])
  })
})

// ---------------------------------------------------------------------------
// e. Exact-leaf fixtures are unchanged on the in-memory store
// ---------------------------------------------------------------------------

describe('e. in-memory store: exact-leaf fixtures are unchanged', () => {
  it('get/getKeyed return exactly the raw store rows, in store order; search returns all matches', async () => {
    const store = await createStore({ type: 'memory' })
    const svc = new MemoryService(store, [TENANT_NS])
    await svc.put('memories', { tenantId: 'acme' }, 'k1', { text: 'first note' })
    await svc.put('memories', { tenantId: 'acme' }, 'k2', { text: 'second note' })
    await svc.put('memories', { tenantId: 'acme' }, 'k3', { text: 'third note' })

    const raw = await store.search(['memories', 'acme'], { limit: 500, offset: 0 })
    expect(raw).toHaveLength(3)
    expect(await svc.get('memories', { tenantId: 'acme' })).toEqual(raw.map(i => i.value))
    expect(await svc.getKeyed('memories', { tenantId: 'acme' })).toEqual(
      raw.map(i => ({ key: i.key, value: i.value })),
    )
    expect(texts(await svc.search('memories', { tenantId: 'acme' }, 'note', 10))).toEqual([
      'first note',
      'second note',
      'third note',
    ])
  })
})

// ---------------------------------------------------------------------------
// f. Fail closed on items without a namespace
// ---------------------------------------------------------------------------

describe('f. items returned without namespace fail closed', () => {
  it('leaf reads drop them', async () => {
    const pg = new NamespacelessStore()
    const svc = new MemoryService(pg.asBaseStore(), [TENANT_NS])
    await svc.put('memories', { tenantId: 't1' }, 'a', { text: 'note of t1' })
    expect(await svc.get('memories', { tenantId: 't1' })).toEqual([])
    expect(await svc.search('memories', { tenantId: 't1' }, 'note', 10)).toEqual([])
    expect(await svc.getKeyed('memories', { tenantId: 't1' })).toEqual([])
    // A single-key get is an exact `WHERE namespace_path = $1` read and is unaffected.
    expect(texts(await svc.get('memories', { tenantId: 't1' }, 'a'))).toEqual(['note of t1'])
  })

  it('maintenance deletes ignore them', async () => {
    const pg = new NamespacelessStore()
    await pg.put(['memories', 't1'], 'old', { text: 'x', timestamp: '2000-01-01T00:00:00.000Z', _decay: { strength: 0.1, createdAt: 1 } })
    const pruned = await new MemoryPruner().prune(pg, { namespace: ['memories', 't1'], ttlMs: DAY, now: () => 10 * DAY })
    expect(pruned.expired).toBe(0)
    const consolidated = await consolidateNamespace(pg.asBaseStore(), ['memories', 't1'])
    expect(consolidated.pruned).toBe(0)
    expect(pg.deletes).toEqual([])
    expect(pg.has(['memories', 't1'], 'old')).toBe(true)
  })

  it('TenantScopedStore.search drops them', async () => {
    const pg = new NamespacelessStore()
    const t1 = new TenantScopedStore({ store: pg.asBaseStore(), tenantId: 't1' })
    await t1.put(['lessons'], 'a', { text: 'lesson' })
    expect(await t1.search(['lessons'])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// g. Colon alias — KNOWN, UNFIXED DEFECT (disclosed, not isolation)
// ---------------------------------------------------------------------------

describe('g. colon alias (known unfixed defect, disclosed)', () => {
  it('KNOWN DEFECT: [memories, "t1:u1"] is stored at the same path and returned as [memories, t1, u1]', async () => {
    const pg = new FakePostgresStore()
    await pg.put(['memories', 't1:u1'], 'alias', { text: 'stored under a colon label' })

    const [item] = await pg.search(['memories', 't1', 'u1'], { limit: 10 })
    expect(item?.namespace).toEqual(['memories', 't1', 'u1'])
    // No check on the returned namespace can tell the two scopes apart.
    expect(namespaceEquals(item, ['memories', 't1', 'u1'])).toBe(true)

    // So a MemoryService read for scope (t1, u1) returns the colon-label record,
    // and a TenantScopedStore for tenant t1 returns a record stored for "t1:u1".
    const child = new MemoryService(pg.asBaseStore(), [CHILD_NS])
    expect(texts(await child.get('memories', { tenantId: 't1', userId: 'u1' }))).toEqual([
      'stored under a colon label',
    ])
    const tenantT1 = new TenantScopedStore({ store: pg.asBaseStore(), tenantId: 't1' })
    const tenantColon = new TenantScopedStore({ store: pg.asBaseStore(), tenantId: 't1:u1' })
    await tenantColon.put(['lessons'], 'x', { text: 'colon tenant lesson' })
    expect((await tenantT1.search([], { limit: 10 })).map(r => r.key)).toEqual(['x'])
  })
})
