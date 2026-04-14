# Search Architecture (`packages/codegen/src/search`)

## 1. Scope

This folder implements semantic code search for `@dzupagent/codegen` by combining:

- AST-aware chunking (`chunkByAST`) from `../chunking/ast-chunker.ts`
- language detection (`detectLanguage`) from `../repomap/tree-sitter-extractor.ts`
- vector retrieval + metadata filtering via `SemanticStore` from `@dzupagent/core`

Files in scope:

- `code-search-service.ts`: runtime service (index, search, delete, stats)
- `code-search-types.ts`: API types and metadata contract
- `index.ts`: folder-level re-exports

Primary objective: transform source files into semantically meaningful chunks, index them in a vector store, and provide query APIs for natural-language and symbol-centric retrieval.

## 2. Public API

## 2.1 Exports

From `src/search/index.ts`:

- `CodeSearchService`
- `CodeSearchOptions`
- `CodeSearchResult`
- `CodeSearchServiceConfig`
- `IndexResult`
- `IndexStats`
- `ChunkMetadata`

From package root (`src/index.ts`), the same service/types are re-exported as part of `@dzupagent/codegen` public API.

## 2.2 `CodeSearchService` methods

Implemented in `code-search-service.ts`:

- `init()`
  - ensures vector collection exists.
- `indexFile(filePath, content, language?)`
  - chunks one file and upserts chunk documents into vector store.
- `indexFiles(files)`
  - batch indexing with per-file error capture.
- `search(query, opts?)`
  - semantic retrieval with optional metadata filters.
- `searchBySymbol(symbolName, opts?)`
  - semantic retrieval + metadata constraint over serialized symbol list.
- `removeFile(filePath)`
  - deletes all chunks for one file.
- `getStats()`
  - returns aggregate runtime stats (`totalChunks`, `totalFiles`, `languages`, `lastIndexedAt`).

## 2.3 Type contract summary

`CodeSearchOptions`:

- `limit` (default `10`)
- `minScore` (default `0`)
- `language`
- `filePath`
- `symbolKind`

`CodeSearchResult`:

- chunk location and content: `filePath`, `content`, `startLine`, `endLine`, `chunkId`
- semantic metadata: `symbols`, `language`, `score`

`ChunkMetadata` (stored in vector DB):

- `filePath`, `language`, `startLine`, `endLine`, `chunkId`
- `symbols` as JSON string array
- `symbolKinds` as JSON string array

## 3. Dependencies And Contracts

## 3.1 Semantic store dependency

`CodeSearchService` is backend-agnostic and depends only on `SemanticStore` interface behavior:

- `ensureCollection(name)`
- `upsert(collection, docs)`
- `search(collection, query, limit, filter?)`
- `delete(collection, { filter })`
- `store.count(collection)`

This allows using in-memory, LanceDB, Qdrant, PgVector, etc., through `@dzupagent/core` adapters.

## 3.2 Chunking + symbol extraction dependency

`indexFile()` delegates structural splitting to `chunkByAST()`. That path includes graceful fallback behavior:

- AST-based chunking when tree-sitter symbols are available
- line-window chunking when symbol extraction is unavailable/empty

This means search indexing still works even without tree-sitter runtime dependencies, with lower structural precision.

## 3.3 Filter semantics dependency

Search filtering uses normalized `MetadataFilter` operators from `@dzupagent/core`:

- equality: `eq`
- string containment: `contains`
- boolean composition: `and`

Important behavior note:

- `filePath` option is documented as prefix match in type comment, but current implementation uses `contains`.
- `symbolKind` and symbol-name search rely on substring matching against JSON-serialized arrays, not exact tokenized membership.

## 4. Data Model And Storage Strategy

Each indexed chunk is stored as one semantic document:

- `id`: chunk ID from chunker (`symbol-based` or `line-range` style)
- `text`: raw chunk content
- `metadata`:
  - location (`filePath`, line range)
  - classification (`language`, serialized `symbolKinds`)
  - discovery fields (`symbols`, `chunkId`)

Why symbols are serialized to JSON strings:

- keeps metadata schema simple across heterogeneous vector adapters
- supports broad `contains` filtering without requiring adapter-native array operators

Tradeoff:

- substring filtering may produce false positives for similarly named symbols (`User` vs `SuperUser`).

## 5. Flow

## 5.1 Index flow (`indexFile`)

1. Resolve language:
   - explicit `language` argument if provided
   - else `detectLanguage(filePath)`
   - else `'unknown'`
