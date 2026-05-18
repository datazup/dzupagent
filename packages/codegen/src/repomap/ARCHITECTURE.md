# Repomap Architecture (`src/repomap`)

## Scope
This document covers the repo-map subsystem in `packages/codegen/src/repomap` and its package-level integration points in `packages/codegen`.

Files in scope:
- `src/repomap/index.ts`
- `src/repomap/symbol-extractor.ts`
- `src/repomap/import-graph.ts`
- `src/repomap/repo-map-builder.ts`
- `src/repomap/tree-sitter-extractor.ts`
- `src/repomap/tree-sitter-extractor-types.ts`
- `src/repomap/tree-sitter-extractor-loader.ts`
- `src/repomap/tree-sitter-extractor-grammars.ts`
- `src/repomap/tree-sitter-extractor-node-helpers.ts`
- `src/repomap/tree-sitter-extractor-walker.ts`

This subsystem provides symbol extraction primitives, import-graph analysis, and token-budgeted markdown repo-map generation used by `@dzupagent/codegen` internals and exports.

## Responsibilities
The subsystem currently owns three primary capabilities:
- Regex symbol extraction from source text (`extractSymbols`).
- Optional tree-sitter-backed AST extraction with graceful fallback (`extractSymbolsAST`).
- Import graph construction and repo-map ranking/rendering (`buildImportGraph`, `buildRepoMap`).

Concrete behavior in current code:
- Symbol extraction captures `class`, `interface`, `enum`, `type`, `function`, and `const` declarations.
- Import graph resolution only links relative imports that can be resolved to files in the provided file set.
- Repo map output is deterministic markdown constrained by a configurable token budget (`maxTokens`, default `4000`).

## Structure
- `index.ts`
  - Barrel exports for all public repomap APIs and types.

- `symbol-extractor.ts`
  - Defines `ExtractedSymbol`.
  - Implements line-by-line regex extraction with ordered declaration patterns.
  - Skips blank lines and comment-prefixed lines (`//`, `/*`, `*`).

- `import-graph.ts`
  - Defines `ImportEdge` and `ImportGraph`.
  - Parses `import ... from '...'` forms (named, namespace, default, `import type`).
  - Resolves relative imports with `.js/.mjs -> .ts`, `.ts` suffix, and `index.ts` fallbacks.
  - Exposes graph query helpers: `importedBy`, `importsFrom`, `roots`.

- `repo-map-builder.ts`
  - Defines `RepoMapConfig` and `RepoMap`.
  - Filters files via substring-based `excludePatterns`.
  - Uses regex symbol extraction and import graph reference counts for scoring.
  - Produces `## <file>` sections and `- <symbol>` lines within token budget.

- `tree-sitter-extractor.ts`
  - Public coordinator for AST extraction.
  - Wires loader, grammars, and walker modules.
  - Re-exports tree-sitter-facing types/utilities.

- `tree-sitter-extractor-types.ts`
  - Public types: `SupportedLanguage`, `ASTSymbol`, `EXTENSION_MAP`.
  - Opaque internal `TS*` interfaces that mirror `web-tree-sitter` runtime shapes.

- `tree-sitter-extractor-loader.ts`
  - Lazy parser constructor loading (`web-tree-sitter` dynamic import).
  - Grammar loading (`tree-sitter-wasms`) with language cache.
  - Language detection by extension and availability checks.
  - Cache reset helper for tests.

- `tree-sitter-extractor-grammars.ts`
  - Language-specific node-kind maps used by AST walker.
  - Mapping from `SupportedLanguage` to grammar WASM filenames.

- `tree-sitter-extractor-node-helpers.ts`
  - Symbol detail extraction helpers: name, export status, signature, docstring, parameters, return type.

- `tree-sitter-extractor-walker.ts`
  - Recursive AST traversal that builds `ASTSymbol[]`.
  - Handles TS/JS `lexical_declaration` classification (`function` vs `const`) based on value node type.

## Runtime and Control Flow
1. Regex extraction path
- `extractSymbols(filePath, content)` splits content by line and tests ordered regex patterns.
- On first match per line, it emits one `ExtractedSymbol` with normalized `signature`, `line`, `exported`, and `filePath`.

2. AST extraction path
- `extractSymbolsAST(filePath, content)` calls `detectLanguage(filePath)`.
- For supported extensions (`.ts/.tsx/.js/.jsx/.mjs/.py/.go/.rs/.java`), it attempts:
  - lazy parser init (`getParserCtor`),
  - grammar load (`loadLanguage`),
  - parse + AST walk (`walkTree`).
- It deduplicates AST results by `name:line:kind`.
- Any failure falls back to regex conversion for TypeScript/JavaScript.
- Fallback for non-TS/JS languages returns `[]` when AST parsing is unavailable.

3. Import graph path
- `buildImportGraph(files, rootDir)` resolves every input file to absolute path.
- It runs `IMPORT_RE` against each file and resolves only relative specifiers.
- It emits edges `{ from, to, symbols }` and precomputes lookup maps for:
  - `importedBy(filePath)`
  - `importsFrom(filePath)`
  - `roots()` (files with no outgoing imports).

