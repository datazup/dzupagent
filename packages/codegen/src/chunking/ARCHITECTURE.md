# Chunking Architecture (`packages/codegen/src/chunking`)

## 1. Scope

This folder implements AST-aware code chunking for `@dzupagent/codegen`:

- `ast-chunker.ts`: main implementation (`chunkByAST`) and all splitting/merging/overlap logic.
- `index.ts`: thin public re-export.

Primary goal: split source code into embedding-ready chunks that preserve semantic boundaries (functions/classes/methods) when possible, while degrading gracefully when AST extraction is unavailable.

## 2. Public API

### 2.1 `chunkByAST(filePath, content, config?)`

Asynchronous entry point:

- Detects language from file extension.
- Attempts AST symbol extraction through `extractSymbolsAST`.
- Chunks by top-level symbols when available.
- Falls back to line-based chunking when symbols are unavailable.

Source: `./ast-chunker.ts` lines 326-426.

### 2.2 Types

`CodeChunk`:

- `id`: stable chunk identifier (`file#symbol` or line-range form).
- `filePath`
- `content`
- `startLine`, `endLine` (1-indexed)
- `symbols: ASTSymbol[]`
- `language`
- `estimatedTokens` (chars/4 heuristic)

`ASTChunkerConfig`:

- `maxChunkTokens` (default `512`)
- `minChunkTokens` (default `64`)
- `overlapLines` (default `2`)

Source: `./ast-chunker.ts` lines 15-42, 48-52.

## 3. Internal Flow

## 3.1 High-level pipeline

1. Merge config with defaults.
2. Detect language via `detectLanguage(filePath)`.
3. Return `[]` for empty/whitespace content.
4. Extract symbols via `extractSymbolsAST(filePath, content)`.
5. If no symbols: line-based fallback (`chunkByLines`).
6. Compute top-level ranges (`!parent`).
7. Optionally emit `#preamble` chunk.
8. For each top-level symbol:
   - if symbol token size > `maxChunkTokens`: attempt `splitLargeSymbol` at child boundaries.
   - else emit one symbol chunk.
9. Optionally emit `#trailing` chunk.
10. Merge adjacent undersized chunks (`mergeSmallChunks`).
11. Apply leading overlap (`addOverlap`) for continuity.
12. Return final `CodeChunk[]`.

## 3.2 AST dependency and graceful degradation

`chunkByAST` depends on `extractSymbolsAST` from `../repomap/tree-sitter-extractor.ts`.

That extractor:

- Dynamically loads `web-tree-sitter` and WASM grammars when available.
- Uses AST walking for rich symbol ranges (`line`, `endLine`, `parent`, etc.).
- Falls back to regex extraction for TS/JS when tree-sitter/grammar loading fails.
- Returns empty symbols for unsupported non-TS/JS regex fallback paths.

Impact on chunking:

- With AST available: boundary quality is highest (class/method aware).
- With regex fallback: symbols can be coarse (`endLine` often equal to `line`), so chunking may become less granular.
- With no symbols: deterministic line-window fallback still returns usable chunks.

## 3.3 ASCII flow

```text
chunkByAST
  -> detectLanguage
  -> extractSymbolsAST
      -> tree-sitter success? yes -> symbols
      -> no -> regex/empty fallback
  -> symbols empty?
      -> yes: chunkByLines -> return
      -> no: top-level symbol chunking
           -> splitLargeSymbol (if oversized)
           -> mergeSmallChunks
           -> addOverlap
           -> return
```

## 4. Feature Catalog (Descriptive)

## 4.1 AST boundary chunking

Description:

- Uses symbol ranges (class/function/interface/etc.) as chunk boundaries.

Why it matters:

- Preserves semantic units better than pure size windows.
- Improves retrieval precision for code search and embeddings.

Implementation:

- `getTopLevelRanges`, per-symbol chunk creation in main loop.

## 4.2 Oversized symbol splitting by children

Description:

- Splits oversized parent symbols (for example, classes) into child chunks when child symbols exist.

Behavior:

- Optional header chunk (`Parent:header`) for content before first child.
- Child chunks named `Parent.child`.

Implementation:

- `splitLargeSymbol`.

## 4.3 Small-chunk consolidation

Description:

- Merges adjacent chunks until minimum token size is satisfied.

Behavior:

- Uses `minChunkTokens` as threshold.
- Aggregates symbols and rebuilds merged content by line range.

Implementation:

- `mergeSmallChunks`.

## 4.4 Context overlap at boundaries

Description:

- Adds leading overlap lines from previous chunk for continuity.

Behavior:

- First chunk unchanged.
- Subsequent chunks extend `startLine` backwards by `overlapLines` (bounded at line 1).
- For line-range IDs (`#L...`), ID is rewritten to new line range; symbol IDs remain stable.

Implementation:

- `addOverlap`.

## 4.5 Line-based fallback mode

Description:

- If symbol extraction yields nothing, chunk by line windows.

Behavior:

- `maxLines = max(10, floor(maxChunkTokens / 4))`
- Sliding step: `maxLines - overlapLines`
- Emits chunks with empty `symbols` array.

Implementation:

- `chunkByLines`.

## 5. Configuration Semantics

