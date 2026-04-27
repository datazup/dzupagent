# Adaptation Architecture

## Scope
This document covers the adaptation subsystem in `packages/codegen/src/adaptation`:

- `framework-adapter.ts`
- `path-mapper.ts`
- `languages/language-config.ts`
- `languages/index.ts`

It also covers how this subsystem is exposed and validated through the surrounding `@dzupagent/codegen` package:

- public exports in `src/index.ts`
- package metadata in `package.json`
- package docs (`README.md`, `docs/api-tiers.md`)
- adaptation-focused tests in `src/__tests__`

## Responsibilities
The adaptation subsystem currently provides three utility capabilities:

- Backend path adaptation:
  - Maps source file paths from one backend framework layout to another via ordered regex rules (`PathMapper`, `FrameworkAdapter.mapPath`).
- Frontend migration guidance:
  - Returns static textual adaptation guides for selected framework pairs (`FrameworkAdapter.getAdaptationGuide`).
- Language profile registry:
  - Defines language-specific metadata (extensions, lint/test/build commands, sandbox image, prompt fragment, detection files) and language detection helpers (`LANGUAGE_CONFIGS`, `detectLanguageFromFiles`, `getLanguagePrompt`).

Non-responsibilities in the current codebase:

- No AST/code transformation engine is implemented in this module.
- No runtime pipeline in `src/` currently imports adaptation helpers (outside tests and root exports).
- Migration planning is implemented separately in `src/migration/migration-planner.ts` and does not call adaptation APIs.

## Structure
- `path-mapper.ts`
  - `PathMapper` stores ordered `{ pattern: RegExp, target: string }` rules.
  - `addMapping(pattern, target)` compiles regex and appends.
  - `map(sourcePath)` returns first replacement match or `null`.

- `framework-adapter.ts`
  - Defines built-in backend mappings (`BACKEND_MAPPINGS`) for:
    - `express -> nextjs`
    - `express -> sveltekit`
    - `express -> fastify`
    - `nextjs -> express`
  - Defines built-in frontend guides (`FRONTEND_GUIDES`) for:
    - `vue3 -> react`
    - `react -> vue3`
    - `vue3 -> svelte`
    - `react -> svelte`
  - `FrameworkAdapter` loads built-ins in constructor and supports extension via:
    - `addBackendMapping(source, target, mapper)`
    - `addFrontendGuide(source, target, guide)`

- `languages/language-config.ts`
  - `SupportedLanguage` union:
    - `typescript | python | go | rust | java | kotlin`
  - `LanguageConfig` interface and `LANGUAGE_CONFIGS` registry.
  - `detectLanguageFromFiles(filenames)` with explicit priority:
    - `typescript`, `python`, `go`, `rust`, `kotlin`, `java`
  - `getLanguagePrompt(language)` returns prompt fragment from registry.

- `languages/index.ts`
  - Re-exports language types/functions/constants from `language-config.ts`.

## Runtime and Control Flow
1. Adapter construction:
   - `new FrameworkAdapter()` calls `loadBuiltinMappings()` and `loadBuiltinGuides()`.

2. Backend path mapping flow:
   - Caller invokes `mapPath(path, source, target)`.
   - Adapter scans `backendMappings` in insertion order.
   - For matching `(source, target)` entries, it calls `entry.mapper.map(path)`.
   - First non-`null` result is returned; otherwise `null`.

3. Frontend guide lookup flow:
   - Caller invokes `getAdaptationGuide(source, target)`.
   - Adapter returns first matching guide text; otherwise `null`.

4. Language detection flow:
   - `detectLanguageFromFiles` normalizes to basenames.
   - Checks detection files in fixed priority order.
   - Returns the first matching language, else `null`.
   - Kotlin is intentionally checked before Java to prefer `build.gradle.kts`.

Ordering semantics are part of behavior:

- `PathMapper` is first-match-wins.
- `FrameworkAdapter` built-ins load before custom entries.
- Custom backend mappings for an existing pair are additive, not global overrides.

