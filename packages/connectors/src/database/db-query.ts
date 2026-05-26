/**
 * Database connector — query executors.
 *
 * Provides the {@link QueryExecutor} factories that back database operations:
 * a custom query-function executor (driver-agnostic, used for tests/wrapping)
 * and a `pg`-pool executor that supports read-only transaction wrapping
 * (BEGIN / SET LOCAL TRANSACTION READ ONLY / COMMIT / ROLLBACK).
 */
import { oidToName } from './db-connection.js'
import type { DatabaseConnectorConfig, PgPool, QueryExecutor, QueryResult } from './db-types.js'

export function createCustomExecutor(
  queryFn: NonNullable<DatabaseConnectorConfig['query']>,
): QueryExecutor {
  return {
    async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
      const start = Date.now()
      const result = await queryFn(sql, params)
      const rows = result.rows as Record<string, unknown>[]
      const firstRow = rows[0]
      const fields = firstRow
        ? Object.keys(firstRow).map(name => ({ name, type: 'unknown' }))
        : []
      return {
        rows,
        rowCount: result.rowCount,
        fields,
        duration: Date.now() - start,
      }
    },
    async close() {
      // nothing to close for a custom query fn
    },
  }
}

export function createPgExecutor(pool: PgPool): QueryExecutor {
  function mapPgResult(
    result: {
      rows: Record<string, unknown>[]
      rowCount: number | null
      fields: Array<{ name: string; dataTypeID: number }>
    },
    start: number,
  ): QueryResult {
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
      fields: result.fields.map(f => ({ name: f.name, type: oidToName(f.dataTypeID) })),
      duration: Date.now() - start,
    }
  }

  return {
    async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
      const start = Date.now()
      const result = await pool.query(sql, params)
      return mapPgResult(result, start)
    },
    async executeReadOnly(sql: string, params?: unknown[]): Promise<QueryResult> {
      if (typeof pool.connect !== 'function') {
        return this.execute(sql, params)
      }

      const client = await pool.connect()
      const start = Date.now()
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL TRANSACTION READ ONLY')
        const result = await client.query(sql, params)
        await client.query('COMMIT')
        return mapPgResult(result, start)
      } catch (error) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // ignore rollback failures; original error is more actionable
        }
        throw error
      } finally {
        client.release()
      }
    },
    async close() {
      await pool.end()
    },
  }
}
