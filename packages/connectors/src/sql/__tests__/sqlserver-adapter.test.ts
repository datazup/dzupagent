/**
 * Tests for SQLServerConnector — mocks mssql via node:module createRequire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SQLConnectionConfig } from '../types.js'

// ---------------------------------------------------------------------------
// Mock mssql module
// ---------------------------------------------------------------------------

const mockRequestQuery = vi.fn()
const mockRequestInput = vi.fn()
const mockRequest = vi.fn(() => ({
  query: mockRequestQuery,
  input: mockRequestInput,
  timeout: 0,
}))

// Make input() chainable
mockRequestInput.mockReturnValue({
  query: mockRequestQuery,
  input: mockRequestInput,
  timeout: 0,
})

const mockPoolClose = vi.fn()
const mockPoolConnect = vi.fn()

const mockConnectionPool = vi.fn(() => ({
  request: mockRequest,
  close: mockPoolClose,
  connect: mockPoolConnect,
}))

const mockMSSQLModule = {
  ConnectionPool: mockConnectionPool,
  VarChar: 'VarChar',
  default: {
    ConnectionPool: mockConnectionPool,
    VarChar: 'VarChar',
  },
}

const mockRuntimeRequire = vi.fn((specifier: string) => {
  if (specifier === 'mssql') {
    return mockMSSQLModule
  }
  throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' })
})

const mockResolve = vi.fn((specifier: string) => {
  if (specifier === 'mssql') return '/node_modules/mssql/index.js'
  throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' })
})

Object.assign(mockRuntimeRequire, { resolve: mockResolve })

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => mockRuntimeRequire),
}))

// Mock dynamic import for loadMSSQLModule
vi.mock('mssql', () => mockMSSQLModule)

const baseConfig: SQLConnectionConfig = {
  host: '127.0.0.1',
  port: 1433,
  database: 'testdb',
  username: 'sa',
  password: 'pass',
  ssl: false,
}

// ---------------------------------------------------------------------------
// Import after mocking
// ---------------------------------------------------------------------------

const { SQLServerConnector } = await import('../adapters/sqlserver.js')

describe('SQLServerConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPoolConnect.mockResolvedValue({
      request: mockRequest,
      close: mockPoolClose,
      connect: mockPoolConnect,
    })
    // Make request() return a chainable object
    mockRequest.mockReturnValue({
      query: mockRequestQuery,
      input: mockRequestInput,
      timeout: 0,
    })
    mockRequestInput.mockReturnValue({
      query: mockRequestQuery,
      input: mockRequestInput,
      timeout: 0,
    })
  })

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('creates connector without throwing when mssql is available', () => {
      const connector = new SQLServerConnector(baseConfig)
      expect(connector).toBeDefined()
    })

    it('throws when mssql driver is not installed', () => {
      mockResolve.mockImplementation(() => {
        throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' })
      })

      expect(() => new SQLServerConnector(baseConfig)).toThrow(
        /requires the optional dependency/,
      )

      // Restore
      mockResolve.mockImplementation((specifier: string) => {
        if (specifier === 'mssql') return '/node_modules/mssql/index.js'
        throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' })
      })
    })
  })

  // -------------------------------------------------------------------------
  // getDialect
  // -------------------------------------------------------------------------

  describe('getDialect', () => {
    it('returns sqlserver', () => {
      const connector = new SQLServerConnector(baseConfig)
      expect(connector.getDialect()).toBe('sqlserver')
    })
  })

  // -------------------------------------------------------------------------
  // testConnection
  // -------------------------------------------------------------------------

  describe('testConnection', () => {
    it('returns ok:true on successful connection', async () => {
      mockRequestQuery.mockResolvedValue({
        recordset: [{ ok: 1 }],
      })
      const connector = new SQLServerConnector(baseConfig)

      const result = await connector.testConnection()

      expect(result.ok).toBe(true)
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it('returns ok:false on connection failure', async () => {
      mockPoolConnect.mockRejectedValue(new Error('ECONNREFUSED'))
      const connector = new SQLServerConnector(baseConfig)

      const result = await connector.testConnection()

      expect(result.ok).toBe(false)
      expect(result.error).toContain('ECONNREFUSED')
    })

    it('handles non-Error thrown values', async () => {
      mockPoolConnect.mockRejectedValue('raw error')
      const connector = new SQLServerConnector(baseConfig)

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
      mockRequestQuery.mockResolvedValue({
        recordset: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
      })

      const connector = new SQLServerConnector(baseConfig)
      const result = await connector.executeQuery('SELECT * FROM users')

      expect(result.columns).toEqual(['id', 'name'])
      expect(result.rows).toHaveLength(2)
      expect(result.rowCount).toBe(2)
      expect(result.truncated).toBe(false)
    })

    it('prepends SET TRANSACTION ISOLATION LEVEL', async () => {
      mockRequestQuery.mockResolvedValue({ recordset: [] })

      const connector = new SQLServerConnector(baseConfig)
      await connector.executeQuery('SELECT 1')

      expect(mockRequestQuery).toHaveBeenCalledWith(
        expect.stringContaining('SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED'),
      )
    })

    it('handles empty recordset', async () => {
      mockRequestQuery.mockResolvedValue({ recordset: [] })

      const connector = new SQLServerConnector(baseConfig)
      const result = await connector.executeQuery('SELECT * FROM empty_table')

      expect(result.columns).toEqual([])
      expect(result.rows).toEqual([])
    })

    it('handles undefined recordset', async () => {
      mockRequestQuery.mockResolvedValue({})

      const connector = new SQLServerConnector(baseConfig)
      const result = await connector.executeQuery('SELECT 1')

      expect(result.columns).toEqual([])
      expect(result.rows).toEqual([])
    })

    it('truncates when rows exceed maxRows', async () => {
      const rows = Array.from({ length: 11 }, (_, i) => ({ id: i + 1 }))
      mockRequestQuery.mockResolvedValue({ recordset: rows })

      const connector = new SQLServerConnector(baseConfig)
      const result = await connector.executeQuery('SELECT * FROM t', { maxRows: 10 })

      expect(result.truncated).toBe(true)
      expect(result.rows).toHaveLength(10)
    })
  })

  // -------------------------------------------------------------------------
  // wrapWithLimit (TOP N override)
  // -------------------------------------------------------------------------

  describe('wrapWithLimit — T-SQL TOP syntax', () => {
    it('injects TOP N for SELECT', async () => {
      mockRequestQuery.mockResolvedValue({ recordset: [] })

      const connector = new SQLServerConnector(baseConfig)
      await connector.executeQuery('SELECT * FROM users', { maxRows: 10 })

      const calledSql = mockRequestQuery.mock.calls[0]![0] as string
      expect(calledSql).toContain('SELECT TOP 11 * FROM users')
    })

    it('injects TOP N for SELECT DISTINCT', async () => {
      mockRequestQuery.mockResolvedValue({ recordset: [] })

      const connector = new SQLServerConnector(baseConfig)
      await connector.executeQuery('SELECT DISTINCT name FROM users', { maxRows: 10 })

      const calledSql = mockRequestQuery.mock.calls[0]![0] as string
      expect(calledSql).toContain('SELECT DISTINCT TOP 11 name FROM users')
    })

    it('does not double-wrap when TOP already present', async () => {
      mockRequestQuery.mockResolvedValue({ recordset: [] })

      const connector = new SQLServerConnector(baseConfig)
      await connector.executeQuery('SELECT TOP 5 * FROM users', { maxRows: 10 })

      const calledSql = mockRequestQuery.mock.calls[0]![0] as string
      expect(calledSql).toContain('TOP 5')
      expect(calledSql).not.toContain('TOP 11')
    })

    it('does not double-wrap when LIMIT already present', async () => {
      mockRequestQuery.mockResolvedValue({ recordset: [] })

      const connector = new SQLServerConnector(baseConfig)
      await connector.executeQuery('SELECT * FROM users LIMIT 5', { maxRows: 10 })

      const calledSql = mockRequestQuery.mock.calls[0]![0] as string
      expect(calledSql).toContain('LIMIT 5')
      expect(calledSql).not.toContain('TOP')
    })
  })

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------

  describe('destroy', () => {
    it('calls pool.close()', async () => {
      mockPoolClose.mockResolvedValue(undefined)

      // We need to first getPool to have a pool to close
      mockRequestQuery.mockResolvedValue({ recordset: [{ ok: 1 }] })
      const connector = new SQLServerConnector(baseConfig)
      await connector.testConnection() // This creates the pool

      await connector.destroy()

      expect(mockPoolClose).toHaveBeenCalled()
    })

    it('is no-op when pool was never created', async () => {
      const connector = new SQLServerConnector(baseConfig)
      await connector.destroy() // Should not throw

      expect(mockPoolClose).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Schema discovery
  // -------------------------------------------------------------------------

  describe('discoverSchema', () => {
    it('uses dbo as default schema', async () => {
      mockRequestQuery.mockResolvedValue({ recordset: [] })

      const connector = new SQLServerConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.schemaName).toBe('dbo')
      expect(schema.dialect).toBe('sqlserver')
    })

    it('discovers tables from INFORMATION_SCHEMA', async () => {
      mockRequestQuery
        .mockResolvedValueOnce({
          recordset: [
            { tableName: 'users' },
            { tableName: 'orders' },
          ],
        })
        // users enrichment: columns, fks, rowCount
        .mockResolvedValueOnce({ recordset: [] }) // columns
        .mockResolvedValueOnce({ recordset: [] }) // fks
        .mockResolvedValueOnce({ recordset: [{ rowCount: 1000 }] }) // rowCount
        // orders enrichment
        .mockResolvedValueOnce({ recordset: [] })
        .mockResolvedValueOnce({ recordset: [] })
        .mockResolvedValueOnce({ recordset: [{ rowCount: 500 }] })

      const connector = new SQLServerConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.tables).toHaveLength(2)
      expect(schema.tables[0]!.tableName).toBe('users')
      expect(schema.tables[0]!.rowCountEstimate).toBe(1000)
    })

    it('discovers columns with type and key info', async () => {
      mockRequestQuery
        .mockResolvedValueOnce({ recordset: [{ tableName: 'users' }] })
        .mockResolvedValueOnce({
          recordset: [
            {
              columnName: 'id',
              dataType: 'INT',
              isNullable: 'NO',
              defaultValue: null,
              maxLength: null,
              isPrimaryKey: 1,
            },
            {
              columnName: 'email',
              dataType: 'NVARCHAR',
              isNullable: 'YES',
              defaultValue: "('')",
              maxLength: 255,
              isPrimaryKey: 0,
            },
          ],
        })
        .mockResolvedValueOnce({ recordset: [] })
        .mockResolvedValueOnce({ recordset: [{ rowCount: 50 }] })

      const connector = new SQLServerConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })
      const columns = schema.tables[0]!.columns

      expect(columns).toHaveLength(2)
      expect(columns[0]!.isPrimaryKey).toBe(true)
      expect(columns[0]!.dataType).toBe('int')
      expect(columns[1]!.isNullable).toBe(true)
      expect(columns[1]!.defaultValue).toBe("('')")
      expect(columns[1]!.maxLength).toBe(255)
    })

    it('discovers foreign keys', async () => {
      mockRequestQuery
        .mockResolvedValueOnce({ recordset: [{ tableName: 'orders' }] })
        .mockResolvedValueOnce({ recordset: [] })
        .mockResolvedValueOnce({
          recordset: [{
            constraintName: 'FK_orders_user',
            columnName: 'user_id',
            referencedTable: 'users',
            referencedColumn: 'id',
            referencedSchema: 'dbo',
          }],
        })
        .mockResolvedValueOnce({ recordset: [{ rowCount: 100 }] })

      const connector = new SQLServerConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })
      const fks = schema.tables[0]!.foreignKeys

      expect(fks).toHaveLength(1)
      expect(fks[0]!.constraintName).toBe('FK_orders_user')
      expect(fks[0]!.referencedTable).toBe('users')
    })

    it('returns 0 row count when no partitions found', async () => {
      mockRequestQuery
        .mockResolvedValueOnce({ recordset: [{ tableName: 't' }] })
        .mockResolvedValueOnce({ recordset: [] })
        .mockResolvedValueOnce({ recordset: [] })
        .mockResolvedValueOnce({ recordset: [] }) // no partition rows

      const connector = new SQLServerConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.tables[0]!.rowCountEstimate).toBe(0)
    })

    it('discovers sample values', async () => {
      mockRequestQuery
        .mockResolvedValueOnce({ recordset: [{ tableName: 't' }] })
        .mockResolvedValueOnce({
          recordset: [
            { columnName: 'city', dataType: 'NVARCHAR', isNullable: 'YES', defaultValue: null, maxLength: 100, isPrimaryKey: 0 },
          ],
        })
        .mockResolvedValueOnce({ recordset: [] }) // fks
        .mockResolvedValueOnce({ recordset: [{ rowCount: 10 }] })
        .mockResolvedValueOnce({ recordset: [{ val: 'NYC' }, { val: 'LA' }] })

      const connector = new SQLServerConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 3 })

      expect(schema.tables[0]!.sampleValues['city']).toEqual(['NYC', 'LA'])
    })
  })
})
