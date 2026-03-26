/** Minimal type declaration for the optional `pg` peer dependency. */
declare module 'pg' {
  interface PoolConfig {
    connectionString?: string
    host?: string
    port?: number
    database?: string
    user?: string
    password?: string
    ssl?: boolean | Record<string, unknown>
    max?: number
    statement_timeout?: number
    [key: string]: unknown
  }

  interface QueryResultField {
    name: string
    dataTypeID: number
  }

  interface QueryResult {
    rows: Record<string, unknown>[]
    rowCount: number | null
    fields: QueryResultField[]
  }

  class Pool {
    constructor(config?: PoolConfig)
    query(text: string, values?: unknown[]): Promise<QueryResult>
    end(): Promise<void>
  }
}
