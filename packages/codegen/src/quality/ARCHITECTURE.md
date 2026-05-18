# `src/quality` Architecture

## Scope
`src/quality` contains static quality and coherence analysis utilities used by `@dzupagent/codegen`. All analyzers operate on in-memory code snapshots and regex/string heuristics; they do not execute tests, run typecheck/lint processes, or parse ASTs.

Files in scope:
- `quality-types.ts`: shared contracts for quality dimensions and aggregate results.
- `quality-scorer.ts`: weighted aggregator over `QualityDimension` implementations.
- `quality-dimensions.ts`: built-in dimensions for strictness/hygiene/completeness/test/docs checks.
- `coverage-analyzer.ts`: static source-to-test coverage approximation and prioritization of uncovered files.
- `import-validator.ts`: import coherence validator over `Map`/`Record` snapshots with unresolved/self/circular issue detection.
- `contract-validator.ts`: backend endpoint vs frontend API call contract validation.
- `convention-gate.ts`: confidence-filtered convention enforcement with built-in conventions and custom extension points.

Out of scope:
- sandbox execution (`src/sandbox/*`),
- VFS-based import validator in `src/validation/import-validator.ts` (separate API and result shape),
- pipeline execution/runtime orchestration (quality is plugged in by callers).

## Responsibilities
- Provide a deterministic `QualityScorer` API that normalizes dimension scores to `0..100` and flattens diagnostics.
- Provide opinionated default `QualityDimension`s via `builtinDimensions`.
- Provide standalone analyzers for:
  - test coverage heuristics (`analyzeCoverage`, `findUncoveredFiles`),
  - import coherence and graph issues (`validateImports` in `src/quality/import-validator.ts`),
  - backend/frontend API contract matching (`extractEndpoints`, `extractAPICalls`, `validateContracts`),
  - convention-gate checks (`ConventionGate` and related types).
- Keep module-level behavior side-effect free so it can be reused from tools, pipeline validation phases, and tests.

## Structure
- `quality-types.ts`
  - `QualityContext`, `DimensionResult`, `QualityResult`, `QualityDimension`.
- `quality-scorer.ts`
  - `QualityScorer` with mutable dimension registration (`addDimension`, `addDimensions`) and async `evaluate`.
- `quality-dimensions.ts`
  - built-ins: `typeStrictness`, `eslintClean`, `hasTests`, `codeCompleteness`, `hasJsDoc`.
  - `builtinDimensions` ordered array of those five dimensions.
- `coverage-analyzer.ts`
  - `CoverageReport`, `CoverageConfig`, `analyzeCoverage`, `findUncoveredFiles`.
- `import-validator.ts`
  - `ImportIssue`, `ImportValidationResult`, `validateImports(files, rootDir?)`.
- `contract-validator.ts`
  - `APIEndpoint`, `APICall`, `ContractIssue`, `ContractValidationResult`,
  - `extractEndpoints`, `extractAPICalls`, `validateContracts`.
- `convention-gate.ts`
  - convention model and categories (`LearnedConvention`, `ConventionCategory`),
  - gate configuration/result (`ConventionGateConfig`, `ConventionGateResult`),
  - evaluator class (`ConventionGate` + `withDefaults`).

## Runtime and Control Flow
Primary scoring flow:
1. Caller builds a file snapshot (`Record<string, string>`) and optional `QualityContext`.
2. Caller creates `QualityScorer` and registers dimensions.
3. `QualityScorer.evaluate` runs dimensions concurrently via `Promise.all`.
4. Aggregation logic computes:
   - `quality = round((sum(score) / sum(maxScore)) * 100)` (or `0` when no dimensions),
   - `success = errors.length === 0`,
   - flattened `errors` and `warnings`.
5. Caller consumes the result for validation gates or correction loop decisions.

Standalone analyzer flows:
- `analyzeCoverage` filters candidate source files by glob-like patterns, excludes configured paths, matches test files by base name/path conventions, and returns covered/uncovered arrays with ratio.
- `findUncoveredFiles` uses `analyzeCoverage` output and ranks uncovered files by `lineCount * max(exportCount, 1)`.
- `validateImports` builds a file adjacency graph from relative static and dynamic imports, validates path resolution with extension/index fallbacks, then DFS-detects cycles.
- `validateContracts` extracts backend endpoints and frontend calls line-by-line, matches by normalized path + method, and reports unmatched/mismatched issues.
- `ConventionGate.evaluate` filters conventions by `minConfidence`, checks each file against custom tests and/or regex patterns, and returns pass/fail plus violation counts.

## Key APIs and Types
- `QualityScorer`
  - `addDimension(dimension: QualityDimension): this`
  - `addDimensions(dimensions: QualityDimension[]): this`
  - `evaluate(vfs: Record<string, string>, context?: QualityContext): Promise<QualityResult>`
