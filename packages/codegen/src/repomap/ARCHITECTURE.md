# `src/repomap` Architecture

This document describes the current implementation in `packages/codegen/src/repomap` as of **April 4, 2026**.

## 1. Scope

`src/repomap` provides structural code understanding primitives used by `@dzupagent/codegen`:

1. Symbol extraction from source text (`regex` and optional `tree-sitter` AST).
2. Import relationship graph construction for in-repo relative imports.
3. Token-budgeted repository map generation (`buildRepoMap`) for LLM context packing.

It is intentionally lightweight and dependency-tolerant:

1. Works without `web-tree-sitter` installed (fallback behavior).
2. Uses deterministic scoring and stable sort order for map output.
3. Exposes focused primitives that higher layers (chunking/search/context) can compose.

## 2. File Map

| File | Responsibility |
|---|---|
| `symbol-extractor.ts` | Regex-based symbol extraction for TS/JS-like declarations (`class`, `interface`, `function`, `type`, `enum`, `const`) |
| `tree-sitter-extractor.ts` | Multi-language AST extraction (`typescript`, `javascript`, `python`, `go`, `rust`, `java`) with graceful fallback |
| `import-graph.ts` | Relative-import dependency graph builder with resolution helpers (`.js/.mjs -> .ts`, `index.ts`) |
| `repo-map-builder.ts` | Ranking + token-budgeted markdown map generation over extracted symbols |
| `index.ts` | Public barrel exports for repomap APIs |

## 3. Public API Surface

From `repomap/index.ts` and package root exports (`packages/codegen/src/index.ts`):

1. `extractSymbols(filePath, content): ExtractedSymbol[]`
2. `extractSymbolsAST(filePath, content): Promise<ASTSymbol[]>`
3. `isTreeSitterAvailable(language?): Promise<boolean>`
4. `detectLanguage(filePath): SupportedLanguage | undefined`
5. `buildImportGraph(files, rootDir): ImportGraph`
6. `buildRepoMap(files, config?): RepoMap`

Primary public types:

1. `ExtractedSymbol`
2. `ASTSymbol`
3. `ImportEdge`, `ImportGraph`
4. `RepoMapConfig`, `RepoMap`

## 4. Feature Catalog (Behavior + Description)

## 4.1 Regex symbol extraction (`symbol-extractor.ts`)

What it does:

1. Scans file content line-by-line.
2. Skips blank lines and comment-prefixed lines.
3. Applies ordered regex patterns and captures first match per line.
4. Returns a normalized symbol record with kind, signature, export flag, and line.

Supported kinds:

1. `class`
2. `interface`
3. `function`
4. `type`
5. `enum`
6. `const`

Notable behavior:

1. Pattern order matters; only first matching kind is emitted per line.
2. `signature` strips `export` prefix and trailing braces.
3. Designed for TypeScript/JavaScript declaration forms (not full language grammar).

## 4.2 AST symbol extraction with fallback (`tree-sitter-extractor.ts`)

What it does:

1. Detects language from file extension.
2. Dynamically imports `web-tree-sitter` if available.
3. Loads grammar WASM from optional `tree-sitter-wasms` package.
4. Walks AST recursively and emits rich `ASTSymbol` objects.
5. Falls back to regex extraction when parser or grammar is unavailable.

Additional AST fields beyond regex:

1. `endLine`, `column`, `endColumn`
2. `parent` (nested ownership)
3. `language`
4. `docstring` (best-effort preceding comment)
5. `parameters` and `returnType` (best-effort)

Fallback model:

1. For `typescript`/`javascript`: regex results are converted into `ASTSymbol` shape.
2. For unsupported/non-TSJS fallback paths: returns `[]`.
3. Any parse/load error is swallowed and converted to fallback output.

## 4.3 Import graph generation (`import-graph.ts`)

What it does:

1. Parses static `import ... from '...'` forms using regex.
2. Resolves only relative specifiers (`./`, `../`) against known file set.
3. Builds edge list: `from -> to` with imported symbol names.
4. Precomputes reverse and forward lookups.

Resolution rules:

1. Bare/package imports are ignored.
2. `.js` / `.mjs` specifiers are normalized to `.ts` for in-repo matching.
3. Missing extension tries `+ '.ts'`.
4. Directory import tries `index.ts`.

Exposed graph queries:

1. `importedBy(filePath)`
2. `importsFrom(filePath)`
3. `roots()` (files with no outgoing imports)

## 4.4 Token-budgeted repo map generation (`repo-map-builder.ts`)

What it does:

