declare module 'better-sqlite3' {
  export interface Statement {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }

  export interface Options {
    readonly?: boolean
  }

  export interface Database {
    prepare(sql: string): Statement
    pragma(sql: string): unknown
    close(): void
  }

  export interface DatabaseConstructor {
    new (filePath: string, options?: Options): Database
  }

  const Database: DatabaseConstructor

  export default Database
}
