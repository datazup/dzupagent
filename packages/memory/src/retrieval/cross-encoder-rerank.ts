/**
 * Cross-encoder reranking for retrieval results.
 *
 * After initial retrieval (vector + FTS + graph via RRF fusion), rerank the
 * top-K results using a cross-encoder model that scores query-document pairs
 * jointly. Cross-encoders are more accurate than bi-encoders because they see
 * both query and document simultaneously.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Provider interface for cross-encoder scoring.
 * Implementations can use local models (Transformers.js), APIs (Cohere, Jina),
 * or custom endpoints.
 */
export interface CrossEncoderProvider {
  /** Score query-document pairs. Returns scores in the same order as documents. Higher = more relevant. */
  score(query: string, documents: string[]): Promise<number[]>;
}

export interface RerankerConfig {
  /** Number of candidates to fetch from base retriever for reranking (default: 20) */
  rerankTopK?: number | undefined;
  /** Number of final results to return after reranking (default: 5) */
  finalTopK?: number | undefined;
  /** Minimum score to include in final results (default: 0 — include all) */
  minScore?: number | undefined;
}

export interface RerankedResult {
  key: string;
  /** Cross-encoder score (higher = more relevant) */
  score: number;
  /** Original pre-reranking score from the base retriever */
  originalScore: number;
  /** Rank change: positive means moved up, negative means moved down */
  rankChange: number;
  value: Record<string, unknown>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface Candidate {
  key: string;
  score: number;
  value: Record<string, unknown>;
}

/** Extract displayable text from a candidate value. */
function extractText(value: Record<string, unknown>): string {
  if (typeof value['text'] === 'string') return value['text'];
  if (typeof value['content'] === 'string') return value['content'];
  return JSON.stringify(value);
}

// ─── Rerank ──────────────────────────────────────────────────────────────────

/**
 * Rerank a set of retrieval results using a cross-encoder.
 *
 * @param query The search query
 * @param candidates Results from the base retriever (pre-reranking)
 * @param provider Cross-encoder scoring provider
 * @param config Reranking parameters
 * @returns Reranked results, sorted by cross-encoder score descending
 */
export async function rerank(
  query: string,
  candidates: Candidate[],
  provider: CrossEncoderProvider,
  config?: RerankerConfig,
): Promise<RerankedResult[]> {
  const rerankTopK = config?.rerankTopK ?? 20;
  const finalTopK = config?.finalTopK ?? 5;
  const minScore = config?.minScore ?? 0;

  if (candidates.length === 0) return [];

  // Take at most rerankTopK candidates
  const pool = candidates.slice(0, rerankTopK);

  // Single candidate — return as-is without calling provider
  if (pool.length === 1) {
    const c = pool[0]!;
    return [{ key: c.key, score: c.score, originalScore: c.score, rankChange: 0, value: c.value }];
  }

  const documentTexts = pool.map((c) => extractText(c.value));

  let scores: number[];
  try {
    scores = await provider.score(query, documentTexts);
  } catch {
    // Non-fatal: return candidates in original order
    return pool.slice(0, finalTopK).map((c) => ({
      key: c.key,
      score: c.score,
      originalScore: c.score,
      rankChange: 0,
      value: c.value,
    }));
  }

  // Provider returned wrong number of scores — fall back to original ordering
  if (scores.length !== pool.length) {
    return pool.slice(0, finalTopK).map((c) => ({
      key: c.key,
      score: c.score,
      originalScore: c.score,
      rankChange: 0,
      value: c.value,
    }));
  }

  // Build scored entries with original rank
  const scored = pool.map((c, originalRank) => ({
    key: c.key,
    ceScore: scores[originalRank]!,
    originalScore: c.score,
    originalRank,
    value: c.value,
  }));

  // Sort by cross-encoder score descending
  scored.sort((a, b) => b.ceScore - a.ceScore);

  // Filter by minScore, take finalTopK, compute rank changes
  const results: RerankedResult[] = [];
  for (let newRank = 0; newRank < scored.length && results.length < finalTopK; newRank++) {
    const entry = scored[newRank]!;
    if (entry.ceScore < minScore) continue;
    results.push({
      key: entry.key,
      score: entry.ceScore,
      originalScore: entry.originalScore,
      rankChange: entry.originalRank - newRank,
      value: entry.value,
    });
  }

  return results;
}

// ─── LLM-based Cross-Encoder ────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You are a relevance scoring engine. Score how relevant each document is to the query. ' +
  'Respond ONLY with a JSON array of numbers (0-10 scale). Example: [8.5, 2.0, 6.3]';

/**
 * Create a simple cross-encoder provider from an LLM model.
 * Uses the LLM to score relevance of each document to the query.
 *
 * NOTE: This is slower and more expensive than a dedicated cross-encoder model.
 * Use only when no local model or API is configured.
 */
export function createLLMReranker(model: BaseChatModel): CrossEncoderProvider {
  return {
    async score(query: string, documents: string[]): Promise<number[]> {
      const docList = documents.map((d, i) => `Document ${i + 1}: ${d}`).join('\n');
      const userPrompt = `Score the relevance of each document to the query on a scale of 0-10.\nQuery: ${query}\n\n${docList}\n\nRespond as JSON array of numbers: [score1, score2, ...]`;

      const response = await model.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(userPrompt),
      ]);

      const text = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);

      // Extract JSON array from response (may include markdown fences)
      const match = text.match(/\[[\d\s,.\-eE]+\]/);
      if (!match) {
        return documents.map(() => 1.0);
      }

      try {
        const parsed: unknown = JSON.parse(match[0]);
        if (!Array.isArray(parsed) || parsed.length !== documents.length) {
          return documents.map(() => 1.0);
        }
        return parsed.map((v) => (typeof v === 'number' ? v : 1.0));
      } catch {
        return documents.map(() => 1.0);
      }
    },
  };
}
