/**
 * CorpusManager — lifecycle management for named document corpora.
 *
 * Manages creating, ingesting into, invalidating, and searching document
 * corpora. Each corpus maps to a single vector collection. Sources within
 * a corpus can be individually replaced or removed.
 *
 * All state is in-memory — corpus metadata does not survive process restarts.
 * For persistent corpus registries, wrap this with a persistence adapter.
 */

import type { VectorStore, EmbeddingProvider } from '@dzupagent/core'
import { SemanticStore } from '@dzupagent/core'
import { SmartChunker } from './chunker.js'
import type {
  Corpus,
  CorpusConfig,
  CorpusSource,
  IngestJobResult,
  CorpusStats,
  CorpusScoredDocument,
} from './corpus-types.js'
import { CorpusNotFoundError, SourceNotFoundError } from './corpus-types.js'

/** Configuration for creating a CorpusManager */
export interface CorpusManagerConfig {
  vectorStore: VectorStore
  embedding: EmbeddingProvider
}

/** Generate a simple UUID v4-like ID */
function generateId(): string {
  const hex = '0123456789abcdef'
  const parts = [8, 4, 4, 4, 12] as const
  return parts
    .map((len) => {
      let segment = ''
      for (let i = 0; i < len; i++) {
        segment += hex[Math.floor(Math.random() * 16)]
      }
      return segment
    })
    .join('-')
}

/**
 * Manages the lifecycle of named document corpora backed by vector storage.
 *
 * @example
 * ```ts
 * const mgr = new CorpusManager({ vectorStore, embedding })
 * const corpus = await mgr.createCorpus('My Docs')
 * await mgr.ingestSource(corpus.id, { id: 'readme', text: readmeContent })
 * const hits = await mgr.search(corpus.id, 'how to install', 5)
 * ```
 */
export class CorpusManager {
  private readonly semanticStore: SemanticStore
  private readonly vectorStore: VectorStore
  private readonly embedding: EmbeddingProvider

  /** Corpus registry: id -> Corpus */
  private readonly corpora = new Map<string, Corpus>()

  /** Source tracking: corpusId -> Set<sourceId> */
  private readonly sourceMap = new Map<string, Set<string>>()

  /** Chunk ID tracking: `${corpusId}::${sourceId}` -> string[] */
  private readonly chunkMap = new Map<string, string[]>()

  constructor(config: CorpusManagerConfig) {
    this.vectorStore = config.vectorStore
    this.embedding = config.embedding
    this.semanticStore = new SemanticStore({
      embedding: config.embedding,
      vectorStore: config.vectorStore,
    })
  }

  // ---------------------------------------------------------------------------
  // Corpus CRUD
  // ---------------------------------------------------------------------------

  /** Create a new corpus with the given name and optional config */
  async createCorpus(name: string, config?: CorpusConfig): Promise<Corpus> {
    const id = generateId()
    const now = new Date()
    const corpus: Corpus = {
      id,
      name,
      createdAt: now,
      updatedAt: now,
      ...(config != null ? { config } : {}),
    }

    const collectionName = this.collectionName(id, config)
    await this.vectorStore.createCollection(collectionName, {
      dimensions: this.embedding.dimensions,
      metric: 'cosine',
    })

    this.corpora.set(id, corpus)
    this.sourceMap.set(id, new Set())
    return corpus
  }

  /** List all registered corpora */
  async listCorpora(): Promise<Corpus[]> {
    return [...this.corpora.values()]
  }

  /** Get a corpus by ID. Throws CorpusNotFoundError if not found. */
  async getCorpus(id: string): Promise<Corpus> {
    const corpus = this.corpora.get(id)
    if (!corpus) throw new CorpusNotFoundError(id)
    return corpus
  }

  /** Delete a corpus and its vector collection */
  async deleteCorpus(id: string): Promise<void> {
    const corpus = this.corpora.get(id)
    if (!corpus) throw new CorpusNotFoundError(id)

    const collectionName = this.collectionName(id, corpus.config)

    // Clean up chunk tracking for all sources
    const sources = this.sourceMap.get(id)
    if (sources) {
      for (const sourceId of sources) {
        this.chunkMap.delete(this.chunkKey(id, sourceId))
      }
    }

    this.sourceMap.delete(id)
    this.corpora.delete(id)

    await this.vectorStore.deleteCollection(collectionName)
  }

  // ---------------------------------------------------------------------------
  // Source Ingestion
  // ---------------------------------------------------------------------------

