/**
 * SemanticStore — high-level text-oriented API over VectorStore + EmbeddingProvider.
 *
 * Handles embedding text to vectors automatically, so callers work with
 * plain text documents rather than raw vectors.
 */

import type { EmbeddingProvider } from './embedding-types.js'
import type {
  CollectionConfig,
  MetadataFilter,
  VectorDeleteFilter,
  VectorStore,
} from './types.js'

/** Configuration for creating a SemanticStore */
export interface SemanticStoreConfig {
  /** Provider for generating text embeddings */
  embedding: EmbeddingProvider
  /** Underlying vector store for persistence and search */
  vectorStore: VectorStore
  /** Default collection name when none is specified */
  defaultCollection?: string
}

/** A document to store — text with optional metadata */
export interface Document {
  id: string
  text: string
  metadata?: Record<string, unknown>
}

/** A scored search result — document with similarity score */
export interface ScoredDocument {
  id: string
  text: string
  score: number
  metadata: Record<string, unknown>
}

/**
 * High-level semantic search and storage.
 *
 * Wraps a VectorStore and EmbeddingProvider to provide text-in / text-out
 * operations. Embedding is handled automatically on upsert and search.
 *
 * @example
 * ```ts
 * const store = new SemanticStore({
 *   embedding: createOpenAIEmbedding({ apiKey }),
 *   vectorStore: new InMemoryVectorStore(),
 * })
 *
 * await store.ensureCollection('docs', { dimensions: 1536 })
 * await store.upsert('docs', [{ id: '1', text: 'Hello world' }])
 * const results = await store.search('docs', 'greeting', 5)
 * ```
 */
export class SemanticStore {
  private readonly _embedding: EmbeddingProvider
  private readonly _store: VectorStore

  constructor(config: SemanticStoreConfig) {
    this._embedding = config.embedding
    this._store = config.vectorStore
  }

  /** Access the underlying embedding provider */
  get embedding(): EmbeddingProvider {
    return this._embedding
  }

  /** Access the underlying vector store */
  get store(): VectorStore {
    return this._store
  }

  /**
   * Search by text query.
   *
   * Embeds the query text, searches the vector store, and returns
   * scored documents with their original text.
   */
  async search(
    collection: string,
    query: string,
    limit: number,
    filter?: MetadataFilter,
  ): Promise<ScoredDocument[]> {
    const queryVector = await this._embedding.embedQuery(query)

    const results = await this._store.search(collection, {
      vector: queryVector,
      limit,
      ...(filter != null ? { filter } : {}),
      includeMetadata: true,
    })

    return results.map((r) => ({
      id: r.id,
      text: r.text ?? '',
      score: r.score,
      metadata: r.metadata,
    }))
  }

  /**
   * Upsert documents with automatic embedding.
   *
   * Batch-embeds all document texts at once for efficiency,
   * then upserts the resulting vectors.
   */
  async upsert(collection: string, docs: Document[]): Promise<void> {
    if (docs.length === 0) return

    const texts = docs.map((d) => d.text)
    const vectors = await this._embedding.embed(texts)

    const entries = docs.map((doc, i) => ({
      id: doc.id,
      vector: vectors[i]!,
      metadata: doc.metadata ?? {},
      text: doc.text,
    }))

    await this._store.upsert(collection, entries)
  }

  /**
   * Delete documents by IDs or metadata filter.
   */
  async delete(collection: string, filter: VectorDeleteFilter): Promise<void> {
    await this._store.delete(collection, filter)
  }

  /**
   * Ensure a collection exists, creating it if necessary.
   *
   * When creating, uses the embedding provider's dimensions by default.
   */
  async ensureCollection(
    collection: string,
    config?: Partial<CollectionConfig>,
  ): Promise<void> {
    const exists = await this._store.collectionExists(collection)
    if (exists) return

    const fullConfig: CollectionConfig = {
      dimensions: config?.dimensions ?? this._embedding.dimensions,
      metric: config?.metric ?? 'cosine',
      ...(config?.metadata != null ? { metadata: config.metadata } : {}),
    }

    await this._store.createCollection(collection, fullConfig)
  }
}
