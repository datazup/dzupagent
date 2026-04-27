# Conventions Architecture

## Scope
This document covers `packages/codegen/src/conventions` in `@dzupagent/codegen`, specifically:
- `convention-detector.ts`
- `convention-enforcer.ts`
- `index.ts`
- Convention-focused tests under `src/__tests__` that exercise this module

The module is a lightweight, regex/heuristic utility for convention detection, convention enforcement, and prompt shaping. It is exported as part of the package public API, but it is not currently wired into the package's pipeline executor flow by default.

## Responsibilities
The conventions module has three responsibilities:
- Infer style conventions from an in-memory file map (`Record<string, string>`).
- Check generated or candidate files against selected conventions and produce line-level violations with a normalized score.
- Convert high-confidence conventions into an LLM prompt fragment (`conventionsToPrompt`) grouped by category.

It intentionally does not:
- Parse ASTs.
- Read files from disk directly.
- Apply automatic fixes.
- Emit logs/metrics or integrate with telemetry.

## Structure
Module files:
- `convention-detector.ts`: detection heuristics and `detectConventions` entrypoint.
- `convention-enforcer.ts`: checker construction, enforcement loop, and prompt formatter.
- `index.ts`: local barrel re-exports.

Key internal detector functions in `convention-detector.ts`:
- `detectNaming(lines)`
- `detectFormatting(lines)`
- `detectImports(lines)`
- `detectPatterns(lines)`
- `detectStructure(filePaths)`
- `detectLanguage(filePaths)`
- `ratio(a, b)` helper

Key internal enforcement function in `convention-enforcer.ts`:
- `buildChecker(convention)` maps supported convention names to per-line checkers.

Supported enforcement checker names today:
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
1. Accept `files: Record<string, string>`.
2. Flatten all file contents into lines and extract file paths.
3. Run naming/formatting/import/pattern detectors on combined lines.
4. Run structure detector on file paths.
5. Infer language by extension count (`ts/tsx` vs `js/jsx`).
6. Filter out low-confidence conventions (`confidence < 0.1`).
7. Return `ConventionReport` with conventions, language, and `filesAnalyzed`.

Enforcement flow (`enforceConventions`):
1. Convert each input `DetectedConvention` to a checker via `buildChecker`.
2. Ignore unknown convention names (no checker produced).
3. Iterate every line of every file and execute all active checkers.
4. Collect `ConventionViolation[]` with `file`, `line`, `expected`, and `actual`.
5. Compute `score` as a rounded percentage from line-level violation density; empty input or no checkers yields `100`.

Prompt flow (`conventionsToPrompt`):
1. Group conventions by category.
2. Keep only conventions with `confidence >= 0.5`.
3. Build a sectioned prompt headed by `Follow these coding conventions:`.
4. Include examples when present.
5. Return empty string if no high-confidence conventions remain.

## Key APIs and Types
Primary API:
- `detectConventions(files): ConventionReport`
- `enforceConventions(files, conventions): EnforcementResult`
- `conventionsToPrompt(conventions): string`

Core types:
- `DetectedConvention`
- `ConventionReport`
- `ConventionViolation`
- `EnforcementResult`

`DetectedConvention.category` values:
- `naming`
- `structure`
- `formatting`
- `imports`
- `patterns`

Notable detector outputs include convention names such as:
- `camelCase variables` / `snake_case variables`
- `PascalCase types`
- `relative-imports` / `alias-imports`
- `async-await` / `promise-then`
- `function-style` / `class-style`
- `named-exports` / `default-exports`
- `barrel-exports`
- `flat-structure` / `nested-structure`

## Dependencies
Direct module dependencies:
- No external runtime dependencies in `src/conventions/*`.
- Internal type-only import in enforcer: `./convention-detector.js`.

Package-level context (`packages/codegen/package.json`):
- This module ships within `@dzupagent/codegen` and is re-exported from package root.
- The package depends on `@dzupagent/core` and `@dzupagent/adapter-types`, but the conventions module itself does not call either directly.

## Integration Points
Exports:
- Local barrel: `src/conventions/index.ts`.
- Package root: `src/index.ts` re-exports detector/enforcer APIs and types.

Current in-repo usage:
- Active usage is in tests and package export surface.
- No direct runtime call sites were found in other codegen runtime modules (for example pipeline execution paths).

Related but separate convention enforcement surface:
- `src/quality/convention-gate.ts` defines `ConventionGate` with a different model (`LearnedConvention`) and built-in gate rules.
- There is no direct adapter between `DetectedConvention` and `LearnedConvention` in current code.

## Testing and Observability
Tests covering this module:
- `src/__tests__/convention-detector-and-adapters.test.ts` exercises detector behavior across naming, formatting, imports, patterns, structure, language inference, and confidence filtering.
- `src/__tests__/convention-enforcer.test.ts` exercises enforcement checker behavior, unknown conventions, scoring, and prompt generation.
- `src/__tests__/branch-coverage-conventions-validation.test.ts` adds branch-focused checks for enforcer and prompt edge paths.

Observability characteristics:
- No built-in logging, tracing, metrics, or event emission.
- Operational visibility is via returned data structures (`ConventionReport`, `EnforcementResult`) and test assertions.

## Risks and TODOs
Current risks:
- Detector and enforcer convention vocabularies only partially overlap; many detected conventions are advisory only and not enforceable by `enforceConventions`.
- Heuristic regex matching can misclassify edge syntax (for example complex strings/import patterns).
- Enforcement score is line-density based, so multiple checker hits on one line can disproportionately reduce score.
- `type-imports` enforcement uses uppercase-name heuristics and may miss or misclassify mixed imports.

TODOs inferred from current design gaps:
- Add a formal mapping/coverage contract between detected convention names and enforceable convention names.
- Decide whether to bridge `src/conventions/*` and `src/quality/convention-gate.ts` or keep them intentionally separate with explicit conversion utilities.
- If runtime adoption is desired, add an explicit pipeline integration point rather than relying on ad hoc external calls.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

