# Search Architecture (`packages/codegen/src/search`)

## Scope
This document covers the `packages/codegen/src/search` module only:
- `code-search-service.ts`
- `code-search-types.ts`
- `index.ts`

The module provides semantic code search primitives over chunked source code. It is intentionally filesystem-agnostic and works on caller-provided file content.

Out of scope for this module:
- Vector store adapter implementation details (owned by `@dzupagent/core` vector-store adapters)
- Embedding provider implementation details (owned by `@dzupagent/core`)
- AST parsing/chunking internals (owned by `src/chunking/ast-chunker.ts`)
- Tree-sitter language extraction internals (owned by `src/repomap/tree-sitter-extractor.ts`)

## Responsibilities
`CodeSearchService` is responsible for:
- Initializing a vector collection (`init`)
- Indexing one file (`indexFile`) by chunking source and upserting chunk documents
- Indexing many files (`indexFiles`) with per-file error capture and aggregate stats
- Running semantic query search (`search`) with optional metadata filters
- Running symbol-targeted search (`searchBySymbol`) by composing a symbol metadata filter with optional base filters
- Deleting indexed chunks for one file (`removeFile`)
- Resetting the full collection (`reindexCollection`)
- Returning lightweight service stats (`getStats`)

The search module also owns the TypeScript contracts used by callers (`CodeSearchOptions`, `CodeSearchResult`, `IndexResult`, `IndexStats`, `CodeSearchServiceConfig`, `ChunkMetadata`).

## Structure
Files and roles:
- `code-search-service.ts`: service implementation, defaults, filter builder, and result-mapping helpers.
- `code-search-types.ts`: public types for options, results, indexing stats, and config.
- `index.ts`: folder-level barrel export for class and types.

Export surface integration:
- Re-exported from package root `src/index.ts` under `// --- Code Search ---`
- Re-exported from deprecated transitional facade `src/compat.ts` via `export * from './search/index.js'`

## Runtime and Control Flow
`indexFile(filePath, content, language?)`:
1. Resolves `resolvedLang` from explicit `language`, then `detectLanguage(filePath)`, then `'unknown'`.
2. Calls `chunkByAST(filePath, content, this.config.chunkConfig)`.
3. Returns `0` immediately when no chunks are produced.
4. Maps each chunk to semantic document shape `{ id, text, metadata }`.
5. Builds metadata from `ChunkMetadata` and stores `symbols` and `symbolKinds` as JSON strings.
6. Upserts documents via `this.store.upsert(this.collection, documents)`.
7. Updates in-memory tracking (`indexedFiles`, `indexedLanguages`, `lastIndexedAt`).
8. Returns chunk count.

`indexFiles(files)`:
1. Records wall-clock start time.
2. Processes files sequentially (`for ... of` + `await`), calling `indexFile`.
3. Counts files as indexed only when returned chunk count is greater than zero.
4. Captures per-file errors and continues remaining files.
5. Returns `{ filesIndexed, chunksCreated, durationMs, errors }`.

`search(query, opts?)`:
1. Resolves `limit` (default `10`).
2. Builds filter with `buildFilter(opts)`: `language -> eq`, `filePath -> contains`, `symbolKind -> contains`.
3. Executes `this.store.search(this.collection, query, limit, filter)`.
4. Applies `minScore` in-process (`opts?.minScore ?? 0`).
5. Maps each scored document with `toSearchResult`.

`searchBySymbol(symbolName, opts?)`:
1. Builds symbol filter `{ field: 'symbols', op: 'contains', value: symbolName }`.
2. Combines base filter from `buildFilter(opts)` with symbol filter using `{ and: [...] }` when base filter exists.
3. Searches using `symbolName` as query text.
4. Applies `minScore` in-process.
5. Maps through `toSearchResult`.

`reindexCollection()`:
1. Calls `this.store.store.deleteCollection(this.collection)` on the underlying vector store.
2. Clears in-memory tracking sets and timestamp.
3. Recreates/ensures collection with `this.store.ensureCollection(this.collection)`.

`removeFile(filePath)`:
1. Calls `this.store.delete(this.collection, { filter: { field: 'filePath', op: 'eq', value: filePath } })`.
2. Removes `filePath` from `indexedFiles`.

`getStats()`:
1. Reads `totalChunks` from `this.store.store.count(this.collection)`.
2. Returns in-memory tracking for `totalFiles`, `languages`, and `lastIndexedAt`.

## Key APIs and Types
Main class:
- `CodeSearchService`

Public methods:
- `init(): Promise<void>`
- `indexFile(filePath: string, content: string, language?: string): Promise<number>`
- `indexFiles(files: Array<{ filePath: string; content: string; language?: string }>): Promise<IndexResult>`
- `search(query: string, opts?: CodeSearchOptions): Promise<CodeSearchResult[]>`
- `searchBySymbol(symbolName: string, opts?: CodeSearchOptions): Promise<CodeSearchResult[]>`
- `reindexCollection(): Promise<void>`
- `removeFile(filePath: string): Promise<void>`
- `getStats(): Promise<IndexStats>`