1. Filters input files by `excludePatterns` (substring match).
2. Extracts symbols from each included file (`extractSymbols`).
3. Builds import graph and counts per-file inbound references.
4. Scores each symbol.
5. Sorts deterministically by score, then file path, then line.
6. Emits markdown sections per file until token budget is consumed.

Scoring formula:

1. Base by kind weight:
   - `class/interface = 3`
   - `function/enum = 2`
   - `type/const = 1`
2. `+3` if exported
3. `+N` where `N = inbound import count of symbol's file`
4. `+5` if symbol file is in `focusFiles`

Budgeting model:

1. Token estimate is `ceil(chars / 4)` heuristic.
2. Emits file header (`## path`) + symbol bullet lines (`- signature`).
3. Stops when next section/symbol would exceed `maxTokens`.
4. Returns final `content`, `symbolCount`, `fileCount`, `estimatedTokens`.

## 5. Internal Flow

## 5.1 `extractSymbolsAST` flow

```text
extractSymbolsAST(filePath, content)
  -> detectLanguage(extension)
  -> unsupported language? regexFallback
  -> getParserCtor() dynamic import web-tree-sitter
  -> parser unavailable? regexFallback
  -> loadLanguage(WASM)
  -> grammar unavailable? regexFallback
  -> parse + walkTree(root)
  -> dedupe (name:line:kind)
  -> return AST symbols
  -> on any error: regexFallback
```

## 5.2 `buildImportGraph` flow

```text
buildImportGraph(files, rootDir)
  -> knownPaths = absolute file set
  -> for each file:
       regex scan import declarations
       resolve relative specifier to known path
       push edge(from,to,symbols)
  -> build byImporter and byImported maps
  -> return edges + lookup helpers + roots()
```

## 5.3 `buildRepoMap` flow

```text
buildRepoMap(files, config)
  -> merge default config
  -> exclude files by substring patterns
  -> extract symbols per included file
  -> if no symbols: return empty map
  -> build import graph + inbound importer counts
  -> score symbols (kind/export/ref/focus bonuses)
  -> stable sort by score/path/line
  -> group by file in ranked order
  -> append markdown within maxTokens budget
  -> return RepoMap summary object
```

## 6. Usage Examples

## 6.1 Quick symbol extraction (regex)

```ts
import { extractSymbols } from '@dzupagent/codegen'

const code = `
export interface User { id: string }
export class UserService {}
const internal = 1
`

const symbols = extractSymbols('src/user.ts', code)
// [
//   { name: 'User', kind: 'interface', exported: true, ... },
//   { name: 'UserService', kind: 'class', exported: true, ... },
//   { name: 'internal', kind: 'const', exported: false, ... },
// ]
```

## 6.2 AST extraction with fallback safety

```ts
import { extractSymbolsAST, isTreeSitterAvailable } from '@dzupagent/codegen'

const available = await isTreeSitterAvailable('typescript')
const symbols = await extractSymbolsAST('src/service.ts', source)

console.log({ available, first: symbols[0] })
// If tree-sitter is available: rich ASTSymbol fields are populated.
// If not: TS/JS regex fallback still returns symbol records.
```

## 6.3 Building an import graph

```ts
import { buildImportGraph } from '@dzupagent/codegen'

const files = [
  { path: 'src/index.ts', content: "import { A } from './a'" },
  { path: 'src/a.ts', content: 'export const A = 1' },
]

const graph = buildImportGraph(files, '/project')
console.log(graph.edges)
console.log(graph.importedBy('src/a.ts'))
console.log(graph.importsFrom('src/index.ts'))
```

## 6.4 Building a budgeted repo map

```ts
import { buildRepoMap } from '@dzupagent/codegen'

const map = buildRepoMap(files, {
  maxTokens: 800,
  focusFiles: ['src/service.ts'],
  excludePatterns: ['node_modules', 'dist', '.test.ts'],
})

console.log(map.content)
console.log(map.symbolCount, map.fileCount, map.estimatedTokens)
```

## 7. Practical Use Cases

1. LLM context compression:
   - Produce compact structure summaries under strict token budget before prompt assembly.
2. Priority context selection:
   - Use `focusFiles` and import centrality bonuses to bias toward likely-impact files.
3. Code search/indexing bootstrap:
   - Use `extractSymbolsAST` and language detection in chunking/search workflows.
4. Dependency-aware architecture insight:
   - Use `buildImportGraph` to inspect local coupling and module fan-in/fan-out.
5. Multi-language symbol probing:
   - Use AST extraction for Python/Go/Rust/Java when optional tree-sitter stack is installed.

## 8. In-Repo References and Consumers

## 8.1 Direct consumers inside `@dzupagent/codegen`

