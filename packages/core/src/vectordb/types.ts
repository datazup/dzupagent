/**
 * VectorStore abstraction layer — provider-agnostic types for vector DB operations.
 *
 * Each adapter (Qdrant, Pinecone, Weaviate, in-memory) translates these types
 * to its native format. Metadata filters use a normalized AST that adapters
 * convert at call-time.
 */

/** Distance metric for similarity search */
export type DistanceMetric = 'cosine' | 'euclidean' | 'dot_product'

/** Collection configuration */
export interface CollectionConfig {
  /** Dimensionality of vectors stored in this collection */
  dimensions: number
  /** Distance metric for similarity search (default: 'cosine') */
  metric?: DistanceMetric
  /** Metadata field types for indexing */
  metadata?: Record<string, 'string' | 'number' | 'boolean' | 'string[]'>
}

/** A vector entry to upsert */
export interface VectorEntry {
  id: string
  vector: number[]
  metadata: Record<string, unknown>
  /** Original text for retrieval */
  text?: string
}

/** Query parameters for vector search */
export interface VectorQuery {
  vector: number[]
  limit: number
  filter?: MetadataFilter
  minScore?: number
  /** Include metadata in results (default: true) */
  includeMetadata?: boolean
  /** Include raw vectors in results (default: false) */
  includeVectors?: boolean
}

/** A search result from vector similarity query */
export interface VectorSearchResult {
  id: string
  score: number
  metadata: Record<string, unknown>
  text?: string
  vector?: number[]
}

/** Deletion filter — delete by IDs or by metadata filter */
export type VectorDeleteFilter =
  | { ids: string[] }
  | { filter: MetadataFilter }

/**
 * Normalized metadata filter — each adapter translates to native format.
 *
 * Supports comparison, set membership, string contains, and boolean composition.
 */
export type MetadataFilter =
  | { field: string; op: 'eq' | 'neq'; value: string | number | boolean }
  | { field: string; op: 'gt' | 'gte' | 'lt' | 'lte'; value: number }
  | { field: string; op: 'in' | 'not_in'; value: (string | number)[] }
  | { field: string; op: 'contains'; value: string }
  | { and: MetadataFilter[] }
  | { or: MetadataFilter[] }

/** Health check result */
export interface VectorStoreHealth {
  healthy: boolean
  latencyMs: number
  provider: string
  details?: Record<string, unknown>
}

/** The core VectorStore interface — all adapters implement this */
export interface VectorStore {
  readonly provider: string

  // --- Collection lifecycle ---

  /** Create a new collection with the given config */
  createCollection(name: string, config: CollectionConfig): Promise<void>
  /** Delete a collection and all its vectors */
  deleteCollection(name: string): Promise<void>
  /** List all collection names */
  listCollections(): Promise<string[]>
  /** Check if a collection exists */
  collectionExists(name: string): Promise<boolean>

  // --- Vector operations ---

  /** Upsert one or more vector entries into a collection */
  upsert(collection: string, entries: VectorEntry[]): Promise<void>
  /** Search for similar vectors */
  search(collection: string, query: VectorQuery): Promise<VectorSearchResult[]>
  /** Delete vectors by IDs or metadata filter */
  delete(collection: string, filter: VectorDeleteFilter): Promise<void>
  /** Count total vectors in a collection */
  count(collection: string): Promise<number>

  // --- Lifecycle ---

  /** Run a health check against the backing store */
  healthCheck(): Promise<VectorStoreHealth>
  /** Close connections and release resources */
  close(): Promise<void>
}
