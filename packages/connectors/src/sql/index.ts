/**
 * Unified SQL connectors barrel — types, factory, tools, DDL, adapters.
 */

// --- Types ---
export type {
  SQLDialect,
  DatabaseType,
  SQLConnectionConfig,
  QueryExecutionOptions,
  QueryResultData,
  ConnectionTestResult,
  ColumnInfo,
  ForeignKey,
  TableSchema,
  DatabaseSchema,
  SchemaDiscoveryOptions,
  SQLConnector,
} from './types.js'

// --- Base class ---
export { BaseSQLConnector } from './base-sql-connector.js'

// --- DDL generation ---
export { generateDDL } from './ddl-generator.js'

// --- Factory ---
export { createSQLConnector } from './factory.js'

// --- Tools ---
export { createSQLTools } from './sql-tools.js'
export type { SQLToolsConfig } from './sql-tools.js'

// --- Dialect adapters ---
export {
  PostgreSQLConnector,
  MySQLConnector,
  ClickHouseConnector,
  SnowflakeConnector,
  BigQueryConnector,
  SQLiteConnector,
  SQLServerConnector,
  DuckDBConnector,
} from './adapters/index.js'
