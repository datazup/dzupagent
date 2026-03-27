/**
 * Semantic capability search — ECO-050.
 *
 * Provides a SemanticSearchProvider interface and a keyword-fallback
 * implementation using TF-IDF-style scoring over capability descriptions.
 */

import type { RegisteredAgent } from './types.js'

// ------------------------------------------------------------------ Interface

/**
 * Provider for semantic search over agent capabilities.
 *
 * Implementations may use vector embeddings (e.g., via OpenAI/Cohere)
 * or fall back to keyword-based scoring.
 */
export interface SemanticSearchProvider {
  /** Embed a query string into a numeric vector. */
  embedQuery(text: string): Promise<number[]>

  /** Search for agents whose capabilities match the embedding, returning scored results. */
  search(embedding: number[], limit: number): Promise<Array<{ agentId: string; score: number }>>

  /**
   * Index an agent's capabilities for later search.
   * Must be called whenever an agent is registered or updated.
   */
  indexAgent(agent: RegisteredAgent): void

  /** Remove an agent from the index. */
  removeAgent(agentId: string): void
}

// ------------------------------------------------------------------ TF-IDF helpers

/** Tokenize text into lowercase terms. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1)
}

/**
 * Calculate inverse document frequency with smoothing.
 * Uses IDF = log(1 + N / (1 + df)) to avoid zero when all docs match.
 */
function idf(term: string, documents: Map<string, string[]>): number {
  let count = 0
  for (const tokens of documents.values()) {
    if (tokens.includes(term)) count++
  }
  return Math.log(1 + documents.size / (1 + count))
}

/** Calculate TF-IDF score between a query and a document's tokens. */
function tfidfScore(
  queryTokens: string[],
  docTokens: string[],
  allDocuments: Map<string, string[]>,
): number {
  if (docTokens.length === 0 || queryTokens.length === 0) return 0
  let score = 0
  for (const qt of queryTokens) {
    // Term frequency in document
    const tf = docTokens.filter((t) => t === qt).length / docTokens.length
    if (tf > 0) {
      const idfVal = idf(qt, allDocuments)
      score += tf * idfVal
    }
  }
  return score
}

// ------------------------------------------------------------------ Implementation

/**
 * Keyword-based fallback search using TF-IDF scoring.
 *
 * Indexes agent capabilities (name + description + tags) and scores
 * queries against them. Does not require any embedding model.
 */
export class KeywordFallbackSearch implements SemanticSearchProvider {
  /** agentId -> tokenized capability text */
  private readonly _documents = new Map<string, string[]>()

  /** agentId -> raw text (for re-tokenizing on search if needed) */
  private readonly _rawText = new Map<string, string>()

  indexAgent(agent: RegisteredAgent): void {
    const parts: string[] = [agent.name, agent.description]
    for (const cap of agent.capabilities) {
      parts.push(cap.name)
      if (cap.description) parts.push(cap.description)
      if (cap.tags) parts.push(...cap.tags)
    }
    const text = parts.join(' ')
    this._rawText.set(agent.id, text)
    this._documents.set(agent.id, tokenize(text))
  }

  removeAgent(agentId: string): void {
    this._documents.delete(agentId)
    this._rawText.delete(agentId)
  }

  /**
   * "Embed" a query by tokenizing it.
   * Returns token character codes as a numeric array (for interface compat).
   * The actual scoring is done in `search()` using the raw query.
   */
  async embedQuery(text: string): Promise<number[]> {
    // Store the query text as char codes so it can be reconstructed in search()
    return Array.from(new TextEncoder().encode(text))
  }

  async search(
    embedding: number[],
    limit: number,
  ): Promise<Array<{ agentId: string; score: number }>> {
    // Reconstruct the query text from the "embedding"
    const queryText = new TextDecoder().decode(new Uint8Array(embedding))
    const queryTokens = tokenize(queryText)

    if (queryTokens.length === 0) return []

    const results: Array<{ agentId: string; score: number }> = []

    for (const [agentId, docTokens] of this._documents) {
      const score = tfidfScore(queryTokens, docTokens, this._documents)
      if (score > 0) {
        results.push({ agentId, score })
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }
}

/**
 * Create a keyword-based fallback search provider.
 * Use this when no vector embedding service is available.
 */
export function createKeywordFallbackSearch(): SemanticSearchProvider {
  return new KeywordFallbackSearch()
}
