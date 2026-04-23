/**
 * CodeSearchService — wires AST-aware chunking into a SemanticStore
 * for full codebase semantic search.
 *
 * Accepts any SemanticStore backend (LanceDB, Qdrant, in-memory, etc.)
 * and uses the AST chunker to split source files at symbol boundaries
 * before embedding.
 */

import type { SemanticStore, MetadataFilter } from '@dzupagent/core'
import { chunkByAST } from '../chunking/ast-chunker.js'
import { detectLanguage } from '../repomap/tree-sitter-extractor.js'
import type {
  CodeSearchOptions,
  CodeSearchResult,
  CodeSearchServiceConfig,
  ChunkMetadata,
  IndexResult,
  IndexStats,
} from './code-search-types.js'

// -----------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------

const DEFAULT_COLLECTION = 'code_chunks'
const DEFAULT_SEARCH_LIMIT = 10

// -----------------------------------------------------------------------
// CodeSearchService
// -----------------------------------------------------------------------

/**
 * Semantic code search backed by AST-aware chunking and vector embeddings.
 *
 * Usage:
 * ```ts
 * const search = new CodeSearchService(semanticStore, { collectionName: 'my_code' })
 * await search.init()
 * await search.indexFile('src/app.ts', sourceCode, 'typescript')
 * const results = await search.search('user authentication logic')
 * ```
 */
export class CodeSearchService {
  private readonly store: SemanticStore
  private readonly collection: string
  private readonly config: CodeSearchServiceConfig

  /** Track indexed file paths for stats */
  private readonly indexedFiles = new Set<string>()
  private readonly indexedLanguages = new Set<string>()
  private lastIndexedAt: Date | null = null