  /** Ingest a source document into a corpus. Re-ingests if sourceId already exists. */
  async ingestSource(
    corpusId: string,
    source: CorpusSource,
  ): Promise<IngestJobResult> {
    const corpus = this.corpora.get(corpusId)
    if (!corpus) throw new CorpusNotFoundError(corpusId)

    const collectionName = this.collectionName(corpusId, corpus.config)
    const key = this.chunkKey(corpusId, source.id)
    const sources = this.sourceMap.get(corpusId)!

    // If already ingested, treat as re-ingest
    let chunksReplaced = 0
    const existingChunks = this.chunkMap.get(key)
    if (existingChunks && existingChunks.length > 0) {
      chunksReplaced = existingChunks.length
      await this.semanticStore.delete(collectionName, { ids: existingChunks })
      this.chunkMap.delete(key)
    }

    // Chunk the text
    const chunkingConfig = corpus.config?.chunkingConfig
    const chunker = new SmartChunker({
      ...(chunkingConfig?.targetTokens != null
        ? { targetTokens: chunkingConfig.targetTokens }
        : {}),
      ...(chunkingConfig?.overlapFraction != null
        ? { overlapFraction: chunkingConfig.overlapFraction }
        : {}),
    })

    const chunks = chunker.chunkText(source.text, source.id)

    // Build documents for SemanticStore
    const docs = chunks.map((chunk) => ({
      id: chunk.id,
      text: chunk.text,
      metadata: {
        ...chunk.metadata,
        ...(source.metadata ?? {}),
        _corpusId: corpusId,
        _sourceId: source.id,
      },
    }))

    if (docs.length > 0) {
      await this.semanticStore.upsert(collectionName, docs)
    }

    // Track chunk IDs
    const chunkIds = chunks.map((c) => c.id)
    this.chunkMap.set(key, chunkIds)
    sources.add(source.id)

    // Update corpus timestamp
    corpus.updatedAt = new Date()

    return {
      corpusId,
      sourceId: source.id,
      chunksCreated: chunks.length,
      chunksReplaced,
    }
  }

  /** Remove all chunks for a source, but keep the corpus */
  async invalidateSource(corpusId: string, sourceId: string): Promise<void> {
    const corpus = this.corpora.get(corpusId)
    if (!corpus) throw new CorpusNotFoundError(corpusId)

    const sources = this.sourceMap.get(corpusId)!
    if (!sources.has(sourceId)) throw new SourceNotFoundError(sourceId)

    const key = this.chunkKey(corpusId, sourceId)
    const chunkIds = this.chunkMap.get(key)

    if (chunkIds && chunkIds.length > 0) {
      const collectionName = this.collectionName(corpusId, corpus.config)
      await this.semanticStore.delete(collectionName, { ids: chunkIds })
    }

    this.chunkMap.delete(key)
    sources.delete(sourceId)
    corpus.updatedAt = new Date()
  }

  /** Replace a source's content: invalidate old chunks, ingest new text */
  async reIngestSource(
    corpusId: string,
    sourceId: string,
    newText: string,
    metadata?: Record<string, unknown>,
  ): Promise<IngestJobResult> {
    const corpus = this.corpora.get(corpusId)
    if (!corpus) throw new CorpusNotFoundError(corpusId)

    const sources = this.sourceMap.get(corpusId)!
    if (!sources.has(sourceId)) throw new SourceNotFoundError(sourceId)

    // Get old chunk count for reporting
    const key = this.chunkKey(corpusId, sourceId)
    const oldChunks = this.chunkMap.get(key)
    const chunksReplaced = oldChunks?.length ?? 0

    // Invalidate
    await this.invalidateSource(corpusId, sourceId)

    // Re-ingest (invalidateSource removed the sourceId, so ingestSource won't double-invalidate)
    const result = await this.ingestSource(corpusId, {
      id: sourceId,
      text: newText,
      ...(metadata != null ? { metadata } : {}),
    })

    return {
      ...result,
      chunksReplaced,
    }
  }

  // ---------------------------------------------------------------------------
  // Query & Stats
  // ---------------------------------------------------------------------------

  /** Get aggregate statistics for a corpus */
  async getStats(corpusId: string): Promise<CorpusStats> {
    const corpus = this.corpora.get(corpusId)
    if (!corpus) throw new CorpusNotFoundError(corpusId)

    const sources = this.sourceMap.get(corpusId)!
    const collectionName = this.collectionName(corpusId, corpus.config)

    let totalChunks = 0
    for (const sourceId of sources) {
      const key = this.chunkKey(corpusId, sourceId)
      const chunkIds = this.chunkMap.get(key)
      totalChunks += chunkIds?.length ?? 0
    }

    return {
      corpusId,
      totalSources: sources.size,
      totalChunks,
      collections: [collectionName],
    }
  }

  /** Search a corpus by text query */
  async search(
    corpusId: string,
    query: string,
    topK?: number,
  ): Promise<CorpusScoredDocument[]> {
    const corpus = this.corpora.get(corpusId)
    if (!corpus) throw new CorpusNotFoundError(corpusId)

    const collectionName = this.collectionName(corpusId, corpus.config)
    const results = await this.semanticStore.search(
      collectionName,
      query,
      topK ?? 10,
    )

    return results.map((r) => ({
      id: r.id,
      text: r.text,
      score: r.score,
      metadata: r.metadata,
    }))
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private collectionName(corpusId: string, config?: CorpusConfig): string {
    const prefix = config?.collectionPrefix
    return prefix ? `${prefix}${corpusId}` : `corpus_${corpusId}`
  }

  private chunkKey(corpusId: string, sourceId: string): string {
    return `${corpusId}::${sourceId}`
  }
}
