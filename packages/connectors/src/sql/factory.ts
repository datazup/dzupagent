/**
 * Factory for creating the appropriate SQLConnector based on database type.
 */

import type { SQLConnector, SQLConnectionConfig, DatabaseType } from './types.js'
import { PostgreSQLConnector } from './adapters/postgresql.js'
import { MySQLConnector } from './adapters/mysql.js'
import { ClickHouseConnector } from './adapters/clickhouse.js'
import { SnowflakeConnector } from './adapters/snowflake.js'
import { BigQueryConnector } from './adapters/bigquery.js'
import { SQLiteConnector } from './adapters/sqlite.js'
import { SQLServerConnector } from './adapters/sqlserver.js'
import { DuckDBConnector } from './adapters/duckdb.js'

/**
 * Creates a unified SQLConnector for the given database type.
 * Each connector combines query execution + schema discovery.
 *
 * @throws Error if the database type is not supported.
 */
export function createSQLConnector(
  databaseType: DatabaseType,
  config: SQLConnectionConfig,
): SQLConnector {
  switch (databaseType) {
    case 'postgresql':
      return new PostgreSQLConnector(config)
    case 'mysql':
      return new MySQLConnector(config)
    case 'clickhouse':
      return new ClickHouseConnector(config)
    case 'snowflake':
      return new SnowflakeConnector(config)
    case 'bigquery':
      return new BigQueryConnector(config)
    case 'sqlite':
      return new SQLiteConnector(config)
    case 'sqlserver':
      return new SQLServerConnector(config)
    case 'duckdb':
      return new DuckDBConnector(config)
    default: {
      const _exhaustive: never = databaseType
      throw new Error(`Unsupported database type: ${String(_exhaustive)}`)
    }
  }
}
