# Conventions Architecture

## Scope
This document covers the conventions module in `packages/codegen/src/conventions`:
- `convention-detector.ts`
- `convention-enforcer.ts`
- `index.ts`

It also references direct integration and verification points in the same package:
- package export entrypoints (`src/index.ts`, `src/compat.ts`, `package.json` export map)
- convention-focused tests in `src/__tests__`

## Responsibilities
The module has three concrete responsibilities:
- Detect repository style signals from an in-memory file map (`Record<string, string>`) and return a typed `ConventionReport`.
- Enforce a limited subset of convention names against file contents and return line-level `ConventionViolation` records with a numeric conformance score.
- Convert detected conventions into a prompt fragment (`conventionsToPrompt`) for downstream LLM usage.

Out of scope in current implementation:
- AST parsing
- filesystem IO (callers provide file content)
- auto-fixing/rewrite application
- logging, metrics, tracing, or event emission

## Structure
Module files:
- `convention-detector.ts`
  - Defines `DetectedConvention`, `ConventionReport`, and `detectConventions(files)`.
  - Uses private heuristic helpers: `detectNaming`, `detectFormatting`, `detectImports`, `detectPatterns`, `detectStructure`, `detectLanguage`, and `ratio`.
- `convention-enforcer.ts`
  - Defines `ConventionViolation`, `EnforcementResult`, `enforceConventions(files, conventions)`, and `conventionsToPrompt(conventions)`.
  - Uses `buildChecker(convention)` to map supported convention names to line checkers.
- `index.ts`
  - Barrel re-exports detector/enforcer APIs and types.

Supported checker names in `buildChecker`:
- `single-quotes`
- `double-quotes`
- `semicolons`
- `no-semicolons`
- `indent-2spaces`
- `indent-4spaces`
- `indent-tabs`
- `type-imports`

## Runtime and Control Flow
Detection flow (`detectConventions`):
1. Read `paths = Object.keys(files)` and flatten all file content to line arrays.
2. Run naming, formatting, import, pattern, and structure detectors.
3. Infer language from file extensions (`.ts/.tsx` vs `.js/.jsx`; ties resolve to `typescript`).
4. Filter conventions below confidence `0.1`.
5. Return `ConventionReport` with `conventions`, `language`, and `filesAnalyzed`.

Notable detection heuristics:
- Formatting/import/pattern conventions generally require at least 3 observations (`> 2`) before emitting.
- Structure detection emits `barrel-exports` when `index.[tj]sx?` files are present and `filePaths.length > 3`.
- Structure depth convention is `flat-structure` vs `nested-structure` from average path depth threshold `<= 3`.

Enforcement flow (`enforceConventions`):
1. Build active line checkers from input conventions via `buildChecker`.
2. Unknown convention names are ignored (no checker produced).
3. Evaluate every line in every file against all active checkers.
4. Collect `ConventionViolation[]` with file path, line number, convention, expected, and actual values.
5. Compute score as `round((1 - violations/totalLines) * 100)`, clamped to `>= 0`; empty input or no checkers returns score `100`.

Prompt flow (`conventionsToPrompt`):
1. Group conventions by `category`.
2. Keep only conventions with confidence `>= 0.5`.
3. Emit a sectioned prompt starting with `Follow these coding conventions:` and category headers.
4. Include examples when present.
5. Return empty string when no category has high-confidence items.

## Key APIs and Types
Primary exports from this module:
- `detectConventions(files: Record<string, string>): ConventionReport`
- `enforceConventions(files: Record<string, string>, conventions: DetectedConvention[]): EnforcementResult`
- `conventionsToPrompt(conventions: DetectedConvention[]): string`

Core types:
- `DetectedConvention`
  - `category`: `naming | structure | formatting | imports | patterns`
  - includes `name`, `description`, `examples`, `confidence`
- `ConventionReport`
  - `conventions`, `language`, `filesAnalyzed`
- `ConventionViolation`
  - `file`, `line`, `convention`, `expected`, `actual`
- `EnforcementResult`
  - `violations`, `score`

Convention names emitted by detector include:
- Naming: `camelCase variables`, `snake_case variables`, `PascalCase types`
- Formatting: `indent-tabs`, `indent-2spaces`, `indent-4spaces`, `single-quotes`, `double-quotes`, `semicolons`, `no-semicolons`
- Imports: `relative-imports`, `alias-imports`, `type-imports`
- Patterns: `async-await`, `promise-then`, `function-style`, `class-style`, `named-exports`, `default-exports`
- Structure: `barrel-exports`, `flat-structure`, `nested-structure`

## Dependencies
Direct module dependencies:
- No external runtime imports inside `src/conventions/*`.
- `convention-enforcer.ts` has only a type import from `./convention-detector.js`.

Package context (`packages/codegen/package.json`):
- Runtime dependencies: `@dzupagent/core`, `@dzupagent/adapter-types`.
- Peer dependencies: `@langchain/core`, `@langchain/langgraph`, `zod`, optional `tree-sitter-wasms`, optional `web-tree-sitter`.

The conventions module itself does not directly call those package dependencies.

## Integration Points
Public integration surfaces:
- Root package exports from `src/index.ts`:
  - detector/enforcer functions and related types are re-exported.
- Compat facade re-export from `src/compat.ts`:
  - `export * from './conventions/index.js'`.
- Package export map (`package.json`):
  - module is consumable through root (`@dzupagent/codegen`) and compat path (`@dzupagent/codegen/compat`).

Current internal usage inside `packages/codegen/src`:
- No runtime call sites outside the conventions module itself.
- Current non-export usage is test coverage under `src/__tests__`.

Adjacent but separate convention systems:
- `src/quality/convention-gate.ts` (`ConventionGate`, `LearnedConvention`) is a different enforcement model.
- `src/guardrails/convention-learner.ts` learns `ConventionSet` for guardrail rules.
- There is no in-code adapter between `DetectedConvention` and `LearnedConvention`/`ConventionSet`.

## Testing and Observability
Direct tests covering this module behavior:
- `src/__tests__/convention-detector-and-adapters.test.ts`
  - detector naming/format/import/pattern/structure/language and confidence filtering paths.
- `src/__tests__/convention-enforcer.test.ts`
  - checker behavior, unknown convention handling, score behavior, and prompt generation.
- `src/__tests__/branch-coverage-conventions-validation.test.ts`
  - branch-heavy enforcer cases (semicolon exceptions, quote/import exceptions, type-import heuristics) and prompt category filtering.

Package test runtime:
- Vitest (`vitest.config.ts`), Node environment.
- Includes `src/**/*.test.ts` and `src/**/*.spec.ts`.

Observability:
- No logging/telemetry hooks in conventions module.
- Operational visibility is via returned `ConventionReport` and `EnforcementResult` values.

## Risks and TODOs
Current risks from implementation:
- Vocabulary mismatch: detector emits many names that enforcer does not validate; only a subset is enforceable.
- Heuristic limits: regex-based detection/enforcement can misclassify edge syntax and mixed-style files.
- Score model: violation density is computed per line, but multiple checker hits can stack on one line and disproportionately reduce score.
- `type-imports` checker is heuristic (uppercase-name based) and may miss or mislabel mixed imports.
- Detector currently counts `named`/`defaultImport` in `detectImports` but does not expose a convention derived from those counters.

Practical TODOs:
- Define and enforce an explicit mapping contract between detected names and enforceable names.
- Decide whether to bridge conventions module outputs into `ConventionGate`/guardrail convention models.
- If runtime adoption is expected, add a first-class integration point in pipeline/runtime modules instead of relying only on exported utility calls.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js