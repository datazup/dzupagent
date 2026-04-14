/**
 * @dzupagent/rag — Type definitions for the RAG pipeline.
 *
 * All interfaces used across chunking, retrieval, assembly, and the
 * top-level pipeline orchestrator.
 */

// ---------------------------------------------------------------------------
// Search & Context Modes
// ---------------------------------------------------------------------------

/** Vector-only, keyword-only, or hybrid (RRF) search */
export type SearchMode = 'vector' | 'keyword' | 'hybrid'

/** Per-source context inclusion mode */
export type ContextMode = 'off' | 'insights' | 'full'

// ---------------------------------------------------------------------------
// Pipeline Configuration
// ---------------------------------------------------------------------------

/** Top-level configuration for the full RAG pipeline */
export interface RagPipelineConfig {
  chunking: ChunkingConfig
  embedding: EmbeddingConfig
  vectorStore: VectorStoreConfig
  retrieval: RetrievalConfig
}

/** Configuration for text chunking */
export interface ChunkingConfig {
  /** Target tokens per chunk (default 1200) */
  targetTokens: number
  /** Overlap fraction between adjacent chunks (default 0.15) */
  overlapFraction: number
  /** Respect markdown headers and paragraph boundaries (default true) */
  respectBoundaries: boolean
}

/** Configuration for the embedding provider */
export interface EmbeddingConfig {
  /** Provider name: 'openai', 'voyage', 'cohere', 'ollama', 'custom' */
  provider: string
  /** Model identifier, e.g. 'text-embedding-3-small' */
  model: string
  /** Vector dimensionality, e.g. 1536 */
  dimensions: number
  /** Batch size for embedding requests (default 100) */
  batchSize: number
}

/** Configuration for the vector store adapter */
export interface VectorStoreConfig {
  /** Adapter name: 'qdrant', 'pgvector', 'chroma', 'pinecone', 'inmemory', etc. */
  adapter: string
  /** Prefix for tenant-scoped collection names, e.g. 'tenant_' */
  collectionPrefix: string
  /** Additional adapter-specific configuration */
  [key: string]: unknown
}

/** Configuration for the retrieval stage */
export interface RetrievalConfig {
  /** Search mode: vector, keyword, or hybrid */
  mode: SearchMode
  /** Maximum results to retrieve (default 10) */
  topK: number
  /** Enable quality-boosted scoring (default true) */
  qualityBoosting: boolean
  /** Weights for chunk vs source quality (default { chunk: 0.6, source: 0.4 }) */
  qualityWeights: { chunk: number; source: number }
  /** Maximum token budget for assembled context */
  tokenBudget: number
  /** Optional reranker strategy */
  reranker?: 'cross-encoder' | 'none'
}

// ---------------------------------------------------------------------------
// Chunk Types
// ---------------------------------------------------------------------------

/** Result of chunking a single text document */
export interface ChunkResult {
  /** Unique chunk identifier */
  id: string
  /** The chunk text content */
  text: string
  /** Estimated token count */
  tokenCount: number
  /** Quality score from 0 to 1 */
  quality: number
  /** Positional and source metadata */
  metadata: ChunkMetadata
}

/** Metadata attached to each chunk */
export interface ChunkMetadata {
  /** ID of the source document */
  sourceId: string
  /** 0-based index within the source */
  chunkIndex: number
  /** Character offset of the chunk start in the original text */
  startOffset: number
  /** Character offset of the chunk end in the original text */
  endOffset: number
  /** Type of boundary used to split at this point */
  boundaryType: 'header' | 'paragraph' | 'sentence' | 'token'
}

// ---------------------------------------------------------------------------
// Retrieval Types
// ---------------------------------------------------------------------------

/** Result returned by the retriever */
export interface RetrievalResult {
  /** Scored and ranked chunks */
  chunks: ScoredChunk[]
  /** Total tokens across all returned chunks */
  totalTokens: number
  /** Search mode that was used */
  searchMode: SearchMode
  /** Wall-clock time of the search in ms */
  queryTimeMs: number
}

/** A chunk with relevance scores */
export interface ScoredChunk {
  /** Chunk identifier */
  id: string
  /** Chunk text */
  text: string
  /** Combined relevance score */
  score: number
  /** Raw vector similarity score (if vector search was used) */
  vectorScore?: number
  /** Keyword/FTS rank score (if keyword search was used) */
  keywordScore?: number
  /** Quality adjustment score */
  qualityScore?: number
  /** Source document ID */
  sourceId: string
  /** Source document title */
  sourceTitle?: string
  /** Source document URL */
  sourceUrl?: string
  /** Source-level quality score (0-1) when available */
  sourceQuality?: number
  /** 0-based chunk index within the source */
  chunkIndex: number
}

