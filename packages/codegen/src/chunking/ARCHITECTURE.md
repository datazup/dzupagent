# Chunking Architecture (`packages/codegen/src/chunking`)

## Scope
This document covers the AST-aware chunking subsystem implemented in `packages/codegen/src/chunking`.

Included files:
- `src/chunking/ast-chunker.ts`: core chunk construction logic.
- `src/chunking/index.ts`: local re-export surface.

Out of scope:
- Symbol extraction internals (`src/repomap/tree-sitter-extractor*.ts`).
- Vector indexing/search storage (`src/search/*`).
- Embedding model behavior and tokenizer-accurate budgeting.

## Responsibilities
The chunking module is responsible for converting source code text into `CodeChunk[]` that downstream indexing can store and query.

Primary responsibilities:
- Build chunk boundaries from AST symbols when available (`extractSymbolsAST`).
- Fallback to line-window chunking when no AST symbols are available.
- Preserve per-chunk metadata used by search/indexing flows:
  - `id`
  - `filePath`
  - `startLine` / `endLine`
  - `symbols`
  - `language`
  - `estimatedTokens`
- Apply configurable chunk shaping via `ASTChunkerConfig`:
  - `maxChunkTokens` (default `512`)
  - `minChunkTokens` (default `64`)
  - `overlapLines` (default `2`)

## Structure
Current module layout:
- `ast-chunker.ts`
- `index.ts`

Public API from this folder:
- `chunkByAST(filePath, content, config?)`
- `CodeChunk` (type)
- `ASTChunkerConfig` (type)

Internal helper flow in `ast-chunker.ts`:
- `estimateTokens`: coarse token heuristic (`Math.ceil(text.length / 4)`).
- `extractLines`: 1-based inclusive line slicing with bounds clamping.
- `chunkId`: symbol-based or line-range chunk ID generation.
- `getTopLevelRanges`: selects symbols where `parent` is absent.
- `getChildren`: parent-name-based child lookup.
- `splitLargeSymbol`: splits oversized top-level symbols using child boundaries.
- `mergeSmallChunks`: merges adjacent undersized chunks.
- `chunkByLines`: fallback line-window chunking.
- `addOverlap`: applies leading overlap to non-first chunks.

## Runtime and Control Flow
Main runtime entrypoint: `chunkByAST(...)` (async).

Execution flow:
1. Merge caller config with defaults.
2. Detect language using `detectLanguage(filePath)`; fallback label is `'unknown'`.
3. Return `[]` for empty or whitespace-only content.
4. Run `extractSymbolsAST(filePath, content)`.
5. If no symbols are returned, run `chunkByLines(...)` fallback.
6. Filter AST symbols to top-level ranges (`!parent`).
7. If no top-level ranges exist, run `chunkByLines(...)` fallback.
8. Build chunks in order:
- Optional `#preamble` chunk for lines before first top-level symbol.
- Per top-level symbol chunk.
- If top-level symbol exceeds `maxChunkTokens`, use `splitLargeSymbol(...)`:
- optional `#<symbol>:header` chunk when header segment meets `minChunkTokens`
- child chunks with IDs `#<parent>.<child>`
- Optional `#trailing` chunk for lines after last top-level symbol.
9. Run `mergeSmallChunks(...)` to coalesce adjacent chunks below `minChunkTokens`.
10. Run `addOverlap(...)` with configured overlap lines.
11. Return final `CodeChunk[]`.

Important behavior details:
- Overlap is applied only as leading context on non-first chunks.
- `addOverlap` rewrites IDs only for line-based IDs (`#Lx-Ly`), while symbol IDs remain unchanged.
- Fallback line chunking computes `maxLines` as `max(10, floor(maxChunkTokens / 4))` and advances by `maxLines - overlapLines`.

## Key APIs and Types
`chunkByAST(filePath: string, content: string, config?: ASTChunkerConfig): Promise<CodeChunk[]>`
- Public chunking entrypoint.
- Consumes AST symbol extraction from `repomap/tree-sitter-extractor`.
- Returns embedding-ready chunk units with metadata.

`CodeChunk`
- `id: string`
- `filePath: string`
- `content: string`
- `startLine: number` (1-indexed)
- `endLine: number` (1-indexed)
- `symbols: ASTSymbol[]`
- `language: string`
- `estimatedTokens: number`

`ASTChunkerConfig`
- `maxChunkTokens?: number`
- `minChunkTokens?: number`
- `overlapLines?: number`

Re-exports:
- `src/chunking/index.ts` re-exports `chunkByAST` and chunking types.
- `src/index.ts` re-exports `chunkByAST`, `CodeChunk`, and `ASTChunkerConfig` at package root.

## Dependencies
Direct code dependencies of this module:
- `../repomap/tree-sitter-extractor.js`
- `extractSymbolsAST`
- `detectLanguage`
- `ASTSymbol` type

Package-level dependency context relevant to runtime behavior:
- `web-tree-sitter` and `tree-sitter-wasms` are optional peer dependencies in `packages/codegen/package.json`.
- When those optional peers are unavailable, symbol extraction can degrade to regex/empty-symbol fallback paths, which this module handles by line-based chunking.

## Integration Points
Primary runtime consumer:
- `src/search/code-search-service.ts`
- `CodeSearchService.indexFile(...)` calls `chunkByAST(...)`.
- Maps chunk metadata to vector-store documents (`chunkId`, line ranges, language, serialized symbol names/kinds).

Type-level integration:
- `src/search/code-search-types.ts`
- `CodeSearchServiceConfig.chunkConfig?: ASTChunkerConfig`
- Re-exports `CodeChunk` and `ASTChunkerConfig` for search API users.

Public package surface integration:
- `src/index.ts` exposes chunking API for external package consumers.

## Testing and Observability
Test coverage for chunking behavior is implemented in:
- `src/__tests__/ast-chunker.test.ts`

Covered scenarios include:
- TypeScript and JavaScript input handling.
- Custom config acceptance (`maxChunkTokens`, `minChunkTokens`, `overlapLines`).
- Edge cases: empty, whitespace-only, single-line, imports-only, unsupported file type fallback.
- Large file behavior: splitting large class-like content and merging tiny adjacent symbols.
- Metadata integrity checks for IDs, line ranges, language, token estimates, and file path.

Observability status in current code:
- No dedicated logs, metrics, counters, or tracing hooks in `ast-chunker.ts`.
- Operational visibility is indirect through higher-level indexing/search behavior.

## Risks and TODOs
Current risks grounded in implementation:
- Child-symbol grouping in `splitLargeSymbol` uses parent/child name matching (`parent === parentName`), which can be ambiguous in files with repeated symbol names.
- Token sizing is heuristic (`chars / 4`), not model-tokenizer-accurate.
- Fallback line chunk sizing (`floor(maxChunkTokens / 4)` lines) is a coarse proxy.
- For unsupported languages without tree-sitter support, chunking can lose semantic boundaries and rely on line windows.
- No built-in runtime diagnostic signal for whether AST path vs fallback path was used.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

