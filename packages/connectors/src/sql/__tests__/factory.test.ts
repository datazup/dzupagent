import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SQLConnectionConfig } from '../types.js'

const ctorSpies = {
  postgresql: vi.fn(),
  mysql: vi.fn(),
  clickhouse: vi.fn(),
  snowflake: vi.fn(),
  bigquery: vi.fn(),
  sqlite: vi.fn(),
  sqlserver: vi.fn(),
  duckdb: vi.fn(),
}

vi.mock('../adapters/postgresql.js', () => ({
  PostgreSQLConnector: class {
    constructor(config: SQLConnectionConfig) {
      ctorSpies.postgresql(config)
    }
  },
}))

vi.mock('../adapters/mysql.js', () => ({
  MySQLConnector: class {
    constructor(config: SQLConnectionConfig) {
      ctorSpies.mysql(config)
    }
  },
}))

vi.mock('../adapters/clickhouse.js', () => ({
  ClickHouseConnector: class {
    constructor(config: SQLConnectionConfig) {
      ctorSpies.clickhouse(config)
    }
  },
}))

vi.mock('../adapters/snowflake.js', () => ({
  SnowflakeConnector: class {
    constructor(config: SQLConnectionConfig) {
      ctorSpies.snowflake(config)
    }
  },
}))

vi.mock('../adapters/bigquery.js', () => ({
  BigQueryConnector: class {
    constructor(config: SQLConnectionConfig) {
      ctorSpies.bigquery(config)
    }
  },
}))

vi.mock('../adapters/sqlite.js', () => ({
  SQLiteConnector: class {
    constructor(config: SQLConnectionConfig) {
      ctorSpies.sqlite(config)
    }
  },
}))

vi.mock('../adapters/sqlserver.js', () => ({
  SQLServerConnector: class {
    constructor(config: SQLConnectionConfig) {
      ctorSpies.sqlserver(config)
    }
  },
}))

vi.mock('../adapters/duckdb.js', () => ({
  DuckDBConnector: class {
    constructor(config: SQLConnectionConfig) {
      ctorSpies.duckdb(config)
    }
  },
}))

import { createSQLConnector } from '../factory.js'

const baseConfig: SQLConnectionConfig = {
  host: '127.0.0.1',
  port: 5432,
  database: 'db',
  username: 'user',
  password: 'pass',
  ssl: false,
}

describe('createSQLConnector factory mapping', () => {
  beforeEach(() => {
    for (const spy of Object.values(ctorSpies)) {
      spy.mockClear()
    }
  })

  it('maps each database type to its adapter constructor', () => {
    createSQLConnector('postgresql', baseConfig)
    createSQLConnector('mysql', baseConfig)
    createSQLConnector('clickhouse', baseConfig)
    createSQLConnector('snowflake', baseConfig)
    createSQLConnector('bigquery', baseConfig)
    createSQLConnector('sqlite', baseConfig)
    createSQLConnector('sqlserver', baseConfig)
    createSQLConnector('duckdb', baseConfig)

    expect(ctorSpies.postgresql).toHaveBeenCalledWith(baseConfig)
    expect(ctorSpies.mysql).toHaveBeenCalledWith(baseConfig)
    expect(ctorSpies.clickhouse).toHaveBeenCalledWith(baseConfig)
    expect(ctorSpies.snowflake).toHaveBeenCalledWith(baseConfig)
    expect(ctorSpies.bigquery).toHaveBeenCalledWith(baseConfig)
    expect(ctorSpies.sqlite).toHaveBeenCalledWith(baseConfig)
    expect(ctorSpies.sqlserver).toHaveBeenCalledWith(baseConfig)
    expect(ctorSpies.duckdb).toHaveBeenCalledWith(baseConfig)
  })

  it('throws for unsupported database type', () => {
    expect(() =>
      createSQLConnector('oracle' as never, baseConfig),
    ).toThrow('Unsupported database type: oracle')
  })
})
