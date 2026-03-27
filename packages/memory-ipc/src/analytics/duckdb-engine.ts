/**
 * DuckDB-WASM query engine for Arrow Table analytics.
 *
 * Lazily initializes a DuckDB-WASM instance. Registers Arrow Tables
 * as virtual tables for zero-copy SQL queries.
 *
 * @duckdb/duckdb-wasm is an optional peer dependency -- this module
 * gracefully throws a descriptive error if not installed.
 */

import type { Table } from 'apache-arrow'

// ---------------------------------------------------------------------------
// Types for @duckdb/duckdb-wasm (avoid hard dependency)
// ---------------------------------------------------------------------------

/** Minimal type for DuckDB-WASM AsyncDuckDB instance */
interface DuckDBInstance {
  open(config: Record<string, unknown>): Promise<void>
  connect(): Promise<DuckDBConnection>
  terminate(): Promise<void>
}

/** Minimal type for DuckDB-WASM connection */
interface DuckDBConnection {
  insertArrowTable(table: Table, options: { name: string; create: boolean }): Promise<void>
  query<T extends RowRecord = RowRecord>(sql: string): Promise<Table & { toArray(): T[] }>
  close(): Promise<void>
}

/** Minimal type for DuckDB-WASM worker bundle */
interface DuckDBBundle {
  mainModule: string
  mainWorker: string | null
}

/** Minimal type for DuckDB-WASM module */
interface DuckDBModule {
  selectBundle(bundles: Record<string, DuckDBBundle>): Promise<DuckDBBundle>
  ConsoleLogger: new () => unknown
  AsyncDuckDB: new (logger: unknown, worker: unknown) => DuckDBInstance
  getJsDelivrBundles(): Record<string, DuckDBBundle>
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Base constraint for query result row types */
export type RowRecord = Record<string, unknown>

/** Result of a DuckDB analytics query */
export interface AnalyticsResult<T extends RowRecord = RowRecord> {
  /** Result as Arrow Table (zero-copy) */
  arrowTable: Table
  /** Result as plain JS objects (materialized from Arrow) */
  rows: T[]
  /** Query execution time in milliseconds */
  executionMs: number
  /** Number of rows in result */
  rowCount: number
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

class DuckDBUnavailableError extends Error {
  readonly code = 'MISSING_PEER_DEP'
  constructor() {
    super(
      '@duckdb/duckdb-wasm is not installed. ' +
      'Install it with: npm install @duckdb/duckdb-wasm'
    )
    this.name = 'DuckDBUnavailableError'
  }
}

// ---------------------------------------------------------------------------
// Dynamic import helper
// ---------------------------------------------------------------------------

async function loadDuckDB(): Promise<DuckDBModule> {
  try {
    // Dynamic import -- @duckdb/duckdb-wasm is an optional peer dep
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mod: DuckDBModule = await (Function('return import("@duckdb/duckdb-wasm")')() as Promise<DuckDBModule>)
    return mod
  } catch {
    throw new DuckDBUnavailableError()
  }
}

// ---------------------------------------------------------------------------
// DuckDBEngine
// ---------------------------------------------------------------------------

/**
 * DuckDB-WASM query engine for Arrow Table analytics.
 *
 * Lazily initializes a DuckDB-WASM instance. Registers Arrow Tables
 * as virtual tables for zero-copy SQL queries.
 *
 * @example
 * ```ts
 * const engine = await DuckDBEngine.create()
 * const result = await engine.query(memoryTable, `
 *   SELECT namespace, COUNT(*) as count, AVG(decay_strength) as avg_strength
 *   FROM memory
 *   GROUP BY namespace
 *   ORDER BY count DESC
 * `)
 * console.log(result.rows)
 * await engine.close()
 * ```
 */
export class DuckDBEngine {
  private db: DuckDBInstance
  private connection: DuckDBConnection
  private registeredTables = new Set<string>()

  private constructor(db: DuckDBInstance, connection: DuckDBConnection) {
    this.db = db
    this.connection = connection
  }

