/**
 * Database connector — high-level operations and schema introspection.
 *
 * Builds the programmatic {@link DatabaseOperations} surface on top of a
 * {@link QueryExecutor}: parameterized queries with read-only enforcement and
 * auto-limiting, table listing, column description, and health checks.
 */
import {
  LIMIT_RE,
  enforceReadOnlyStatement,
  maskSqlLiteralsAndComments,
  shouldApplyAutoLimit,
} from './db-sql-safety.js'
import type {
  ColumnInfo,
  DatabaseConnectorConfig,
  QueryExecutor,
  QueryResult,
  TableInfo,
} from './db-types.js'

export interface DatabaseOperations {
  /** Execute a parameterized SQL query. */
  query(sql: string, params?: unknown[]): Promise<QueryResult>
  /** List all tables in a given schema (default: public). */
  listTables(schema?: string): Promise<TableInfo[]>
  /** Get detailed column info for a specific table. */
  describeTable(tableName: string, schema?: string): Promise<ColumnInfo[]>
  /** Full table info including columns and approximate row count. */
  getTableInfo(tableName: string, schema?: string): Promise<TableInfo>
  /** Connection health check. Returns true if the database is reachable. */
  healthCheck(): Promise<boolean>
  /** Close the underlying connection pool. */
  close(): Promise<void>
}

export function createDatabaseOperations(
  executor: QueryExecutor,
  config: Pick<DatabaseConnectorConfig, 'readOnly' | 'maxRows'>,
): DatabaseOperations {
  const readOnly = config.readOnly ?? true
  const maxRows = config.maxRows ?? 1000

  async function executeSql(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (readOnly && executor.executeReadOnly) {
      return executor.executeReadOnly(sql, params)
    }
    return executor.execute(sql, params)
  }

  return {
    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
      const candidateSql = readOnly ? enforceReadOnlyStatement(sql) : sql
      const maskedCandidate = maskSqlLiteralsAndComments(candidateSql)

      // Enforce row limit by wrapping SELECT-like queries
      let safeSql = candidateSql
      if (shouldApplyAutoLimit(maskedCandidate) && !LIMIT_RE.test(maskedCandidate)) {
        safeSql = `SELECT * FROM (${candidateSql}) AS __limited LIMIT ${maxRows}`
      }

      return executeSql(safeSql, params)
    },

    async listTables(schema = 'public'): Promise<TableInfo[]> {
      const result = await executeSql(
        `SELECT table_name, table_schema
         FROM information_schema.tables
         WHERE table_schema = $1
         ORDER BY table_name`,
        [schema],
      )

      return result.rows.map(row => ({
        name: String(row['table_name']),
        schema: String(row['table_schema']),
        columns: [],
      }))
    },

    async describeTable(tableName: string, schema = 'public'): Promise<ColumnInfo[]> {
      const result = await executeSql(
        `SELECT
           c.column_name,
           c.data_type,
           c.is_nullable,
           c.column_default,
           CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN true ELSE false END AS is_primary_key
         FROM information_schema.columns c
         LEFT JOIN information_schema.key_column_usage kcu
           ON c.table_name = kcu.table_name
           AND c.column_name = kcu.column_name
           AND c.table_schema = kcu.table_schema
         LEFT JOIN information_schema.table_constraints tc
           ON kcu.constraint_name = tc.constraint_name
           AND tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = c.table_schema
         WHERE c.table_name = $1
           AND c.table_schema = $2
         ORDER BY c.ordinal_position`,
        [tableName, schema],
      )

      return result.rows.map(row => {
        const defaultValue = row['column_default'] != null ? String(row['column_default']) : undefined
        return {
          name: String(row['column_name']),
          type: String(row['data_type']),
          nullable: row['is_nullable'] === 'YES',
          ...(defaultValue !== undefined ? { defaultValue } : {}),
          isPrimaryKey: row['is_primary_key'] === true || row['is_primary_key'] === 't',
        }
      })
    },

    async getTableInfo(tableName: string, schema = 'public'): Promise<TableInfo> {
      const columns = await this.describeTable(tableName, schema)

      // Approximate row count from pg_class (fast, no full scan)
      let rowCount: number | undefined
      try {
        const countResult = await executeSql(
          `SELECT reltuples::bigint AS estimate
           FROM pg_class
           WHERE relname = $1`,
          [tableName],
        )
        const estimate = countResult.rows[0]?.['estimate']
        if (estimate != null) rowCount = Number(estimate)
      } catch {
        // Non-critical — row count is optional
      }

      return { name: tableName, schema, columns, ...(rowCount !== undefined ? { rowCount } : {}) }
    },

    async healthCheck(): Promise<boolean> {
      try {
        await executeSql('SELECT 1 AS ok')
        return true
      } catch {
        return false
      }
    },

    async close(): Promise<void> {
      await executor.close()
    },
  }
}
