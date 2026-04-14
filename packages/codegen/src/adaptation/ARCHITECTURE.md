# Adaptation Module Architecture

This document describes the architecture of `packages/codegen/src/adaptation`, including feature inventory, runtime flow, usage patterns, cross-package references, and current test coverage.

## 1. Scope

The adaptation module provides three capabilities:

1. Backend file-path adaptation between framework conventions (`PathMapper`, `FrameworkAdapter`).
2. Frontend migration guidance text between framework pairs (`FrameworkAdapter` guides).
3. Language-specific generation metadata and project-language detection (`languages/language-config.ts`).

Source files:

- `path-mapper.ts`
- `framework-adapter.ts`
- `languages/language-config.ts`
- `languages/index.ts`

## 2. Module Topology

### 2.1 `PathMapper` (low-level regex mapper)

Responsibility:

- Stores ordered regex mapping rules.
- Maps an input source path to a target path using first-match semantics.

Public API:

- `addMapping(pattern: string, target: string): this`
- `map(sourcePath: string): string | null`

Design notes:

- Rules are evaluated in insertion order.
- `map` returns `null` when no pattern matches.
- Uses JavaScript `RegExp` + `String.replace` capture groups.

### 2.2 `FrameworkAdapter` (high-level adapter)

Responsibility:

- Loads built-in backend mapping sets for framework pairs.
- Loads built-in frontend adaptation guides.
- Supports custom extension by registering additional mappings/guides at runtime.

Public API:

- `addBackendMapping(source, target, mapper): this`
- `addFrontendGuide(source, target, guide): this`
- `mapPath(path, source, target): string | null`
- `getAdaptationGuide(source, target): string | null`

Internal model:

- `backendMappings: { source, target, mapper }[]`
- `frontendGuides: { source, target, guide }[]`

Initialization:

- Constructor eagerly loads built-ins via `loadBuiltinMappings()` and `loadBuiltinGuides()`.

### 2.3 `languages/language-config` (language policy registry)

Responsibility:

- Declares `SupportedLanguage` enum-like union:
  - `typescript`, `python`, `go`, `rust`, `java`, `kotlin`
- Provides per-language config (`extensions`, prompt conventions, lint/build/test commands, package manager, sandbox image, detection files).
- Detects project language from root-level file names.
- Returns prompt fragment for a chosen language.

Public API:

- `LANGUAGE_CONFIGS`
- `detectLanguageFromFiles(filenames): SupportedLanguage | null`
- `getLanguagePrompt(language): string`

`languages/index.ts` is a pure re-export surface.

## 3. Built-in Feature Inventory

### 3.1 Built-in backend path mappings

Implemented pairs:

1. `express -> nextjs`
2. `express -> sveltekit`
3. `express -> fastify`
4. `nextjs -> express`

Representative rules:

- `routes/(.*)\.routes\.ts -> app/api/$1/route.ts`
- `controllers/(.*)\.controller\.ts -> app/api/$1/route.ts`
- `middleware/(.*)\.ts -> src/plugins/$1.plugin.ts` (for Fastify)
- `app/api/(.*)/route\.ts -> src/routes/$1.routes.ts` (Next.js to Express)

### 3.2 Built-in frontend guide pairs

Implemented pairs:

1. `vue3 -> react`
2. `react -> vue3`
3. `vue3 -> svelte`
4. `react -> svelte`

Guide content includes transformation hints for:

- reactive state APIs
- lifecycle APIs
- template/JSX syntax
- conditional/list rendering
- event binding and model binding
- store/state-management concepts

### 3.3 Language generation policy catalog

For each supported language, config includes:

- extensions
- prompt fragment (style and architecture guidance)
- lint command
- optional build command
- test command
- package manager
- sandbox base image
- detection files

Examples:

- TypeScript: `npx tsc --noEmit && npx eslint .`, `npx vitest run`, `node:20-slim`
- Python: `python -m mypy . && python -m ruff check .`, `python -m pytest`, `python:3.12-slim`
- Go: `go vet ./... && golangci-lint run`, `go test ./...`, `golang:1.22-alpine`

## 4. Runtime Flow

### 4.1 Backend path adaptation flow

1. Create `FrameworkAdapter`.
2. Constructor loads built-in mapping groups into internal `backendMappings`.
3. Call `mapPath(path, source, target)`.
4. Adapter scans entries where `entry.source === source && entry.target === target`.
5. For matching pair, delegates to `PathMapper.map(path)`.
6. Returns first non-null mapped result; returns `null` if no rules match.

### 4.2 Frontend guide retrieval flow

1. Create `FrameworkAdapter`.
2. Constructor loads built-in guide entries.
3. Call `getAdaptationGuide(source, target)`.
4. Returns guide text for matching pair, else `null`.

### 4.3 Language detection flow

1. Call `detectLanguageFromFiles(filenames)`.
2. Function normalizes to basename (drops directory prefix).
3. Checks language priorities in this order:
   - TypeScript, Python, Go, Rust, Kotlin, Java
4. Returns first language whose `detectionFiles` intersect input set.
5. Returns `null` if no match.

