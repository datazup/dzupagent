/**
 * RagPipeline — Top-level orchestrator wiring chunking, embedding,
 * vector storage, retrieval, and context assembly.
 *
 * This class provides the main entry points for RAG operations:
 * - `ingest()` — chunk text, embed, and store in vector DB
 * - `retrieve()` — search for relevant chunks
 * - `assembleContext()` — retrieve + assemble into LLM-ready context
 */

import type {
  EmbeddingProvider,
  VectorStore,
  VectorEntry,
  MetadataFilter,
} from '@dzipagent/core'

import { SmartChunker } from './chunker.js'
import { HybridRetriever } from './retriever.js'
import type { HybridRetrieverConfig } from './retriever.js'
import { ContextAssembler } from './assembler.js'
import type {
  RagPipelineConfig,
  IngestOptions,
  IngestResult,
  RetrievalConfig,
  RetrievalResult,
  AssembledContext,
  SourceMeta,
  AssemblyOptions,
} from './types.js'

// ---------------------------------------------------------------------------
// Default Pipeline Config
// ---------------------------------------------------------------------------

/** Default pipeline configuration */
export const DEFAULT_PIPELINE_CONFIG: RagPipelineConfig = {
  chunking: {
    targetTokens: 1200,
    overlapFraction: 0.15,
    respectBoundaries: true,
  },
  embedding: {
    provider: 'openai',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    batchSize: 100,
  },
  vectorStore: {
    adapter: 'inmemory',
    collectionPrefix: 'rag_',
  },
  retrieval: {
    mode: 'hybrid',
    topK: 10,
    qualityBoosting: true,
    qualityWeights: { chunk: 0.6, source: 0.4 },
    tokenBudget: 8000,
    reranker: 'none',
  },
}

// ---------------------------------------------------------------------------
// Pipeline Dependencies (injected)
// ---------------------------------------------------------------------------

/** External dependencies injected into the pipeline */
export interface RagPipelineDeps {
  /** Embedding provider from @dzipagent/core */
  embeddingProvider: EmbeddingProvider
  /** Vector store adapter from @dzipagent/core */
  vectorStore: VectorStore
  /** Optional keyword search function for hybrid mode */
  keywordSearch?: (
    query: string,
    filter: Record<string, unknown>,
    limit: number,
  ) => Promise<Array<{ id: string; score: number; text: string; metadata: Record<string, unknown> }>>
}

// ---------------------------------------------------------------------------
// RagPipeline
// ---------------------------------------------------------------------------

/**
 * Main RAG pipeline orchestrator.
 *
 * Wires together a SmartChunker, EmbeddingProvider, VectorStore,
 * HybridRetriever, and ContextAssembler into a cohesive pipeline.
 */
export class RagPipeline {
  private readonly config: RagPipelineConfig
  private readonly deps: RagPipelineDeps
  private readonly chunker: SmartChunker
  private readonly assembler: ContextAssembler
  private readonly retrievers = new Map<string, HybridRetriever>()

  constructor(config: Partial<RagPipelineConfig>, deps: RagPipelineDeps) {
    this.config = {
      chunking: { ...DEFAULT_PIPELINE_CONFIG.chunking, ...config.chunking },
      embedding: { ...DEFAULT_PIPELINE_CONFIG.embedding, ...config.embedding },
      vectorStore: { ...DEFAULT_PIPELINE_CONFIG.vectorStore, ...config.vectorStore },
      retrieval: { ...DEFAULT_PIPELINE_CONFIG.retrieval, ...config.retrieval },
    }
    this.deps = deps
    this.chunker = new SmartChunker(this.config.chunking)
    this.assembler = new ContextAssembler()
  }

  /**
   * Ingest a text document: chunk, embed, and store vectors.
   *
   * @param text - Raw text content to ingest
   * @param options - Ingest options (sourceId, sessionId, tenantId, etc.)
   * @returns IngestResult with chunk details and timing
   */
  async ingest(text: string, options: IngestOptions): Promise<IngestResult> {
    const chunkingConfig = options.chunkingOverrides
      ? { ...this.config.chunking, ...options.chunkingOverrides }
      : this.config.chunking

    // Use a per-call chunker if overrides are provided
    const chunker = options.chunkingOverrides
      ? new SmartChunker(chunkingConfig)
      : this.chunker

    // Step 1: Chunk
    const chunks = chunker.chunkText(text, options.sourceId)

    if (chunks.length === 0) {
      return {
        chunks: [],
        totalChunks: 0,
        totalTokens: 0,
        embeddingTimeMs: 0,
        storageTimeMs: 0,
      }
    }

    const totalTokens = chunks.reduce((sum, c) => sum + c.tokenCount, 0)

    // Step 2: Embed (if autoEmbed is not explicitly false)
    let embeddingTimeMs = 0
    let storageTimeMs = 0
    const autoEmbed = options.autoEmbed !== false

    if (autoEmbed) {
      const embeddingStart = Date.now()
      const texts = chunks.map(c => c.text)
      const embeddings = await this.batchEmbed(texts)
      embeddingTimeMs = Date.now() - embeddingStart

      // Step 3: Store in vector DB
      const storageStart = Date.now()
      const collectionName = this.getCollectionName(options.tenantId)

      const entries: VectorEntry[] = chunks.map((chunk, i) => ({
        id: chunk.id,
        vector: embeddings[i]!,
        text: chunk.text,
        metadata: {
          source_id: options.sourceId,
          session_id: options.sessionId,
          chunk_index: chunk.metadata.chunkIndex,
          quality_score: chunk.quality,
          token_count: chunk.tokenCount,
          ...options.metadata,
        },
      }))

      await this.deps.vectorStore.upsert(collectionName, entries)
      storageTimeMs = Date.now() - storageStart
    }

    return {
      chunks,
      totalChunks: chunks.length,
      totalTokens,
      embeddingTimeMs,
      storageTimeMs,
    }
  }

