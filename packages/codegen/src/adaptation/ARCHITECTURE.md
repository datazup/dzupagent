# Adaptation Architecture

## Scope
This document covers the adaptation layer under `packages/codegen/src/adaptation` in `@dzupagent/codegen`.

Included files:
- `framework-adapter.ts`
- `path-mapper.ts`
- `languages/language-config.ts`
- `languages/index.ts`

Related package surfaces that expose this layer:
- `packages/codegen/src/index.ts` (root exports)
- `packages/codegen/src/compat.ts` (compat re-exports for adapter/path mapper)
- `packages/codegen/package.json` (package-level export entrypoints)
- `packages/codegen/README.md` and `packages/codegen/docs/api-tiers.md` (published API descriptions)

## Responsibilities
The adaptation layer provides lightweight utilities for framework and language adaptation metadata.

Current responsibilities:
- Path mapping between framework folder conventions via ordered regex rules.
- Framework-to-framework adaptation guide lookup for frontend migrations.
- Language registry for supported codegen languages, including:
  - file extensions
  - prompt conventions
  - lint/build/test commands
  - package manager hints
  - sandbox base image hints
  - detection file signatures
- Language detection from project filenames and prompt-fragment retrieval.

Out of scope in current code:
- No AST/code transformation engine.
- No direct orchestration in generation/pipeline runtime modules.
- No telemetry or persistence in this layer.

## Structure
- `path-mapper.ts`
  - Defines `PathMapper`.
  - Stores internal ordered mappings as `{ pattern: RegExp, target: string }`.
  - `addMapping(pattern, target)` appends a compiled regex rule.
  - `map(sourcePath)` applies first matching rule and returns rewritten path, else `null`.

- `framework-adapter.ts`
  - Defines built-in backend route/path mapping sets in `BACKEND_MAPPINGS`:
    - `express->nextjs`
    - `express->sveltekit`
    - `express->fastify`
    - `nextjs->express`
  - Defines built-in frontend textual guides in `FRONTEND_GUIDES`:
    - `vue3->react`
    - `react->vue3`
    - `vue3->svelte`
    - `react->svelte`
  - Exposes `FrameworkAdapter` for builtin loading and extension.

- `languages/language-config.ts`
  - Defines `SupportedLanguage` union:
    - `typescript | python | go | rust | java | kotlin`
  - Defines `LanguageConfig` interface.
  - Defines `LANGUAGE_CONFIGS` registry with per-language metadata.
  - Exposes `detectLanguageFromFiles(filenames)` with explicit check order.
  - Exposes `getLanguagePrompt(language)`.

- `languages/index.ts`
  - Re-exports language types/constants/functions from `language-config.ts`.

## Runtime and Control Flow
1. Adapter initialization:
- `new FrameworkAdapter()` runs `loadBuiltinMappings()` then `loadBuiltinGuides()`.
- Built-in backend mappings are converted into `PathMapper` instances at construction time.

2. Backend path adaptation flow:
- Caller invokes `FrameworkAdapter.mapPath(path, source, target)`.
- Adapter scans registered backend mappings in insertion order.
- For matching framework pair, it delegates to that pair’s `PathMapper.map(path)`.
- First successful mapped path is returned; otherwise `null`.

3. Frontend guide adaptation flow:
- Caller invokes `FrameworkAdapter.getAdaptationGuide(source, target)`.
- Adapter returns first matching guide text, else `null`.

4. Language detection flow:
- Caller passes filenames into `detectLanguageFromFiles`.
- Filenames are normalized to basenames.
- Detection checks run in priority order:
  - `typescript`, `python`, `go`, `rust`, `kotlin`, `java`
- First matching language is returned, else `null`.
- Kotlin is intentionally checked before Java to avoid `build.gradle.kts` being treated as generic Gradle Java.

