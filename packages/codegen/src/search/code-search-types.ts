/**
 * Types for the CodeSearchService — semantic code search powered by
 * AST-aware chunking and vector embeddings.
 */

import type { CodeChunk, ASTChunkerConfig } from '../chunking/ast-chunker.js'
import type { ASTSymbol } from '../repomap/tree-sitter-extractor.js'

// -----------------------------------------------------------------------
// Search options & results
// -----------------------------------------------------------------------

/** Options for code search queries */
export interface CodeSearchOptions {
  /** Maximum number of results to return (default: 10) */
  limit?: number
  /** Minimum similarity score threshold 0..1 (default: 0) */
  minScore?: number
  /** Filter results to a specific language */
  language?: string
  /** Filter results to a specific file path (prefix match) */
  filePath?: string
  /** Filter results to chunks containing a specific symbol kind */
  symbolKind?: string
}

/** A single code search result */
export interface CodeSearchResult {
  /** File path of the matched chunk */
  filePath: string
  /** Source code content of the chunk */
  content: string
  /** Start line (1-indexed) */
  startLine: number
  /** End line (1-indexed) */
  endLine: number
  /** Symbol names found in the chunk */
  symbols: string[]
  /** Similarity score (higher is better) */
  score: number
  /** Language of the source file */
  language: string
  /** Unique chunk identifier */
  chunkId: string
}

// -----------------------------------------------------------------------
// Indexing types
// -----------------------------------------------------------------------

/** Result of an indexing operation */
export interface IndexResult {
  /** Number of files successfully indexed */
  filesIndexed: number
  /** Total number of chunks created across all files */
  chunksCreated: number
  /** Time taken in milliseconds */
  durationMs: number
  /** Errors encountered during indexing (file path -> error message) */
  errors: Array<{ filePath: string; message: string }>
}

/** Statistics about the indexed collection */
export interface IndexStats {
  /** Total number of chunks in the collection */
  totalChunks: number
  /** Total number of distinct files indexed */
  totalFiles: number
  /** Set of languages encountered */
  languages: string[]
  /** Timestamp of the last indexing operation */
  lastIndexedAt: Date | null
}

// -----------------------------------------------------------------------
// Service configuration
// -----------------------------------------------------------------------

/** Configuration for CodeSearchService */
export interface CodeSearchServiceConfig {
  /** Name of the vector collection to use (default: 'code_chunks') */
  collectionName?: string
  /** AST chunker configuration */
  chunkConfig?: ASTChunkerConfig
}

// -----------------------------------------------------------------------
// Metadata shape stored in vector DB per chunk
// -----------------------------------------------------------------------

/** Metadata stored alongside each chunk vector */
export interface ChunkMetadata {
  filePath: string
  language: string
  startLine: number
  endLine: number
  /** JSON-serialized array of symbol names in this chunk */
  symbols: string
  /** JSON-serialized array of symbol kinds in this chunk */
  symbolKinds: string
  chunkId: string
}

// Re-export upstream types used in the public API
export type { CodeChunk, ASTChunkerConfig, ASTSymbol }
