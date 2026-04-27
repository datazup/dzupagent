# Search Architecture (`packages/codegen/src/search`)

## Scope
This folder implements semantic code search for `@dzupagent/codegen`.

It covers:
- Search service lifecycle and operations in `code-search-service.ts`.
- Public type contracts in `code-search-types.ts`.
- Module-level re-exports in `index.ts`.

It does not include:
- Embedding model or vector backend implementation details (provided by `@dzupagent/core` through `SemanticStore`).
- AST parsing internals (implemented in `src/chunking/ast-chunker.ts` and `src/repomap/tree-sitter-extractor.ts`).

## Responsibilities
The search module is responsible for:
- Creating/initializing a vector collection (`init`).
- Indexing code content by chunking files with `chunkByAST` and upserting chunk documents.
- Supporting batch indexing with per-file error capture (`indexFiles`).
- Running semantic search with optional metadata filtering (`search`).
- Running symbol-oriented search by combining semantic query + symbol metadata filter (`searchBySymbol`).
- Resetting collection state (`reindexCollection`) and deleting file-specific records (`removeFile`).
- Exposing lightweight indexing stats (`getStats`) using a mix of store count + in-memory tracking.

## Structure
Files in this folder:
- `code-search-service.ts`
- `code-search-types.ts`
- `index.ts`

Public exports from this folder (`src/search/index.ts`):
- `CodeSearchService`
- `CodeSearchOptions`
- `CodeSearchResult`
- `CodeSearchServiceConfig`
- `IndexResult`
- `IndexStats`
- `ChunkMetadata`

The package root (`src/index.ts`) also re-exports this same search surface as part of `@dzupagent/codegen`.

## Runtime and Control Flow
Index flow (`indexFile`):
1. Resolve language from explicit argument, else `detectLanguage(filePath)`, else `'unknown'`.
2. Chunk content through `chunkByAST(filePath, content, chunkConfig?)`.
3. Convert each chunk into store document shape `{ id, text, metadata }`.
4. Serialize symbol names and symbol kinds into JSON strings in metadata.
5. Upsert all documents into the configured collection.
6. Update in-memory tracking sets (`indexedFiles`, `indexedLanguages`) and `lastIndexedAt`.

Batch flow (`indexFiles`):
1. Iterate file inputs sequentially.
2. Call `indexFile` per item.
3. Aggregate `filesIndexed`, `chunksCreated`, and per-file error records.
4. Return `durationMs` based on wall-clock timing.

Search flow (`search`):
1. Resolve `limit` (`10` default).
2. Build metadata filter from `language`, `filePath`, `symbolKind`.
3. Query `SemanticStore.search(collection, query, limit, filter)`.
4. Apply `minScore` client-side.
5. Map scored docs into `CodeSearchResult`.

Symbol flow (`searchBySymbol`):
1. Build symbol filter on metadata field `symbols` with `contains`.
2. Combine with base filter (if provided) via `and`.
3. Query store using symbol name as query text.
4. Apply `minScore` and map results.

Reset/delete flow:
- `reindexCollection` calls `store.store.deleteCollection(collection)`, clears in-memory tracking, then re-ensures the collection.
- `removeFile` deletes records by `filePath eq <path>` and removes the file from `indexedFiles`.

Stats flow (`getStats`):
- `totalChunks` is read from `store.store.count(collection)`.
- `totalFiles`, `languages`, `lastIndexedAt` come from in-memory state.

## Key APIs and Types
Primary class:
- `CodeSearchService`

Service methods:
- `init(): Promise<void>`
- `indexFile(filePath: string, content: string, language?: string): Promise<number>`
- `indexFiles(files: Array<{ filePath: string; content: string; language?: string }>): Promise<IndexResult>`
- `search(query: string, opts?: CodeSearchOptions): Promise<CodeSearchResult[]>`
- `searchBySymbol(symbolName: string, opts?: CodeSearchOptions): Promise<CodeSearchResult[]>`
- `reindexCollection(): Promise<void>`
- `removeFile(filePath: string): Promise<void>`
- `getStats(): Promise<IndexStats>`

Core option/result types:
- `CodeSearchOptions`
- `CodeSearchResult`
- `IndexResult`
- `IndexStats`
- `CodeSearchServiceConfig`
- `ChunkMetadata`

Metadata contract persisted per chunk (`ChunkMetadata`):
- `filePath`, `language`, `startLine`, `endLine`, `chunkId`
- `symbols` as JSON string array
- `symbolKinds` as JSON string array

## Dependencies
Direct dependencies used by `src/search/*`:
- `@dzupagent/core`
  - `SemanticStore`
  - `MetadataFilter`
- `../chunking/ast-chunker.js`
  - `chunkByAST`
  - `CodeChunk`, `ASTChunkerConfig` types
- `../repomap/tree-sitter-extractor.js`
  - `detectLanguage`
  - `ASTSymbol` type (re-exported from types module)

Repository-level packaging context (`packages/codegen/package.json`):
- Package depends on `@dzupagent/core` and `@dzupagent/adapter-types`.
- Search behavior in this folder directly relies on `@dzupagent/core`; `@dzupagent/adapter-types` is not used in `src/search/*`.

## Integration Points
Within `packages/codegen`:
- Public exposure through `src/index.ts` root exports.
- Indexing path relies on chunk boundaries from `src/chunking/ast-chunker.ts`.
- Language detection path uses `src/repomap/tree-sitter-extractor.ts`.

Across the monorepo (current codebase evidence):
- Search APIs are tested in `src/__tests__/code-search-service.test.ts` and `src/__tests__/code-search-reindex.test.ts`.
- The module is part of the package public API tier inventory (`docs/api-tiers.md`, “Chunking + search” group).
- No direct runtime usage of `CodeSearchService` was found outside `packages/codegen/src` in this workspace scan.

## Testing and Observability
Tests directly covering search behavior:
- `src/__tests__/code-search-service.test.ts`
- `src/__tests__/code-search-reindex.test.ts`

Test coverage in these suites includes:
- Collection init/default collection behavior.
- Indexing metadata shape, language detection fallback, and JSON metadata serialization.
- Batch indexing aggregation/error capture behavior.
- Search filter composition (`language`, `filePath`, `symbolKind`) and `minScore` handling.
- Symbol search filter composition.
- `toSearchResult` resilience for malformed/missing metadata.
- File deletion effects and stats updates.
- Full reindex lifecycle (`deleteCollection` + state reset + re-indexing).

Observability characteristics:
- This module has no built-in logging, metrics, or event bus hooks.
- Operational visibility is currently through method outputs (`IndexResult`, `IndexStats`) and caller instrumentation.

## Risks and TODOs
Current risks visible from implementation and tests:
- `CodeSearchOptions.filePath` comment says prefix match, but implementation uses `contains`.
- Symbol and symbol-kind filters operate on JSON-serialized strings with `contains`, which may produce substring false positives.
- `getStats` file/language tracking is in-memory; state is not reconstructed from persisted metadata after process restart.
- `reindexCollection` depends on `store.store.deleteCollection(...)` being available on the provided store implementation.
- `indexFiles` is sequential; large indexing jobs may be slower than parallel ingestion.

Concrete TODOs:
- Align `filePath` behavior vs docs/comments (either update docs to `contains` semantics or implement prefix-specific operator path).
- Consider exact symbol membership filtering strategy for stores that support structured metadata.
- Decide whether stats should be fully derivable from store state to survive service restarts.
- Consider optional instrumentation hooks for indexing/search latency and error rates.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

