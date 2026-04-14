/**
 * HybridRetriever — Vector + keyword search with RRF fusion and quality boosting.
 *
 * Ported from research-app's rag-retrieval.ts, decoupled from Prisma/Qdrant
 * to accept injected search functions via constructor config.
 */

import type {
  RetrievalConfig,
  RetrievalResult,
  ScoredChunk,
  VectorSearchFn,
  KeywordSearchFn,
  VectorSearchHit,
  KeywordSearchHit,
} from './types.js'

/** Conservative token estimate: 4 chars per token (ceiling). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ---------------------------------------------------------------------------
// Source Quality Strategy
// ---------------------------------------------------------------------------

export interface SourceQualityContext {
  query: string
  filter: Record<string, unknown>
  mode: RetrievalConfig['mode']
  topK: number
  chunk: ScoredChunk
}

export type SourceQualityProvider =
  (context: SourceQualityContext) => number | Promise<number>

export interface SourceQualityStrategyConfig {
  /**
   * Optional provider used to derive source quality from the chunk plus
   * retrieval context. When omitted, the retriever falls back to the chunk's
   * normalized `sourceQuality` field and then `0.5`.
   */
  provider?: SourceQualityProvider
  /**
   * Fallback value used when neither the provider nor chunk-level source
   * quality is available. Defaults to `0.5`.
   */
  fallback?: number
}

// ---------------------------------------------------------------------------
// Default Config
// ---------------------------------------------------------------------------

/** Default retrieval configuration */
export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  mode: 'hybrid',
  topK: 10,
  qualityBoosting: true,
  qualityWeights: { chunk: 0.6, source: 0.4 },
  tokenBudget: 8000,
  reranker: 'none',
}

// ---------------------------------------------------------------------------
// Retriever Config
// ---------------------------------------------------------------------------

/** Configuration for the HybridRetriever including injected search functions */
export interface HybridRetrieverConfig extends RetrievalConfig {
  /** Vector similarity search function (required for vector/hybrid modes) */
  vectorSearch: VectorSearchFn
  /** Keyword/FTS search function (required for keyword/hybrid modes) */
  keywordSearch?: KeywordSearchFn
  /** Embedding function to convert query text to a vector */
  embedQuery: (text: string) => Promise<number[]>
  /** Optional source-quality strategy used during quality boosting */
  sourceQuality?: SourceQualityStrategyConfig
}

// ---------------------------------------------------------------------------
// HybridRetriever
// ---------------------------------------------------------------------------

/**
 * Retriever supporting vector, keyword, and hybrid (RRF) search modes.
 *
 * Quality boosting adjusts raw similarity scores based on chunk and source
 * quality metadata, applying a +/- 15% adjustment range.
 *
 * For hybrid mode, Reciprocal Rank Fusion (k=60) is used to merge results
 * from both search channels.
 */
export class HybridRetriever {
  private readonly config: HybridRetrieverConfig

  constructor(config: HybridRetrieverConfig) {
    this.config = { ...DEFAULT_RETRIEVAL_CONFIG, ...config }
  }

  /**
   * Execute a retrieval query.
   *
   * @param query - Natural language query
   * @param filter - Metadata filter passed to search functions (e.g. sessionId, tenantId)
   * @param options - Per-query overrides for retrieval config
   * @returns Scored, ranked chunks within the token budget
   */
  async retrieve(
    query: string,
    filter: Record<string, unknown>,
    options?: Partial<RetrievalConfig>,
  ): Promise<RetrievalResult> {
    const startTime = Date.now()

    const mode = options?.mode ?? this.config.mode
    const topK = Math.min(Math.max(1, options?.topK ?? this.config.topK), 100)
    const qualityBoosting = options?.qualityBoosting ?? this.config.qualityBoosting
    const tokenBudget = options?.tokenBudget ?? this.config.tokenBudget

    let chunks: ScoredChunk[]

    if (mode === 'vector') {
      chunks = await this.vectorSearch(query, filter, topK)
    } else if (mode === 'keyword') {
      chunks = await this.keywordSearch(query, filter, topK)
    } else {
      chunks = await this.hybridSearch(query, filter, topK)
    }

    // Apply quality boosting
    if (qualityBoosting) {
      chunks = await this.applyQualityBoosting(chunks, {
        query,
        filter,
        mode,
        topK,
      })
    }

    // Sort by final score descending
    chunks.sort((a, b) => b.score - a.score)

    // Apply token budget
    chunks = this.applyTokenBudget(chunks, tokenBudget)

    const totalTokens = chunks.reduce((sum, c) => sum + estimateTokens(c.text), 0)
    const queryTimeMs = Date.now() - startTime

    return {
      chunks,
      totalTokens,
      searchMode: mode,
      queryTimeMs,
    }
  }

