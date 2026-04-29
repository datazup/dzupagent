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

export interface DrizzleConflictMutationResult extends PromiseLike<unknown> {
  onConflictDoNothing(): PromiseLike<unknown>
}

export interface DrizzleInsertBuilder<TResult extends PromiseLike<unknown> = DrizzleMutationResult> {
  values(values: unknown): TResult
}

export interface DrizzleUpdateWhereBuilder<TResult extends PromiseLike<unknown> = DrizzleMutationResult> extends PromiseLike<unknown> {
  where(condition: unknown): TResult
}

export interface DrizzleUpdateBuilder<TResult extends PromiseLike<unknown> = DrizzleMutationResult> {
  set(values: unknown): DrizzleUpdateWhereBuilder<TResult>
}

export interface DrizzleDeleteBuilder {
  where(condition: unknown): DrizzleMutationResult
}

export interface DrizzleStoreDatabase {
  select(selection?: unknown): DrizzleSelectQuery
  insert(table: unknown): DrizzleInsertBuilder
  update(table: unknown): DrizzleUpdateBuilder
  delete(table: unknown): DrizzleDeleteBuilder
}

export interface DrizzleConflictInsertDatabase extends Omit<DrizzleStoreDatabase, 'insert'> {
  insert(table: unknown): DrizzleInsertBuilder<DrizzleConflictMutationResult>
}

export interface DrizzleReturningStoreDatabase extends Omit<DrizzleStoreDatabase, 'insert' | 'update'> {
  insert(table: unknown): DrizzleInsertBuilder<DrizzleMutationResult>
  update(table: unknown): DrizzleUpdateBuilder<DrizzleMutationResult>
}
