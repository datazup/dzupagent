# Repomap Architecture (`src/repomap`)

## Scope
This document covers the `packages/codegen/src/repomap` subsystem only:
- `symbol-extractor.ts`
- `tree-sitter-extractor.ts`
- `import-graph.ts`
- `repo-map-builder.ts`
- `index.ts`

It describes the current implementation for symbol extraction, import graph construction, and token-budgeted repo-map generation used by `@dzupagent/codegen`.

## Responsibilities
The subsystem provides three concrete capabilities:
- Extract symbols from source files.
- Build a relative-import dependency graph across a provided file set.
- Produce a deterministic markdown repo map constrained by a token budget.

It also provides a tree-sitter-based path for richer symbol extraction with graceful fallback to regex extraction when optional runtime dependencies are unavailable.

## Structure
- `symbol-extractor.ts`
  - Defines `ExtractedSymbol`.
  - Uses ordered regex patterns to detect `class`, `interface`, `enum`, `type`, `function`, and `const` declarations line-by-line.
  - Skips blank lines and comment-prefixed lines.

- `tree-sitter-extractor.ts`
  - Defines `SupportedLanguage`, `EXTENSION_MAP`, and `ASTSymbol`.
  - Dynamically imports `web-tree-sitter` and lazily loads grammars from `tree-sitter-wasms`.
  - Walks AST nodes using per-language node-kind maps.
  - Falls back to regex-derived symbols for TypeScript/JavaScript and returns `[]` for unsupported/non-TS/JS fallback paths.
  - Contains `_resetTreeSitterCache()` helper used by tests.

- `import-graph.ts`
  - Defines `ImportEdge` and `ImportGraph`.
  - Parses static `import ... from '...'` forms via regex.
  - Resolves only relative imports against known file paths.
  - Builds edge list plus `importedBy()`, `importsFrom()`, and `roots()` lookups.

- `repo-map-builder.ts`
  - Defines `RepoMapConfig` and `RepoMap`.
  - Applies exclude-pattern filtering (substring matching).
  - Extracts symbols, computes import-reference counts, scores symbols, sorts deterministically, and emits markdown within `maxTokens`.
  - Uses `chars/4` token estimation.

- `index.ts`
  - Barrel exports for all public repomap APIs and types.

## Runtime and Control Flow
1. Symbol extraction path
- `extractSymbols(filePath, content)` scans each line and matches the first declaration pattern per line.
- `extractSymbolsAST(filePath, content)` detects language by extension, attempts tree-sitter parser/grammar initialization, parses and walks AST, then deduplicates symbols by `name:line:kind`.
- Any parser/grammar/runtime failure routes to fallback behavior.

2. Import graph path
- `buildImportGraph(files, rootDir)` resolves each file to absolute path, scans imports with `IMPORT_RE`, resolves only relative specifiers, and stores `{ from, to, symbols }` edges.
- Lookup maps are precomputed for reverse/forward traversal.

3. Repo map path
- `buildRepoMap(files, config?)` merges defaults (`maxTokens: 4000`) and filters by `excludePatterns`.
- Extracts symbols using the regex extractor.
- Builds import graph to compute per-file inbound reference count.
- Scores symbols using kind weights + export bonus + ref bonus + focus bonus.
- Sorts by `score desc`, then `filePath asc`, then `line asc`.
- Groups by file, emits markdown sections (`## <file>`, `- <signature>`) until budget is reached.
- Returns `{ content, symbolCount, fileCount, estimatedTokens }`.

## Key APIs and Types
Primary exported APIs from `src/repomap/index.ts`:
- `extractSymbols(filePath, content): ExtractedSymbol[]`
- `extractSymbolsAST(filePath, content): Promise<ASTSymbol[]>`
- `isTreeSitterAvailable(language?): Promise<boolean>`
- `detectLanguage(filePath): SupportedLanguage | undefined`
- `buildImportGraph(files, rootDir): ImportGraph`
- `buildRepoMap(files, config?): RepoMap`
- `EXTENSION_MAP`