2. Generate AST-aware chunks via `chunkByAST(filePath, content, chunkConfig?)`.
3. Return early if no chunks.
4. Map each chunk into semantic document shape.
5. Serialize symbol names and kinds into metadata JSON strings.
6. Upsert all chunk documents into configured collection.
7. Update in-memory stats (`indexedFiles`, `indexedLanguages`, `lastIndexedAt`).
8. Return chunk count.

## 5.2 Batch index flow (`indexFiles`)

1. Start timer.
2. Iterate files sequentially.
3. Call `indexFile()` per file.
4. Accumulate:
   - `filesIndexed` (only when chunk count > 0)
   - `chunksCreated`
   - `errors[]` (without aborting remaining files)
5. Return aggregate `IndexResult` with duration.

## 5.3 Search flow (`search`)

1. Resolve `limit` (default `10`).
2. Build metadata filter from options.
3. Call semantic search in store.
4. Apply `minScore` client-side filter.
5. Map scored documents into `CodeSearchResult`.

## 5.4 Symbol search flow (`searchBySymbol`)

1. Build symbol filter: `{ field: 'symbols', op: 'contains', value: symbolName }`.
2. Combine with base filter (if any) using `and`.
3. Query semantic store with `symbolName` as text query.
4. Apply `minScore`.
5. Map to `CodeSearchResult`.

## 5.5 Delete + stats flow

- `removeFile(filePath)`:
  - deletes by metadata filter `filePath eq <value>`
  - removes file path from `indexedFiles`
- `getStats()`:
  - live chunk count from store (`store.count(collection)`)
  - in-memory file/language sets + last index timestamp

## 5.6 ASCII sequence

```text
Caller
  -> CodeSearchService.init()
      -> SemanticStore.ensureCollection()

Caller
  -> indexFile(path, code)
      -> chunkByAST(path, code)
          -> extractSymbolsAST/tree-sitter OR fallback
      -> map chunks to docs + metadata JSON
      -> SemanticStore.upsert(collection, docs)
      -> update in-memory stats

Caller
  -> search(query, opts)
      -> buildFilter(opts)
      -> SemanticStore.search(collection, query, limit, filter)
      -> minScore filter
      -> toSearchResult()
```

## 6. Feature Catalog (Descriptive)

## 6.1 AST-aware semantic indexing

Description:

- indexes semantically coherent units (functions/classes/methods) rather than naive fixed-size text slices.

Impact:

- better retrieval precision for code-assistant and RAG scenarios.

## 6.2 Filesystem-agnostic indexing API

Description:

- accepts in-memory `{ filePath, content }` payloads.

Impact:

- can be used with virtual FS, git snapshots, generated code buffers, or disk reads outside the service.

## 6.3 Batch resilience

Description:

- `indexFiles()` captures per-file failures and continues remaining files.

Impact:

- partial indexing completes even with malformed files or transient backend errors.

## 6.4 Rich metadata filtering

Description:

- query options map to `MetadataFilter` for language/path/symbol-kind constraints.

Impact:

- enables narrowing retrieval scope before reranking/LLM assembly.

## 6.5 Symbol-oriented retrieval mode

Description:

- `searchBySymbol()` overlays symbol metadata filtering on semantic query.

Impact:

- useful for targeted symbol lookups (`AuthService`, `validateToken`, etc.) while preserving semantic ranking.

## 6.6 Score gating

Description:

- `minScore` threshold is applied after store search.

Impact:

- consumers can tune precision/recall without changing vector backend settings.

## 6.7 Lightweight operational stats

Description:

- exposes indexed file count, chunk count, language set, and last indexing timestamp.

Impact:

- useful for diagnostics and ingestion progress reporting.

## 7. Usage Examples

## 7.1 Minimal end-to-end setup

```ts
import {
  SemanticStore,
  InMemoryVectorStore,
  createCustomEmbedding,
} from '@dzupagent/core'
import { CodeSearchService } from '@dzupagent/codegen'

const semanticStore = new SemanticStore({
  embedding: createCustomEmbedding({
    modelId: 'demo-embed',
    dimensions: 3,
    embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
    embedQuery: async () => [0.1, 0.2, 0.3],
  }),
  vectorStore: new InMemoryVectorStore(),
})

const search = new CodeSearchService(semanticStore, {
  collectionName: 'my_code_chunks',
  chunkConfig: { maxChunkTokens: 320, minChunkTokens: 48, overlapLines: 2 },
})

await search.init()
await search.indexFile('src/auth.ts', sourceCode)

const results = await search.search('token validation')
```

## 7.2 Batch indexing with error capture