  constructor(store: SemanticStore, config?: CodeSearchServiceConfig) {
    this.store = store
    this.config = config ?? {}
    this.collection = config?.collectionName ?? DEFAULT_COLLECTION
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /**
   * Ensure the backing vector collection exists.
   * Call this before any indexing or search operations.
   */
  async init(): Promise<void> {
    await this.store.ensureCollection(this.collection)
  }

  // ---------------------------------------------------------------------
  // Indexing
  // ---------------------------------------------------------------------

  /**
   * Chunk and index a single file into the vector store.
   *
   * @param filePath - Logical path of the file (used for metadata and chunk IDs)
   * @param content  - Source code content
   * @param language - Language identifier (e.g. 'typescript'). Auto-detected from extension if omitted.
   * @returns Number of chunks created
   */
  async indexFile(filePath: string, content: string, language?: string): Promise<number> {
    const resolvedLang = language ?? detectLanguage(filePath) ?? 'unknown'

    // Chunk the file using AST boundaries
    const chunks = await chunkByAST(filePath, content, this.config.chunkConfig)

    if (chunks.length === 0) return 0

    // Build documents for the semantic store
    const documents = chunks.map((chunk) => {
      const symbolNames = chunk.symbols.map((s) => s.name)
      const symbolKinds = chunk.symbols.map((s) => s.kind)

      const metadata: ChunkMetadata = {
        filePath: chunk.filePath,
        language: resolvedLang,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        symbols: JSON.stringify(symbolNames),
        symbolKinds: JSON.stringify(symbolKinds),
        chunkId: chunk.id,
      }

      return {
        id: chunk.id,
        text: chunk.content,
        metadata: metadata as unknown as Record<string, unknown>,
      }
    })

    await this.store.upsert(this.collection, documents)

    // Track stats
    this.indexedFiles.add(filePath)
    this.indexedLanguages.add(resolvedLang)
    this.lastIndexedAt = new Date()

    return chunks.length
  }

  /**
   * Index multiple files matching glob patterns in a directory.
   *
   * Requires a `readDir` and `readFile` callback since CodeSearchService
   * is filesystem-agnostic (works with VFS or real FS).
   *
   * @param files - Array of { filePath, content } objects to index
   * @returns Aggregated index result
   */
  async indexFiles(
    files: Array<{ filePath: string; content: string; language?: string }>,
  ): Promise<IndexResult> {
    const startTime = Date.now()
    let chunksCreated = 0
    let filesIndexed = 0
    const errors: Array<{ filePath: string; message: string }> = []

    for (const file of files) {
      try {
        const count = await this.indexFile(file.filePath, file.content, file.language)
        if (count > 0) filesIndexed++
        chunksCreated += count
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push({ filePath: file.filePath, message })
      }
    }

    return {
      filesIndexed,
      chunksCreated,
      durationMs: Date.now() - startTime,
      errors,
    }
  }

  // ---------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------

  /**
   * Semantic search across indexed code chunks.
   *
   * @param query - Natural language or code query
   * @param opts  - Search options (limit, filters, minimum score)
   * @returns Ranked code search results
   */
  async search(query: string, opts?: CodeSearchOptions): Promise<CodeSearchResult[]> {
    const limit = opts?.limit ?? DEFAULT_SEARCH_LIMIT
    const filter = this.buildFilter(opts)

    const results = await this.store.search(
      this.collection,
      query,
      limit,
      filter,
    )

    return results
      .filter((r) => r.score >= (opts?.minScore ?? 0))
      .map((r) => this.toSearchResult(r))
  }

  /**
   * Search for chunks containing a specific symbol name.
   *
   * Combines a text query for the symbol name with metadata filtering
   * on the serialized symbols array.
   *
   * @param symbolName - Name of the symbol to search for
   * @param opts       - Additional search options
   */
  async searchBySymbol(
    symbolName: string,
    opts?: CodeSearchOptions,
  ): Promise<CodeSearchResult[]> {
    const limit = opts?.limit ?? DEFAULT_SEARCH_LIMIT

    // Build a filter that includes the symbol name in the serialized JSON
    const symbolFilter: MetadataFilter = {
      field: 'symbols',
      op: 'contains',
      value: symbolName,
    }

    const baseFilter = this.buildFilter(opts)
    const combinedFilter: MetadataFilter = baseFilter
      ? { and: [baseFilter, symbolFilter] }
      : symbolFilter

    const results = await this.store.search(
      this.collection,
      symbolName,
      limit,
      combinedFilter,
    )

    return results
      .filter((r) => r.score >= (opts?.minScore ?? 0))
      .map((r) => this.toSearchResult(r))
  }

  // ---------------------------------------------------------------------
  // Deletion
  // ---------------------------------------------------------------------

  /**
   * Drop and recreate the vector collection, resetting all tracking state.
   * Equivalent to a full re-index — call `indexFile`/`indexFiles` after this.
   */
  async reindexCollection(): Promise<void> {
    await this.store.store.deleteCollection(this.collection)
    this.indexedFiles.clear()
    this.indexedLanguages.clear()
    this.lastIndexedAt = null
    await this.store.ensureCollection(this.collection)
  }

  /**
   * Remove all indexed chunks for a given file path.
   */
  async removeFile(filePath: string): Promise<void> {
    await this.store.delete(this.collection, {
      filter: { field: 'filePath', op: 'eq', value: filePath },
    })
    this.indexedFiles.delete(filePath)
  }

  // ---------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------

  /**
   * Get statistics about the indexed collection.
   */
  async getStats(): Promise<IndexStats> {
    const totalChunks = await this.store.store.count(this.collection)

    return {
      totalChunks,
      totalFiles: this.indexedFiles.size,
      languages: [...this.indexedLanguages],
      lastIndexedAt: this.lastIndexedAt,
    }
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  /**
   * Build a MetadataFilter from CodeSearchOptions.
   */
  private buildFilter(opts?: CodeSearchOptions): MetadataFilter | undefined {
    if (!opts) return undefined

    const filters: MetadataFilter[] = []

    if (opts.language) {
      filters.push({ field: 'language', op: 'eq', value: opts.language })
    }

    if (opts.filePath) {
      filters.push({ field: 'filePath', op: 'contains', value: opts.filePath })
    }

    if (opts.symbolKind) {
      filters.push({ field: 'symbolKinds', op: 'contains', value: opts.symbolKind })
    }

    if (filters.length === 0) return undefined
    if (filters.length === 1) return filters[0]
    return { and: filters }
  }

  /**
   * Convert a ScoredDocument from the SemanticStore into a CodeSearchResult.
   */
  private toSearchResult(doc: { id: string; text: string; score: number; metadata: Record<string, unknown> }): CodeSearchResult {
    const meta = doc.metadata as unknown as ChunkMetadata

    let symbols: string[] = []
    try {
      symbols = JSON.parse(meta.symbols ?? '[]') as string[]
    } catch {
      // Malformed JSON — ignore
    }

    return {
      filePath: String(meta.filePath ?? ''),
      content: doc.text,
      startLine: Number(meta.startLine ?? 0),
      endLine: Number(meta.endLine ?? 0),
      symbols,
      score: doc.score,
      language: String(meta.language ?? 'unknown'),
      chunkId: String(meta.chunkId ?? doc.id),
    }
  }
}