## Key APIs and Types
- Classes:
  - `PathMapper`
    - `addMapping(pattern: string, target: string): this`
    - `map(sourcePath: string): string | null`
  - `FrameworkAdapter`
    - `addBackendMapping(source: string, target: string, mapper: PathMapper): this`
    - `addFrontendGuide(source: string, target: string, guide: string): this`
    - `mapPath(path: string, source: string, target: string): string | null`
    - `getAdaptationGuide(source: string, target: string): string | null`

- Types:
  - `SupportedLanguage`
  - `LanguageConfig`

- Constants:
  - `LANGUAGE_CONFIGS`

- Functions:
  - `detectLanguageFromFiles(filenames: string[]): SupportedLanguage | null`
  - `getLanguagePrompt(language: SupportedLanguage): string`

- Package export surface:
  - Re-exported from `src/index.ts` and shipped via package root `exports` in `package.json`.

## Dependencies
Direct code dependencies inside `src/adaptation`:

- Internal:
  - `framework-adapter.ts` depends on `PathMapper`.
  - `languages/index.ts` depends on `languages/language-config.ts`.
- External:
  - No third-party imports in adaptation source files.
  - Uses only built-in JS runtime features (`RegExp`, arrays, strings, records).

Package-level context:

- `@dzupagent/codegen` depends on `@dzupagent/core` and `@dzupagent/adapter-types`, but adaptation files do not currently import either.

## Integration Points
Current integration points in the repository:

- Public API:
  - Exported by `packages/codegen/src/index.ts`.
  - Distributed through package root export in `packages/codegen/package.json`.
- Documentation:
  - Mentioned in `packages/codegen/README.md` and `packages/codegen/docs/api-tiers.md`.
- Tests:
  - Extensively exercised in adaptation-specific and branch-coverage suites under `packages/codegen/src/__tests__`.

Current non-integration (important for architecture accuracy):

- No non-test runtime modules in `packages/codegen/src` currently import adaptation APIs for generation, pipeline, guardrails, or migration execution orchestration.
- `src/migration/migration-planner.ts` is a separate utility layer with its own plan/scope/prompt logic.

## Testing and Observability
Adaptation-focused test files include:

- `src/__tests__/path-mapper.test.ts`
- `src/__tests__/adaptation-language-config.test.ts`
- `src/__tests__/adaptation-layer.test.ts`

Adaptation behavior is also covered in broader branch suites, including:

- `src/__tests__/branch-coverage-sandbox-lint.test.ts`
- `src/__tests__/branch-coverage-conventions-validation.test.ts`
- `src/__tests__/branch-coverage-misc.test.ts`
- `src/__tests__/convention-detector-and-adapters.test.ts`

Validated in this refresh run:

- Command:
  - `yarn workspace @dzupagent/codegen test src/__tests__/path-mapper.test.ts src/__tests__/adaptation-language-config.test.ts src/__tests__/adaptation-layer.test.ts`
- Result:
  - 3 test files passed
  - 121 tests passed

Observability status:

- Adaptation module has no built-in logging, tracing, or metrics hooks.
- Runtime visibility is currently via caller instrumentation and test coverage.

## Risks and TODOs
- Framework IDs are stringly-typed:
  - `source`/`target` are plain strings, so invalid pairs degrade to `null` at runtime.
- Regex safety:
  - `PathMapper.addMapping` compiles unvalidated regex strings; invalid patterns throw, and costly patterns can affect performance.
- Override semantics:
  - Built-in mappings are loaded first; custom rules are appended and cannot preempt built-ins for the same match shape without changing registration strategy.
- Static command/image drift:
  - `LANGUAGE_CONFIGS` embeds command/toolchain assumptions and sandbox image tags that may age independently of runtime environments.
- Limited runtime adoption:
  - Adaptation utilities are exported and tested, but not wired into package-internal orchestration flows yet.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

