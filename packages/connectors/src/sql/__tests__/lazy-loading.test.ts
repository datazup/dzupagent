import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SQLConnectionConfig } from '../types.js'
import * as sqlModule from '../index.js'

const adapterCtorSpies = vi.hoisted(() => ({
  postgresql: vi.fn(),
  mysql: vi.fn(),
  clickhouse: vi.fn(),
  snowflake: vi.fn(),
  bigquery: vi.fn(),
  sqlite: vi.fn(),
  sqlserver: vi.fn(),
  duckdb: vi.fn(),
}))

vi.mock('../adapters/postgresql.js', () => ({
  PostgreSQLConnector: class {
    constructor(config: SQLConnectionConfig) {
      adapterCtorSpies.postgresql(config)
    }
  },
}))

vi.mock('../adapters/mysql.js', () => ({
  MySQLConnector: class {
    constructor(config: SQLConnectionConfig) {
      adapterCtorSpies.mysql(config)
    }
  },
}))

vi.mock('../adapters/clickhouse.js', () => ({
  ClickHouseConnector: class {
    constructor(config: SQLConnectionConfig) {
      adapterCtorSpies.clickhouse(config)
    }
  },
}))

vi.mock('../adapters/snowflake.js', () => ({
  SnowflakeConnector: class {
    constructor(config: SQLConnectionConfig) {
      adapterCtorSpies.snowflake(config)
    }
  },
}))

vi.mock('../adapters/bigquery.js', () => ({
  BigQueryConnector: class {
    constructor(config: SQLConnectionConfig) {
      adapterCtorSpies.bigquery(config)
    }
  },
}))

vi.mock('../adapters/sqlite.js', () => ({
  SQLiteConnector: class {
    constructor(config: SQLConnectionConfig) {
      adapterCtorSpies.sqlite(config)
    }
  },
}))

vi.mock('../adapters/sqlserver.js', () => ({
  SQLServerConnector: class {
    constructor(config: SQLConnectionConfig) {
      adapterCtorSpies.sqlserver(config)
    }
  },
}))

vi.mock('../adapters/duckdb.js', () => ({
  DuckDBConnector: class {
    constructor(config: SQLConnectionConfig) {
      adapterCtorSpies.duckdb(config)
    }
  },
}))

const baseConfig: SQLConnectionConfig = {
  host: '127.0.0.1',
  port: 5432,
  database: 'db',
  username: 'user',
  password: 'pass',
  ssl: false,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SQL package lazy-loading boundaries', () => {
  it('imports the SQL barrel without instantiating connector classes', () => {
    expect(sqlModule.createSQLConnector).toBeTypeOf('function')
    expect(sqlModule.createSQLTools).toBeTypeOf('function')
    expect(sqlModule.BaseSQLConnector).toBeTypeOf('function')

    expect(adapterCtorSpies.postgresql).not.toHaveBeenCalled()
    expect(adapterCtorSpies.mysql).not.toHaveBeenCalled()
    expect(adapterCtorSpies.clickhouse).not.toHaveBeenCalled()
    expect(adapterCtorSpies.snowflake).not.toHaveBeenCalled()
    expect(adapterCtorSpies.bigquery).not.toHaveBeenCalled()
    expect(adapterCtorSpies.sqlite).not.toHaveBeenCalled()
    expect(adapterCtorSpies.sqlserver).not.toHaveBeenCalled()
    expect(adapterCtorSpies.duckdb).not.toHaveBeenCalled()
  })

  it('defers MySQL driver loading until connector construction', async () => {
    vi.resetModules()

    const createPool = vi.fn(() => ({
      getConnection: vi.fn(),
      end: vi.fn(),
    }))
    const runtimeRequireSpy = vi.fn((specifier: string) => {
      if (specifier === 'mysql2/promise') {
        return {
          createPool,
        }
      }

      throw new Error(`Unexpected driver request: ${specifier}`)
    })
    const createRequireSpy = vi.fn(() => runtimeRequireSpy)

    vi.doUnmock('../adapters/mysql.js')
    vi.doMock('node:module', () => ({
      createRequire: createRequireSpy,
    }))

    const { MySQLConnector } = await import('../adapters/mysql.js')

    expect(createRequireSpy).toHaveBeenCalledTimes(1)
    expect(runtimeRequireSpy).not.toHaveBeenCalled()

    const connector = new MySQLConnector(baseConfig)

    expect(connector.getDialect()).toBe('mysql')
    expect(runtimeRequireSpy).toHaveBeenCalledTimes(1)
    expect(runtimeRequireSpy).toHaveBeenCalledWith('mysql2/promise')
    expect(createPool).toHaveBeenCalledTimes(1)
    expect(createPool).toHaveBeenCalledWith({
      host: baseConfig.host,
      port: baseConfig.port,
      database: baseConfig.database,
      user: baseConfig.username,
      password: baseConfig.password,
      ssl: undefined,
      connectionLimit: 5,
      idleTimeout: 30_000,
      enableKeepAlive: true,
    })
    expect(connector).toBeInstanceOf(MySQLConnector)
  })
})