// ---------------------------------------------------------------------------
// Assembly Types
// ---------------------------------------------------------------------------

/** Fully assembled context ready for LLM consumption */
export interface AssembledContext {
  /** System prompt incorporating source citations */
  systemPrompt: string
  /** Concatenated context text */
  contextText: string
  /** Citation references */
  citations: CitationResult[]
  /** Total tokens used by the assembled context */
  totalTokens: number
  /** Per-source breakdown of token usage */
  sourceBreakdown: SourceContextBreakdown[]
}

/** A single citation reference */
export interface CitationResult {
  /** Source document ID */
  sourceId: string
  /** Source document title */
  sourceTitle: string
  /** Source document URL */
  sourceUrl?: string
  /** Chunk index within the source */
  chunkIndex: number
  /** Relevance score */
  score: number
  /** Short text snippet for display */
  snippet: string
}

/** Per-source context usage breakdown */
export interface SourceContextBreakdown {
  /** Source document ID */
  sourceId: string
  /** Source document title */
  sourceTitle: string
  /** Context mode applied to this source */
  mode: ContextMode
  /** Tokens consumed by this source */
  tokenCount: number
  /** Number of chunks included from this source */
  chunkCount: number
}

// ---------------------------------------------------------------------------
// Quality Types
// ---------------------------------------------------------------------------

/** Detailed quality metrics for a text chunk */
export interface QualityMetrics {
  /** Ratio of unique words to total words */
  vocabularyDiversity: number
  /** Average number of words per sentence */
  avgSentenceLength: number
  /** Ratio of non-whitespace to total characters */
  textToNoiseRatio: number
  /** Score based on structural elements (headers, lists, etc.) */
  structureScore: number
  /** Weighted composite score (0-1) */
  overallScore: number
}

// ---------------------------------------------------------------------------
// Ingestion Types
// ---------------------------------------------------------------------------

/** Options for the ingest pipeline */
export interface IngestOptions {
  /** Source document ID */
  sourceId: string
  /** Session scope */
  sessionId: string
  /** Tenant scope */
  tenantId: string
  /** Automatically embed chunks after chunking (default true) */
  autoEmbed?: boolean
  /** Automatically generate a summary (default false) */
  autoSummarize?: boolean
  /** Override default chunking config for this ingest */
  chunkingOverrides?: Partial<ChunkingConfig>
  /** Additional metadata to attach to all chunks */
  metadata?: Record<string, unknown>
}

/** Result of an ingest operation */
export interface IngestResult {
  /** All produced chunks */
  chunks: ChunkResult[]
  /** Total number of chunks */
  totalChunks: number
  /** Total tokens across all chunks */
  totalTokens: number
  /** Time spent generating embeddings (ms) */
  embeddingTimeMs: number
  /** Time spent writing to vector store (ms) */
  storageTimeMs: number
}

// ---------------------------------------------------------------------------
// Function Signatures (for dependency injection)
// ---------------------------------------------------------------------------

/** Vector search function injected into the retriever */
export type VectorSearchFn = (
  query: number[],
  filter: Record<string, unknown>,
  limit: number,
  minScore?: number,
) => Promise<VectorSearchHit[]>

/** Keyword search function injected into the retriever */
export type KeywordSearchFn = (
  query: string,
  filter: Record<string, unknown>,
  limit: number,
) => Promise<KeywordSearchHit[]>

/** Raw hit from vector search */
export interface VectorSearchHit {
  id: string
  score: number
  text: string
  metadata: Record<string, unknown>
}

/** Raw hit from keyword search */
export interface KeywordSearchHit {
  id: string
  score: number
  text: string
  metadata: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Assembly Options
// ---------------------------------------------------------------------------

/** Source metadata for the assembler */
export interface SourceMeta {
  sourceId: string
  title: string
  url?: string
  contextMode: ContextMode
  summary?: string
}

/** Options for the context assembly step */
export interface AssemblyOptions {
  /** Maximum total tokens for assembled context */
  tokenBudget: number
  /** Template for grounded prompt (use {{source_context}} placeholder) */
  groundedTemplate?: string
  /** Template for extended prompt (use {{source_context}} placeholder) */
  extendedTemplate?: string
  /** Snippet length for citations */
  snippetLength?: number
}