Behavioral ordering guarantees:
- `PathMapper` is first-match-wins.
- `FrameworkAdapter` built-ins are loaded before custom registrations.
- Custom registrations are appended; they do not replace existing entries globally.

## Key APIs and Types
Classes:
- `PathMapper`
  - `addMapping(pattern: string, target: string): this`
  - `map(sourcePath: string): string | null`
- `FrameworkAdapter`
  - `addBackendMapping(source: string, target: string, mapper: PathMapper): this`
  - `addFrontendGuide(source: string, target: string, guide: string): this`
  - `mapPath(path: string, source: string, target: string): string | null`
  - `getAdaptationGuide(source: string, target: string): string | null`

Types:
- `SupportedLanguage`
- `LanguageConfig`

Constants and functions:
- `LANGUAGE_CONFIGS`
- `detectLanguageFromFiles(filenames: string[]): SupportedLanguage | null`
- `getLanguagePrompt(language: SupportedLanguage): string`

Export surface notes:
- Root export via `src/index.ts` exposes all adaptation symbols.
- `src/compat.ts` additionally re-exports `FrameworkAdapter` and `PathMapper`.
- Package `exports` currently provide root/`vfs`/`tools`/`runtime`/`compat` entrypoints; adaptation symbols are consumed via the root entrypoint (or `compat` for adapter/path mapper).

## Dependencies
Direct dependencies inside adaptation source:
- Internal:
  - `framework-adapter.ts` imports `PathMapper`.
  - `languages/index.ts` imports from `languages/language-config.ts`.
- External:
  - No third-party imports in adaptation files.
  - Uses JavaScript/TypeScript runtime primitives only (`RegExp`, `Array`, `Record`, strings).

Package-level context:
- `@dzupagent/codegen` depends on `@dzupagent/core` and `@dzupagent/adapter-types`, but adaptation files do not directly import them.
- Peer dependencies (`@langchain/*`, `zod`, optional tree-sitter packages) are unrelated to adaptation internals.

## Integration Points
Active integration points in package code:
- Public exports:
  - `src/index.ts` exports adaptation APIs.
  - `src/compat.ts` re-exports `FrameworkAdapter` and `PathMapper`.
- Documentation:
  - `README.md` lists adaptation APIs in the package API reference.
  - `docs/api-tiers.md` classifies adaptation exports under the advanced tier.
- Tests:
  - adaptation-specific tests and broader suites exercise this layer.

Current non-integration:
- No non-test module in `packages/codegen/src` imports adaptation helpers for generation execution or pipeline orchestration.
- Adaptation currently behaves as a reusable utility layer exposed to consumers, not an internally wired runtime stage.

## Testing and Observability
Direct adaptation-focused tests:
- `src/__tests__/path-mapper.test.ts`
- `src/__tests__/adaptation-language-config.test.ts`
- `src/__tests__/adaptation-layer.test.ts`

Additional coverage that includes adapter behavior:
- `src/__tests__/convention-detector-and-adapters.test.ts`
- `src/__tests__/branch-coverage-conventions-validation.test.ts`
- `src/__tests__/branch-coverage-sandbox-lint.test.ts`
- `src/__tests__/branch-coverage-misc.test.ts`

Observability:
- No built-in logging/metrics/tracing hooks in adaptation source.
- Operational visibility is currently test-driven or caller-driven.

## Risks and TODOs
- Stringly framework identifiers:
  - `FrameworkAdapter` uses raw string `source`/`target` identifiers with no compile-time enum.
- Regex safety and performance:
  - `PathMapper.addMapping` accepts arbitrary regex strings; invalid regex throws, and complex patterns can be expensive.
- Override semantics:
  - Built-ins register first; custom additions append and may not override early matching behavior.
- Static registry drift:
  - `LANGUAGE_CONFIGS` hard-codes toolchain commands and container image tags that can drift from real project environments.
- Limited internal adoption:
  - The layer is exported and tested, but not yet integrated into internal generation/pipeline control flows.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js