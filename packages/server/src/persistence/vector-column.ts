/**
 * Custom Drizzle column type for PostgreSQL pgvector `vector` columns.
 *
 * Handles serialization between TypeScript `number[]` and pgvector's
 * text format `'[1.0,2.0,3.0]'`.
 *
 * Requires the pgvector PostgreSQL extension:
 *   CREATE EXTENSION IF NOT EXISTS vector;
 */
import { customType } from 'drizzle-orm/pg-core'

/**
 * Custom Drizzle column type for pgvector's `vector(N)` type.
 *
 * @example
 * ```ts
 * import { pgTable, uuid, text } from 'drizzle-orm/pg-core'
 * import { vectorColumn } from './vector-column.js'
 *
 * const myTable = pgTable('my_table', {
 *   id: uuid('id').defaultRandom().primaryKey(),
 *   embedding: vectorColumn('embedding', { dimensions: 1536 }),
 * })
 * ```
 */
export const vectorColumn = customType<{
  data: number[]
  config: { dimensions: number }
  driverData: string
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`
  },
  fromDriver(value: string): number[] {
    // pgvector returns strings like '[1.0,2.0,3.0]'
    const inner = value.slice(1, -1)
    if (inner.length === 0) return []
    return inner.split(',').map(Number)
  },
})
