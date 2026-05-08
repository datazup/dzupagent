/**
 * Wires a {@link QdrantVectorStore} into the `VectorSearchFn` /
 * `KeywordSearchFn` shape that `HybridRetriever` already consumes.
 *
 * The function returns `null` (mirroring `loadModule`) when the optional
 * `@qdrant/js-client-rest` peer dep is missing and the caller did not
 * supply a `client` test-seam.
 */

import type {
  KeywordSearchFn,
  KeywordSearchHit,
  VectorSearchFn,
  VectorSearchHit,
} from '../types.js'

import { QdrantVectorStore } from './qdrant-store.js'
import type { QdrantRetrieverConfig } from './qdrant-types.js'

/**
 * Result of {@link createQdrantRetriever}.
 *
 * `embedQuery` is intentionally NOT included — the caller injects an
 * embedder so the framework stays embedding-agnostic.
 */
export interface QdrantRetrieverWiring {
  /** The shared store, exposed so the caller can also `upsert`. */
  store: QdrantVectorStore
  /** Plug into `HybridRetrieverConfig.vectorSearch`. */
  vectorSearch: VectorSearchFn
  /** Plug into `HybridRetrieverConfig.keywordSearch`. */
  keywordSearch: KeywordSearchFn
}

/**
 * Build a {@link QdrantVectorStore} and wrap it in `VectorSearchFn` /
 * `KeywordSearchFn` adapters that match the shape `HybridRetriever`
 * already accepts.
 *
 * Returns `null` (mirroring `loadModule`) when:
 *   - The optional `@qdrant/js-client-rest` peer dep is not installed,
 *     and the caller did not supply a `client` test-seam.
 */
export async function createQdrantRetriever(
  config: QdrantRetrieverConfig,
): Promise<QdrantRetrieverWiring | null> {
  const store = await QdrantVectorStore.tryCreate(config)
  if (!store) return null

  const textField = config.textField ?? 'text'

  const toVectorHit = (
    h: { id: string; score: number; payload: Record<string, unknown> },
  ): VectorSearchHit => {
    const text = pickText(h.payload, textField)
    return {
      id: h.id,
      score: h.score,
      text,
      metadata: h.payload,
    }
  }

  const toKeywordHit = (
    h: { id: string; score: number; payload: Record<string, unknown> },
  ): KeywordSearchHit => {
    const text = pickText(h.payload, textField)
    return {
      id: h.id,
      score: h.score,
      text,
      metadata: h.payload,
    }
  }

  const vectorSearch: VectorSearchFn = async (vector, filter, limit, minScore) => {
    const hits = await store.search(vector, limit, filter)
    const filtered = typeof minScore === 'number' ? hits.filter((h) => h.score >= minScore) : hits
    return filtered.map(toVectorHit)
  }

  const keywordSearch: KeywordSearchFn = async (query, filter, limit) => {
    const hits = await store.keywordSearch(query, limit, filter)
    return hits.map(toKeywordHit)
  }

  return { store, vectorSearch, keywordSearch }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pickText(payload: Record<string, unknown>, key: string): string {
  const v = payload[key]
  return typeof v === 'string' ? v : ''
}