  /**
   * Create a DuckDBEngine from pre-built db/connection objects.
   * Intended for testing -- allows injecting mock DuckDB instances.
   *
   * @internal
   */
  static _createFromConnection(
    db: { terminate(): Promise<void> },
    connection: {
      insertArrowTable(table: Table, options: { name: string; create: boolean }): Promise<void>
      query<T extends RowRecord = RowRecord>(sql: string): Promise<Table & { toArray(): T[] }>
      close(): Promise<void>
    },
  ): DuckDBEngine {
    return new DuckDBEngine(
      db as DuckDBInstance,
      connection as DuckDBConnection,
    )
  }

  /**
   * Create and initialize the DuckDB-WASM engine.
   * Throws DuckDBUnavailableError if @duckdb/duckdb-wasm is not installed.
   */
  static async create(): Promise<DuckDBEngine> {
    const duckdb = await loadDuckDB()

    const logger = new duckdb.ConsoleLogger()

    // Worker creation is environment-dependent (browser vs Node).
    // DuckDB-WASM handles the null case internally (single-threaded mode).
    const db = new duckdb.AsyncDuckDB(logger, null)
    await db.open({
      query: { castBigIntToDouble: true },
    })

    const connection = await db.connect()
    return new DuckDBEngine(db, connection)
  }

  /**
   * Run a SQL query against an Arrow Table.
   *
   * The table is registered as a virtual table named by `alias` (default: 'memory').
   * Query must reference this table name.
   *
   * @param table - Arrow Table to query
   * @param sql - SQL query string
   * @param alias - Virtual table name (default: 'memory')
   */
  async query<T extends RowRecord = RowRecord>(
    table: Table,
    sql: string,
    alias = 'memory',
  ): Promise<AnalyticsResult<T>> {
    const start = performance.now()

    try {
      await this.registerTable(table, alias)
      const result = await this.connection.query<T>(sql)
      const executionMs = performance.now() - start

      const rows = result.toArray()

      return {
        arrowTable: result as unknown as Table,
        rows,
        executionMs,
        rowCount: rows.length,
      }
    } finally {
      await this.unregisterTable(alias)
    }
  }

  /**
   * Run a SQL query against multiple Arrow Tables.
   * Tables are registered with the provided aliases (map keys).
   *
   * @param tables - Map of alias to Arrow Table
   * @param sql - SQL query referencing the aliases
   */
  async queryMulti<T extends RowRecord = RowRecord>(
    tables: Map<string, Table>,
    sql: string,
  ): Promise<AnalyticsResult<T>> {
    const start = performance.now()
    const aliases: string[] = []

    try {
      for (const [alias, table] of tables) {
        await this.registerTable(table, alias)
        aliases.push(alias)
      }

      const result = await this.connection.query<T>(sql)
      const executionMs = performance.now() - start

      const rows = result.toArray()

      return {
        arrowTable: result as unknown as Table,
        rows,
        executionMs,
        rowCount: rows.length,
      }
    } finally {
      for (const alias of aliases) {
        await this.unregisterTable(alias)
      }
    }
  }

  /** Release DuckDB-WASM resources */
  async close(): Promise<void> {
    // Drop any remaining registered tables
    for (const alias of this.registeredTables) {
      try {
        await this.connection.query(`DROP TABLE IF EXISTS "${alias}"`)
      } catch {
        // Best-effort cleanup
      }
    }
    this.registeredTables.clear()

    try {
      await this.connection.close()
    } catch {
      // Best-effort cleanup
    }

    try {
      await this.db.terminate()
    } catch {
      // Best-effort cleanup
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async registerTable(table: Table, alias: string): Promise<void> {
    // Drop existing table with this alias if present
    if (this.registeredTables.has(alias)) {
      await this.connection.query(`DROP TABLE IF EXISTS "${alias}"`)
      this.registeredTables.delete(alias)
    }

    await this.connection.insertArrowTable(table, {
      name: alias,
      create: true,
    })
    this.registeredTables.add(alias)
  }

  private async unregisterTable(alias: string): Promise<void> {
    if (!this.registeredTables.has(alias)) return
    try {
      await this.connection.query(`DROP TABLE IF EXISTS "${alias}"`)
    } catch {
      // Best-effort cleanup
    }
    this.registeredTables.delete(alias)
  }
}
