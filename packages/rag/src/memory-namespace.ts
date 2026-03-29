/**
 * RagMemoryNamespace — Bridges RAG chunk storage with a MemoryService.
 *
 * Uses MemoryServiceLike interface (duck-typing) to avoid a hard dependency
 * on @dzipagent/memory. Any object that satisfies put/get/search/delete
 * with the right signatures can be used, making the integration optional.
 */

import type { ChunkResult } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the RAG memory namespace */
export interface RagMemoryConfig {
  /** Namespace name for RAG chunks in memory */
  namespace: string
  /** Scope keys for isolation (e.g., ['tenantId', 'sessionId']) */
  scopeKeys: string[]
}

/**
 * Minimal interface for memory service operations needed by RAG.
 *
 * Compatible with @dzipagent/memory MemoryService:
 * - put(namespace, scope, key, value) — stores a record
 * - get(namespace, scope) — retrieves all records in a scope
 * - search(namespace, scope, query, limit) — semantic search (optional)
 * - delete(namespace, scope, key) — remove a single record (optional)
 */
export interface MemoryServiceLike {
  put(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void>

  get(
    namespace: string,
    scope: Record<string, string>,
  ): Promise<Record<string, unknown>[]>

  search?(
    namespace: string,
    scope: Record<string, string>,
    query: string,
    limit: number,
  ): Promise<Record<string, unknown>[]>

  delete?(
    namespace: string,
    scope: Record<string, string>,
    key: string,
  ): Promise<void>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Shape of a serialized chunk stored in memory */
interface StoredChunk {
  id: string
  text: string
  tokenCount: number
  quality: number
  metadata: ChunkResult['metadata']
}

function isStoredChunk(value: unknown): value is StoredChunk {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['id'] === 'string' &&
    typeof v['text'] === 'string' &&
    typeof v['tokenCount'] === 'number' &&
    typeof v['quality'] === 'number' &&
    v['metadata'] != null
  )
}

function storedToChunkResult(stored: StoredChunk): ChunkResult {
  return {
    id: stored.id,
    text: stored.text,
    tokenCount: stored.tokenCount,
    quality: stored.quality,
    metadata: stored.metadata,
  }
}

// ---------------------------------------------------------------------------
// RagMemoryNamespace
// ---------------------------------------------------------------------------

export class RagMemoryNamespace {
  constructor(
    private readonly memoryService: MemoryServiceLike,
    private readonly config: RagMemoryConfig,
  ) {}

  /**
   * Store ingested chunks as memory records.
   *
   * Each chunk is stored with its id as the key. The value includes
   * text, tokenCount, quality, and metadata for later retrieval.
   */
  async storeChunks(
    chunks: ChunkResult[],
    scope: Record<string, string>,
  ): Promise<void> {
    for (const chunk of chunks) {
      const value: Record<string, unknown> = {
        id: chunk.id,
        text: chunk.text,
        tokenCount: chunk.tokenCount,
        quality: chunk.quality,
        metadata: chunk.metadata,
      }
      await this.memoryService.put(
        this.config.namespace,
        scope,
        chunk.id,
        value,
      )
    }
  }

  /**
   * Get all chunks for a scope.
   *
   * Filters out any records that don't match the expected chunk shape
   * (memory namespaces can contain heterogeneous data).
   */
  async getChunks(scope: Record<string, string>): Promise<ChunkResult[]> {
    const records = await this.memoryService.get(this.config.namespace, scope)
    const chunks: ChunkResult[] = []
    for (const record of records) {
      if (isStoredChunk(record)) {
        chunks.push(storedToChunkResult(record))
      }
    }
    return chunks
  }

  /**
   * Search chunks using memory service semantic search.
   *
   * Throws if the memory service does not support search.
   */
  async searchChunks(
    query: string,
    scope: Record<string, string>,
    limit: number = 10,
  ): Promise<Array<{ chunk: ChunkResult; score: number }>> {
    if (!this.memoryService.search) {
      throw new Error('Memory service does not support search')
    }
    const results = await this.memoryService.search(
      this.config.namespace,
      scope,
      query,
      limit,
    )
    const output: Array<{ chunk: ChunkResult; score: number }> = []
    for (const record of results) {
      if (isStoredChunk(record)) {
        output.push({
          chunk: storedToChunkResult(record),
          // MemoryService search results don't carry individual scores;
          // use position-based relevance (first = highest)
          score: 1 / (output.length + 1),
        })
      }
    }
    return output
  }

  /**
   * Delete all chunks belonging to a source (for re-ingestion).
   *
   * Fetches all chunks in the scope, then deletes those matching
   * the given sourceId. Throws if the memory service does not
   * support delete.
   */
  async deleteBySource(
    sourceId: string,
    scope: Record<string, string>,
  ): Promise<void> {
    if (!this.memoryService.delete) {
      throw new Error('Memory service does not support delete')
    }
    const records = await this.memoryService.get(this.config.namespace, scope)
    for (const record of records) {
      if (!isStoredChunk(record)) continue
      if (record.metadata.sourceId === sourceId) {
        await this.memoryService.delete(this.config.namespace, scope, record.id)
      }
    }
  }

  /** Get chunk count for a scope */
  async getChunkCount(scope: Record<string, string>): Promise<number> {
    const records = await this.memoryService.get(this.config.namespace, scope)
    return records.filter(r => isStoredChunk(r)).length
  }
}
