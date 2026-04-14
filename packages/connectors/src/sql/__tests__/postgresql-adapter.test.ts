/**
 * Tests for PostgreSQLConnector — mocks the pg module at the driver level.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SQLConnectionConfig } from '../types.js'

// ---------------------------------------------------------------------------
// Mock pg module
// ---------------------------------------------------------------------------

const mockClientQuery = vi.fn()
const mockClientRelease = vi.fn()
const mockPoolQuery = vi.fn()
const mockPoolConnect = vi.fn()
const mockPoolOn = vi.fn()
const mockPoolEnd = vi.fn()

vi.mock('pg', () => {
  return {
    default: {
      Pool: vi.fn().mockImplementation(() => ({
        query: mockPoolQuery,
        connect: mockPoolConnect,
        on: mockPoolOn,
        end: mockPoolEnd,
      })),
    },
  }
})

const baseConfig: SQLConnectionConfig = {
  host: '127.0.0.1',
  port: 5432,
  database: 'testdb',
  username: 'testuser',
  password: 'testpass',
  ssl: false,
}

// ---------------------------------------------------------------------------
// Import after mocking
// ---------------------------------------------------------------------------

const { PostgreSQLConnector } = await import('../adapters/postgresql.js')

describe('PostgreSQLConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPoolConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    })
  })

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('creates a pg Pool with correct config', async () => {
      const pg = vi.mocked(await import('pg'))
      new PostgreSQLConnector(baseConfig)
      expect(pg.default.Pool).toHaveBeenCalledWith(
        expect.objectContaining({
          host: '127.0.0.1',
          port: 5432,
          database: 'testdb',
          user: 'testuser',
          password: 'testpass',
          ssl: false,
          max: 5,
          idleTimeoutMillis: 30_000,
        }),
      )
    })

    it('configures ssl when ssl is true', async () => {
      const pg = vi.mocked(await import('pg'))
      new PostgreSQLConnector({ ...baseConfig, ssl: true })
      expect(pg.default.Pool).toHaveBeenCalledWith(
        expect.objectContaining({
          ssl: { rejectUnauthorized: true },
        }),
      )
    })

    it('allows self-signed certs when sslAllowSelfSigned is true', async () => {
      const pg = vi.mocked(await import('pg'))
      new PostgreSQLConnector({ ...baseConfig, ssl: true, sslAllowSelfSigned: true })
      expect(pg.default.Pool).toHaveBeenCalledWith(
        expect.objectContaining({
          ssl: { rejectUnauthorized: false },
        }),
      )
    })

    it('passes ssl object through when ssl is an object', async () => {
      const pg = vi.mocked(await import('pg'))
      const sslConfig = { ca: 'my-ca-cert', rejectUnauthorized: false }
      new PostgreSQLConnector({ ...baseConfig, ssl: sslConfig })
      expect(pg.default.Pool).toHaveBeenCalledWith(
        expect.objectContaining({
          ssl: sslConfig,
        }),
      )
    })

    it('registers a connect handler for read-only mode', () => {
      new PostgreSQLConnector(baseConfig)
      expect(mockPoolOn).toHaveBeenCalledWith('connect', expect.any(Function))
    })
  })

  // -------------------------------------------------------------------------
  // getDialect
  // -------------------------------------------------------------------------

  describe('getDialect', () => {
    it('returns postgresql', () => {
      const connector = new PostgreSQLConnector(baseConfig)
      expect(connector.getDialect()).toBe('postgresql')
    })
  })

  // -------------------------------------------------------------------------
  // testConnection
  // -------------------------------------------------------------------------

  describe('testConnection', () => {
    it('returns ok:true on successful connection', async () => {
      mockClientQuery.mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1, fields: [] })
      const connector = new PostgreSQLConnector(baseConfig)

      const result = await connector.testConnection()

      expect(result.ok).toBe(true)
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
      expect(mockPoolConnect).toHaveBeenCalled()
      expect(mockClientQuery).toHaveBeenCalledWith('SELECT 1')
      expect(mockClientRelease).toHaveBeenCalled()
    })

    it('returns ok:false on connection failure', async () => {
      mockPoolConnect.mockRejectedValue(new Error('ECONNREFUSED'))
      const connector = new PostgreSQLConnector(baseConfig)

      const result = await connector.testConnection()

      expect(result.ok).toBe(false)
      expect(result.error).toContain('ECONNREFUSED')
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it('returns ok:false with string error', async () => {
      mockPoolConnect.mockRejectedValue('string error')
      const connector = new PostgreSQLConnector(baseConfig)

      const result = await connector.testConnection()

      expect(result.ok).toBe(false)
      expect(result.error).toBe('string error')
    })

    it('releases client even when query fails', async () => {
      const client = { query: vi.fn().mockRejectedValue(new Error('timeout')), release: vi.fn() }
      mockPoolConnect.mockResolvedValue(client)
      const connector = new PostgreSQLConnector(baseConfig)

      await connector.testConnection()

      expect(client.release).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // executeQuery
  // -------------------------------------------------------------------------

  describe('executeQuery', () => {
    it('executes a query and returns structured results', async () => {
      mockClientQuery
        .mockResolvedValueOnce(undefined) // SET statement_timeout
        .mockResolvedValueOnce({
          rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
          rowCount: 2,
          fields: [{ name: 'id', dataTypeID: 23 }, { name: 'name', dataTypeID: 25 }],
        })
        .mockResolvedValueOnce(undefined) // RESET statement_timeout

      const connector = new PostgreSQLConnector(baseConfig)
      const result = await connector.executeQuery('SELECT * FROM users')

      expect(result.columns).toEqual(['id', 'name'])
      expect(result.rows).toHaveLength(2)
      expect(result.rowCount).toBe(2)
      expect(result.truncated).toBe(false)
    })

    it('sets statement_timeout from options', async () => {
      mockClientQuery
        .mockResolvedValueOnce(undefined) // SET
        .mockResolvedValueOnce({ rows: [], rowCount: 0, fields: [] })
        .mockResolvedValueOnce(undefined) // RESET

      const connector = new PostgreSQLConnector(baseConfig)
      await connector.executeQuery('SELECT 1', { timeoutMs: 5000 })

      expect(mockClientQuery).toHaveBeenCalledWith('SET statement_timeout = 5000')
    })

    it('applies LIMIT when not present', async () => {
      mockClientQuery
        .mockResolvedValueOnce(undefined) // SET
        .mockResolvedValueOnce({ rows: [], rowCount: 0, fields: [] })
        .mockResolvedValueOnce(undefined) // RESET

      const connector = new PostgreSQLConnector(baseConfig)
      await connector.executeQuery('SELECT * FROM users', { maxRows: 10 })

      // wrapWithLimit adds maxRows+1
      expect(mockClientQuery).toHaveBeenCalledWith('SELECT * FROM users LIMIT 11')
    })

    it('truncates results when exceeding maxRows', async () => {
      const rows = Array.from({ length: 11 }, (_, i) => ({ id: i + 1 }))
      mockClientQuery
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          rows,
          rowCount: 11,
          fields: [{ name: 'id', dataTypeID: 23 }],
        })
        .mockResolvedValueOnce(undefined)

      const connector = new PostgreSQLConnector(baseConfig)
      const result = await connector.executeQuery('SELECT * FROM users', { maxRows: 10 })

      expect(result.truncated).toBe(true)
      expect(result.rows).toHaveLength(10)
    })

    it('throws on query error with PostgreSQL prefix', async () => {
      mockClientQuery
        .mockResolvedValueOnce(undefined) // SET
        .mockRejectedValueOnce(new Error('relation "users" does not exist'))

      // Need to also handle the RESET call in finally block
      mockClientQuery.mockResolvedValueOnce(undefined)

      const connector = new PostgreSQLConnector(baseConfig)

      await expect(connector.executeQuery('SELECT * FROM users'))
        .rejects.toThrow('PostgreSQL query failed: relation "users" does not exist')
    })

    it('throws with stringified error when non-Error thrown', async () => {
      mockClientQuery
        .mockResolvedValueOnce(undefined) // SET
        .mockRejectedValueOnce('raw string error')

      mockClientQuery.mockResolvedValueOnce(undefined)

      const connector = new PostgreSQLConnector(baseConfig)

      await expect(connector.executeQuery('SELECT 1'))
        .rejects.toThrow('PostgreSQL query failed: raw string error')
    })

    it('resets statement_timeout in finally block', async () => {
      mockClientQuery
        .mockResolvedValueOnce(undefined) // SET
        .mockResolvedValueOnce({ rows: [], rowCount: 0, fields: [] })
        .mockResolvedValueOnce(undefined) // RESET

      const connector = new PostgreSQLConnector(baseConfig)
      await connector.executeQuery('SELECT 1')

      expect(mockClientQuery).toHaveBeenCalledWith('SET statement_timeout = 0')
      expect(mockClientRelease).toHaveBeenCalled()
    })

    it('handles empty fields gracefully', async () => {
      mockClientQuery
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1, fields: undefined })
        .mockResolvedValueOnce(undefined)

      const connector = new PostgreSQLConnector(baseConfig)
      const result = await connector.executeQuery('SELECT 1 AS id')

      expect(result.columns).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------

  describe('destroy', () => {
    it('calls pool.end()', async () => {
      mockPoolEnd.mockResolvedValue(undefined)
      const connector = new PostgreSQLConnector(baseConfig)

      await connector.destroy()

      expect(mockPoolEnd).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Schema discovery — discoverSchema (integration via base class)
  // -------------------------------------------------------------------------

  describe('discoverSchema', () => {
    it('uses public as default schema', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })

      const connector = new PostgreSQLConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.schemaName).toBe('public')
      expect(schema.dialect).toBe('postgresql')
    })

    it('uses config.schema when provided', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })

      const connector = new PostgreSQLConnector({ ...baseConfig, schema: 'analytics' })
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.schemaName).toBe('analytics')
    })

    it('discovers tables from information_schema', async () => {
      mockPoolQuery
        // discoverTables
        .mockResolvedValueOnce({
          rows: [
            { table_name: 'users', table_schema: 'public', description: 'User table' },
            { table_name: 'orders', table_schema: 'public', description: null },
          ],
          rowCount: 2,
        })
        // For each table: discoverColumns, discoverForeignKeys, discoverRowCount
        // users: columns
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // users: foreign keys
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // users: row count
        .mockResolvedValueOnce({ rows: [{ estimate: 1000 }], rowCount: 1 })
        // orders: columns
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // orders: foreign keys
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // orders: row count
        .mockResolvedValueOnce({ rows: [{ estimate: 500 }], rowCount: 1 })

      const connector = new PostgreSQLConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.tables).toHaveLength(2)
      expect(schema.tables[0]!.tableName).toBe('users')
      expect(schema.tables[0]!.description).toBe('User table')
      expect(schema.tables[0]!.rowCountEstimate).toBe(1000)
      expect(schema.tables[1]!.tableName).toBe('orders')
      expect(schema.tables[1]!.rowCountEstimate).toBe(500)
    })

    it('discovers columns with correct type mapping', async () => {
      mockPoolQuery
        // discoverTables
        .mockResolvedValueOnce({
          rows: [{ table_name: 'users', table_schema: 'public', description: null }],
          rowCount: 1,
        })
        // discoverColumns
        .mockResolvedValueOnce({
          rows: [
            {
              column_name: 'id',
              data_type: 'integer',
              udt_name: 'int4',
              is_nullable: 'NO',
              column_default: "nextval('users_id_seq'::regclass)",
              character_maximum_length: null,
              description: 'Primary key',
              is_primary_key: true,
            },
            {
              column_name: 'email',
              data_type: 'character varying',
              udt_name: 'varchar',
              is_nullable: 'YES',
              column_default: null,
              character_maximum_length: 255,
              description: null,
              is_primary_key: false,
            },
            {
              column_name: 'status',
              data_type: 'USER-DEFINED',
              udt_name: 'user_status',
              is_nullable: 'NO',
              column_default: null,
              character_maximum_length: null,
              description: null,
              is_primary_key: false,
            },
            {
              column_name: 'tags',
              data_type: 'ARRAY',
              udt_name: '_text',
              is_nullable: 'YES',
              column_default: null,
              character_maximum_length: null,
              description: null,
              is_primary_key: false,
            },
            {
              column_name: 'created_at',
              data_type: 'timestamp with time zone',
              udt_name: 'timestamptz',
              is_nullable: 'NO',
              column_default: null,
              character_maximum_length: null,
              description: null,
              is_primary_key: false,
            },
            {
              column_name: 'is_active',
              data_type: 'boolean',
              udt_name: 'bool',
              is_nullable: 'NO',
              column_default: 'true',
              character_maximum_length: null,
              description: null,
              is_primary_key: false,
            },
          ],
          rowCount: 6,
        })
        // discoverForeignKeys
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // discoverRowCount
        .mockResolvedValueOnce({ rows: [{ estimate: 100 }], rowCount: 1 })

      const connector = new PostgreSQLConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })
      const columns = schema.tables[0]!.columns

      expect(columns).toHaveLength(6)

      // integer
      expect(columns[0]!.dataType).toBe('integer')
      expect(columns[0]!.isPrimaryKey).toBe(true)
      expect(columns[0]!.isNullable).toBe(false)

      // character varying -> varchar
      expect(columns[1]!.dataType).toBe('varchar')
      expect(columns[1]!.maxLength).toBe(255)

      // USER-DEFINED -> udt_name
      expect(columns[2]!.dataType).toBe('user_status')

      // ARRAY -> text[]
      expect(columns[3]!.dataType).toBe('text[]')

      // timestamp with time zone -> timestamptz
      expect(columns[4]!.dataType).toBe('timestamptz')

      // boolean -> bool
      expect(columns[5]!.dataType).toBe('bool')
    })

    it('discovers foreign keys', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [{ table_name: 'orders', table_schema: 'public', description: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // columns
        .mockResolvedValueOnce({
          rows: [{
            constraint_name: 'fk_orders_user',
            column_name: 'user_id',
            referenced_table: 'users',
            referenced_column: 'id',
            referenced_schema: 'public',
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ estimate: 50 }], rowCount: 1 })

      const connector = new PostgreSQLConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })
      const fks = schema.tables[0]!.foreignKeys

      expect(fks).toHaveLength(1)
      expect(fks[0]!.constraintName).toBe('fk_orders_user')
      expect(fks[0]!.columnName).toBe('user_id')
      expect(fks[0]!.referencedTable).toBe('users')
    })

    it('returns 0 for row count when no rows in pg_class', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [{ table_name: 't', table_schema: 'public', description: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // columns
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // fks
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // row count empty

      const connector = new PostgreSQLConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.tables[0]!.rowCountEstimate).toBe(0)
    })

    it('returns 0 for negative reltuples (never analyzed)', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [{ table_name: 't', table_schema: 'public', description: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ estimate: -1 }], rowCount: 1 })

      const connector = new PostgreSQLConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })

      expect(schema.tables[0]!.rowCountEstimate).toBe(0)
    })

    it('discovers sample values', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [{ table_name: 'users', table_schema: 'public', description: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [
            { column_name: 'name', data_type: 'text', udt_name: 'text', is_nullable: 'YES', column_default: null, character_maximum_length: null, description: null, is_primary_key: false },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // fks
        .mockResolvedValueOnce({ rows: [{ estimate: 10 }], rowCount: 1 }) // row count
        .mockResolvedValueOnce({ rows: [{ val: 'Alice' }, { val: 'Bob' }], rowCount: 2 }) // sample values

      const connector = new PostgreSQLConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 5 })

      expect(schema.tables[0]!.sampleValues['name']).toEqual(['Alice', 'Bob'])
    })
  })

  // -------------------------------------------------------------------------
  // Data type mapping edge cases
  // -------------------------------------------------------------------------

  describe('data type mapping', () => {
    async function getColumnType(dataType: string, udtName: string): Promise<string> {
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [{ table_name: 't', table_schema: 'public', description: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{
            column_name: 'col',
            data_type: dataType,
            udt_name: udtName,
            is_nullable: 'YES',
            column_default: null,
            character_maximum_length: null,
            description: null,
            is_primary_key: false,
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ estimate: 0 }], rowCount: 1 })

      const connector = new PostgreSQLConnector(baseConfig)
      const schema = await connector.discoverSchema({ sampleValueLimit: 0 })
      return schema.tables[0]!.columns[0]!.dataType
    }

    it('maps character to char', async () => {
      expect(await getColumnType('character', 'bpchar')).toBe('char')
    })

    it('maps timestamp without time zone to timestamp', async () => {
      expect(await getColumnType('timestamp without time zone', 'timestamp')).toBe('timestamp')
    })

    it('maps time without time zone to time', async () => {
      expect(await getColumnType('time without time zone', 'time')).toBe('time')
    })

    it('maps time with time zone to timetz', async () => {
      expect(await getColumnType('time with time zone', 'timetz')).toBe('timetz')
    })

    it('maps double precision to float8', async () => {
      expect(await getColumnType('double precision', 'float8')).toBe('float8')
    })

    it('maps ARRAY with underscore prefix correctly', async () => {
      expect(await getColumnType('ARRAY', '_int4')).toBe('int4[]')
    })

    it('maps ARRAY without underscore prefix', async () => {
      expect(await getColumnType('ARRAY', 'text')).toBe('text[]')
    })

    it('passes through unknown types', async () => {
      expect(await getColumnType('jsonb', 'jsonb')).toBe('jsonb')
    })
  })
})