  // -------------------------------------------------------------------------
  // Search Methods
  // -------------------------------------------------------------------------

  private async vectorSearch(
    query: string,
    filter: Record<string, unknown>,
    limit: number,
  ): Promise<ScoredChunk[]> {
    const embedding = await this.config.embedQuery(query)
    const hits = await this.config.vectorSearch(embedding, filter, limit)
    return hits.map(hit => this.vectorHitToChunk(hit))
  }

  private async keywordSearch(
    query: string,
    filter: Record<string, unknown>,
    limit: number,
  ): Promise<ScoredChunk[]> {
    if (!this.config.keywordSearch) return []
    const hits = await this.config.keywordSearch(query, filter, limit)
    return hits.map(hit => this.keywordHitToChunk(hit))
  }

  private async hybridSearch(
    query: string,
    filter: Record<string, unknown>,
    limit: number,
  ): Promise<ScoredChunk[]> {
    const [vectorResults, keywordResults] = await Promise.all([
      this.vectorSearch(query, filter, limit),
      this.keywordSearch(query, filter, limit),
    ])

    return this.reciprocalRankFusion(vectorResults, keywordResults, limit)
  }

  // -------------------------------------------------------------------------
  // Reciprocal Rank Fusion
  // -------------------------------------------------------------------------

  /**
   * Merge vector and keyword results using RRF with k=60.
   *
   * For each result set, the RRF score is `1 / (k + rank + 1)`.
   * When a chunk appears in both sets, scores are summed.
   */
  private reciprocalRankFusion(
    vectorResults: ScoredChunk[],
    keywordResults: ScoredChunk[],
    limit: number,
    k = 60,
  ): ScoredChunk[] {
    const rrfMap = new Map<string, { score: number; chunk: ScoredChunk }>()

    vectorResults.forEach((chunk, rank) => {
      const rrfScore = 1 / (k + rank + 1)
      rrfMap.set(chunk.id, {
        score: rrfScore,
        chunk: { ...chunk, vectorScore: chunk.score },
      })
    })

    keywordResults.forEach((chunk, rank) => {
      const rrfScore = 1 / (k + rank + 1)
      const existing = rrfMap.get(chunk.id)
      if (existing) {
        existing.score += rrfScore
        existing.chunk.keywordScore = chunk.score
      } else {
        rrfMap.set(chunk.id, {
          score: rrfScore,
          chunk: { ...chunk, keywordScore: chunk.score },
        })
      }
    })

    return Array.from(rrfMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(entry => ({ ...entry.chunk, score: entry.score }))
  }

  // -------------------------------------------------------------------------
  // Quality Boosting
  // -------------------------------------------------------------------------

  /**
   * Adjust scores based on quality metadata.
   *
   * The quality score is a weighted blend of chunk quality (default 0.6)
   * and source quality (default 0.4). The boost factor is +/- 15% max.
   */
  private async applyQualityBoosting(
    chunks: ScoredChunk[],
    context: Omit<SourceQualityContext, 'chunk'>,
  ): Promise<ScoredChunk[]> {
    const weights = this.config.qualityWeights

    return Promise.all(chunks.map(async (chunk) => {
      const chunkQuality = (chunk.qualityScore ?? 0.5)
      const sourceQuality = await this.resolveSourceQuality(chunk, context)
      const blended = chunkQuality * weights.chunk + sourceQuality * weights.source
      // +/- 15% max adjustment around quality midpoint (0.5)
      const boost = 1 + (blended - 0.5) * 0.3

      return {
        ...chunk,
        score: chunk.score * boost,
        qualityScore: blended,
      }
    }))
  }

  /**
   * Resolve source quality using the configured strategy.
   *
   * Resolution order:
   * 1. Configured provider, if present and returns a finite number.
   *    Provider failures are ignored and treated as a miss.
   * 2. Chunk-level `sourceQuality`, which is the normalized default path.
   * 3. Configured fallback, or `0.5` when no fallback is configured.
   */
  private async resolveSourceQuality(
    chunk: ScoredChunk,
    context: Omit<SourceQualityContext, 'chunk'>,
  ): Promise<number> {
    const strategy = this.config.sourceQuality

    if (strategy?.provider) {
      try {
        const resolved = await strategy.provider({ ...context, chunk })
        const normalized = this.normalizeQuality(resolved)
        if (normalized !== undefined) return normalized
      } catch {
        // Provider errors should not fail retrieval; fall through to chunk/fallback.
      }
    }

    const direct = this.normalizeQuality(chunk.sourceQuality)
    if (direct !== undefined) return direct

    const fallback = this.normalizeQuality(strategy?.fallback)
    return fallback ?? 0.5
  }

  private normalizeQuality(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return undefined
    }
    return Math.max(0, Math.min(1, value))
  }