```ts
const indexResult = await search.indexFiles([
  { filePath: 'src/auth.ts', content: authSource, language: 'typescript' },
  { filePath: 'src/user.ts', content: userSource, language: 'typescript' },
])

console.log(indexResult.filesIndexed)
console.log(indexResult.chunksCreated)
console.log(indexResult.errors)
```

## 7.3 Filtered semantic search

```ts
const hits = await search.search('request validation middleware', {
  limit: 5,
  minScore: 0.65,
  language: 'typescript',
  filePath: 'src/api/',
  symbolKind: 'function',
})
```

## 7.4 Symbol search

```ts
const symbolHits = await search.searchBySymbol('UserService', {
  language: 'typescript',
  minScore: 0.4,
})
```

## 7.5 Remove file and inspect stats

```ts
await search.removeFile('src/auth.ts')
const stats = await search.getStats()
console.log(stats.totalChunks, stats.totalFiles, stats.languages, stats.lastIndexedAt)
```

## 8. Use Cases

- Semantic code retrieval for coding agents.
- Codebase RAG context assembly (pre-LLM retrieval stage).
- Symbol-aware navigation and impact analysis (`searchBySymbol`).
- Incremental re-indexing when files change (`removeFile` + `indexFile`).
- Language-scoped retrieval in polyglot repositories.

## 9. References In Other Packages And Usage

Repository scan results:

- Direct runtime usage outside `packages/codegen`: none found for `CodeSearchService`/search types.
- Internal runtime usage:
  - exported via `packages/codegen/src/index.ts` for external consumers.
- External package-level reference to `@dzupagent/codegen`:
  - `packages/server/src/runtime/tool-resolver.ts` dynamically imports `@dzupagent/codegen`, but currently uses git tool factories (`createGitTools`, `GitExecutor`), not search APIs.

Documentation-only references:

- `packages/codegen/ARCHITECTURE.md`
- `packages/codegen/src/chunking/ARCHITECTURE.md`
- `packages/core/src/vectordb/ARCHITECTURE.md`

Conclusion:

- search module is production-ready within `@dzupagent/codegen` API surface and tests, but currently has no cross-package runtime consumers in this monorepo.

## 10. Test Coverage And Validation

## 10.1 Executed test commands

Executed during this analysis:

- `yarn workspace @dzupagent/codegen test src/__tests__/code-search-service.test.ts`
  - Result: `28/28` tests passed.
- `yarn workspace @dzupagent/codegen test src/__tests__/ast-chunker.test.ts`
  - Result: `19/19` tests passed.
- `yarn workspace @dzupagent/codegen test src/__tests__/tree-sitter-extractor.test.ts`
  - Result: `29/29` tests passed.

Focused coverage run:

- `yarn workspace @dzupagent/codegen test:coverage src/__tests__/code-search-service.test.ts`
  - Service-level coverage in report:
    - `search/code-search-service.ts`: `98.71%` statements/lines, `100%` functions, `82.45%` branches
  - Uncovered lines reported: `279-280`, `297-298`
  - Command exits non-zero due package-wide global coverage thresholds (expected when running a single test file with global gates enabled).

## 10.2 What the current tests cover well

`code-search-service.test.ts` covers:

- lifecycle: collection initialization + default collection fallback
- indexing: metadata shape, language auto-detection, symbol/kind serialization
- batch indexing: aggregate counts and per-file error capture
- searching: structure validation, limit handling, score threshold
- filter wiring: language, filePath, combined `and`
- symbol search: symbol filter + combined filters
- deletion: file-filter delete and stats update for tracked files
- stats: empty state, post-index state, multi-language tracking
- edge behavior: blank files, no matches, empty index

## 10.3 Notable gaps and residual risks

- `symbolKind` search option branch is not explicitly tested (matches uncovered lines around filter build path).
- malformed `symbols` JSON path in `toSearchResult()` catch block is not directly tested.
- metadata `contains` behavior differs by backend adapter; symbol filtering precision can vary (substring vs exact match semantics).
- stats are partially in-memory (`indexedFiles`, `indexedLanguages`) and not reconstructed from store metadata on service restart.

## 11. Implementation Notes And Tradeoffs

- Sequential batch indexing is simple and predictable but not throughput-optimized for large repositories.
- Using JSON strings for symbol metadata maximizes backend compatibility, at the cost of exact-match expressiveness.
- `CodeSearchOptions.filePath` currently behaves as substring match (`contains`) rather than strict prefix matching.
- `indexFiles()` JSDoc mentions callbacks (`readDir`/`readFile`) but implementation now accepts preloaded file objects; doc text can be aligned if desired.
