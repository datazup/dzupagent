/**
 * Tests for SnowflakeConnector — mocks snowflake-sdk via node:module createRequire + dynamic import.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SQLConnectionConfig } from '../types.js'

// ---------------------------------------------------------------------------
// Mock snowflake-sdk
// ---------------------------------------------------------------------------

const mockExecute = vi.fn()
const mockConnect = vi.fn()
const mockDestroy = vi.fn()

const mockCreateConnection = vi.fn(() => ({
  connect: mockConnect,
  execute: mockExecute,
  destroy: mockDestroy,
}))

const mockConfigure = vi.fn()

const mockSnowflakeSDK = {
  createConnection: mockCreateConnection,
  configure: mockConfigure,
}

const mockRuntimeRequire = vi.fn((specifier: string) => {
  if (specifier === 'snowflake-sdk') {
    return mockSnowflakeSDK
  }
  throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' })
}) as unknown as NodeRequire

mockRuntimeRequire.resolve = vi.fn((specifier: string) => {
  if (specifier === 'snowflake-sdk') return '/fake/path/snowflake-sdk'
  throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' })
}) as unknown as NodeRequire['resolve']

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => mockRuntimeRequire),
}))

vi.mock('snowflake-sdk', () => ({
  default: mockSnowflakeSDK,
  createConnection: mockCreateConnection,
  configure: mockConfigure,
}))

const baseConfig: SQLConnectionConfig = {
  host: 'myaccount.snowflakecomputing.com',
  port: 443,
  database: 'MY_DB',
  username: 'testuser',
  password: 'testpass',
  ssl: true,
  account: 'myaccount',
  warehouse: 'MY_WH',
  role: 'MY_ROLE',
}

// ---------------------------------------------------------------------------
// Import after mocking
// ---------------------------------------------------------------------------

const { SnowflakeConnector } = await import('../adapters/snowflake.js')

// ---------------------------------------------------------------------------
// Helper: set up connect + execute mocks for a sequence of queries
// ---------------------------------------------------------------------------

function setupConnection(queryResults: Array<{ err?: Error; rows?: unknown[] }>): void {
  mockConnect.mockImplementation(
    (cb: (err: Error | null, conn: unknown) => void) => {
      cb(null, {
        execute: mockExecute,
        destroy: mockDestroy,
        connect: mockConnect,
      })
    },
  )

  let callIdx = 0
  mockExecute.mockImplementation(
    (opts: { sqlText: string; binds?: unknown[]; streamResult?: boolean; complete: (err: Error | null, stmt: unknown, rows: unknown[]) => void }) => {
      const entry = queryResults[callIdx++]
      if (entry?.err) {
        opts.complete(entry.err, null, [])
      } else {
        opts.complete(null, null, entry?.rows ?? [])
      }
    },
  )
}

describe('SnowflakeConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('creates a connector with valid config', () => {
      const connector = new SnowflakeConnector(baseConfig)
      expect(connector).toBeDefined()
    })

    it('throws when snowflake-sdk is not installed', () => {
      const savedResolve = (mockRuntimeRequire.resolve as ReturnType<typeof vi.fn>).getMockImplementation()
      ;(mockRuntimeRequire.resolve as ReturnType<typeof vi.fn>).mockImplementation((spec: string) => {
        throw Object.assign(new Error(`Cannot find module '${spec}'`), { code: 'MODULE_NOT_FOUND' })
      })

      expect(() => new SnowflakeConnector(baseConfig)).toThrow(
        'SnowflakeConnector requires the optional dependency "snowflake-sdk"',
      )

      ;(mockRuntimeRequire.resolve as ReturnType<typeof vi.fn>).mockImplementation(savedResolve!)
    })
  })

  // -------------------------------------------------------------------------
  // getDialect
  // -------------------------------------------------------------------------

  describe('getDialect', () => {
    it('returns snowflake', () => {
      const connector = new SnowflakeConnector(baseConfig)
      expect(connector.getDialect()).toBe('snowflake')
    })
  })

  // -------------------------------------------------------------------------
  // testConnection
  // -------------------------------------------------------------------------

  describe('testConnection', () => {
    it('returns ok:true on successful connection', async () => {
      setupConnection([{ rows: [{ test: 1 }] }])

      const connector = new SnowflakeConnector(baseConfig)
      const result = await connector.testConnection()

      expect(result.ok).toBe(true)
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it('returns ok:false on connection failure', async () => {
      mockConnect.mockImplementation(
        (cb: (err: Error | null, conn: unknown) => void) => {
          cb(new Error('Network error'), null)
        },
      )

      const connector = new SnowflakeConnector(baseConfig)
      const result = await connector.testConnection()

      expect(result.ok).toBe(false)
      expect(result.error).toContain('Snowflake connection failed')
    })

    it('returns ok:false on query failure', async () => {
      setupConnection([{ err: new Error('Permission denied') }])

      const connector = new SnowflakeConnector(baseConfig)
      const result = await connector.testConnection()

      expect(result.ok).toBe(false)
      expect(result.error).toContain('Permission denied')
    })

    it('handles non-Error thrown values', async () => {
      mockConnect.mockImplementation(() => {
        throw 'raw error'
      })

      const connector = new SnowflakeConnector(baseConfig)
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
      setupConnection([
        // ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS
        { rows: [] },
        // actual query
        { rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] },
      ])

      const connector = new SnowflakeConnector(baseConfig)
      const result = await connector.executeQuery('SELECT * FROM users')

      expect(result.columns).toEqual(['id', 'name'])
      expect(result.rows).toHaveLength(2)
      expect(result.rowCount).toBe(2)
      expect(result.truncated).toBe(false)
    })

    it('sets session timeout before query', async () => {
      setupConnection([{ rows: [] }, { rows: [] }])

      const connector = new SnowflakeConnector(baseConfig)
      await connector.executeQuery('SELECT 1', { timeoutMs: 5000 })

      const firstCall = mockExecute.mock.calls[0]?.[0] as { sqlText: string }
      expect(firstCall.sqlText).toContain('STATEMENT_TIMEOUT_IN_SECONDS = 5')
    })

    it('rounds up timeout to at least 1 second', async () => {
      setupConnection([{ rows: [] }, { rows: [] }])

      const connector = new SnowflakeConnector(baseConfig)
      await connector.executeQuery('SELECT 1', { timeoutMs: 100 })

      const firstCall = mockExecute.mock.calls[0]?.[0] as { sqlText: string }
      expect(firstCall.sqlText).toContain('STATEMENT_TIMEOUT_IN_SECONDS = 1')
    })

    it('returns empty result for zero rows', async () => {
      setupConnection([{ rows: [] }, { rows: [] }])

      const connector = new SnowflakeConnector(baseConfig)
      const result = await connector.executeQuery('SELECT * FROM empty_table')

      expect(result.columns).toEqual([])
      expect(result.rows).toEqual([])
      expect(result.rowCount).toBe(0)
    })

    it('truncates when rows exceed maxRows', async () => {
      const rows = Array.from({ length: 11 }, (_, i) => ({ id: i + 1 }))
      setupConnection([{ rows: [] }, { rows }])

      const connector = new SnowflakeConnector(baseConfig)
      const result = await connector.executeQuery('SELECT * FROM t', { maxRows: 10 })

      expect(result.truncated).toBe(true)
      expect(result.rows).toHaveLength(10)
    })

    it('wraps query in subquery with LIMIT (Snowflake override)', async () => {
      setupConnection([{ rows: [] }, { rows: [] }])

      const connector = new SnowflakeConnector(baseConfig)
      await connector.executeQuery('SELECT * FROM t', { maxRows: 10 })

      const queryCall = mockExecute.mock.calls[1]?.[0] as { sqlText: string }
      expect(queryCall.sqlText).toContain('SELECT * FROM (SELECT * FROM t) AS _sub LIMIT 11')
    })

    it('does not add LIMIT when already present', async () => {
      setupConnection([{ rows: [] }, { rows: [] }])

      const connector = new SnowflakeConnector(baseConfig)
      await connector.executeQuery('SELECT * FROM t LIMIT 5', { maxRows: 10 })

      const queryCall = mockExecute.mock.calls[1]?.[0] as { sqlText: string }
      expect(queryCall.sqlText).toBe('SELECT * FROM t LIMIT 5')
    })

    it('strips trailing semicolons', async () => {
      setupConnection([{ rows: [] }, { rows: [] }])

      const connector = new SnowflakeConnector(baseConfig)
      await connector.executeQuery('SELECT * FROM t;', { maxRows: 10 })

      const queryCall = mockExecute.mock.calls[1]?.[0] as { sqlText: string }
      expect(queryCall.sqlText).not.toContain(';')
    })

    it('propagates query errors', async () => {
      setupConnection([
        { rows: [] }, // ALTER SESSION
        { err: new Error('SQL compilation error') },
      ])

      const connector = new SnowflakeConnector(baseConfig)

      await expect(connector.executeQuery('INVALID SQL')).rejects.toThrow('Snowflake query error')
    })
  })

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------

  describe('destroy', () => {
    it('calls connection.destroy() when connected', async () => {
      setupConnection([{ rows: [{ test: 1 }] }])
      mockDestroy.mockImplementation((cb: (err: Error | null) => void) => {
        cb(null)
      })

      const connector = new SnowflakeConnector(baseConfig)
      await connector.testConnection()

      await connector.destroy()

      expect(mockDestroy).toHaveBeenCalled()
    })

    it('does nothing when not connected', async () => {
      const connector = new SnowflakeConnector(baseConfig)

      await connector.destroy()

      expect(mockDestroy).not.toHaveBeenCalled()
    })

    it('propagates destroy errors', async () => {
      setupConnection([{ rows: [{ test: 1 }] }])
      mockDestroy.mockImplementation((cb: (err: Error | null) => void) => {
        cb(new Error('destroy failed'))
      })

      const connector = new SnowflakeConnector(baseConfig)
      await connector.testConnection()

      await expect(connector.destroy()).rejects.toThrow('destroy failed')
    })
  })

  // -------------------------------------------------------------------------
  // Connection caching
  // -------------------------------------------------------------------------

  describe('connection caching', () => {
    it('reuses existing connection on subsequent calls', async () => {
      setupConnection([
        { rows: [{ test: 1 }] },
        { rows: [{ test: 1 }] },
      ])

      const connector = new SnowflakeConnector(baseConfig)
      await connector.testConnection()
      await connector.testConnection()

      expect(mockConnect).toHaveBeenCalledTimes(1)
    })

    it('passes account, warehouse, and role from config', async () => {
      setupConnection([{ rows: [{ test: 1 }] }])

      const connector = new SnowflakeConnector(baseConfig)
      await connector.testConnection()

      expect(mockCreateConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          account: 'myaccount',
          username: 'testuser',
          password: 'testpass',
          database: 'MY_DB',
          schema: 'PUBLIC',
          warehouse: 'MY_WH',
          role: 'MY_ROLE',
        }),
      )
    })

    it('uses host as account fallback', async () => {
      setupConnection([{ rows: [{ test: 1 }] }])

      const config = { ...baseConfig, account: undefined }
      const connector = new SnowflakeConnector(config)
      await connector.testConnection()

      expect(mockCreateConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          account: 'myaccount.snowflakecomputing.com',
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // Schema discovery
  // -------------------------------------------------------------------------

  describe('discoverSchema', () => {
    it('uses PUBLIC as default schema', async () => {
      setupConnection([{ rows: [] }])

      const connector = new SnowflakeConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.schemaName).toBe('PUBLIC')
      expect(schema.dialect).toBe('snowflake')
    })

    it('discovers tables from INFORMATION_SCHEMA', async () => {
      setupConnection([
        // discoverTables
        { rows: [
          { TABLE_NAME: 'USERS', TABLE_TYPE: 'BASE TABLE', COMMENT: 'User table' },
          { TABLE_NAME: 'ORDERS', TABLE_TYPE: 'BASE TABLE', COMMENT: null },
        ] },
        // users: columns
        { rows: [] },
        // users: foreign keys
        { rows: [] },
        // users: row count
        { rows: [{ ROW_COUNT: 1000 }] },
        // orders: columns
        { rows: [] },
        // orders: foreign keys
        { rows: [] },
        // orders: row count
        { rows: [{ ROW_COUNT: 500 }] },
      ])

      const connector = new SnowflakeConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.tables).toHaveLength(2)
      expect(schema.tables[0]!.tableName).toBe('USERS')
      expect(schema.tables[0]!.description).toBe('User table')
      expect(schema.tables[0]!.rowCountEstimate).toBe(1000)
      expect(schema.tables[1]!.tableName).toBe('ORDERS')
      expect(schema.tables[1]!.description).toBeNull()
    })

    it('discovers columns with data type mapping', async () => {
      setupConnection([
        // discoverTables
        { rows: [{ TABLE_NAME: 'T', TABLE_TYPE: 'BASE TABLE', COMMENT: null }] },
        // discoverColumns
        { rows: [
          { COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, ORDINAL_POSITION: 1, CHARACTER_MAXIMUM_LENGTH: null, COMMENT: null },
          { COLUMN_NAME: 'NAME', DATA_TYPE: 'VARCHAR', IS_NULLABLE: 'YES', COLUMN_DEFAULT: "'unnamed'", ORDINAL_POSITION: 2, CHARACTER_MAXIMUM_LENGTH: 255, COMMENT: 'User name' },
          { COLUMN_NAME: 'CREATED', DATA_TYPE: 'TIMESTAMP_NTZ', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, ORDINAL_POSITION: 3, CHARACTER_MAXIMUM_LENGTH: null, COMMENT: null },
          { COLUMN_NAME: 'SCORE', DATA_TYPE: 'FLOAT', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, ORDINAL_POSITION: 4, CHARACTER_MAXIMUM_LENGTH: null, COMMENT: null },
        ] },
        // discoverForeignKeys
        { rows: [] },
        // discoverRowCount
        { rows: [{ ROW_COUNT: 100 }] },
      ])

      const connector = new SnowflakeConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })
      const columns = schema.tables[0]!.columns

      expect(columns).toHaveLength(4)
      expect(columns[0]!.columnName).toBe('ID')
      expect(columns[0]!.dataType).toBe('NUMBER')
      expect(columns[0]!.isNullable).toBe(false)
      expect(columns[0]!.isPrimaryKey).toBe(false) // Snowflake doesn't expose PKs

      expect(columns[1]!.columnName).toBe('NAME')
      expect(columns[1]!.dataType).toBe('VARCHAR')
      expect(columns[1]!.isNullable).toBe(true)
      expect(columns[1]!.defaultValue).toBe("'unnamed'")
      expect(columns[1]!.maxLength).toBe(255)
      expect(columns[1]!.description).toBe('User name')

      expect(columns[2]!.dataType).toBe('TIMESTAMP_NTZ')
      expect(columns[3]!.dataType).toBe('FLOAT')
    })

    it('discovers foreign keys', async () => {
      setupConnection([
        { rows: [{ TABLE_NAME: 'ORDERS', TABLE_TYPE: 'BASE TABLE', COMMENT: null }] },
        { rows: [] }, // columns
        { rows: [
          {
            CONSTRAINT_NAME: 'FK_ORDERS_USER',
            COLUMN_NAME: 'USER_ID',
            REFERENCED_TABLE: 'USERS',
            REFERENCED_COLUMN: 'ID',
            REFERENCED_SCHEMA: 'PUBLIC',
          },
        ] },
        { rows: [{ ROW_COUNT: 50 }] },
      ])

      const connector = new SnowflakeConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })
      const fks = schema.tables[0]!.foreignKeys

      expect(fks).toHaveLength(1)
      expect(fks[0]!.constraintName).toBe('FK_ORDERS_USER')
      expect(fks[0]!.columnName).toBe('USER_ID')
      expect(fks[0]!.referencedTable).toBe('USERS')
      expect(fks[0]!.referencedColumn).toBe('ID')
    })

    it('returns 0 row count when table not found', async () => {
      setupConnection([
        { rows: [{ TABLE_NAME: 'T', TABLE_TYPE: 'BASE TABLE', COMMENT: null }] },
        { rows: [] },
        { rows: [] },
        { rows: [] }, // empty row count
      ])

      const connector = new SnowflakeConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.tables[0]!.rowCountEstimate).toBe(0)
    })

    it('discovers sample values', async () => {
      setupConnection([
        { rows: [{ TABLE_NAME: 'T', TABLE_TYPE: 'BASE TABLE', COMMENT: null }] },
        { rows: [
          { COLUMN_NAME: 'CITY', DATA_TYPE: 'VARCHAR', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, ORDINAL_POSITION: 1, CHARACTER_MAXIMUM_LENGTH: null, COMMENT: null },
        ] },
        { rows: [] },
        { rows: [{ ROW_COUNT: 10 }] },
        { rows: [{ val: 'Berlin' }, { val: 'Paris' }] },
      ])

      const connector = new SnowflakeConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 5 })

      expect(schema.tables[0]!.sampleValues['CITY']).toEqual(['Berlin', 'Paris'])
    })

    it('uses bind parameters for INFORMATION_SCHEMA queries', async () => {
      setupConnection([
        // discoverTables (uses binds)
        { rows: [{ TABLE_NAME: 'T', TABLE_TYPE: 'BASE TABLE', COMMENT: null }] },
        { rows: [] },
        { rows: [] },
        { rows: [{ ROW_COUNT: 0 }] },
      ])

      const connector = new SnowflakeConnector(baseConfig)
      await connector.discoverSchema({ sampleValueLimit: 0 })

      // Verify that the tables query used bind parameters
      const tablesCall = mockExecute.mock.calls[0]?.[0] as { sqlText: string; binds?: unknown[] }
      expect(tablesCall.binds).toEqual(['PUBLIC'])
    })
  })

  // -------------------------------------------------------------------------
  // Data type mapping
  // -------------------------------------------------------------------------

  describe('data type mapping', () => {
    async function getColumnDataType(inputType: string): Promise<string> {
      setupConnection([
        { rows: [{ TABLE_NAME: 'T', TABLE_TYPE: 'BASE TABLE', COMMENT: null }] },
        { rows: [
          { COLUMN_NAME: 'COL', DATA_TYPE: inputType, IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, ORDINAL_POSITION: 1, CHARACTER_MAXIMUM_LENGTH: null, COMMENT: null },
        ] },
        { rows: [] },
        { rows: [{ ROW_COUNT: 0 }] },
      ])

      const connector = new SnowflakeConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })
      return schema.tables[0]!.columns[0]!.dataType
    }

    it('maps STRING to VARCHAR', async () => {
      expect(await getColumnDataType('STRING')).toBe('VARCHAR')
    })

    it('maps TEXT to VARCHAR', async () => {
      expect(await getColumnDataType('TEXT')).toBe('VARCHAR')
    })

    it('maps DOUBLE PRECISION to FLOAT', async () => {
      expect(await getColumnDataType('DOUBLE PRECISION')).toBe('FLOAT')
    })

    it('maps TIMESTAMP to TIMESTAMP_NTZ', async () => {
      expect(await getColumnDataType('TIMESTAMP')).toBe('TIMESTAMP_NTZ')
    })

    it('maps VARIANT unchanged', async () => {
      expect(await getColumnDataType('VARIANT')).toBe('VARIANT')
    })

    it('maps BOOLEAN unchanged', async () => {
      expect(await getColumnDataType('BOOLEAN')).toBe('BOOLEAN')
    })

    it('maps GEOGRAPHY unchanged', async () => {
      expect(await getColumnDataType('GEOGRAPHY')).toBe('GEOGRAPHY')
    })

    it('maps unknown types to uppercase', async () => {
      expect(await getColumnDataType('custom_type')).toBe('CUSTOM_TYPE')
    })
  })
})
