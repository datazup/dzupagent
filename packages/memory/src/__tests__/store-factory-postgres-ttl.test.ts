/**
 * MC-05a (MEMCTX-PG-TTL-20261108-R1) — opt-in record expiry for the Postgres store.
 *
 * `@langchain/langgraph-checkpoint-postgres/store` is mocked: these cases only
 * capture what `createStore` hands to `PostgresStore.fromConnString` and that
 * it calls `setup()` / `stop()`. No case opens a database connection; the
 * connection string is an opaque sentinel that nothing parses.
 *
 * The last block pins the installed library's SQL that the existing-data
 * guarantee rests on, by reading its `dist` files (read-only).
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { closeMemoryStore, createStore } from '../store-factory.js'

const pg = vi.hoisted(() => {
  const instances: Array<{ setup: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = []
  const fromConnString = vi.fn((_connectionString: string, _options?: unknown) => {
    const store = {
      setup: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    }
    instances.push(store)
    return store
  })
  return { fromConnString, instances }
})

vi.mock('@langchain/langgraph-checkpoint-postgres/store', () => ({
  PostgresStore: { fromConnString: pg.fromConnString },
}))

const CS = 'mock-connection-not-a-database'
const embeddings = {
  embedDocuments: async (texts: string[]) => texts.map(() => [0, 0]),
  embedQuery: async () => [0, 0],
}

function onlyCallArgs(): unknown[] {
  expect(pg.fromConnString).toHaveBeenCalledTimes(1)
  return pg.fromConnString.mock.calls[0] as unknown[]
}

beforeEach(() => {
  pg.fromConnString.mockClear()
  pg.instances.length = 0
})

describe('postgres ttlMs is passed to PostgresStore (MC-05a item 1)', () => {
  it('maps ttlMs to defaultTtl minutes, refreshOnRead false, and the default 60-minute sweep', async () => {
    await createStore({ type: 'postgres', connectionString: CS, ttlMs: 3_600_000 })

    const args = onlyCallArgs()
    expect(args).toHaveLength(2)
    expect(args[0]).toBe(CS)
    expect(args[1]).toStrictEqual({
      ttl: { defaultTtl: 60, refreshOnRead: false, sweepIntervalMinutes: 60 },
    })
    expect(pg.instances[0]!.setup).toHaveBeenCalledTimes(1)
  })

  it('converts a non-whole-minute ttlMs exactly', async () => {
    await createStore({ type: 'postgres', connectionString: CS, ttlMs: 90_000 })
    expect(onlyCallArgs()[1]).toStrictEqual({
      ttl: { defaultTtl: 1.5, refreshOnRead: false, sweepIntervalMinutes: 60 },
    })
  })

  it('accepts the 60000 ms minimum', async () => {
    await createStore({ type: 'postgres', connectionString: CS, ttlMs: 60_000 })
    expect(onlyCallArgs()[1]).toStrictEqual({
      ttl: { defaultTtl: 1, refreshOnRead: false, sweepIntervalMinutes: 60 },
    })
  })

  it('passes the index config alongside ttl', async () => {
    await createStore({
      type: 'postgres',
      connectionString: CS,
      ttlMs: 120_000,
      index: { embeddings, dims: 2 },
    })
    expect(onlyCallArgs()[1]).toStrictEqual({
      index: { dims: 2, embed: embeddings, fields: ['text'] },
      ttl: { defaultTtl: 2, refreshOnRead: false, sweepIntervalMinutes: 60 },
    })
  })
})

describe('postgres ttlSweepIntervalMs (MC-05a item 2)', () => {
  it('sets sweepIntervalMinutes', async () => {
    await createStore({
      type: 'postgres',
      connectionString: CS,
      ttlMs: 3_600_000,
      ttlSweepIntervalMs: 300_000,
    })
    expect(onlyCallArgs()[1]).toStrictEqual({
      ttl: { defaultTtl: 60, refreshOnRead: false, sweepIntervalMinutes: 5 },
    })
  })

  it('accepts the 60000 ms minimum', async () => {
    await createStore({
      type: 'postgres',
      connectionString: CS,
      ttlMs: 3_600_000,
      ttlSweepIntervalMs: 60_000,
    })
    expect(onlyCallArgs()[1]).toStrictEqual({
      ttl: { defaultTtl: 60, refreshOnRead: false, sweepIntervalMinutes: 1 },
    })
  })

  it.each([59_999, 0, -60_000, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'refuses ttlSweepIntervalMs=%s',
    async (ttlSweepIntervalMs) => {
      await expect(
        createStore({ type: 'postgres', connectionString: CS, ttlMs: 3_600_000, ttlSweepIntervalMs }),
      ).rejects.toThrow(/ttlSweepIntervalMs must be a finite number of at least 60000 ms/)
      expect(pg.fromConnString).not.toHaveBeenCalled()
    },
  )

  it('refuses ttlSweepIntervalMs without ttlMs', async () => {
    await expect(
      createStore({ type: 'postgres', connectionString: CS, ttlSweepIntervalMs: 300_000 }),
    ).rejects.toThrow('ttlSweepIntervalMs requires ttlMs')
    expect(pg.fromConnString).not.toHaveBeenCalled()
  })

  it('refuses ttlSweepIntervalMs for the memory store', async () => {
    await expect(
      createStore({ type: 'memory', ttlMs: 1_000, ttlSweepIntervalMs: 300_000 }),
    ).rejects.toThrow('ttlSweepIntervalMs is supported only by the postgres store')
    await expect(
      createStore({ type: 'memory', ttlSweepIntervalMs: 300_000 }),
    ).rejects.toThrow('ttlSweepIntervalMs is supported only by the postgres store')
  })
})

describe('postgres maxRecords stays memory-only (MC-05a item 3)', () => {
  it('refuses maxRecords with the existing message, alone or with ttlMs', async () => {
    await expect(
      createStore({ type: 'postgres', connectionString: CS, maxRecords: 10 }),
    ).rejects.toThrow('maxRecords/ttlMs are supported only by the in-memory store')
    await expect(
      createStore({ type: 'postgres', connectionString: CS, maxRecords: 10, ttlMs: 3_600_000 }),
    ).rejects.toThrow('maxRecords/ttlMs are supported only by the in-memory store')
    expect(pg.fromConnString).not.toHaveBeenCalled()
  })
})

describe('no ttlMs leaves the postgres call unchanged (MC-05a item 4)', () => {
  it('passes undefined options without an index', async () => {
    await createStore({ type: 'postgres', connectionString: CS })

    const args = onlyCallArgs()
    expect(args).toHaveLength(2)
    expect(args[0]).toBe(CS)
    expect(args[1]).toBeUndefined()
    expect(pg.instances[0]!.setup).toHaveBeenCalledTimes(1)
  })

  it('passes exactly { index } with an index', async () => {
    await createStore({ type: 'postgres', connectionString: CS, index: { embeddings, dims: 2 } })

    const options = onlyCallArgs()[1] as Record<string, unknown>
    expect(Object.keys(options)).toEqual(['index'])
    expect(options).toStrictEqual({ index: { dims: 2, embed: embeddings, fields: ['text'] } })
  })
})

describe('postgres ttlMs minimum (MC-05a item 6)', () => {
  it.each([59_999, 10, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses postgres ttlMs=%s naming ttlMs and the 60000 ms minimum',
    async (ttlMs) => {
      await expect(
        createStore({ type: 'postgres', connectionString: CS, ttlMs }),
      ).rejects.toThrow(/^ttlMs must be a finite number of at least 60000 ms \(one minute\) for the postgres store/)
      expect(pg.fromConnString).not.toHaveBeenCalled()
    },
  )

  it('keeps sub-minute ttlMs valid for the memory store', async () => {
    const store = await createStore({ type: 'memory', ttlMs: 1_000 })
    expect(typeof store.put).toBe('function')
    expect(pg.fromConnString).not.toHaveBeenCalled()
  })
})

describe('closeMemoryStore stops a ttl-enabled postgres store (MC-05a item 5)', () => {
  it('calls stop, which clears the library sweeper', async () => {
    const store = await createStore({ type: 'postgres', connectionString: CS, ttlMs: 3_600_000 })
    expect(await closeMemoryStore(store)).toBe(true)
    expect(pg.instances[0]!.stop).toHaveBeenCalledTimes(1)
  })
})

describe('installed PostgresStore SQL the existing-data guarantee rests on (MC-05a)', () => {
  // Resolved from the package (CJS entry), then both the ESM `.js` that
  // store-factory.ts loads and the `.cjs` twin are read. Read-only.
  const storeDir = dirname(
    createRequire(import.meta.url).resolve('@langchain/langgraph-checkpoint-postgres/store'),
  )
  const read = (rel: string, ext: '.js' | '.cjs'): string =>
    readFileSync(join(storeDir, `${rel}${ext}`), 'utf8').replace(/\s+/g, ' ')

  describe.each(['.js', '.cjs'] as const)('dist %s', (ext) => {
    it('the sweeper deletes only expired non-null rows, schema-wide', () => {
      const src = read('modules/ttl-manager', ext)
      const deletes = src.match(/DELETE FROM [^`]*`/g) ?? []
      expect(deletes).toEqual([
        'DELETE FROM "${this.core.schema}".store WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP `',
      ])
    })

    it('get filters out expired rows', () => {
      const src = read('modules/crud-operations', ext)
      expect(src).toContain(
        'FROM "${this.core.schema}".store WHERE namespace_path = $1 AND key = $2 AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) `',
      )
    })

    it('every search read of the store table filters out expired rows', () => {
      const src = read('modules/search-operations', ext)
      const reads = src.split('FROM "${this.core.schema}".store').slice(1)
      expect(reads.length).toBeGreaterThanOrEqual(5)
      for (const tail of reads) {
        const query = tail.slice(0, tail.indexOf('`'))
        expect(query).toMatch(
          /\((s\.)?expires_at IS NULL OR (s\.)?expires_at > CURRENT_TIMESTAMP\)/,
        )
      }
    })

    it('the upsert sets expires_at on conflict', () => {
      const src = read('modules/crud-operations', ext)
      expect(src).toContain(
        'INSERT INTO "${this.core.schema}".store (namespace_path, key, value, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT (namespace_path, key) DO UPDATE SET value = $3, expires_at = $4, updated_at = CURRENT_TIMESTAMP `',
      )
    })

    it('expiry is computed in minutes and the sweeper starts only with sweepIntervalMinutes', () => {
      expect(read('modules/database-core', ext)).toContain(
        'const effectiveTtl = ttl ?? this.ttlConfig?.defaultTtl; if (!effectiveTtl) return null; return new Date(Date.now() + effectiveTtl * 60 * 1e3);',
      )
      const index = read('index', ext)
      expect(index).toContain('if (this.core.ttlConfig?.sweepIntervalMinutes) this.ttlManager.start();')
      expect(index).toMatch(/async stop\(\) \{ if \(this\.isClosed\) return; this\.ttlManager\.stop\(\);/)
    })
  })
})
