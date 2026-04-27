# `src/quality` Architecture

## Scope
`src/quality` provides static, file-map-based quality analysis utilities for `@dzupagent/codegen`. The module works on in-memory snapshots (`Record<string, string>` or `Map<string, string>`) and does not execute compilers, linters, or tests.

The scope includes:
- weighted multi-dimension scoring (`quality-scorer.ts` + `quality-dimensions.ts`)
- static test-coverage approximation (`coverage-analyzer.ts`)
- import coherence checks across generated files (`import-validator.ts`)
- frontend/backend API contract coherence checks (`contract-validator.ts`)
- convention enforcement with confidence filtering (`convention-gate.ts`)
- shared scoring types (`quality-types.ts`)

It excludes runtime sandbox execution and AST/deep semantic validation.

## Responsibilities
- Provide a composable `QualityScorer` that aggregates independent quality dimensions into a normalized `0..100` score.
- Ship built-in dimensions for common guardrails: type strictness, debug-statement hygiene, test presence, code completeness, and JSDoc presence.
- Provide standalone static analyzers for:
  - test coverage heuristics (`analyzeCoverage`, `findUncoveredFiles`)
  - import graph validity and cycle detection (`validateImports`)
  - API call/endpoint contract validation (`validateContracts`)
  - learned/default convention gating (`ConventionGate`)
- Keep APIs deterministic and side-effect free so they can be run in tools, pipeline nodes, or tests.

## Structure
- `quality-types.ts`
  - shared interfaces: `QualityContext`, `DimensionResult`, `QualityResult`, `QualityDimension`.
- `quality-scorer.ts`
  - `QualityScorer` class with `addDimension`, `addDimensions`, and `evaluate`.
- `quality-dimensions.ts`
  - built-in `QualityDimension` implementations and `builtinDimensions`.
- `coverage-analyzer.ts`
  - static source/test matching and uncovered-file prioritization.
- `import-validator.ts`
  - multi-file relative import resolution, self-import detection, and cycle detection.
- `contract-validator.ts`
  - extraction of endpoints/API calls and mismatch reporting.
- `convention-gate.ts`
  - convention model (`LearnedConvention`) and `ConventionGate` evaluator.

## Runtime and Control Flow
1. Caller provides a file snapshot (`Record<string, string>`).
2. For scoring flows, caller constructs `QualityScorer` and registers one or more dimensions.
3. `QualityScorer.evaluate` executes all dimensions concurrently with `Promise.all`.
4. Scorer aggregates:
- `quality = round((sum(score) / sum(maxScore)) * 100)` (or `0` if no dimensions)
- `success = errors.length === 0`
- flattened `errors` and `warnings` across dimensions
5. Caller uses returned quality data for gating, reporting, or fix-loop decisions.

Standalone analyzers (`analyzeCoverage`, `validateImports`, `validateContracts`, `ConventionGate.evaluate`) execute independently and return their own result types without requiring `QualityScorer`.

## Key APIs and Types
- `QualityScorer`
  - `addDimension(dimension: QualityDimension): this`
  - `addDimensions(dimensions: QualityDimension[]): this`
  - `evaluate(vfs, context?): Promise<QualityResult>`
- Built-in dimensions (`quality-dimensions.ts`)
  - `typeStrictness` (`15` points): flags `any`, `@ts-ignore`, `@ts-nocheck` in `.ts/.tsx` excluding `.d.ts`
  - `eslintClean` (`10` points): warns on `console.log`, `debugger`, `alert()` in non-test source files
  - `hasTests` (`10` points): checks sibling `.test/.spec` files and skips `index.*`
  - `codeCompleteness` (`10` points): errors on empty bodies; warns on inline `TODO`/`FIXME` in code lines
  - `hasJsDoc` (`5` points): warns when exported function/class/const declarations lack nearby JSDoc
  - `builtinDimensions`: ordered array of the above dimensions
