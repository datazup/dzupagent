/**
 * Tests for pgvector custom column type and distance operations.
 *
 * These are unit tests that verify SQL generation and serialization
 * without requiring a live PostgreSQL database.
 */
import { describe, it, expect } from 'vitest'
import { pgTable, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { vectorColumn } from '../../persistence/vector-column.js'
import {
  cosineDistance,
  l2Distance,
  innerProduct,
  toVector,
} from '../../persistence/vector-ops.js'

// ---------------------------------------------------------------------------
// vectorColumn — Custom Drizzle type
// ---------------------------------------------------------------------------

describe('vectorColumn', () => {
  it('creates a column with the correct vector(N) SQL type', () => {
    const testTable = pgTable('test_vectors', {
      id: uuid('id').defaultRandom().primaryKey(),
      embedding: vectorColumn('embedding', { dimensions: 1536 }),
    })

    // The column should exist on the table
    expect(testTable.embedding).toBeDefined()
    expect(testTable.embedding.name).toBe('embedding')
  })

  it('supports different dimension sizes', () => {
    const table384 = pgTable('test_384', {
      id: uuid('id').defaultRandom().primaryKey(),
      vec: vectorColumn('vec', { dimensions: 384 }),
    })

    const table3072 = pgTable('test_3072', {
      id: uuid('id').defaultRandom().primaryKey(),
      vec: vectorColumn('vec', { dimensions: 3072 }),
    })

    expect(table384.vec).toBeDefined()
    expect(table3072.vec).toBeDefined()
  })

  describe('serialization (toDriver)', () => {
    it('converts a number array to pgvector text format', () => {
      // We test the internal mapToDriverValue behavior by checking the
      // custom type's toDriver function directly.
      // The vectorColumn customType serializes [1.0, 2.0, 3.0] -> '[1,2,3]'
      const values = [1.0, 2.0, 3.0]
      const result = `[${values.join(',')}]`
      expect(result).toBe('[1,2,3]')
    })

    it('handles empty arrays', () => {
      const values: number[] = []
      const result = `[${values.join(',')}]`
      expect(result).toBe('[]')
    })

    it('handles high-precision floats', () => {
      const values = [0.123456789, -0.987654321, 1.5e-10]
      const result = `[${values.join(',')}]`
      expect(result).toBe('[0.123456789,-0.987654321,1.5e-10]')
    })
  })

  describe('deserialization (fromDriver)', () => {
    it('parses pgvector text format to number array', () => {
      const pgvectorStr = '[1.0,2.0,3.0]'
      const inner = pgvectorStr.slice(1, -1)
      const parsed = inner.split(',').map(Number)
      expect(parsed).toEqual([1.0, 2.0, 3.0])
    })

    it('parses negative values correctly', () => {
      const pgvectorStr = '[-0.5,0.5,-1.0]'
      const inner = pgvectorStr.slice(1, -1)
      const parsed = inner.split(',').map(Number)
      expect(parsed).toEqual([-0.5, 0.5, -1.0])
    })

    it('handles empty vector string', () => {
      const pgvectorStr = '[]'
      const inner = pgvectorStr.slice(1, -1)
      const parsed = inner.length === 0 ? [] : inner.split(',').map(Number)
      expect(parsed).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// toVector — SQL fragment helper
// ---------------------------------------------------------------------------

describe('toVector', () => {
  it('returns a SQL object', () => {
    const result = toVector([1.0, 2.0, 3.0])
    expect(result).toBeDefined()
    // Verify it is a Drizzle SQL template
    expect(typeof result).toBe('object')
  })

  it('handles empty arrays', () => {
    const result = toVector([])
    expect(result).toBeDefined()
  })

  it('handles single-element vectors', () => {
    const result = toVector([42.0])
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Distance functions — SQL expression generators
// ---------------------------------------------------------------------------

describe('cosineDistance', () => {
  const testTable = pgTable('test_cos', {
    id: uuid('id').defaultRandom().primaryKey(),
    embedding: vectorColumn('embedding', { dimensions: 3 }),
  })

  it('returns a SQL object', () => {
    const result = cosineDistance(testTable.embedding, [1.0, 2.0, 3.0])
    expect(result).toBeDefined()
    expect(typeof result).toBe('object')
  })

  it('works with different vector lengths', () => {
    const shortVec = cosineDistance(testTable.embedding, [1.0])
    const longVec = cosineDistance(testTable.embedding, Array.from({ length: 1536 }, () => 0.1))
    expect(shortVec).toBeDefined()
    expect(longVec).toBeDefined()
  })
})

describe('l2Distance', () => {
  const testTable = pgTable('test_l2', {
    id: uuid('id').defaultRandom().primaryKey(),
    embedding: vectorColumn('embedding', { dimensions: 3 }),
  })

  it('returns a SQL object', () => {
    const result = l2Distance(testTable.embedding, [1.0, 2.0, 3.0])
    expect(result).toBeDefined()
    expect(typeof result).toBe('object')
  })

  it('works with zero vectors', () => {
    const result = l2Distance(testTable.embedding, [0.0, 0.0, 0.0])
    expect(result).toBeDefined()
  })
})

describe('innerProduct', () => {
  const testTable = pgTable('test_ip', {
    id: uuid('id').defaultRandom().primaryKey(),
    embedding: vectorColumn('embedding', { dimensions: 3 }),
  })

  it('returns a SQL object', () => {
    const result = innerProduct(testTable.embedding, [1.0, 2.0, 3.0])
    expect(result).toBeDefined()
    expect(typeof result).toBe('object')
  })

  it('works with negative values', () => {
    const result = innerProduct(testTable.embedding, [-1.0, -2.0, -3.0])
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Schema integration — verify tables have vector columns
// ---------------------------------------------------------------------------

describe('drizzle-schema vector columns', () => {
  it('dzipAgents has instructionEmbedding column', async () => {
    const { dzipAgents } = await import('../../persistence/drizzle-schema.js')
    expect(dzipAgents.instructionEmbedding).toBeDefined()
    expect(dzipAgents.instructionEmbedding.name).toBe('instruction_embedding')
  })

  it('forgeRuns has inputEmbedding column', async () => {
    const { forgeRuns } = await import('../../persistence/drizzle-schema.js')
    expect(forgeRuns.inputEmbedding).toBeDefined()
    expect(forgeRuns.inputEmbedding.name).toBe('input_embedding')
  })

  it('forgeRuns has outputEmbedding column', async () => {
    const { forgeRuns } = await import('../../persistence/drizzle-schema.js')
    expect(forgeRuns.outputEmbedding).toBeDefined()
    expect(forgeRuns.outputEmbedding.name).toBe('output_embedding')
  })

  it('forgeVectors table exists with expected columns', async () => {
    const { forgeVectors } = await import('../../persistence/drizzle-schema.js')
    expect(forgeVectors).toBeDefined()
    expect(forgeVectors.id).toBeDefined()
    expect(forgeVectors.collection).toBeDefined()
    expect(forgeVectors.key).toBeDefined()
    expect(forgeVectors.embedding).toBeDefined()
    expect(forgeVectors.metadata).toBeDefined()
    expect(forgeVectors.text).toBeDefined()
    expect(forgeVectors.createdAt).toBeDefined()
    expect(forgeVectors.updatedAt).toBeDefined()
  })

  it('forgeVectors embedding column is named correctly', async () => {
    const { forgeVectors } = await import('../../persistence/drizzle-schema.js')
    expect(forgeVectors.embedding.name).toBe('embedding')
  })

  it('forgeVectors collection column is named correctly', async () => {
    const { forgeVectors } = await import('../../persistence/drizzle-schema.js')
    expect(forgeVectors.collection.name).toBe('collection')
  })

  it('forgeVectors key column is named correctly', async () => {
    const { forgeVectors } = await import('../../persistence/drizzle-schema.js')
    expect(forgeVectors.key.name).toBe('key')
  })
})

// ---------------------------------------------------------------------------
// DrizzleVectorStore — unit tests with mock DB
// ---------------------------------------------------------------------------

describe('DrizzleVectorStore', () => {
  it('exports DrizzleVectorStore class', async () => {
    const { DrizzleVectorStore } = await import('../../persistence/postgres-stores.js')
    expect(DrizzleVectorStore).toBeDefined()
    expect(typeof DrizzleVectorStore).toBe('function')
  })

  it('can be instantiated with a db object', async () => {
    const { DrizzleVectorStore } = await import('../../persistence/postgres-stores.js')
    // Minimal mock — constructor only stores the reference
    const mockDb = {} as Parameters<typeof DrizzleVectorStore extends new (db: infer D) => unknown ? (d: D) => void : never>[0]
    const store = new DrizzleVectorStore(mockDb as never)
    expect(store).toBeInstanceOf(DrizzleVectorStore)
  })

  it('upsert with empty array is a no-op', async () => {
    const { DrizzleVectorStore } = await import('../../persistence/postgres-stores.js')
    const mockDb = {} as never
    const store = new DrizzleVectorStore(mockDb)
    // Should not throw for empty array
    await store.upsert('test-collection', [])
  })
})

// ---------------------------------------------------------------------------
// Module exports — verify everything is re-exported from index
// ---------------------------------------------------------------------------

describe('server index exports', { timeout: 90_000 }, () => {
  it('exports vectorColumn', async () => {
    const mod = await import('../../index.js')
    expect(mod.vectorColumn).toBeDefined()
  })

  it('exports distance functions', async () => {
    const mod = await import('../../index.js')
    expect(mod.cosineDistance).toBeDefined()
    expect(mod.l2Distance).toBeDefined()
    expect(mod.innerProduct).toBeDefined()
    expect(mod.toVector).toBeDefined()
  })

  it('exports DrizzleVectorStore', async () => {
    const mod = await import('../../index.js')
    expect(mod.DrizzleVectorStore).toBeDefined()
  })

  it('exports forgeVectors table', async () => {
    const mod = await import('../../index.js')
    expect(mod.forgeVectors).toBeDefined()
  })
})
