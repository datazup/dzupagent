/**
 * Database connector — PostgreSQL-focused SQL query execution tools.
 *
 * Provides parameterized query execution, schema introspection, and health
 * checks against a PostgreSQL database. Uses `pg` as an optional peer
 * dependency via dynamic import with graceful failure.
 *
 * SAFETY: Only parameterized queries are allowed — no string interpolation
 * of user input into SQL. Read-only mode allows only read-safe statement
 * forms and rejects multi-statement/query-shape bypasses.
 *
 * This module is a barrel; the implementation lives in the sibling
 * `db-*` modules. See {@link ./db-tools.js} for the public entry points.
 */
export type {
  DatabaseConnectorConfig,
  QueryResult,
  TableInfo,
  ColumnInfo,
} from './db-types.js'
export type { DatabaseOperations } from './db-operations.js'
export { createDatabaseOperations } from './db-operations.js'
export { createDatabaseConnector, createDatabaseConnectorToolkit } from './db-tools.js'