- Built-in dimensions (`quality-dimensions.ts`)
  - `typeStrictness` (`maxPoints: 15`): flags `: any`, `<any>`, `as any`, `@ts-ignore`, `@ts-nocheck`.
  - `eslintClean` (`10`): warns on `console.log`, `debugger`, `alert(` in non-test source files.
  - `hasTests` (`10`): checks for sibling `.test/.spec` files for source files (excluding `index.*` source files).
  - `codeCompleteness` (`10`): errors on empty function bodies; warns on non-comment `TODO`/`FIXME` markers.
  - `hasJsDoc` (`5`): warns when exported function/class/const declarations lack nearby doc-comment markers.
  - `builtinDimensions: QualityDimension[]` (current total possible points: `50`).
- Coverage API
  - `analyzeCoverage(files, config?) => CoverageReport`
  - `findUncoveredFiles(files, config?) => Array<{ filePath; priority; reason }>`
- Import coherence API (`src/quality/import-validator.ts`)
  - `validateImports(files: Map<string, string> | Record<string, string>, rootDir = '') => ImportValidationResult`
  - issue variants: `'unresolved' | 'circular' | 'self-import'`.
- Contract API
  - `extractEndpoints(files) => APIEndpoint[]`
  - `extractAPICalls(files) => APICall[]`
  - `validateContracts(backendFiles, frontendFiles) => ContractValidationResult`
  - `ContractValidationResult.valid` is driven by `unmatched-call` and `method-mismatch`; `unmatched-endpoint` is reported but does not invalidate.
- Convention API
  - `new ConventionGate(config: ConventionGateConfig)`
  - `ConventionGate.withDefaults(overrides?)`
  - `evaluate(files: Array<{ path: string; content: string }>) => ConventionGateResult`
  - built-in conventions include file naming, ESM import extensions, `no any`, `no @ts-ignore`, `no console.log`, `no var`, and export naming checks.

## Dependencies
Internal dependencies inside `src/quality` are minimal:
- `quality-scorer.ts` and `quality-dimensions.ts` depend on `quality-types.ts`.
- Other analyzers are self-contained and only use platform JS/TS features.

External runtime libraries are not imported directly by these quality files.

Package-level context:
- `@dzupagent/codegen` depends on `@dzupagent/core` and `@dzupagent/adapter-types`.
- quality integration with LangChain/Zod happens in `src/tools/validate.tool.ts` (outside `src/quality`), where `QualityScorer` is injected into a LangChain tool.

## Integration Points
- Package exports (`src/index.ts`)
  - quality core: `QualityScorer`, `QualityDimension`/result/context types.
  - dimensions: all five built-ins + `builtinDimensions`.
  - analyzers: `analyzeCoverage`, `findUncoveredFiles`, `validateImportCoherence` (alias of `src/quality/import-validator.ts`), contract extraction/validation APIs.
  - conventions: `ConventionGate` and convention model/result types.
- Runtime facade (`src/runtime.ts`)
  - re-exports only `quality-scorer`, `quality-dimensions`, and `quality-types` from this subsystem.
- Tooling integration (`src/tools/validate.tool.ts`)
  - `createValidateTool(scorer)` runs `scorer.evaluate(vfsSnapshot, context)` and returns structured JSON text with `quality`, `success`, `dimensions`, `errors`, `warnings`.
- Pipeline/correction integration
  - `src/pipeline/phase-types.ts` and `src/pipeline/gen-pipeline-builder.ts` reference `QualityDimension[]` + threshold in validation phase config.
  - `src/correction/correction-types.ts` and `src/correction/self-correction-loop.ts` use `qualityScore` and `qualityThreshold` in correction acceptance criteria.

## Testing and Observability
Direct quality-focused test coverage in `src/__tests__`:
- `quality-scorer.test.ts`
- `quality-dimensions.test.ts`
- `coverage-analyzer.test.ts`
- `import-validator-deep.test.ts` (covers both `src/quality/import-validator.ts` and `src/validation/import-validator.ts`)
- `contract-validator.test.ts`
- `convention-gate.test.ts`
- `validate-tool.test.ts` (integration of `QualityScorer` through tool wrapper)

Additional broader package tests (for example `code-review.test.ts`) also exercise some contract-validator behavior.

Observability characteristics:
- No built-in logging/metrics in `src/quality`.
- Diagnostics are returned as structured arrays:
  - `errors` / `warnings` for scorer/dimensions,
  - `issues` for import/contract validation,
  - `violations` for convention gate.

## Risks and TODOs
- Heuristic/regex limitations:
  - import extraction, endpoint/call extraction, JSDoc checks, and convention checks can miss complex syntax or produce false positives.
- Dual import-validator surface:
  - `src/validation/import-validator.ts` (VFS-based, `errors`) and `src/quality/import-validator.ts` (Map/Record-based, `issues`) overlap in purpose but differ in contract and feature set.
- Scoring semantics nuance:
  - `QualityScorer.success` is based on aggregated `errors` only; dimensions can return `passed: false` with warnings and still keep `success: true`.
- Coverage heuristic scope:
  - `coverage-analyzer` relies on naming/pattern conventions, not executed coverage.
- Contract normalization behavior:
  - path normalization lowercases and trims trailing slashes; method/path extraction is pattern-based and may not capture framework-specific abstractions or dynamic routing.
- Convention gate granularity:
  - custom `test` functions produce file-level violations (no line number), while regex pattern checks produce line-level violations.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