- Coverage analyzer
  - `analyzeCoverage(files, config?) => CoverageReport`
  - `findUncoveredFiles(files, config?) => { filePath, priority, reason }[]`
- Import coherence
  - `validateImports(files, rootDir?) => ImportValidationResult` with issues:
    - `unresolved`
    - `self-import`
    - `circular`
- Contract coherence
  - `extractEndpoints(files) => APIEndpoint[]`
  - `extractAPICalls(files) => APICall[]`
  - `validateContracts(backendFiles, frontendFiles) => ContractValidationResult`
- Convention gating
  - `ConventionGate` (`new ConventionGate(config)`)
  - `ConventionGate.withDefaults(overrides?)`
  - `evaluate(files) => ConventionGateResult`

## Dependencies
Inside `src/quality`, implementation is dependency-light:
- No imports from external libraries.
- `quality-scorer.ts` and `quality-dimensions.ts` depend only on `quality-types.ts`.
- Other analyzers are self-contained per file.

Package-level dependencies are provided by `@dzupagent/codegen`, but `src/quality` itself is currently pure TypeScript/regex logic.

## Integration Points
- Public package exports from `src/index.ts`:
  - quality types/scorer
  - all built-in dimensions
  - `analyzeCoverage`, `findUncoveredFiles`
  - `validateImportCoherence` (alias of `quality/import-validator.validateImports`)
  - `extractEndpoints`, `extractAPICalls`, `validateContracts`
  - `ConventionGate` and related convention types
- Tool integration:
  - `src/tools/validate.tool.ts` accepts a `QualityScorer` instance and exposes `validate_feature`, forwarding optional `QualityContext`.
- Pipeline/correction typing integration:
  - `src/pipeline/phase-types.ts` and `src/pipeline/gen-pipeline-builder.ts` reference `QualityDimension[]` and thresholds for validation phase configuration.
  - `src/correction/correction-types.ts` and `src/correction/self-correction-loop.ts` consume quality score fields (`qualityScore`, `qualityThreshold`) at the correction-loop contract level.

Important current-state note:
- `PipelineExecutor` does not directly run `QualityScorer`; quality execution is supplied by caller-provided phase logic/tools.

## Testing and Observability
Current tests under `src/__tests__` directly cover the quality module:
- `quality-scorer.test.ts`
  - scorer aggregation semantics, success/error flattening, zero-dimension behavior
  - includes built-in dimension coverage slices
- `quality-dimensions.test.ts`
  - detailed behavior and edge cases for all built-in dimensions
- `coverage-analyzer.test.ts`
  - source/test matching, exclusion behavior, ratio calculation, uncovered sorting
- `import-validator-deep.test.ts`
  - deep path/extension/index/cycle/self-import coverage for `quality/import-validator.ts`
- `contract-validator.test.ts`
  - endpoint/call extraction and contract mismatch handling
- `convention-gate.test.ts`
  - default rules, confidence filtering, warnings-only mode, custom conventions
- `validate-tool.test.ts`
  - tool-level integration that verifies scorer invocation and output shape

Observability characteristics:
- No internal logging/metrics inside `src/quality`.
- Diagnostics are returned as structured arrays (`errors`, `warnings`, `issues`, `violations`) for external logging/reporting.

## Risks and TODOs
- Heuristic-only analysis:
  - regex parsing may miss complex syntax patterns and can produce false positives/negatives.
- Dual import validators:
  - `src/quality/import-validator.ts` and `src/validation/import-validator.ts` provide overlapping capabilities with different data models; this can drift.
- Scoring semantics:
  - `QualityScorer.success` is based only on `errors`, while some dimensions can fail (`passed: false`) with warnings only; callers must choose gating logic intentionally.
- Coverage approximation:
  - `coverage-analyzer` uses naming conventions, not runtime coverage or execution traces.
- Contract extraction limits:
  - `contract-validator` targets common `router/app` and `axios/api/http/client/fetch` patterns and does not parse framework-specific abstractions beyond these regexes.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js