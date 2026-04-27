# Chunking Architecture (`packages/codegen/src/chunking`)

## Scope
This module owns AST-aware chunking logic for code content inside `@dzupagent/codegen`.

- `src/chunking/ast-chunker.ts` implements chunk construction, merging, and overlap behavior.
- `src/chunking/index.ts` re-exports the chunking API.
- Public surface is also re-exported from `src/index.ts` (`chunkByAST`, `CodeChunk`, `ASTChunkerConfig`).

It does not perform embedding, persistence, or vector search itself. Those concerns are handled by `src/search/*`.

## Responsibilities
- Split source text into semantically meaningful chunks when symbol boundaries are available.
- Degrade gracefully when AST extraction is unavailable by falling back to line-based chunking.
- Preserve metadata needed by downstream indexers: file path, line range, symbols, language, and chunk identifier.
- Provide configurable controls (`maxChunkTokens`, `minChunkTokens`, `overlapLines`) with defaults.

## Structure
- `ast-chunker.ts`
- Public types: `CodeChunk`, `ASTChunkerConfig`
- Public entrypoint: `chunkByAST(filePath, content, config?)`
- Internal helpers: `estimateTokens`, `extractLines`, `chunkId`, `getTopLevelRanges`, `getChildren`, `splitLargeSymbol`, `mergeSmallChunks`, `chunkByLines`, `addOverlap`
- `index.ts`
- Re-exports `chunkByAST` and chunking types.

## Runtime and Control Flow
`chunkByAST` is asynchronous because symbol extraction (`extractSymbolsAST`) is async.

1. Merge user config with defaults (`maxChunkTokens: 512`, `minChunkTokens: 64`, `overlapLines: 2`).
2. Detect language via `detectLanguage(filePath)` from `repomap/tree-sitter-extractor.ts`; fallback label is `'unknown'`.
3. Return `[]` for empty or whitespace-only content.
4. Call `extractSymbolsAST(filePath, content)`.
5. If no symbols are returned, use `chunkByLines(...)`.
6. Build top-level symbol ranges (`symbols` with no `parent`).
7. If no top-level ranges exist, also fall back to `chunkByLines(...)`.
8. Build chunk list:
1. Optional preamble chunk for lines before first top-level symbol (`#preamble`).
2. One chunk per top-level symbol, unless symbol is oversized.
3. Oversized symbol path: `splitLargeSymbol(...)` tries class/interface child-based splitting.
4. Optional trailing chunk after last symbol (`#trailing`).
9. Merge adjacent undersized chunks using `mergeSmallChunks(...)`.
10. Add leading overlap to non-first chunks using `addOverlap(...)`.
11. Return final `CodeChunk[]`.

Fallback behavior is delegated to `extractSymbolsAST` internals:
- Uses `web-tree-sitter` + `tree-sitter-wasms` when available.
- Falls back to regex extraction for TS/JS when tree-sitter is unavailable.
- Returns empty symbols for unsupported fallback languages, which causes line-window chunking.

## Key APIs and Types
- `chunkByAST(filePath: string, content: string, config?: ASTChunkerConfig): Promise<CodeChunk[]>`
- Main entrypoint used by semantic indexing paths.
- `CodeChunk`
- `id`: symbol-based (`file#Symbol`) or line-based (`file#Lx-Ly`)
- `filePath`, `content`
- `startLine`, `endLine` (1-indexed)
- `symbols: ASTSymbol[]`
- `language`
- `estimatedTokens` (heuristic from `text.length / 4`)
- `ASTChunkerConfig`
- `maxChunkTokens?` (default `512`)
- `minChunkTokens?` (default `64`)
- `overlapLines?` (default `2`)

Important behavior details:
- `maxChunkTokens` is a split trigger, not a strict final cap after merge/overlap.
- `minChunkTokens` influences header-chunk emission and post-build merge behavior.
- `addOverlap` rewrites IDs only for line-range IDs (`#L...`), keeping symbol IDs stable.

## Dependencies
Direct code dependencies in this module:
- `../repomap/tree-sitter-extractor.js`
- `extractSymbolsAST` for symbol extraction
- `detectLanguage` for language labeling
- `ASTSymbol` type for chunk metadata

Package-level dependency context relevant to chunking:
- `web-tree-sitter` and `tree-sitter-wasms` are optional peer dependencies in `package.json`.
- If optional peers are absent, chunking still works through fallback paths.

## Integration Points
Primary runtime integration:
- `src/search/code-search-service.ts`
- `indexFile(...)` calls `chunkByAST(...)`.
- Chunk metadata is mapped into `ChunkMetadata` and upserted into `SemanticStore`.

Type-level integration:
- `src/search/code-search-types.ts`
- `CodeSearchServiceConfig.chunkConfig?: ASTChunkerConfig`
- re-exports `CodeChunk`/`ASTChunkerConfig` for consumers of search APIs.

Public package integration:
- `src/index.ts` exports chunking API at package root for downstream packages/apps.

## Testing and Observability
Test coverage for this module is concentrated in:
- `src/__tests__/ast-chunker.test.ts`

Covered behaviors include:
- basic chunk generation for TS/JS inputs
- metadata validity (`id`, line ranges, language, token estimate, file path)
- config acceptance (`maxChunkTokens`, `minChunkTokens`, `overlapLines`)
- edge cases (empty, whitespace-only, single-line input)
- fallback path handling (unsupported file type example)
- large-file scenarios (large class input, tiny symbol merge behavior)

Current observability posture:
- No dedicated logs, metrics, or traces are emitted from `ast-chunker.ts`.
- Runtime visibility for chunking is indirect through `CodeSearchService` outcomes and any higher-level caller instrumentation.

## Risks and TODOs
- Parent-child splitting uses symbol name linkage (`parent` and symbol `name`), which can be ambiguous if multiple top-level symbols share names in one file.
- Token estimation is heuristic (`chars / 4`) and can diverge from actual embedding/model tokenizer counts.
- Fallback line window sizing uses `Math.floor(maxChunkTokens / 4)` lines, which is a coarse approximation and not tokenizer-aware.
- When tree-sitter is unavailable for non-TS/JS languages, extractor returns no symbols and chunking loses semantic boundaries.
- No internal diagnostics are emitted for fallback mode selection, making it harder to distinguish AST vs fallback behavior during indexing.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