1. `packages/codegen/src/chunking/ast-chunker.ts`
   - Uses `extractSymbolsAST` + `detectLanguage` to create AST-aware chunks.
2. `packages/codegen/src/search/code-search-service.ts`
   - Uses `detectLanguage` during file indexing.
3. `packages/codegen/src/search/code-search-types.ts`
   - Re-exports `ASTSymbol` in search type surface.
4. `packages/codegen/src/guardrails/guardrail-types.ts`
   - Optional `repoMap?: RepoMap` in `GuardrailContext` type.
5. `packages/codegen/src/index.ts`
   - Re-exports all repomap APIs at package root.

## 8.2 References in other monorepo packages

Current status from repository-wide search:

1. No direct imports of `packages/codegen/src/repomap/*` outside `packages/codegen`.
2. No external package currently imports repomap symbols from `@dzupagent/codegen` by name.

Related package-level consumption of `@dzupagent/codegen` (non-repomap capabilities):

1. `packages/server/src/runtime/tool-resolver.ts`
   - Dynamically imports `@dzupagent/codegen` for git tooling (`createGitTools`, `GitExecutor`).
2. `packages/evals/src/__tests__/sandbox-contracts.test.ts`
   - Dynamically imports sandbox classes (`MockSandbox`, `DockerSandbox`) when available.
3. `packages/create-dzupagent/src/templates/codegen.ts`
   - Scaffolds `@dzupagent/codegen` as a dependency.

Net: repomap is currently primarily an internal subsystem with public exports available for future adopters.

## 9. Test Coverage and Validation

## 9.1 Executed tests (April 4, 2026)

Command executed:

```bash
yarn workspace @dzupagent/codegen test -- src/__tests__/repo-map.test.ts src/__tests__/import-graph-extended.test.ts src/__tests__/tree-sitter-extractor.test.ts
```

Result:

1. `3` test files passed.
2. `89` tests passed.
3. No test failures.

Breakdown:

1. `repo-map.test.ts`: `35` tests
2. `import-graph-extended.test.ts`: `25` tests
3. `tree-sitter-extractor.test.ts`: `29` tests

## 9.2 Coverage snapshot for `repomap`

Coverage command run (same 3 focused test files):

```bash
yarn workspace @dzupagent/codegen test:coverage -- src/__tests__/repo-map.test.ts src/__tests__/import-graph-extended.test.ts src/__tests__/tree-sitter-extractor.test.ts
```

Observed repomap coverage:

1. `repomap/` aggregate: `71.14%` statements, `88.46%` branches, `61.53%` functions, `71.14%` lines.
2. `import-graph.ts`: `100%` statements/branches/functions/lines.
3. `repo-map-builder.ts`: `100%` statements/functions/lines, `86.95%` branches.
4. `symbol-extractor.ts`: `100%` statements/branches/functions/lines.
5. `tree-sitter-extractor.ts`: `50.15%` statements/lines, `68.42%` branches, `37.5%` functions.

Important note:

1. The coverage command exits non-zero because `packages/codegen/vitest.config.ts` enforces package-wide global thresholds, while this run executes only a focused subset of tests.
2. This is expected for targeted module-only coverage runs.

## 9.3 Coverage gaps to prioritize

1. `tree-sitter-extractor.ts` runtime branches when `web-tree-sitter` and WASM grammars are fully available.
2. Error-path and grammar-load failure permutations in `extractSymbolsAST`.
3. Non-TS/JS AST extraction assertions that currently only verify "returns array" behavior.

## 10. Constraints, Tradeoffs, and Risks

1. Regex extraction precision:
   - Fast and dependency-light, but line-oriented regex cannot fully model language syntax.
2. Optional runtime dependencies:
   - Rich AST quality depends on optional peers (`web-tree-sitter`, `tree-sitter-wasms`) being installed.
3. Import parsing scope:
   - `import-graph` covers static `import ... from` patterns, not dynamic imports or CommonJS `require`.
4. Exclude pattern semantics:
   - `buildRepoMap` uses substring matching, not full glob engine.
5. Token estimation:
   - `chars/4` heuristic is deterministic but model-agnostic approximation.

## 11. Suggested Next Improvements

1. Add integration tests with real installed tree-sitter + WASM fixtures to raise `tree-sitter-extractor` confidence.
2. Expand import parsing for additional syntax forms (side-effect imports and optional CJS paths if needed).
3. Consider optional AST-based symbol source for `buildRepoMap` to improve multi-language and nested-symbol quality.
4. Introduce configurable exclude matcher mode (substring vs glob) for better control in large repos.
