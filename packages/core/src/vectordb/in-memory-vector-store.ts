/**
 * In-memory VectorStore implementation — brute-force cosine similarity search.
 *
 * Useful for:
 * - Unit tests (no external dependencies)
 * - Development / prototyping
 * - Small datasets (< 10k vectors)
 *
 * NOT suitable for production workloads with large vector collections.
 */

import type {
  CollectionConfig,
  VectorDeleteFilter,
  VectorEntry,
  VectorQuery,
  VectorSearchResult,
  VectorStore,
  VectorStoreHealth,
} from './types.js'
import { cosineSimilarity, evaluateFilter } from './filter-utils.js'

interface CollectionData {
  config: CollectionConfig
  entries: Map<string, VectorEntry>
}

/**
 * In-memory vector store with brute-force cosine similarity search.
 *
 * Stores all vectors in Maps — no persistence, no indexing.
 * Search is O(n) per query where n = number of entries in the collection.
 */
export class InMemoryVectorStore implements VectorStore {
  readonly provider = 'memory' as const

  private readonly collections = new Map<string, CollectionData>()

  // --- Collection lifecycle ---

  async createCollection(name: string, config: CollectionConfig): Promise<void> {
    if (this.collections.has(name)) {
      throw new Error(`Collection "${name}" already exists`)
    }
    this.collections.set(name, {
      config,
      entries: new Map(),
    })
  }

  async deleteCollection(name: string): Promise<void> {
    this.collections.delete(name)
  }

  async listCollections(): Promise<string[]> {
    return [...this.collections.keys()]
  }

  async collectionExists(name: string): Promise<boolean> {
    return this.collections.has(name)
  }

  // --- Vector operations ---

  async upsert(collection: string, entries: VectorEntry[]): Promise<void> {
    const col = this.getCollection(collection)

    for (const entry of entries) {
      if (entry.vector.length !== col.config.dimensions) {
        throw new Error(
          `Dimension mismatch in collection "${collection}": ` +
          `expected ${String(col.config.dimensions)}, got ${String(entry.vector.length)}`,
        )
      }
      col.entries.set(entry.id, { ...entry })
    }
  }

  async search(
    collection: string,
    query: VectorQuery,
  ): Promise<VectorSearchResult[]> {
    const col = this.getCollection(collection)

    const results: VectorSearchResult[] = []

    for (const entry of col.entries.values()) {
      // Apply metadata filter
      if (query.filter && !evaluateFilter(entry.metadata, query.filter)) {
        continue
      }

      const score = cosineSimilarity(query.vector, entry.vector)

      // Apply minScore filter
      if (query.minScore !== undefined && score < query.minScore) {
        continue
      }

      const result: VectorSearchResult = {
        id: entry.id,
        score,
        metadata: query.includeMetadata === false ? {} : { ...entry.metadata },
        ...(entry.text != null ? { text: entry.text } : {}),
      }

      if (query.includeVectors) {
        result.vector = [...entry.vector]
      }

      results.push(result)
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score)

    // Apply limit
    return results.slice(0, query.limit)
  }

  async delete(collection: string, filter: VectorDeleteFilter): Promise<void> {
    const col = this.getCollection(collection)

    if ('ids' in filter) {
      for (const id of filter.ids) {
        col.entries.delete(id)
      }
    } else {
      // Delete by metadata filter
      for (const [id, entry] of col.entries) {
        if (evaluateFilter(entry.metadata, filter.filter)) {
          col.entries.delete(id)
        }
      }
    }
  }

  async count(collection: string): Promise<number> {
    const col = this.getCollection(collection)
    return col.entries.size
  }

  // --- Lifecycle ---

  async healthCheck(): Promise<VectorStoreHealth> {
    return {
      healthy: true,
      latencyMs: 0,
      provider: this.provider,
      details: {
        collections: this.collections.size,
        totalEntries: this.totalEntryCount(),
      },
    }
  }

  async close(): Promise<void> {
    this.collections.clear()
  }

  // --- Private helpers ---

  private getCollection(name: string): CollectionData {
    const col = this.collections.get(name)
    if (!col) {
      throw new Error(`Collection "${name}" does not exist`)
    }
    return col
  }

  private totalEntryCount(): number {
    let total = 0
    for (const col of this.collections.values()) {
      total += col.entries.size
    }
    return total
  }
}
