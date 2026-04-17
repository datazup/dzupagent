/**
 * Branch-coverage tests for SQL adapter driver-assertion paths.
 *
 * Each adapter has two parallel branches we cover:
 *  1. resolve() throws MODULE_NOT_FOUND → friendly "install ..." message
 *  2. resolve() throws other error → re-thrown verbatim
 *
 * For adapters that call `runtimeRequire(pkg)` lazily, we additionally cover
 * the synchronous require path.
 *
 * We reset modules between tests so that each adapter picks up a fresh
 * createRequire mock without leaking into other suites.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const makeModuleNotFoundError = (spec: string) =>
  Object.assign(new Error(`Cannot find module '${spec}'`), { code: 'MODULE_NOT_FOUND' })

const makePermissionError = () =>
  Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })

describe('SQL adapters — driver assertion branches', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock('node:module')
    vi.resetModules()
  })

  // -------------------------------------------------------------------------
  // SQLServer — assertSqlServerDriverInstalled via resolve()
  // -------------------------------------------------------------------------

  describe('SQLServerConnector', () => {
    it('re-throws non-MODULE_NOT_FOUND errors from resolve()', async () => {
      const mockRequire = vi.fn() as unknown as NodeRequire
      Object.assign(mockRequire, {
        resolve: vi.fn(() => { throw makePermissionError() }),
      })
      vi.doMock('node:module', () => ({
        createRequire: vi.fn(() => mockRequire),
      }))

      const { SQLServerConnector } = await import('../adapters/sqlserver.js')
      expect(() => new SQLServerConnector({
        host: 'h', port: 1433, database: 'd', username: 'u', password: 'p', ssl: false,
      })).toThrow('EACCES')
    })

    it('throws install message when resolve() yields MODULE_NOT_FOUND', async () => {
      const mockRequire = vi.fn() as unknown as NodeRequire
      Object.assign(mockRequire, {
        resolve: vi.fn(() => { throw makeModuleNotFoundError('mssql') }),
      })
      vi.doMock('node:module', () => ({
        createRequire: vi.fn(() => mockRequire),
      }))

      const { SQLServerConnector } = await import('../adapters/sqlserver.js')
      expect(() => new SQLServerConnector({
        host: 'h', port: 1433, database: 'd', username: 'u', password: 'p', ssl: false,
      })).toThrow('requires the optional dependency "mssql"')
    })
  })

  // -------------------------------------------------------------------------
  // DuckDB — assertDuckDBDriverInstalled via resolve()
  // -------------------------------------------------------------------------

  describe('DuckDBConnector', () => {
    it('re-throws non-MODULE_NOT_FOUND errors from resolve()', async () => {
      const mockRequire = vi.fn() as unknown as NodeRequire
      Object.assign(mockRequire, {
        resolve: vi.fn(() => { throw makePermissionError() }),
      })
      vi.doMock('node:module', () => ({
        createRequire: vi.fn(() => mockRequire),
      }))

      const { DuckDBConnector } = await import('../adapters/duckdb.js')
      expect(() => new DuckDBConnector({
        host: 'h', port: 0, database: 'd', username: '', password: '', ssl: false,
      })).toThrow('EACCES')
    })

    it('throws install message when resolve() yields MODULE_NOT_FOUND', async () => {
      const mockRequire = vi.fn() as unknown as NodeRequire
      Object.assign(mockRequire, {
        resolve: vi.fn(() => { throw makeModuleNotFoundError('duckdb') }),
      })
      vi.doMock('node:module', () => ({
        createRequire: vi.fn(() => mockRequire),
      }))

      const { DuckDBConnector } = await import('../adapters/duckdb.js')
      expect(() => new DuckDBConnector({
        host: 'h', port: 0, database: 'd', username: '', password: '', ssl: false,
      })).toThrow('requires the optional dependency "duckdb"')
    })
  })

  // -------------------------------------------------------------------------
  // BigQuery — loadBigQueryModule() uses synchronous runtimeRequire
  // -------------------------------------------------------------------------

  describe('BigQueryConnector', () => {
    it('re-throws non-MODULE_NOT_FOUND errors from runtimeRequire()', async () => {
      const mockRequire = vi.fn(() => { throw makePermissionError() }) as unknown as NodeRequire
      Object.assign(mockRequire, {
        resolve: vi.fn(() => '/resolved'),
      })
      vi.doMock('node:module', () => ({
        createRequire: vi.fn(() => mockRequire),
      }))

      const { BigQueryConnector } = await import('../adapters/bigquery.js')
      expect(() => new BigQueryConnector({
        host: 'h', port: 0, database: 'db', username: '', password: '', ssl: true,
        projectId: 'p',
      })).toThrow('EACCES')
    })

    it('throws install message from runtimeRequire() when MODULE_NOT_FOUND', async () => {
      const mockRequire = vi.fn(() => {
        throw makeModuleNotFoundError('@google-cloud/bigquery')
      }) as unknown as NodeRequire
      Object.assign(mockRequire, {
        resolve: vi.fn(() => '/resolved'),
      })
      vi.doMock('node:module', () => ({
        createRequire: vi.fn(() => mockRequire),
      }))

      const { BigQueryConnector } = await import('../adapters/bigquery.js')
      expect(() => new BigQueryConnector({
        host: 'h', port: 0, database: 'db', username: '', password: '', ssl: true,
        projectId: 'p',
      })).toThrow('requires the optional dependency "@google-cloud/bigquery"')
    })
  })

  // -------------------------------------------------------------------------
  // ClickHouse — loadClickHouse() uses synchronous runtimeRequire
  // -------------------------------------------------------------------------

  describe('ClickHouseConnector', () => {
    it('re-throws non-MODULE_NOT_FOUND errors from runtimeRequire()', async () => {
      const mockRequire = vi.fn(() => { throw makePermissionError() }) as unknown as NodeRequire
      Object.assign(mockRequire, {
        resolve: vi.fn(() => '/resolved'),
      })
      vi.doMock('node:module', () => ({
        createRequire: vi.fn(() => mockRequire),
      }))

      const { ClickHouseConnector } = await import('../adapters/clickhouse.js')
      expect(() => new ClickHouseConnector({
        host: 'h', port: 8123, database: 'db', username: 'u', password: 'p', ssl: false,
      })).toThrow('EACCES')
    })

    it('throws install message when runtimeRequire() yields MODULE_NOT_FOUND', async () => {
      const mockRequire = vi.fn(() => {
        throw makeModuleNotFoundError('@clickhouse/client')
      }) as unknown as NodeRequire
      Object.assign(mockRequire, {
        resolve: vi.fn(() => '/resolved'),
      })
      vi.doMock('node:module', () => ({
        createRequire: vi.fn(() => mockRequire),
      }))

      const { ClickHouseConnector } = await import('../adapters/clickhouse.js')
      expect(() => new ClickHouseConnector({
        host: 'h', port: 8123, database: 'db', username: 'u', password: 'p', ssl: false,
      })).toThrow('requires the optional dependency "@clickhouse/client"')
    })
  })

  // -------------------------------------------------------------------------
  // MySQL — loadMySQL() uses synchronous runtimeRequire in constructor
  // -------------------------------------------------------------------------

  describe('MySQLConnector', () => {
    it('re-throws non-MODULE_NOT_FOUND errors from runtimeRequire()', async () => {
      const mockRequire = vi.fn(() => { throw makePermissionError() }) as unknown as NodeRequire
      Object.assign(mockRequire, {
        resolve: vi.fn(() => '/resolved'),
      })
      vi.doMock('node:module', () => ({
        createRequire: vi.fn(() => mockRequire),
      }))

      const { MySQLConnector } = await import('../adapters/mysql.js')
      expect(() => new MySQLConnector({
        host: 'h', port: 3306, database: 'db', username: 'u', password: 'p', ssl: false,
      })).toThrow('EACCES')
    })

    it('throws install message when runtimeRequire() yields MODULE_NOT_FOUND', async () => {
      const mockRequire = vi.fn(() => {
        throw makeModuleNotFoundError('mysql2/promise')
      }) as unknown as NodeRequire
      Object.assign(mockRequire, {
        resolve: vi.fn(() => '/resolved'),
      })
      vi.doMock('node:module', () => ({
        createRequire: vi.fn(() => mockRequire),
      }))

      const { MySQLConnector } = await import('../adapters/mysql.js')
      expect(() => new MySQLConnector({
        host: 'h', port: 3306, database: 'db', username: 'u', password: 'p', ssl: false,
      })).toThrow('requires the optional dependency "mysql2"')
    })
  })

  // -------------------------------------------------------------------------
  // Snowflake — assertSnowflakeDriverInstalled via resolve()
  // -------------------------------------------------------------------------

  describe('SnowflakeConnector', () => {
    it('re-throws non-MODULE_NOT_FOUND errors from resolve() in constructor', async () => {
      const mockRequire = vi.fn() as unknown as NodeRequire
      Object.assign(mockRequire, {
        resolve: vi.fn(() => { throw makePermissionError() }),
      })
      vi.doMock('node:module', () => ({
        createRequire: vi.fn(() => mockRequire),
      }))

      const { SnowflakeConnector } = await import('../adapters/snowflake.js')
      expect(() => new SnowflakeConnector({
        host: 'h', port: 443, database: 'db', username: 'u', password: 'p', ssl: true,
        account: 'acct',
      })).toThrow('EACCES')
    })

    it('throws install message when resolve() yields MODULE_NOT_FOUND', async () => {
      const mockRequire = vi.fn() as unknown as NodeRequire
      Object.assign(mockRequire, {
        resolve: vi.fn(() => { throw makeModuleNotFoundError('snowflake-sdk') }),
      })
      vi.doMock('node:module', () => ({
        createRequire: vi.fn(() => mockRequire),
      }))

      const { SnowflakeConnector } = await import('../adapters/snowflake.js')
      expect(() => new SnowflakeConnector({
        host: 'h', port: 443, database: 'db', username: 'u', password: 'p', ssl: true,
        account: 'acct',
      })).toThrow('requires the optional dependency "snowflake-sdk"')
    })
  })

  // -------------------------------------------------------------------------
  // SQLite — assertSqliteDriverInstalled via resolve()
  // -------------------------------------------------------------------------

  describe('SQLiteConnector', () => {
    it('re-throws non-MODULE_NOT_FOUND errors from resolve() in constructor', async () => {
      const mockRequire = vi.fn() as unknown as NodeRequire
      Object.assign(mockRequire, {
        resolve: vi.fn(() => { throw makePermissionError() }),
      })
      vi.doMock('node:module', () => ({
        createRequire: vi.fn(() => mockRequire),
      }))

      const { SQLiteConnector } = await import('../adapters/sqlite.js')
      expect(() => new SQLiteConnector({
        host: '', port: 0, database: 'db', username: '', password: '', ssl: false,
        filePath: ':memory:',
      })).toThrow('EACCES')
    })

    it('throws install message when resolve() yields MODULE_NOT_FOUND', async () => {
      const mockRequire = vi.fn() as unknown as NodeRequire
      Object.assign(mockRequire, {
        resolve: vi.fn(() => { throw makeModuleNotFoundError('better-sqlite3') }),
      })
      vi.doMock('node:module', () => ({
        createRequire: vi.fn(() => mockRequire),
      }))

      const { SQLiteConnector } = await import('../adapters/sqlite.js')
      expect(() => new SQLiteConnector({
        host: '', port: 0, database: 'db', username: '', password: '', ssl: false,
        filePath: ':memory:',
      })).toThrow('requires the optional dependency "better-sqlite3"')
    })
  })
})
