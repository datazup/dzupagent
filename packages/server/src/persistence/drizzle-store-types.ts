/**
 * Narrow Drizzle fluent API used by server persistence stores.
 *
 * The server package supports different Postgres Drizzle drivers in tests and
 * consumers, so stores should depend on the query-builder operations they use
 * instead of a driver-specific database type.
 */
export interface DrizzleSelectQuery extends PromiseLike<unknown[]> {
  from(table: unknown): DrizzleSelectQuery;
  where(condition: unknown): DrizzleSelectQuery;
  orderBy(...expressions: unknown[]): DrizzleSelectQuery;
  limit(limit: number): DrizzleSelectQuery;
}

export interface DrizzleMutationResult extends PromiseLike<unknown> {
  returning(selection?: unknown): Promise<unknown[]>;
}

export interface DrizzleConflictMutationResult extends PromiseLike<unknown> {
  onConflictDoNothing(): PromiseLike<unknown>;
}

/**
 * Insert result supporting upsert with a RETURNING clause. Used by the worker
 * fleet registry, where `register` upserts onto a caller-supplied id and reads
 * back the resulting row.
 */
export interface DrizzleConflictUpdateMutationResult
  extends DrizzleMutationResult {
  onConflictDoUpdate(config: {
    target: unknown;
    set: unknown;
  }): DrizzleMutationResult;
}

export interface DrizzleInsertBuilder<
  TResult extends PromiseLike<unknown> = DrizzleMutationResult
> {
  values(values: unknown): TResult;
}

export interface DrizzleUpdateWhereBuilder<
  TResult extends PromiseLike<unknown> = DrizzleMutationResult
> extends PromiseLike<unknown> {
  where(condition: unknown): TResult;
}

export interface DrizzleUpdateBuilder<
  TResult extends PromiseLike<unknown> = DrizzleMutationResult
> {
  set(values: unknown): DrizzleUpdateWhereBuilder<TResult>;
}

export interface DrizzleDeleteBuilder {
  where(condition: unknown): DrizzleMutationResult;
}

export interface DrizzleStoreDatabase {
  select(selection?: unknown): DrizzleSelectQuery;
  insert(table: unknown): DrizzleInsertBuilder;
  update(table: unknown): DrizzleUpdateBuilder;
  delete(table: unknown): DrizzleDeleteBuilder;
}

export interface DrizzleConflictInsertDatabase
  extends Omit<DrizzleStoreDatabase, "insert"> {
  insert(table: unknown): DrizzleInsertBuilder<DrizzleConflictMutationResult>;
}

export interface DrizzleReturningStoreDatabase
  extends Omit<DrizzleStoreDatabase, "insert" | "update"> {
  insert(table: unknown): DrizzleInsertBuilder<DrizzleMutationResult>;
  update(table: unknown): DrizzleUpdateBuilder<DrizzleMutationResult>;
}

/**
 * Drizzle client surface used by the worker fleet registry. `register` upserts
 * with a RETURNING clause (insert → onConflictDoUpdate → returning) and
 * `reapExpired` updates-with-returning, so both `insert` and `update` builders
 * resolve to returning-capable mutation results.
 */
export interface DrizzleWorkerNodeDatabase
  extends Omit<DrizzleStoreDatabase, "insert" | "update"> {
  insert(
    table: unknown
  ): DrizzleInsertBuilder<DrizzleConflictUpdateMutationResult>;
  update(table: unknown): DrizzleUpdateBuilder<DrizzleMutationResult>;
}
