declare module 'mssql' {
  export interface config {
    server: string
    port: number
    database: string
    user: string
    password: string
    pool?: {
      max?: number
      min?: number
      idleTimeoutMillis?: number
    }
    options?: {
      encrypt?: boolean
      trustServerCertificate?: boolean
    }
  }

  export interface QueryResult<T = Record<string, unknown>> {
    recordset: T[]
  }

  export interface Request {
    timeout: number
    input(name: string, type: unknown, value: unknown): Request
    query<T = Record<string, unknown>>(sql: string): Promise<QueryResult<T>>
  }

  export class ConnectionPool {
    constructor(cfg: config)
    connect(): Promise<ConnectionPool>
    request(): Request
    close(): Promise<void>
  }

  export const VarChar: unknown

  const mssql: {
    ConnectionPool: typeof ConnectionPool
    VarChar: typeof VarChar
  }

  export default mssql
}