4. Repo-map path
- `buildRepoMap(files, config?)` merges config with defaults.
- Excluded files are filtered by substring matches.
- Symbols are extracted via `extractSymbols` (regex path).
- File-level reference counts come from import-graph inbound edges.
- Score calculation per symbol:
  - kind weight: class/interface `+3`, function/enum `+2`, type/const `+1`
  - export bonus: `+3`
  - inbound file import count: `+N`
  - focus file bonus: `+5`
- Sorted output: score desc, then file path asc, then line asc.
- Markdown rendering stops when adding another heading or symbol would exceed `maxTokens` (estimated as `ceil(chars/4)`).

## Key APIs and Types
Public exports from `src/repomap/index.ts`:
- `extractSymbols(filePath, content): ExtractedSymbol[]`
- `extractSymbolsAST(filePath, content): Promise<ASTSymbol[]>`
- `isTreeSitterAvailable(language?): Promise<boolean>`
- `detectLanguage(filePath): SupportedLanguage | undefined`
- `EXTENSION_MAP`
- `buildImportGraph(files, rootDir): ImportGraph`
- `buildRepoMap(files, config?): RepoMap`

Public types:
- `ExtractedSymbol`
- `ASTSymbol`
- `SupportedLanguage`
- `ImportEdge`
- `ImportGraph`
- `RepoMapConfig`
- `RepoMap`

Package-level export behavior in `src/index.ts`:
- Repomap APIs are re-exported at package root.
- `repomap.detectLanguage` is aliased as `detectTreeSitterLanguage` to avoid colliding with generation-level `detectLanguage`.

## Dependencies
Direct runtime dependencies in this subsystem:
- Node built-ins:
  - `node:path` (`import-graph`, `repo-map-builder`, `tree-sitter-extractor-loader`)
  - `node:module` (dynamic `createRequire` in `tree-sitter-extractor-loader`)

Optional runtime peer dependencies used by AST extraction:
- `web-tree-sitter`
- `tree-sitter-wasms`

Package-level declared dependencies relevant to this subsystem:
- `zod` is a package peer but not used directly in `src/repomap/*`.
- `@dzupagent/core` and `@dzupagent/adapter-types` are package dependencies, not direct imports of repomap modules.

## Integration Points
Internal codegen usage:
- `src/chunking/ast-chunker.ts`
  - Uses `extractSymbolsAST`, `detectLanguage`, and `ASTSymbol` for AST-aware chunking.
- `src/search/code-search-service.ts`
  - Uses tree-sitter `detectLanguage` for language inference fallback.
- `src/search/code-search-types.ts`
  - Imports `ASTSymbol` type from repomap tree-sitter types.
- `src/guardrails/guardrail-types.ts`
  - Accepts optional `repoMap?: RepoMap` in `GuardrailContext`.

Export surfaces:
- `src/index.ts` re-exports repomap APIs/types.
- `src/compat.ts` re-exports `./repomap/index.js` as part of compatibility surface.

Documentation references in package docs:
- `docs/api-tiers.md` lists repo-map API as part of stable API surface.
- `docs/ARCHITECTURE.md` references repomap as part of code intelligence utilities.

## Testing and Observability
Repomap-specific tests:
- `src/__tests__/repomap/symbol-extractor.test.ts`
- `src/__tests__/repomap/import-graph.test.ts`
- `src/__tests__/repomap/repo-map-builder.test.ts`

Additional cross-module tests covering repomap behavior:
- `src/__tests__/repo-map.test.ts`
- `src/__tests__/import-graph-extended.test.ts`
- `src/__tests__/tree-sitter-extractor.test.ts`
- `src/__tests__/branch-coverage-misc.test.ts`
- `src/__tests__/codegen-multiedit-repomap-deep.test.ts`

Current observability profile:
- No dedicated logging, metrics, or tracing in `src/repomap/*`.
- Runtime insight is available via returned structures:
  - `ImportGraph.edges` and helper lookups.
  - `RepoMap` counters (`symbolCount`, `fileCount`, `estimatedTokens`) and markdown output.

## Risks and TODOs
Known limitations in current implementation:
- `buildRepoMap` uses regex extraction (`extractSymbols`) and does not consume AST symbols today.
- Regex extraction is line-based and intentionally approximate.
- Import parsing covers static `import ... from` forms only; side-effect imports (`import './x'`) and `require()` are not modeled.
- `excludePatterns` are substring checks, not glob/ignore semantics.
- Token counting uses a fixed heuristic (`chars / 4`) and is model-agnostic.
- AST extraction quality for non-TS/JS languages depends on optional `web-tree-sitter` + `tree-sitter-wasms` availability at runtime.

Potential near-term TODO candidates implied by current design:
- Optionally support AST-backed scoring/rendering in `buildRepoMap`.
- Expand import graph parsing coverage for additional import forms if needed by consumers.
- Add explicit observability hooks when repo-map ranking decisions need runtime introspection.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js