  /**
   * Retrieve relevant chunks for a query.
   *
   * @param query - Natural language query
   * @param options - Retrieval options including session/tenant scope
   * @returns RetrievalResult with scored chunks
   */
  async retrieve(
    query: string,
    options: { sessionId: string; tenantId: string } & Partial<RetrievalConfig>,
  ): Promise<RetrievalResult> {
    const retriever = this.getRetriever(options.tenantId)

    const filter: Record<string, unknown> = {
      session_id: options.sessionId,
    }

    return retriever.retrieve(query, filter, options)
  }

  /**
   * Retrieve chunks and assemble them into LLM-ready context.
   *
   * @param query - Natural language query
   * @param options - Options including session/tenant scope, token budget, and source metadata
   * @returns AssembledContext with system prompt, citations, and token breakdown
   */
  async assembleContext(
    query: string,
    options: {
      sessionId: string
      tenantId: string
      maxTokens?: number
      sourceMetadata?: Map<string, SourceMeta>
      assemblyOptions?: Partial<AssemblyOptions>
    },
  ): Promise<AssembledContext> {
    const retrievalResult = await this.retrieve(query, {
      sessionId: options.sessionId,
      tenantId: options.tenantId,
      tokenBudget: options.maxTokens ?? this.config.retrieval.tokenBudget,
    })

    // Build source metadata map — use provided metadata or create defaults
    const sourceMetadata = options.sourceMetadata ?? this.buildDefaultSourceMeta(retrievalResult)

    return this.assembler.assembleContext(
      retrievalResult,
      sourceMetadata,
      {
        tokenBudget: options.maxTokens ?? this.config.retrieval.tokenBudget,
        ...options.assemblyOptions,
      },
    )
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Batch-embed texts using the configured batch size */
  private async batchEmbed(texts: string[]): Promise<number[][]> {
    const batchSize = this.config.embedding.batchSize
    const results: number[][] = []

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize)
      const embeddings = await this.deps.embeddingProvider.embed(batch)
      results.push(...embeddings)
    }

    return results
  }

  /** Get the collection name for a tenant */
  private getCollectionName(tenantId: string): string {
    return `${this.config.vectorStore.collectionPrefix}${tenantId}`
  }

  /** Dispose a single tenant retriever instance (if present). */
  disposeTenant(tenantId: string): void {
    this.retrievers.delete(tenantId)
  }

  /** Dispose all cached retriever instances. */
  disposeAll(): void {
    this.retrievers.clear()
  }

  /** Lazily create or return the tenant-specific HybridRetriever */
  private getRetriever(tenantId: string): HybridRetriever {
    const existing = this.retrievers.get(tenantId)
    if (existing) return existing

    const collectionName = this.getCollectionName(tenantId)

    const retrieverConfig: HybridRetrieverConfig = {
      ...this.config.retrieval,
      embedQuery: (text: string) => this.deps.embeddingProvider.embedQuery(text),
      vectorSearch: async (queryVector, filter, limit, minScore) => {
        const metadataFilter = this.buildMetadataFilter(filter)
        const results = await this.deps.vectorStore.search(collectionName, {
          vector: queryVector,
          limit,
          filter: metadataFilter,
          minScore,
        })
        return results.map(r => ({
          id: r.id,
          score: r.score,
          text: r.text ?? '',
          metadata: r.metadata,
        }))
      },
      keywordSearch: this.deps.keywordSearch,
    }

    const retriever = new HybridRetriever(retrieverConfig)
    this.retrievers.set(tenantId, retriever)
    return retriever
  }

  /** Convert a flat filter record to the @dzipagent/core MetadataFilter format */
  private buildMetadataFilter(filter: Record<string, unknown>): MetadataFilter | undefined {
    const conditions: MetadataFilter[] = []

    for (const [field, value] of Object.entries(filter)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        conditions.push({ field, op: 'eq', value })
      }
    }

    if (conditions.length === 0) return undefined
    if (conditions.length === 1) return conditions[0]
    return { and: conditions }
  }

  /** Build default source metadata from retrieval results */
  private buildDefaultSourceMeta(result: RetrievalResult): Map<string, SourceMeta> {
    const map = new Map<string, SourceMeta>()

    for (const chunk of result.chunks) {
      if (!map.has(chunk.sourceId)) {
        map.set(chunk.sourceId, {
          sourceId: chunk.sourceId,
          title: chunk.sourceTitle ?? 'Unknown',
          url: chunk.sourceUrl,
          contextMode: 'full',
        })
      }
    }

    return map
  }
}