  // -------------------------------------------------------------------------
  // Token Budget
  // -------------------------------------------------------------------------

  /**
   * Enforce token budget by greedily including top-scored chunks
   * until the budget is exhausted.
   */
  private applyTokenBudget(chunks: ScoredChunk[], budget: number): ScoredChunk[] {
    if (budget <= 0) return chunks

    let totalTokens = 0
    const result: ScoredChunk[] = []

    for (const chunk of chunks) {
      const tokens = estimateTokens(chunk.text)
      if (totalTokens + tokens > budget && result.length > 0) break
      totalTokens += tokens
      result.push(chunk)
    }

    return result
  }

  // -------------------------------------------------------------------------
  // Hit → ScoredChunk Conversion
  // -------------------------------------------------------------------------

  private vectorHitToChunk(hit: VectorSearchHit): ScoredChunk {
    const sourceQuality = this.parseSourceQuality(hit.metadata)
    const qualityScore = hit.metadata['quality_score'] as number | undefined
    const sourceTitle = hit.metadata['source_title'] as string | undefined
    const sourceUrl = hit.metadata['source_url'] as string | undefined
    return {
      id: hit.id,
      text: hit.text,
      score: hit.score,
      vectorScore: hit.score,
      ...(qualityScore !== undefined ? { qualityScore } : {}),
      sourceId: (hit.metadata['source_id'] as string | undefined) ?? '',
      ...(sourceTitle !== undefined ? { sourceTitle } : {}),
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
      ...(sourceQuality !== undefined ? { sourceQuality } : {}),
      chunkIndex: (hit.metadata['chunk_index'] as number | undefined) ?? 0,
    }
  }

  private keywordHitToChunk(hit: KeywordSearchHit): ScoredChunk {
    const sourceQuality = this.parseSourceQuality(hit.metadata)
    const qualityScore = hit.metadata['quality_score'] as number | undefined
    const sourceTitle = hit.metadata['source_title'] as string | undefined
    const sourceUrl = hit.metadata['source_url'] as string | undefined
    return {
      id: hit.id,
      text: hit.text,
      score: hit.score,
      keywordScore: hit.score,
      ...(qualityScore !== undefined ? { qualityScore } : {}),
      sourceId: (hit.metadata['source_id'] as string | undefined) ?? '',
      ...(sourceTitle !== undefined ? { sourceTitle } : {}),
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
      ...(sourceQuality !== undefined ? { sourceQuality } : {}),
      chunkIndex: (hit.metadata['chunk_index'] as number | undefined) ?? 0,
    }
  }

  private parseSourceQuality(metadata: Record<string, unknown>): number | undefined {
    const candidates = [
      metadata['source_quality'],
      metadata['sourceQuality'],
      metadata['domain_authority'],
    ]
    for (const value of candidates) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.min(1, value))
      }
      if (typeof value === 'string') {
        const parsed = Number(value)
        if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
          return Math.max(0, Math.min(1, parsed))
        }
      }
    }
    return undefined
  }
}
