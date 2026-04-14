/**
 * Tests for SQLiteConnector — mocks better-sqlite3 via node:module createRequire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SQLConnectionConfig } from '../types.js'

// ---------------------------------------------------------------------------
// Mock better-sqlite3 via node:module createRequire
// ---------------------------------------------------------------------------

const mockAll = vi.fn()
const mockGet = vi.fn()
const mockPragma = vi.fn()
const mockClose = vi.fn()

const mockPrepare = vi.fn(() => ({
  all: mockAll,
  get: mockGet,
}))

const MockDatabase = vi.fn(() => ({
  prepare: mockPrepare,
  pragma: mockPragma,
  close: mockClose,
}))

const mockRuntimeRequire = vi.fn((specifier: string) => {
  if (specifier === 'better-sqlite3') {
    return MockDatabase
  }
  throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' })
}) as unknown as NodeRequire

// Also mock resolve for assertSqliteDriverInstalled
mockRuntimeRequire.resolve = vi.fn((specifier: string) => {
  if (specifier === 'better-sqlite3') return '/fake/path/better-sqlite3'
  throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' })
}) as unknown as NodeRequire['resolve']

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => mockRuntimeRequire),
}))

const baseConfig: SQLConnectionConfig = {
  host: 'localhost',
  port: 0,
  database: '/tmp/test.db',
  username: '',
  password: '',
  ssl: false,
}

// ---------------------------------------------------------------------------
// Import after mocking
// ---------------------------------------------------------------------------

const { SQLiteConnector } = await import('../adapters/sqlite.js')

describe('SQLiteConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrepare.mockReturnValue({ all: mockAll, get: mockGet })
  })

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('stores the database path from config.database', () => {
      const connector = new SQLiteConnector(baseConfig)
      expect(connector).toBeDefined()
    })

    it('prefers filePath over database', () => {
      const connector = new SQLiteConnector({ ...baseConfig, filePath: '/tmp/explicit.db' })
      expect(connector).toBeDefined()
    })

    it('throws when neither filePath nor database is provided', () => {
      expect(
        () => new SQLiteConnector({ ...baseConfig, database: '', filePath: undefined }),
      ).toThrow('SQLite requires a filePath or database path')
    })

    it('throws when better-sqlite3 is not installed', () => {
      const savedResolve = (mockRuntimeRequire.resolve as ReturnType<typeof vi.fn>).getMockImplementation()
      ;(mockRuntimeRequire.resolve as ReturnType<typeof vi.fn>).mockImplementation((spec: string) => {
        throw Object.assign(new Error(`Cannot find module '${spec}'`), { code: 'MODULE_NOT_FOUND' })
      })

      expect(() => new SQLiteConnector(baseConfig)).toThrow(
        'SQLiteConnector requires the optional dependency "better-sqlite3"',
      )

      ;(mockRuntimeRequire.resolve as ReturnType<typeof vi.fn>).mockImplementation(savedResolve!)
    })
  })

  // -------------------------------------------------------------------------
  // getDialect
  // -------------------------------------------------------------------------

  describe('getDialect', () => {
    it('returns sqlite', () => {
      const connector = new SQLiteConnector(baseConfig)
      expect(connector.getDialect()).toBe('sqlite')
    })
  })

  // -------------------------------------------------------------------------
  // testConnection
  // -------------------------------------------------------------------------

  describe('testConnection', () => {
    it('returns ok:true on successful connection', async () => {
      mockGet.mockReturnValue({ '1': 1 })
      const connector = new SQLiteConnector(baseConfig)

      const result = await connector.testConnection()

      expect(result.ok).toBe(true)
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it('returns ok:false on connection failure', async () => {
      mockPrepare.mockImplementation(() => {
        throw new Error('unable to open database file')
      })
      const connector = new SQLiteConnector(baseConfig)

      const result = await connector.testConnection()

      expect(result.ok).toBe(false)
      expect(result.error).toContain('unable to open database file')
    })

    it('handles non-Error thrown values', async () => {
      mockPrepare.mockImplementation(() => {
        throw 'raw error'
      })
      const connector = new SQLiteConnector(baseConfig)

      const result = await connector.testConnection()

      expect(result.ok).toBe(false)
      expect(result.error).toBe('raw error')
    })
  })

  // -------------------------------------------------------------------------
  // executeQuery
  // -------------------------------------------------------------------------

  describe('executeQuery', () => {
    it('executes a query and returns structured results', async () => {
      mockAll.mockReturnValue([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ])

      const connector = new SQLiteConnector(baseConfig)
      const result = await connector.executeQuery('SELECT * FROM users')

      expect(result.columns).toEqual(['id', 'name'])
      expect(result.rows).toHaveLength(2)
      expect(result.rowCount).toBe(2)
      expect(result.truncated).toBe(false)
    })

    it('returns empty result for zero rows', async () => {
      mockAll.mockReturnValue([])

      const connector = new SQLiteConnector(baseConfig)
      const result = await connector.executeQuery('SELECT * FROM empty_table')

      expect(result.columns).toEqual([])
      expect(result.rows).toEqual([])
      expect(result.rowCount).toBe(0)
    })

    it('truncates when rows exceed maxRows', async () => {
      const rows = Array.from({ length: 11 }, (_, i) => ({ id: i + 1 }))
      mockAll.mockReturnValue(rows)

      const connector = new SQLiteConnector(baseConfig)
      const result = await connector.executeQuery('SELECT * FROM t', { maxRows: 10 })

      expect(result.truncated).toBe(true)
      expect(result.rows).toHaveLength(10)
    })

    it('does not add LIMIT when already present', async () => {
      mockAll.mockReturnValue([{ id: 1 }])

      const connector = new SQLiteConnector(baseConfig)
      await connector.executeQuery('SELECT * FROM t LIMIT 5')

      const calledSql = mockPrepare.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('SELECT'),
      )
      expect(calledSql?.[0]).toBe('SELECT * FROM t LIMIT 5')
    })

    it('adds LIMIT maxRows+1 when not present', async () => {
      mockAll.mockReturnValue([])

      const connector = new SQLiteConnector(baseConfig)
      await connector.executeQuery('SELECT * FROM t', { maxRows: 10 })

      const calledSql = mockPrepare.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('SELECT'),
      )
      expect(calledSql?.[0]).toContain('LIMIT 11')
    })

    it('strips trailing semicolons before adding LIMIT', async () => {
      mockAll.mockReturnValue([])

      const connector = new SQLiteConnector(baseConfig)
      await connector.executeQuery('SELECT * FROM t;', { maxRows: 10 })

      const calledSql = mockPrepare.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('SELECT'),
      )
      expect(calledSql?.[0]).not.toContain(';')
      expect(calledSql?.[0]).toContain('LIMIT 11')
    })
  })

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------

  describe('destroy', () => {
    it('calls db.close() when database is open', async () => {
      // Force database open via testConnection
      mockGet.mockReturnValue({ '1': 1 })
      const connector = new SQLiteConnector(baseConfig)
      await connector.testConnection()

      await connector.destroy()

      expect(mockClose).toHaveBeenCalled()
    })

    it('does nothing when no database is open', async () => {
      const connector = new SQLiteConnector(baseConfig)

      await connector.destroy()

      expect(mockClose).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Connection caching
  // -------------------------------------------------------------------------

  describe('connection caching', () => {
    it('reuses existing database on subsequent calls', async () => {
      mockGet.mockReturnValue({ '1': 1 })
      const connector = new SQLiteConnector(baseConfig)

      await connector.testConnection()
      await connector.testConnection()

      // MockDatabase should only be called once (on first getDatabase)
      expect(MockDatabase).toHaveBeenCalledTimes(1)
    })

    it('opens database in readonly mode with WAL pragma', async () => {
      mockGet.mockReturnValue({ '1': 1 })
      const connector = new SQLiteConnector(baseConfig)

      await connector.testConnection()

      expect(MockDatabase).toHaveBeenCalledWith('/tmp/test.db', { readonly: true })
      expect(mockPragma).toHaveBeenCalledWith('journal_mode = WAL')
    })
  })

  // -------------------------------------------------------------------------
  // Schema discovery
  // -------------------------------------------------------------------------

  describe('discoverSchema', () => {
    it('uses main as default schema', async () => {
      mockAll.mockReturnValue([])

      const connector = new SQLiteConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.schemaName).toBe('main')
      expect(schema.dialect).toBe('sqlite')
    })

    it('discovers tables from sqlite_master', async () => {
      // discoverTables
      mockAll.mockReturnValueOnce([
        { tableName: 'users' },
        { tableName: 'orders' },
      ])
      // users: columns
      .mockReturnValueOnce([])
      // users: foreign keys
      .mockReturnValueOnce([])
      // users: row count
      mockGet.mockReturnValueOnce({ cnt: 1000 })
      // orders: columns
      mockAll.mockReturnValueOnce([])
      // orders: foreign keys
      .mockReturnValueOnce([])
      // orders: row count
      mockGet.mockReturnValueOnce({ cnt: 500 })

      const connector = new SQLiteConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.tables).toHaveLength(2)
      expect(schema.tables[0]!.tableName).toBe('users')
      expect(schema.tables[1]!.tableName).toBe('orders')
    })

    it('discovers columns with PRAGMA table_info', async () => {
      // discoverTables
      mockAll.mockReturnValueOnce([{ tableName: 't' }])
      // discoverColumns
      .mockReturnValueOnce([
        { cid: 0, name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
        { cid: 1, name: 'name', type: 'TEXT', notnull: 0, dflt_value: "'unnamed'", pk: 0 },
        { cid: 2, name: 'age', type: '', notnull: 0, dflt_value: null, pk: 0 },
      ])
      // discoverForeignKeys
      .mockReturnValueOnce([])
      // discoverRowCount
      mockGet.mockReturnValueOnce({ cnt: 100 })

      const connector = new SQLiteConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })
      const columns = schema.tables[0]!.columns

      expect(columns).toHaveLength(3)
      expect(columns[0]!.columnName).toBe('id')
      expect(columns[0]!.isPrimaryKey).toBe(true)
      expect(columns[0]!.isNullable).toBe(false)
      expect(columns[0]!.dataType).toBe('integer')

      expect(columns[1]!.columnName).toBe('name')
      expect(columns[1]!.isPrimaryKey).toBe(false)
      expect(columns[1]!.isNullable).toBe(true)
      expect(columns[1]!.defaultValue).toBe("'unnamed'")
      expect(columns[1]!.dataType).toBe('text')

      // Empty type defaults to 'text'
      expect(columns[2]!.dataType).toBe('text')
    })

    it('discovers foreign keys via PRAGMA foreign_key_list', async () => {
      // discoverTables
      mockAll.mockReturnValueOnce([{ tableName: 'orders' }])
      // discoverColumns
      .mockReturnValueOnce([])
      // discoverForeignKeys
      .mockReturnValueOnce([
        { id: 0, seq: 0, table: 'users', from: 'user_id', to: 'id' },
      ])
      // discoverRowCount
      mockGet.mockReturnValueOnce({ cnt: 50 })

      const connector = new SQLiteConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })
      const fks = schema.tables[0]!.foreignKeys

      expect(fks).toHaveLength(1)
      expect(fks[0]!.constraintName).toBe('fk_orders_user_id_0')
      expect(fks[0]!.columnName).toBe('user_id')
      expect(fks[0]!.referencedTable).toBe('users')
      expect(fks[0]!.referencedColumn).toBe('id')
      expect(fks[0]!.referencedSchema).toBe('main')
    })

    it('discovers row count', async () => {
      // discoverTables
      mockAll.mockReturnValueOnce([{ tableName: 't' }])
      // discoverColumns
      .mockReturnValueOnce([])
      // discoverForeignKeys
      .mockReturnValueOnce([])
      // discoverRowCount
      mockGet.mockReturnValueOnce({ cnt: 42 })

      const connector = new SQLiteConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.tables[0]!.rowCountEstimate).toBe(42)
    })

    it('returns 0 row count when get returns undefined', async () => {
      // discoverTables
      mockAll.mockReturnValueOnce([{ tableName: 't' }])
      // discoverColumns
      .mockReturnValueOnce([])
      // discoverForeignKeys
      .mockReturnValueOnce([])
      // discoverRowCount
      mockGet.mockReturnValueOnce(undefined)

      const connector = new SQLiteConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.tables[0]!.rowCountEstimate).toBe(0)
    })

    it('discovers sample values', async () => {
      // discoverTables
      mockAll.mockReturnValueOnce([{ tableName: 't' }])
      // discoverColumns
      .mockReturnValueOnce([
        { cid: 0, name: 'city', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      ])
      // discoverForeignKeys
      .mockReturnValueOnce([])
      // discoverRowCount
      mockGet.mockReturnValueOnce({ cnt: 10 })
      // discoverSampleValues
      mockAll.mockReturnValueOnce([{ val: 'Berlin' }, { val: 'Paris' }])

      const connector = new SQLiteConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 5 })

      expect(schema.tables[0]!.sampleValues['city']).toEqual(['Berlin', 'Paris'])
    })

    it('queries DISTINCT sample values with LIMIT', async () => {
      // discoverTables
      mockAll.mockReturnValueOnce([{ tableName: 't' }])
      // discoverColumns
      .mockReturnValueOnce([
        { cid: 0, name: 'city', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      ])
      // discoverForeignKeys
      .mockReturnValueOnce([])
      // discoverRowCount
      mockGet.mockReturnValueOnce({ cnt: 10 })
      // discoverSampleValues
      mockAll.mockReturnValueOnce([{ val: 'Berlin' }])

      const connector = new SQLiteConnector(baseConfig)
      await connector.discoverSchema({ sampleValueLimit: 3 })

      // Verify that a DISTINCT sample query was prepared with LIMIT
      const samplePrepareCall = mockPrepare.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('DISTINCT'),
      )
      expect(samplePrepareCall).toBeDefined()
      expect(samplePrepareCall![0]).toContain('LIMIT')
    })
  })
})
