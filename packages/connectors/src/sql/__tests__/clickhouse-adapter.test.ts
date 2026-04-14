/**
 * Tests for ClickHouseConnector — mocks @clickhouse/client via node:module createRequire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SQLConnectionConfig } from '../types.js'

// ---------------------------------------------------------------------------
// Mock @clickhouse/client
// ---------------------------------------------------------------------------

const mockQueryJson = vi.fn()
const mockQuery = vi.fn(() => ({
  json: mockQueryJson,
}))
const mockClose = vi.fn()

const mockCreateClient = vi.fn(() => ({
  query: mockQuery,
  close: mockClose,
}))

const mockRuntimeRequire = vi.fn((specifier: string) => {
  if (specifier === '@clickhouse/client') {
    return { createClient: mockCreateClient }
  }
  throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' })
})

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => mockRuntimeRequire),
}))

const baseConfig: SQLConnectionConfig = {
  host: 'localhost',
  port: 8123,
  database: 'default',
  username: 'default',
  password: '',
  ssl: false,
}

// ---------------------------------------------------------------------------
// Import after mocking
// ---------------------------------------------------------------------------

const { ClickHouseConnector } = await import('../adapters/clickhouse.js')

describe('ClickHouseConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQuery.mockReturnValue({ json: mockQueryJson })
  })

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('creates a client with http URL', () => {
      new ClickHouseConnector(baseConfig)
      expect(mockCreateClient).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'http://localhost:8123',
          username: 'default',
          password: '',
          database: 'default',
        }),
      )
    })

    it('creates a client with https URL when ssl is true', () => {
      new ClickHouseConnector({ ...baseConfig, ssl: true })
      expect(mockCreateClient).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://localhost:8123',
        }),
      )
    })

    it('strips protocol prefix from host', () => {
      new ClickHouseConnector({ ...baseConfig, host: 'https://clickhouse.example.com/' })
      expect(mockCreateClient).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'http://clickhouse.example.com:8123',
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // getDialect
  // -------------------------------------------------------------------------

  describe('getDialect', () => {
    it('returns clickhouse', () => {
      const connector = new ClickHouseConnector(baseConfig)
      expect(connector.getDialect()).toBe('clickhouse')
    })
  })

  // -------------------------------------------------------------------------
  // testConnection
  // -------------------------------------------------------------------------

  describe('testConnection', () => {
    it('returns ok:true on successful connection', async () => {
      mockQueryJson.mockResolvedValue({ data: [{ '1': 1 }] })
      const connector = new ClickHouseConnector(baseConfig)

      const result = await connector.testConnection()

      expect(result.ok).toBe(true)
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'SELECT 1',
          format: 'JSON',
        }),
      )
    })

    it('returns ok:false on connection failure', async () => {
      mockQuery.mockReturnValue({
        json: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      })
      const connector = new ClickHouseConnector(baseConfig)

      const result = await connector.testConnection()

      expect(result.ok).toBe(false)
      expect(result.error).toContain('ECONNREFUSED')
    })

    it('handles non-Error thrown values', async () => {
      mockQuery.mockImplementation(() => {
        throw 'raw error'
      })
      const connector = new ClickHouseConnector(baseConfig)

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
      mockQueryJson.mockResolvedValue({
        meta: [{ name: 'id', type: 'UInt64' }, { name: 'name', type: 'String' }],
        data: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
        rows: 2,
      })

      const connector = new ClickHouseConnector(baseConfig)
      const result = await connector.executeQuery('SELECT * FROM users')

      expect(result.columns).toEqual(['id', 'name'])
      expect(result.rows).toHaveLength(2)
      expect(result.rowCount).toBe(2)
      expect(result.truncated).toBe(false)
    })

    it('sets max_execution_time from timeoutMs', async () => {
      mockQueryJson.mockResolvedValue({ meta: [], data: [] })

      const connector = new ClickHouseConnector(baseConfig)
      await connector.executeQuery('SELECT 1', { timeoutMs: 5000 })

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          clickhouse_settings: { max_execution_time: 5 },
        }),
      )
    })

    it('rounds up timeout to at least 1 second', async () => {
      mockQueryJson.mockResolvedValue({ meta: [], data: [] })

      const connector = new ClickHouseConnector(baseConfig)
      await connector.executeQuery('SELECT 1', { timeoutMs: 100 })

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          clickhouse_settings: { max_execution_time: 1 },
        }),
      )
    })

    it('truncates when rows exceed maxRows', async () => {
      const rows = Array.from({ length: 11 }, (_, i) => ({ id: i + 1 }))
      mockQueryJson.mockResolvedValue({
        meta: [{ name: 'id', type: 'UInt64' }],
        data: rows,
      })

      const connector = new ClickHouseConnector(baseConfig)
      const result = await connector.executeQuery('SELECT * FROM t', { maxRows: 10 })

      expect(result.truncated).toBe(true)
      expect(result.rows).toHaveLength(10)
    })

    it('handles missing meta and data', async () => {
      mockQueryJson.mockResolvedValue({})

      const connector = new ClickHouseConnector(baseConfig)
      const result = await connector.executeQuery('SELECT 1')

      expect(result.columns).toEqual([])
      expect(result.rows).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------

  describe('destroy', () => {
    it('calls client.close()', async () => {
      mockClose.mockResolvedValue(undefined)
      const connector = new ClickHouseConnector(baseConfig)

      await connector.destroy()

      expect(mockClose).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Schema discovery
  // -------------------------------------------------------------------------

  describe('discoverSchema', () => {
    it('uses "default" as default schema', async () => {
      mockQueryJson.mockResolvedValue([])

      const connector = new ClickHouseConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.schemaName).toBe('default')
      expect(schema.dialect).toBe('clickhouse')
    })

    it('discovers tables from system.tables', async () => {
      // discoverTables
      mockQueryJson
        .mockResolvedValueOnce([
          { name: 'events', comment: 'Event log', total_rows: '10000' },
          { name: 'users', comment: '', total_rows: '500' },
        ])
        // events: columns
        .mockResolvedValueOnce([])
        // events: row count
        .mockResolvedValueOnce([{ total_rows: '10000' }])
        // users: columns
        .mockResolvedValueOnce([])
        // users: row count
        .mockResolvedValueOnce([{ total_rows: '500' }])

      const connector = new ClickHouseConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.tables).toHaveLength(2)
      expect(schema.tables[0]!.tableName).toBe('events')
      expect(schema.tables[0]!.description).toBe('Event log')
      expect(schema.tables[1]!.description).toBeNull()
    })

    it('discovers columns with nullable detection', async () => {
      mockQueryJson
        .mockResolvedValueOnce([{ name: 't', comment: '', total_rows: '0' }])
        .mockResolvedValueOnce([
          {
            name: 'id',
            type: 'UInt64',
            default_kind: '',
            default_expression: '',
            comment: '',
            is_in_primary_key: 1,
          },
          {
            name: 'name',
            type: 'Nullable(String)',
            default_kind: 'DEFAULT',
            default_expression: "'unnamed'",
            comment: 'User name',
            is_in_primary_key: 0,
          },
          {
            name: 'category',
            type: 'LowCardinality(Nullable(String))',
            default_kind: '',
            default_expression: '',
            comment: '',
            is_in_primary_key: 0,
          },
          {
            name: 'code',
            type: 'FixedString(10)',
            default_kind: '',
            default_expression: '',
            comment: '',
            is_in_primary_key: 0,
          },
        ])
        .mockResolvedValueOnce([{ total_rows: '100' }])

      const connector = new ClickHouseConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })
      const columns = schema.tables[0]!.columns

      expect(columns).toHaveLength(4)
      expect(columns[0]!.isPrimaryKey).toBe(true)
      expect(columns[0]!.isNullable).toBe(false)
      expect(columns[1]!.isNullable).toBe(true)
      expect(columns[1]!.defaultValue).toBe("'unnamed'")
      expect(columns[1]!.description).toBe('User name')
      expect(columns[2]!.isNullable).toBe(true) // LowCardinality(Nullable(...))
      expect(columns[3]!.maxLength).toBe(10) // FixedString(10)
    })

    it('returns empty foreign keys (ClickHouse has no FKs)', async () => {
      mockQueryJson
        .mockResolvedValueOnce([{ name: 't', comment: '', total_rows: '0' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total_rows: '0' }])

      const connector = new ClickHouseConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.tables[0]!.foreignKeys).toEqual([])
    })

    it('returns 0 row count when table not found', async () => {
      mockQueryJson
        .mockResolvedValueOnce([{ name: 't', comment: '', total_rows: '0' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]) // empty row count result

      const connector = new ClickHouseConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.tables[0]!.rowCountEstimate).toBe(0)
    })

    it('discovers sample values', async () => {
      mockQueryJson
        .mockResolvedValueOnce([{ name: 't', comment: '', total_rows: '10' }])
        .mockResolvedValueOnce([
          { name: 'city', type: 'String', default_kind: '', default_expression: '', comment: '', is_in_primary_key: 0 },
        ])
        .mockResolvedValueOnce([{ total_rows: '10' }])
        .mockResolvedValueOnce([{ val: 'Berlin' }, { val: 'Paris' }])

      const connector = new ClickHouseConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 5 })

      expect(schema.tables[0]!.sampleValues['city']).toEqual(['Berlin', 'Paris'])
    })
  })

  // -------------------------------------------------------------------------
  // isNullableType edge cases
  // -------------------------------------------------------------------------

  describe('nullable type detection', () => {
    it('non-nullable types', async () => {
      mockQueryJson
        .mockResolvedValueOnce([{ name: 't', comment: '', total_rows: '0' }])
        .mockResolvedValueOnce([
          { name: 'a', type: 'String', default_kind: '', default_expression: '', comment: '', is_in_primary_key: 0 },
          { name: 'b', type: 'UInt32', default_kind: '', default_expression: '', comment: '', is_in_primary_key: 0 },
          { name: 'c', type: 'LowCardinality(String)', default_kind: '', default_expression: '', comment: '', is_in_primary_key: 0 },
        ])
        .mockResolvedValueOnce([{ total_rows: '0' }])

      const connector = new ClickHouseConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })
      const columns = schema.tables[0]!.columns

      expect(columns[0]!.isNullable).toBe(false)
      expect(columns[1]!.isNullable).toBe(false)
      expect(columns[2]!.isNullable).toBe(false) // LowCardinality(String) is not nullable
    })
  })

  // -------------------------------------------------------------------------
  // extractMaxLength edge cases
  // -------------------------------------------------------------------------

  describe('max length extraction', () => {
    it('returns null for non-FixedString types', async () => {
      mockQueryJson
        .mockResolvedValueOnce([{ name: 't', comment: '', total_rows: '0' }])
        .mockResolvedValueOnce([
          { name: 'a', type: 'String', default_kind: '', default_expression: '', comment: '', is_in_primary_key: 0 },
          { name: 'b', type: 'FixedString(32)', default_kind: '', default_expression: '', comment: '', is_in_primary_key: 0 },
        ])
        .mockResolvedValueOnce([{ total_rows: '0' }])

      const connector = new ClickHouseConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.tables[0]!.columns[0]!.maxLength).toBeNull()
      expect(schema.tables[0]!.columns[1]!.maxLength).toBe(32)
    })
  })
})
