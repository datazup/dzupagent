/**
 * Corpus lifecycle types — manage named document corpora over a VectorStore.
 *
 * A Corpus is a logical grouping of ingested sources. Each source is chunked,
 * embedded, and stored in a dedicated vector collection. Sources can be
 * individually invalidated and re-ingested without affecting the rest.
 */

/** A named corpus of documents backed by a vector collection */
export interface Corpus {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date
  config?: CorpusConfig
}

/** Configuration for a corpus */
export interface CorpusConfig {
  /** Prefix for collection names (default: `corpus_${id}`) */
  collectionPrefix?: string
  /** Chunking overrides for this corpus */
  chunkingConfig?: { targetTokens?: number; overlapFraction?: number }
}

/** A source document to ingest into a corpus */
export interface CorpusSource {
  /** Caller-provided, stable identifier */
  id: string
  /** Raw document text */
  text: string
  /** Optional metadata attached to all chunks from this source */
  metadata?: Record<string, unknown>
}

/** Result of ingesting a single source into a corpus */
export interface IngestJobResult {
  corpusId: string
  sourceId: string
  chunksCreated: number
  /** Non-zero when replacing a previously ingested source */
  chunksReplaced: number
}

/** Aggregate statistics for a corpus */
export interface CorpusStats {
  corpusId: string
  totalSources: number
  totalChunks: number
  collections: string[]
}

/** Scored document returned from corpus search */
export interface CorpusScoredDocument {
  id: string
  text: string
  score: number
  metadata: Record<string, unknown>
}

/** Thrown when a corpus ID is not found */
export class CorpusNotFoundError extends Error {
  constructor(corpusId: string) {
    super(`Corpus not found: ${corpusId}`)
    this.name = 'CorpusNotFoundError'
  }
}

/** Thrown when a source ID is not found within a corpus */
export class SourceNotFoundError extends Error {
  constructor(sourceId: string) {
    super(`Source not found: ${sourceId}`)
    this.name = 'SourceNotFoundError'
  }
}
