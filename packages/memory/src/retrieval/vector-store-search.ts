/**
 * VectorSearchProvider backed by a SemanticStoreAdapter instead of LangGraph BaseStore.
 *
 * Plugs into AdaptiveRetriever as the 'vector' provider, delegating to
 * a text-oriented semantic store for similarity search. This avoids
 * coupling to BaseStore's limited search API.
 */

import type { VectorSearchResult, VectorSearchProvider } from './vector-search.js'
import type { SemanticStoreAdapter } from '../memory-types.js'

/**
 * VectorSearchProvider backed by a SemanticStoreAdapter.
 *
 * Maps namespace arrays to collection names and delegates search
 * to the semantic store. Results are converted to the standard
 * VectorSearchResult shape expected by AdaptiveRetriever.
 *
 * @example
 * ```ts
 * const provider = new VectorStoreSearch(semanticStore)
 * const retriever = new AdaptiveRetriever({
 *   providers: { vector: provider },
 * })
 * ```
 */
export class VectorStoreSearch implements VectorSearchProvider {
  constructor(
    private readonly semanticStore: SemanticStoreAdapter,
    private readonly collectionPrefix?: string,
  ) {}

  async search(
    namespace: string[],
    query: string,
    limit: number,
  ): Promise<VectorSearchResult[]> {
    const collectionName = this.collectionPrefix
      ? `${this.collectionPrefix}${namespace.join('_')}`
      : `memory_${namespace.join('_')}`

    const results = await this.semanticStore.search(collectionName, query, limit)
    return results.map(r => ({
      key: r.id,
      score: r.score,
      value: r.metadata,
    }))
  }
}