Important detail:

- Kotlin is checked before Java so `build.gradle.kts` resolves to Kotlin correctly.

## 5. Usage Examples

### 5.1 Map backend paths

```ts
import { FrameworkAdapter } from '@dzupagent/codegen'

const adapter = new FrameworkAdapter()

const nextRoute = adapter.mapPath('routes/users.routes.ts', 'express', 'nextjs')
// "app/api/users/route.ts"
```

### 5.2 Get frontend migration guide text

```ts
import { FrameworkAdapter } from '@dzupagent/codegen'

const adapter = new FrameworkAdapter()
const guide = adapter.getAdaptationGuide('vue3', 'react')

if (guide) {
  console.log(guide)
}
```

### 5.3 Register custom mapping pair

```ts
import { FrameworkAdapter, PathMapper } from '@dzupagent/codegen'

const mapper = new PathMapper()
  .addMapping('src/(.*)\\.ts', 'lib/$1.ts')
  .addMapping('test/(.*)\\.spec\\.ts', '__tests__/$1.test.ts')

const adapter = new FrameworkAdapter().addBackendMapping('customA', 'customB', mapper)

adapter.mapPath('src/foo.ts', 'customA', 'customB')
// "lib/foo.ts"
```

### 5.4 Detect project language and fetch prompt

```ts
import { detectLanguageFromFiles, getLanguagePrompt } from '@dzupagent/codegen'

const files = ['package.json', 'tsconfig.json', 'src/index.ts']
const lang = detectLanguageFromFiles(files)

if (lang) {
  const conventions = getLanguagePrompt(lang)
  console.log(lang, conventions)
}
```

## 6. Use Cases

1. Framework migration planning.
   - Convert filesystem layout expectations while migrating Express APIs to Next.js/SvelteKit/Fastify.
2. Prompt augmentation for migration assistants.
   - Retrieve frontend adaptation guide text and inject into LLM prompts.
3. Multi-language generation bootstrap.
   - Detect repository language and pick lint/test/build/sandbox defaults.
4. Organization-specific conventions.
   - Register custom adapters for internal framework aliases or proprietary project layouts.

## 7. Cross-Package And Intra-Repo References

### 7.1 Public export surface

Adaptation APIs are exported from:

- `packages/codegen/src/index.ts`
  - `PathMapper`
  - `FrameworkAdapter`
  - `SupportedLanguage`, `LanguageConfig`
  - `LANGUAGE_CONFIGS`, `detectLanguageFromFiles`, `getLanguagePrompt`

This makes adaptation features consumable via `@dzupagent/codegen`.

### 7.2 References in repository docs

- `packages/codegen/README.md` lists adaptation features.
- `packages/codegen/ARCHITECTURE.md` references adaptation files in migration/adaptation section.

### 7.3 Runtime references from other packages

Current state (repo-wide code search):

- No direct symbol-level imports of `FrameworkAdapter`, `PathMapper`, or `detectLanguageFromFiles` outside `packages/codegen`.
- Other packages reference `@dzupagent/codegen` at package level (for sandbox and runtime tool integration), but not adaptation APIs directly.

Implication:

- Adaptation is currently a public capability primarily validated by internal package tests and available for downstream consumers, but not yet wired into other in-repo runtime paths.

## 8. Test Coverage Status

### 8.1 Existing adaptation tests

Primary file:

- `packages/codegen/src/__tests__/convention-detector-and-adapters.test.ts`

Coverage scope:

1. `FrameworkAdapter` constructor and built-in mappings.
2. Built-in map behavior for:
   - `express->nextjs`
   - `express->sveltekit`
   - `express->fastify`
   - `nextjs->express`
3. Null behavior for unknown framework pairs and unmatched paths.
4. Frontend guide retrieval for all four built-in guide pairs.
5. Custom backend and frontend registration behavior.

Observed count:

- 17 adapter-focused tests inside that file.

### 8.2 Measured signals from focused coverage run

Command executed:

- `yarn workspace @dzupagent/codegen test:coverage src/__tests__/convention-detector-and-adapters.test.ts`

Key adaptation results from report:

- `adaptation/framework-adapter.ts`: 100% statements/lines/functions, 90.9% branches
- `adaptation/path-mapper.ts`: 100% statements/lines/functions/branches
- `adaptation/languages/language-config.ts`: 0% (no direct tests exercising this module in the focused run)

Note:

- The focused coverage command exits non-zero because package-level global thresholds apply to untouched modules outside this single test target.

## 9. Gaps And Improvement Opportunities

1. Missing direct tests for language config API.
   - Add tests for:
     - detection priority (Kotlin before Java)
     - basename normalization
     - all supported languages and null case
     - `getLanguagePrompt` shape/content sanity
2. `PathMapper` edge-case testing is light.
   - Add tests for ordered-rule precedence and regex edge cases.
3. No in-repo runtime consumer currently uses adaptation APIs directly.
   - Consider integrating adaptation with migration planning flow (`migration/migration-planner.ts`) to convert this from library-only utility to orchestrated runtime behavior.

