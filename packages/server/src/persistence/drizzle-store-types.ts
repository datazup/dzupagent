/**
 * Narrow Drizzle fluent API used by server persistence stores.
 *
 * The server package supports different Postgres Drizzle drivers in tests and
 * consumers, so stores should depend on the query-builder operations they use
 * instead of a driver-specific database type.
 */
export interface DrizzleSelectQuery extends PromiseLike<unknown[]> {
  from(table: unknown): DrizzleSelectQuery
  where(condition: unknown): DrizzleSelectQuery
  orderBy(...expressions: unknown[]): DrizzleSelectQuery
  limit(limit: number): DrizzleSelectQuery
}

export interface DrizzleMutationResult extends PromiseLike<unknown> {
  returning(): Promise<unknown[]>
}

export interface DrizzleInsertBuilder {
  values(values: unknown): DrizzleMutationResult
}

export interface DrizzleUpdateWhereBuilder extends PromiseLike<unknown> {
  where(condition: unknown): DrizzleMutationResult
}

export interface DrizzleUpdateBuilder {
  set(values: unknown): DrizzleUpdateWhereBuilder
}

export interface DrizzleDeleteBuilder {
  where(condition: unknown): DrizzleMutationResult
}

export interface DrizzleStoreDatabase {
  select(): DrizzleSelectQuery
  insert(table: unknown): DrizzleInsertBuilder
  update(table: unknown): DrizzleUpdateBuilder
  delete(table: unknown): DrizzleDeleteBuilder
}