Core types:
- `CodeSearchOptions`: `limit`, `minScore`, `language`, `filePath`, `symbolKind`.
- `CodeSearchResult`: `filePath`, `content`, `startLine`, `endLine`, `symbols`, `score`, `language`, `chunkId`.
- `IndexResult`: `filesIndexed`, `chunksCreated`, `durationMs`, `errors`.
- `IndexStats`: `totalChunks`, `totalFiles`, `languages`, `lastIndexedAt`.
- `CodeSearchServiceConfig`: `collectionName`, `chunkConfig`.
- `ChunkMetadata`: `filePath`, `language`, `startLine`, `endLine`, `chunkId`, `symbols`, `symbolKinds`.
- `symbols` and `symbolKinds` are stored as JSON strings.

Internal behavior relevant to callers:
- `toSearchResult` tolerates malformed/missing metadata and falls back to defaults.
- Invalid `symbols` JSON maps to `[]`.
- Missing `language` maps to `'unknown'`.
- Missing `chunkId` falls back to document `id`.

## Dependencies
Direct imports in `src/search/*`:
- `@dzupagent/core/vectordb`: `SemanticStore`, `MetadataFilter`.
- `../chunking/ast-chunker.js`: `chunkByAST` plus `CodeChunk` and `ASTChunkerConfig` types.
- `../repomap/tree-sitter-extractor.js`: `detectLanguage` plus `ASTSymbol` type re-export.

Package manifest context (`packages/codegen/package.json`):
- Runtime dependencies: `@dzupagent/core`, `@dzupagent/adapter-types`
- Search module currently uses `@dzupagent/core` directly; it does not import `@dzupagent/adapter-types`

Coupling note:
- `reindexCollection` and `getStats` call `this.store.store.*` APIs (`deleteCollection`, `count`), so they depend on `SemanticStore` exposing a `store` getter compatible with the `VectorStore` interface.

## Integration Points
Within `packages/codegen`:
- Chunking integration: `chunkByAST` from `src/chunking/ast-chunker.ts`
- Language detection integration: `detectLanguage` from `src/repomap/tree-sitter-extractor.ts`
- Root export integration: `src/index.ts` re-exports search class/types
- Transitional export integration: `src/compat.ts` re-exports `src/search/index.ts`

Within the wider `dzupagent` repo:
- API inventory includes search in advanced tier in `packages/codegen/docs/api-tiers.md` (`Chunking + search` group).
- No non-test runtime construction/usage of `CodeSearchService` was found outside `packages/codegen` during current workspace scan.
- Monorepo docs reference the type/class surface (`docs/CAPABILITY_MATRIX.md`, `docs/PUBLIC_API_SURFACE_ALLOWLISTS.md`) but these are inventory documents, not runtime callers.

## Testing and Observability
Primary test files:
- `src/__tests__/code-search-service.test.ts`
- `src/__tests__/code-search-reindex.test.ts`

Behavior covered by tests:
- Collection initialization for custom/default collection names
- `indexFile` metadata shape, language auto-detection, symbol serialization, edge content inputs
- `indexFiles` aggregation, empty input handling, partial-failure continuation, non-`Error` throwable handling
- `search` filter composition across `language`, `filePath`, `symbolKind`, default/custom limits, min-score gating
- `searchBySymbol` filter composition and option combination
- `toSearchResult` fallback behavior for malformed/missing metadata
- `removeFile` deletion semantics and stats effects
- `getStats` correctness for chunk count/file count/language tracking/timestamps
- `reindexCollection` collection deletion + recreation + in-memory reset and idempotence
- basic concurrent call scenarios (`Promise.all` for indexing/search)

Observability characteristics:
- No internal logger, metric emitter, or event bus integration in this module
- Operational signals are API outputs only.
- Batch indexing signal: `IndexResult.errors` and `durationMs`.
- Service state signal: `IndexStats`.
- Low-level backend observability depends on the concrete `VectorStore` and embedding provider configured in `@dzupagent/core`

## Risks and TODOs
Known risks in current implementation:
- `CodeSearchOptions.filePath` comment says prefix semantics, but implementation uses `contains`
- `symbols`/`symbolKinds` metadata is JSON-serialized strings and filtered with substring `contains`, which can over-match
- Stats are partly in-memory (`indexedFiles`, `indexedLanguages`, `lastIndexedAt`) and do not reconstruct from persisted collection contents after process restart
- `reindexCollection` and `getStats` rely on direct underlying store access (`store.store.*`), increasing coupling to `SemanticStore` internals
- `indexFiles` is sequential and can become a throughput bottleneck for large batches

Current TODOs:
- Align `filePath` docs/type comment with actual `contains` behavior or implement true prefix semantics
- Consider structured metadata representation for symbols/symbol kinds when adapter support allows exact matching
- Decide whether stats should be derivable from vector store state for process-restart continuity
- Consider optional telemetry hooks (timing/error callbacks) for production indexing/search pipelines

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
