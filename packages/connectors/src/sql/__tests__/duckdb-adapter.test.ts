/**
 * Tests for DuckDBConnector — mocks duckdb via node:module createRequire + dynamic import.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SQLConnectionConfig } from '../types.js'

// ---------------------------------------------------------------------------
// Mock duckdb module via node:module createRequire AND dynamic import
// ---------------------------------------------------------------------------

const mockConnAll = vi.fn()
const mockConnRun = vi.fn()
const mockDbClose = vi.fn()

const MockConnection = vi.fn(() => ({
  all: mockConnAll,
  run: mockConnRun,
}))

const MockDuckDatabase = vi.fn(() => ({
  close: mockDbClose,
}))

const mockDuckDBModule = {
  Database: MockDuckDatabase,
  Connection: MockConnection,
}

const mockRuntimeRequire = vi.fn((specifier: string) => {
  if (specifier === 'duckdb') {
    return mockDuckDBModule
  }
  throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' })
}) as unknown as NodeRequire

mockRuntimeRequire.resolve = vi.fn((specifier: string) => {
  if (specifier === 'duckdb') return '/fake/path/duckdb'
  throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' })
}) as unknown as NodeRequire['resolve']

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => mockRuntimeRequire),
}))

// Mock the dynamic import('duckdb') path
vi.mock('duckdb', () => ({
  default: mockDuckDBModule,
  Database: MockDuckDatabase,
  Connection: MockConnection,
}))

const baseConfig: SQLConnectionConfig = {
  host: 'localhost',
  port: 0,
  database: 'testdb',
  username: '',
  password: '',
  ssl: false,
}

// ---------------------------------------------------------------------------
// Import after mocking
// ---------------------------------------------------------------------------

const { DuckDBConnector } = await import('../adapters/duckdb.js')

describe('DuckDBConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: successful query returning rows
    mockConnAll.mockImplementation((sql: string, cb: (err: Error | null, rows: unknown[]) => void) => {
      cb(null, [])
    })
  })

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('defaults to :memory: when no duckdbPath is provided', () => {
      const connector = new DuckDBConnector(baseConfig)
      expect(connector).toBeDefined()
    })

    it('uses duckdbPath from config', () => {
      const connector = new DuckDBConnector({ ...baseConfig, duckdbPath: '/tmp/test.duckdb' })
      expect(connector).toBeDefined()
    })

    it('throws when duckdb is not installed', () => {
      const savedResolve = (mockRuntimeRequire.resolve as ReturnType<typeof vi.fn>).getMockImplementation()
      ;(mockRuntimeRequire.resolve as ReturnType<typeof vi.fn>).mockImplementation((spec: string) => {
        throw Object.assign(new Error(`Cannot find module '${spec}'`), { code: 'MODULE_NOT_FOUND' })
      })

      expect(() => new DuckDBConnector(baseConfig)).toThrow(
        'DuckDBConnector requires the optional dependency "duckdb"',
      )

      ;(mockRuntimeRequire.resolve as ReturnType<typeof vi.fn>).mockImplementation(savedResolve!)
    })
  })

  // -------------------------------------------------------------------------
  // getDialect
  // -------------------------------------------------------------------------

  describe('getDialect', () => {
    it('returns duckdb', () => {
      const connector = new DuckDBConnector(baseConfig)
      expect(connector.getDialect()).toBe('duckdb')
    })
  })

  // -------------------------------------------------------------------------
  // testConnection
  // -------------------------------------------------------------------------

  describe('testConnection', () => {
    it('returns ok:true on successful connection', async () => {
      mockConnAll.mockImplementation((_sql: string, cb: (err: Error | null, rows: unknown[]) => void) => {
        cb(null, [{ ok: 1 }])
      })
      const connector = new DuckDBConnector(baseConfig)

      const result = await connector.testConnection()

      expect(result.ok).toBe(true)
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it('returns ok:false on connection failure', async () => {
      mockConnAll.mockImplementation((_sql: string, cb: (err: Error | null, rows: unknown[]) => void) => {
        cb(new Error('IO Error: cannot open file'), [])
      })
      const connector = new DuckDBConnector(baseConfig)

      const result = await connector.testConnection()

      expect(result.ok).toBe(false)
      expect(result.error).toContain('IO Error: cannot open file')
    })

    it('handles non-Error thrown values', async () => {
      mockConnAll.mockImplementation(() => {
        throw 'raw error'
      })
      const connector = new DuckDBConnector(baseConfig)

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
      mockConnAll.mockImplementation((_sql: string, cb: (err: Error | null, rows: unknown[]) => void) => {
        cb(null, [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }])
      })

      const connector = new DuckDBConnector(baseConfig)
      const result = await connector.executeQuery('SELECT * FROM users')

      expect(result.columns).toEqual(['id', 'name'])
      expect(result.rows).toHaveLength(2)
      expect(result.rowCount).toBe(2)
      expect(result.truncated).toBe(false)
    })

    it('returns empty result for zero rows', async () => {
      const connector = new DuckDBConnector(baseConfig)
      const result = await connector.executeQuery('SELECT * FROM empty_table')

      expect(result.columns).toEqual([])
      expect(result.rows).toEqual([])
      expect(result.rowCount).toBe(0)
    })

    it('truncates when rows exceed maxRows', async () => {
      const rows = Array.from({ length: 11 }, (_, i) => ({ id: i + 1 }))
      mockConnAll.mockImplementation((_sql: string, cb: (err: Error | null, rows: unknown[]) => void) => {
        cb(null, rows)
      })

      const connector = new DuckDBConnector(baseConfig)
      const result = await connector.executeQuery('SELECT * FROM t', { maxRows: 10 })

      expect(result.truncated).toBe(true)
      expect(result.rows).toHaveLength(10)
    })

    it('does not add LIMIT when already present', async () => {
      const connector = new DuckDBConnector(baseConfig)
      await connector.executeQuery('SELECT * FROM t LIMIT 5')

      const calledSql = mockConnAll.mock.calls[0]?.[0]
      expect(calledSql).toBe('SELECT * FROM t LIMIT 5')
    })

    it('adds LIMIT maxRows+1 when not present', async () => {
      const connector = new DuckDBConnector(baseConfig)
      await connector.executeQuery('SELECT * FROM t', { maxRows: 10 })

      const calledSql = mockConnAll.mock.calls[0]?.[0]
      expect(calledSql).toContain('LIMIT 11')
    })

    it('propagates query errors', async () => {
      mockConnAll.mockImplementation((_sql: string, cb: (err: Error | null, rows: unknown[]) => void) => {
        cb(new Error('Parser Error: syntax error'), [])
      })

      const connector = new DuckDBConnector(baseConfig)

      await expect(connector.executeQuery('INVALID SQL')).rejects.toThrow('Parser Error')
    })
  })

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------

  describe('destroy', () => {
    it('calls db.close() when database is open', async () => {
      mockDbClose.mockImplementation((cb: (err: Error | null) => void) => {
        cb(null)
      })

      // Force connection open
      const connector = new DuckDBConnector(baseConfig)
      await connector.testConnection()

      await connector.destroy()

      expect(mockDbClose).toHaveBeenCalled()
    })

    it('does nothing when no database is open', async () => {
      const connector = new DuckDBConnector(baseConfig)

      await connector.destroy()

      expect(mockDbClose).not.toHaveBeenCalled()
    })

    it('propagates close errors', async () => {
      mockDbClose.mockImplementation((cb: (err: Error | null) => void) => {
        cb(new Error('close failed'))
      })

      const connector = new DuckDBConnector(baseConfig)
      await connector.testConnection()

      await expect(connector.destroy()).rejects.toThrow('close failed')
    })
  })

  // -------------------------------------------------------------------------
  // Connection caching
  // -------------------------------------------------------------------------

  describe('connection caching', () => {
    it('reuses existing connection on subsequent calls', async () => {
      const connector = new DuckDBConnector(baseConfig)

      await connector.testConnection()
      await connector.testConnection()

      // Database and Connection should only be created once
      expect(MockDuckDatabase).toHaveBeenCalledTimes(1)
      expect(MockConnection).toHaveBeenCalledTimes(1)
    })

    it('sets read_only mode for file-based databases', async () => {
      const connector = new DuckDBConnector({ ...baseConfig, duckdbPath: '/tmp/test.duckdb' })
      await connector.testConnection()

      expect(mockConnRun).toHaveBeenCalledWith("SET access_mode = 'read_only'")
    })

    it('does not set read_only mode for in-memory databases', async () => {
      const connector = new DuckDBConnector(baseConfig) // defaults to :memory:
      await connector.testConnection()

      expect(mockConnRun).not.toHaveBeenCalledWith("SET access_mode = 'read_only'")
    })
  })

  // -------------------------------------------------------------------------
  // Schema discovery
  // -------------------------------------------------------------------------

  describe('discoverSchema', () => {
    it('uses main as default schema', async () => {
      const connector = new DuckDBConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.schemaName).toBe('main')
      expect(schema.dialect).toBe('duckdb')
    })

    it('discovers tables from information_schema', async () => {
      let callIdx = 0
      mockConnAll.mockImplementation((sql: string, cb: (err: Error | null, rows: unknown[]) => void) => {
        callIdx++
        if (callIdx === 1) {
          // discoverTables
          cb(null, [{ tableName: 'users' }, { tableName: 'orders' }])
        } else if (sql.includes('information_schema.columns')) {
          cb(null, [])
        } else if (sql.includes('duckdb_constraints') && sql.includes('PRIMARY KEY')) {
          cb(null, [])
        } else if (sql.includes('duckdb_constraints') && sql.includes('FOREIGN KEY')) {
          cb(null, [])
        } else if (sql.includes('duckdb_tables')) {
          cb(null, [{ cnt: 100 }])
        } else {
          cb(null, [])
        }
      })

      const connector = new DuckDBConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.tables).toHaveLength(2)
      expect(schema.tables[0]!.tableName).toBe('users')
      expect(schema.tables[1]!.tableName).toBe('orders')
    })

    it('discovers columns with primary key detection', async () => {
      let callIdx = 0
      mockConnAll.mockImplementation((sql: string, cb: (err: Error | null, rows: unknown[]) => void) => {
        callIdx++
        if (callIdx === 1) {
          // discoverTables
          cb(null, [{ tableName: 't' }])
        } else if (sql.includes('information_schema.columns')) {
          cb(null, [
            { columnName: 'id', dataType: 'INTEGER', isNullable: 'NO', defaultValue: null, maxLength: null },
            { columnName: 'name', dataType: 'VARCHAR', isNullable: 'YES', defaultValue: "'default'", maxLength: 255 },
          ])
        } else if (sql.includes('duckdb_constraints') && sql.includes('PRIMARY KEY')) {
          cb(null, [{ col_name: 'id' }])
        } else if (sql.includes('duckdb_constraints') && sql.includes('FOREIGN KEY')) {
          cb(null, [])
        } else if (sql.includes('duckdb_tables')) {
          cb(null, [{ cnt: 42 }])
        } else {
          cb(null, [])
        }
      })

      const connector = new DuckDBConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })
      const columns = schema.tables[0]!.columns

      expect(columns).toHaveLength(2)
      expect(columns[0]!.columnName).toBe('id')
      expect(columns[0]!.isPrimaryKey).toBe(true)
      expect(columns[0]!.isNullable).toBe(false)
      expect(columns[0]!.dataType).toBe('integer')

      expect(columns[1]!.columnName).toBe('name')
      expect(columns[1]!.isPrimaryKey).toBe(false)
      expect(columns[1]!.isNullable).toBe(true)
      expect(columns[1]!.defaultValue).toBe("'default'")
      expect(columns[1]!.maxLength).toBe(255)
    })

    it('handles primary key constraint query failure gracefully', async () => {
      let callIdx = 0
      mockConnAll.mockImplementation((sql: string, cb: (err: Error | null, rows: unknown[]) => void) => {
        callIdx++
        if (callIdx === 1) {
          cb(null, [{ tableName: 't' }])
        } else if (sql.includes('information_schema.columns')) {
          cb(null, [{ columnName: 'id', dataType: 'INTEGER', isNullable: 'NO', defaultValue: null, maxLength: null }])
        } else if (sql.includes('duckdb_constraints') && sql.includes('PRIMARY KEY')) {
          cb(new Error('constraint query failed'), [])
        } else if (sql.includes('duckdb_constraints') && sql.includes('FOREIGN KEY')) {
          cb(null, [])
        } else if (sql.includes('duckdb_tables')) {
          cb(null, [{ cnt: 0 }])
        } else {
          cb(null, [])
        }
      })

      const connector = new DuckDBConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      // Should not throw — fallback is no PKs
      expect(schema.tables[0]!.columns[0]!.isPrimaryKey).toBe(false)
    })

    it('discovers foreign keys', async () => {
      let callIdx = 0
      mockConnAll.mockImplementation((sql: string, cb: (err: Error | null, rows: unknown[]) => void) => {
        callIdx++
        if (callIdx === 1) {
          cb(null, [{ tableName: 'orders' }])
        } else if (sql.includes('information_schema.columns')) {
          cb(null, [])
        } else if (sql.includes('duckdb_constraints') && sql.includes('PRIMARY KEY')) {
          cb(null, [])
        } else if (sql.includes('duckdb_constraints') && sql.includes('FOREIGN KEY')) {
          cb(null, [{ columnNames: ['user_id'] }])
        } else if (sql.includes('duckdb_tables')) {
          cb(null, [{ cnt: 50 }])
        } else {
          cb(null, [])
        }
      })

      const connector = new DuckDBConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })
      const fks = schema.tables[0]!.foreignKeys

      expect(fks).toHaveLength(1)
      expect(fks[0]!.constraintName).toBe('fk_orders_0')
      expect(fks[0]!.columnName).toBe('user_id')
    })

    it('discovers row count from duckdb_tables', async () => {
      let callIdx = 0
      mockConnAll.mockImplementation((sql: string, cb: (err: Error | null, rows: unknown[]) => void) => {
        callIdx++
        if (callIdx === 1) {
          cb(null, [{ tableName: 't' }])
        } else if (sql.includes('information_schema.columns')) {
          cb(null, [])
        } else if (sql.includes('duckdb_constraints') && sql.includes('PRIMARY KEY')) {
          cb(null, [])
        } else if (sql.includes('duckdb_constraints') && sql.includes('FOREIGN KEY')) {
          cb(null, [])
        } else if (sql.includes('duckdb_tables')) {
          cb(null, [{ cnt: 12345 }])
        } else {
          cb(null, [])
        }
      })

      const connector = new DuckDBConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.tables[0]!.rowCountEstimate).toBe(12345)
    })

    it('returns 0 row count when duckdb_tables query fails', async () => {
      let callIdx = 0
      mockConnAll.mockImplementation((sql: string, cb: (err: Error | null, rows: unknown[]) => void) => {
        callIdx++
        if (callIdx === 1) {
          cb(null, [{ tableName: 't' }])
        } else if (sql.includes('information_schema.columns')) {
          cb(null, [])
        } else if (sql.includes('duckdb_constraints') && sql.includes('PRIMARY KEY')) {
          cb(null, [])
        } else if (sql.includes('duckdb_constraints') && sql.includes('FOREIGN KEY')) {
          cb(null, [])
        } else if (sql.includes('duckdb_tables')) {
          cb(new Error('table not found'), [])
        } else {
          cb(null, [])
        }
      })

      const connector = new DuckDBConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.tables[0]!.rowCountEstimate).toBe(0)
    })

    it('discovers sample values', async () => {
      let callIdx = 0
      mockConnAll.mockImplementation((sql: string, cb: (err: Error | null, rows: unknown[]) => void) => {
        callIdx++
        if (callIdx === 1) {
          cb(null, [{ tableName: 't' }])
        } else if (sql.includes('information_schema.columns')) {
          cb(null, [{ columnName: 'city', dataType: 'VARCHAR', isNullable: 'YES', defaultValue: null, maxLength: null }])
        } else if (sql.includes('duckdb_constraints') && sql.includes('PRIMARY KEY')) {
          cb(null, [])
        } else if (sql.includes('duckdb_constraints') && sql.includes('FOREIGN KEY')) {
          cb(null, [])
        } else if (sql.includes('duckdb_tables')) {
          cb(null, [{ cnt: 10 }])
        } else if (sql.includes('DISTINCT')) {
          cb(null, [{ val: 'Berlin' }, { val: 'Paris' }])
        } else {
          cb(null, [])
        }
      })

      const connector = new DuckDBConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 5 })

      expect(schema.tables[0]!.sampleValues['city']).toEqual(['Berlin', 'Paris'])
    })
  })
})