- `maxChunkTokens`: upper bound trigger for splitting large symbol ranges. Not a hard global cap after overlap/merge.
- `minChunkTokens`: lower bound used only in merge pass and header emission suppression.
- `overlapLines`: applied after merge; can increase final token count.

Practical tuning:

- retrieval-heavy indexing: lower `maxChunkTokens` (e.g. `200-350`) and modest overlap (`1-3`).
- LLM context packing: raise `maxChunkTokens` to reduce fragment count.
- noisy tiny symbols (constants): increase `minChunkTokens` for consolidation.

## 6. Usage Examples

## 6.1 Direct chunking

```ts
import { chunkByAST } from '@dzupagent/codegen'

const chunks = await chunkByAST('src/user-service.ts', sourceCode, {
  maxChunkTokens: 320,
  minChunkTokens: 40,
  overlapLines: 2,
})

for (const c of chunks) {
  console.log(c.id, c.startLine, c.endLine, c.estimatedTokens)
}
```

## 6.2 Chunking through semantic indexing

```ts
import { CodeSearchService } from '@dzupagent/codegen'

const search = new CodeSearchService(semanticStore, {
  collectionName: 'code_chunks',
  chunkConfig: { maxChunkTokens: 300, minChunkTokens: 32, overlapLines: 1 },
})

await search.init()
await search.indexFile('src/auth.ts', authSource)
```

`CodeSearchService.indexFile()` invokes `chunkByAST()` and stores chunk metadata (`filePath`, line range, symbol names/kinds, `chunkId`) in the vector store.

## 7. Use Cases

- Semantic code search indexing (method/class retrieval by natural language queries).
- Repository map enrichment with code unit-level granularity.
- RAG-style context assembly for code assistants.
- PR/code-review assistants that need structurally meaningful code snippets.
- Preprocessing large files before embedding/caching.

## 8. References In Other Packages And Usage

Repository-wide search found no direct runtime imports of `chunkByAST` from packages outside `packages/codegen`.

Current reference map:

- `packages/codegen/src/search/code-search-service.ts`
  - Direct runtime consumer.
  - Calls `chunkByAST()` during `indexFile`.
- `packages/codegen/src/search/code-search-types.ts`
  - Type-level reuse (`CodeChunk`, `ASTChunkerConfig`) in `CodeSearchServiceConfig`.
- `packages/codegen/src/index.ts`
  - Exposes `chunkByAST` and chunking types for external package consumers.
- `packages/server/src/runtime/tool-resolver.ts`
  - Imports `@dzupagent/codegen` package at runtime, but currently uses git tool exports only (not chunking API).

Conclusion:

- Chunking is presently an internal subsystem of `@dzupagent/codegen` plus public API surface for future external adopters.

## 9. Test Coverage And Validation

## 9.1 Executed tests

Executed during this analysis:

- `yarn workspace @dzupagent/codegen test src/__tests__/ast-chunker.test.ts`
  - Result: `19/19` tests passing.
- `yarn workspace @dzupagent/codegen test src/__tests__/code-search-service.test.ts`
  - Result: `28/28` tests passing.

## 9.2 What is covered

`ast-chunker.test.ts` covers:

- baseline chunk creation
- ID/line range/token/language/filePath invariants
- config acceptance (`maxChunkTokens`, `minChunkTokens`, `overlapLines`)
- edge cases (empty, whitespace-only, single-line, imports-only)
- non-TS fallback behavior
- large input behavior and tiny-symbol merge expectations
- JS language handling

`code-search-service.test.ts` gives integration coverage for chunking output consumption:

- chunk metadata persistence
- language detection propagation
- symbol/symbol-kind metadata serialization
- multi-file indexing and search workflows

## 9.3 File-level coverage signal

From `vitest --coverage` run focused on chunker tests (report generated even though global package thresholds fail):

- `src/chunking/ast-chunker.ts`
  - statements: `83.33%`
  - lines: `83.33%`
  - functions: `80%`
  - branches: `92.85%`

Observed uncovered regions include:

- fallback branch when symbols exist but top-level ranges are empty (`ast-chunker.ts` ~351-352)
- oversized-symbol split path invocation branch (`ast-chunker.ts` ~382-385) under some runtime parser/fallback conditions

## 9.4 Coverage caveat

`yarn workspace @dzupagent/codegen test:coverage src/__tests__/ast-chunker.test.ts` exits non-zero due package-wide global thresholds in `vitest.config.ts`, even when chunker-local coverage is high. This is expected for a single-test-file coverage run.

## 10. Noted Trade-offs

- Token estimation is heuristic (`chars / 4`), not tokenizer-accurate.
- Symbol-parent linking uses symbol names; same-name sibling edge cases may reduce split precision.
- Fallback quality depends heavily on tree-sitter availability and grammar loading.
- Overlap is line-based and can reintroduce duplicated text intentionally for continuity.

## 11. Recommended Next Improvements

1. Add deterministic tests that force the `topRanges.length === 0` and oversized split branches to close remaining coverage gaps.
2. Add optional pluggable token estimator for model-specific token accounting.
3. Include chunk quality metadata (boundary type, split reason, overlapApplied) for downstream ranking/debugging.
4. Add explicit contract tests for stable chunk ID semantics across overlap and merge scenarios.