Primary types:
- `ExtractedSymbol`
- `ASTSymbol`
- `SupportedLanguage`
- `ImportEdge`
- `ImportGraph`
- `RepoMapConfig`
- `RepoMap`

Notable behavior details reflected in code:
- `buildRepoMap` currently uses `extractSymbols` (regex), not `extractSymbolsAST`.
- Import parsing handles `import ... from` forms (named, namespace, default, `import type`) and ignores bare package imports.
- Relative import resolution includes `.js/.mjs -> .ts`, `.ts` suffix fallback, and `index.ts` directory fallback.

## Dependencies
Runtime dependencies inside this subsystem:
- Node built-ins:
  - `node:path` (`import-graph.ts`, `repo-map-builder.ts`, `tree-sitter-extractor.ts`)
  - `node:module` via dynamic `createRequire` in `tree-sitter-extractor.ts`

Optional runtime peers used by AST extraction:
- `web-tree-sitter`
- `tree-sitter-wasms`

Package-level context (`packages/codegen/package.json`):
- These tree-sitter dependencies are declared as optional peer dependencies.

## Integration Points
Internal integrations in `packages/codegen/src`:
- `chunking/ast-chunker.ts`
  - Uses `extractSymbolsAST`, `detectLanguage`, and `ASTSymbol` for AST-aware chunking.
- `search/code-search-service.ts`
  - Uses repomap `detectLanguage` for indexing metadata when caller does not supply language.
- `search/code-search-types.ts`
  - Re-exports `ASTSymbol` in search-facing type surface.
- `guardrails/guardrail-types.ts`
  - `GuardrailContext` optionally includes `repoMap?: RepoMap`.

Package root export surface (`packages/codegen/src/index.ts`):
- Re-exports repomap APIs at package level.
- Aliases repomap language detector as `detectTreeSitterLanguage` to avoid clashing with generation-level `detectLanguage`.

Cross-package usage:
- No direct imports of repomap internals were found outside `packages/codegen`.

## Testing and Observability
Test coverage in this package includes multiple repomap-focused suites:
- `src/__tests__/repomap/symbol-extractor.test.ts`
- `src/__tests__/repomap/import-graph.test.ts`
- `src/__tests__/repomap/repo-map-builder.test.ts`
- `src/__tests__/repo-map.test.ts`
- `src/__tests__/import-graph-extended.test.ts`
- `src/__tests__/tree-sitter-extractor.test.ts`
- `src/__tests__/codegen-multiedit-repomap-deep.test.ts`
- `src/__tests__/branch-coverage-misc.test.ts` (includes repo-map branch cases)

What these tests emphasize:
- Symbol extraction correctness for declaration forms, exported flags, signatures, and line tracking.
- Import graph resolution edge cases (`.js/.mjs`, nested relative paths, circular refs, self-import, root detection).
- Repo-map ranking and budgeting invariants (kind weights, export/ref/focus scoring effects, deterministic output, tiny/large budgets, exclude patterns).
- Tree-sitter extractor graceful behavior with and without optional tree-sitter dependencies.

Observability characteristics of runtime code:
- No dedicated logging/metrics/tracing in repomap modules.
- Primary runtime introspection is through return values:
  - `ImportGraph` query helpers (`importedBy`, `importsFrom`, `roots`)
  - `RepoMap` summary counters (`symbolCount`, `fileCount`, `estimatedTokens`)

## Risks and TODOs
Current implementation tradeoffs and gaps visible in code:
- Regex symbol extraction is intentionally approximate and line-based.
- `buildRepoMap` scoring/extraction is TS/JS-centric because it uses regex extraction rather than AST extraction.
- Import parsing is limited to static `import ... from` forms and does not model side-effect-only imports or `require()`.
- Exclusion uses substring matching, not glob semantics.
- Token estimation is heuristic (`chars/4`) and model-agnostic.
- Tree-sitter quality depends on optional dependencies being installed and grammar WASM files being resolvable at runtime.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

