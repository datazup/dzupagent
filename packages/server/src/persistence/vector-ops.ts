/**
 * Drizzle SQL helpers for pgvector distance operations.
 *
 * These functions return Drizzle `SQL` template literals usable in
 * `orderBy`, `where`, and `select` clauses. They wrap pgvector's
 * distance operators:
 *
 * - `<=>` cosine distance
 * - `<->` L2 (Euclidean) distance
 * - `<#>` negative inner product
 *
 * @example
 * ```ts
 * import { cosineDistance, toVector } from './vector-ops.js'
 * import { forgeVectors } from './drizzle-schema.js'
 *
 * const queryVec = [0.1, 0.2, 0.3]
 * const results = await db
 *   .select({
 *     id: forgeVectors.id,
 *     distance: cosineDistance(forgeVectors.embedding, queryVec),
 *   })
 *   .from(forgeVectors)
 *   .orderBy(cosineDistance(forgeVectors.embedding, queryVec))
 *   .limit(10)
 * ```
 */
import { sql, type SQL, type Column } from 'drizzle-orm'

/**
 * Format a number array as a pgvector literal string for SQL embedding.
 * Produces a value like `'[0.1,0.2,0.3]'::vector`.
 */
export function toVector(values: number[]): SQL {
  const literal = `[${values.join(',')}]`
  return sql`${literal}::vector`
}

/**
 * Cosine distance between a vector column and a query vector.
 * Maps to pgvector's `<=>` operator.
 *
 * Result range: 0 (identical) to 2 (opposite).
 * Use in `orderBy` (ascending) for nearest-neighbor search.
 */
export function cosineDistance(column: Column, queryVector: number[]): SQL {
  const literal = `[${queryVector.join(',')}]`
  return sql`${column} <=> ${literal}::vector`
}

/**
 * L2 (Euclidean) distance between a vector column and a query vector.
 * Maps to pgvector's `<->` operator.
 *
 * Result range: 0 (identical) to infinity.
 * Use in `orderBy` (ascending) for nearest-neighbor search.
 */
export function l2Distance(column: Column, queryVector: number[]): SQL {
  const literal = `[${queryVector.join(',')}]`
  return sql`${column} <-> ${literal}::vector`
}

/**
 * Negative inner product between a vector column and a query vector.
 * Maps to pgvector's `<#>` operator.
 *
 * pgvector uses the *negative* inner product so that smaller values
 * indicate higher similarity (consistent with distance semantics).
 * Use in `orderBy` (ascending) for maximum-inner-product search.
 */
export function innerProduct(column: Column, queryVector: number[]): SQL {
  const literal = `[${queryVector.join(',')}]`
  return sql`${column} <#> ${literal}::vector`
}
