/**
 * Vector search provider that delegates to a BaseStore-compatible search method.
 */

export interface VectorSearchResult {
  key: string
  score: number
  value: Record<string, unknown>
}

export interface VectorSearchProvider {
  search(namespace: string[], query: string, limit: number): Promise<VectorSearchResult[]>
}

interface StoreSearchable {
  search(
    namespace: string[],
    options?: { query?: string; limit?: number },
  ): Promise<Array<{ key: string; value: Record<string, unknown>; score?: number }>>
}

/**
 * Default vector search that delegates to BaseStore.search().
 * Wraps the store's native semantic search capability.
 */
export class StoreVectorSearch implements VectorSearchProvider {
  constructor(private readonly store: StoreSearchable) {}

  async search(
    namespace: string[],
    query: string,
    limit: number,
  ): Promise<VectorSearchResult[]> {
    const results = await this.store.search(namespace, { query, limit })
    return results.map((r, idx) => ({
      key: r.key,
      score: r.score ?? 1 / (idx + 1),
      value: r.value,
    }))
  }
}
