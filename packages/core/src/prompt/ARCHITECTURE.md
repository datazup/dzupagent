# Prompt Architecture (`packages/core/src/prompt`)

## Scope
This document describes the prompt subsystem implemented under `packages/core/src/prompt`:
- `template-types.ts`
- `template-engine.ts`
- `template-resolver.ts`
- `template-cache.ts`
- `prompt-fragments.ts`
- `fragment-composer.ts`

It is based on current local code in `packages/core/src`, package exports in `packages/core/src/index.ts` and `packages/core/package.json`, plus existing tests in `packages/core/src/__tests__`.

## Responsibilities
The prompt subsystem currently owns five concrete responsibilities:
- Define prompt template contracts (`TemplateVariable`, `TemplateContext`, `StoredTemplate`, resolve/bulk query types, and `ResolvedPrompt`).
- Render template strings with a lightweight engine (`{{var}}`, `{{#if}}`, `{{#unless}}`, `{{#each}}`, `{{> partial}}`).
- Normalize runtime context for rendering (`flattenContext`) including camelCase to snake_case aliasing and delimiter escaping by default.
- Resolve stored templates from a pluggable `PromptStore`, with optional `PromptCache` short-circuiting.
- Provide reusable static prompt fragments and an advanced fragment composition utility (dependencies, conflicts, conditions, priority ordering, and token-budget trimming).

## Structure
Current module layout and intent:
- `template-types.ts`
- Purpose: shared type contracts for the resolver/store/cache boundary.
- `template-engine.ts`
- Purpose: rendering and static analysis helpers (`resolveTemplate`, `flattenContext`, `extractVariables`, `validateTemplate`).
- `template-resolver.ts`
- Purpose: runtime orchestration around store lookup and template application, plus `PromptStore` interface and `ResolutionLevel` type.
- `template-cache.ts`
- Purpose: in-memory TTL cache keyed by `type|category` with general fallback `type|` and bulk preload.
- `prompt-fragments.ts`
- Purpose: canned instruction fragments and simple ordered concatenation via `composeFragments(...names)`.
- `fragment-composer.ts`
- Purpose: advanced composition API (`composeAdvancedFragments`) and static fragment validation (`validateFragments`).

## Runtime and Control Flow
### Template rendering flow (`resolveTemplate`)
1. `flattenContext` converts each context value to string form and writes both original key and snake_case alias.
2. Values are escaped for `{{`/`}}` delimiters unless key is explicitly listed in `rawVariables`.
3. Declared variable metadata is applied (`required`, `defaultValue`, `strictMode`).
4. Control-flow pass runs in this order: partials, `#each`, `#if`/`{{else}}`, `#unless`.
5. Remaining `{{var}}` placeholders are replaced from the flattened map.
6. Unresolved placeholders are removed (replaced with empty string).

### Template resolve flow (`PromptResolver.resolve`)
1. If `templateId` exists and hierarchy includes `override`, resolver queries `store.findTemplate` with explicit override.
2. If unresolved and cache is provided, resolver checks `cache.get(type, category)` and returns immediately on hit.
3. If still unresolved, resolver calls `store.findTemplate(query)` once.
4. On hit, resolver applies `resolveTemplate(template.content, context, { variables })` and returns `{ content, config }`.
5. On miss, resolver returns `{ content: '', config: {} }`.

### Cache lifecycle (`PromptCache`)
1. `preload(store, query)` calls `store.findAllTemplates(query)`.
2. Cache map is rebuilt; first template seen wins for `type|category` and fallback `type|` keys.
3. `loadedAt` timestamp is updated.
4. `get(type, category?)` returns `null` when cache is expired or empty, else category-specific then general fallback.

### Advanced fragment flow (`composeAdvancedFragments`)
1. Filter by optional fragment conditions.
2. Resolve dependencies transitively (emits warnings for cycles and condition-excluded dependencies).
3. Resolve conflicts by priority (higher/equal priority fragment keeps inclusion).
4. Sort by descending priority, then original declaration order.
5. Apply approximate budget trimming (4 chars/token heuristic) and return diagnostics (`included`, `excluded`, `warnings`).

## Key APIs and Types
Publicly exported from `@dzupagent/core` root barrel (`src/index.ts`):
- Template engine:
- `resolveTemplate(template, context, options?)`
- `flattenContext(context, rawVariables?)`
- `extractVariables(template)`
- `validateTemplate(template, declaredVariables, standardVariables?)`
- Resolver and cache:
- `PromptResolver`
- `PromptCache`
- `PromptStore` (type)
- `ResolutionLevel` (type)
- Prompt contracts:
- `TemplateVariable`
- `TemplateContext`
- `StoredTemplate`
- `ResolvedPrompt`
- `PromptResolveQuery`
- `BulkPromptQuery`
- Fragment APIs:
- `PROMPT_FRAGMENTS` and `FRAGMENT_*` constants
- `composeFragments(...names)`
- `composeAdvancedFragments(fragments, options?)`
- `validateFragments(fragments)`
- `ComposableFragment` and `ComposeResult` (types)

Note: prompt APIs are exported from the root entrypoint; they are not currently re-exported from the `orchestration`, `quick-start`, or `security` facade subpaths.

## Dependencies
Internal dependencies inside this module are file-local imports only:
- `template-resolver.ts` depends on `template-engine.ts`, `template-types.ts`, and `template-cache.ts` types.
- `template-cache.ts` depends on `template-types.ts` and `PromptStore` type from `template-resolver.ts`.
- `template-engine.ts`, `prompt-fragments.ts`, and `fragment-composer.ts` have no external package imports.

External package dependencies for this subsystem are effectively inherited from `@dzupagent/core`; prompt files themselves do not directly import LangChain, Zod, or other third-party libraries.

## Integration Points
Current in-repo integration points are:
- Package API boundary:
- `packages/core/src/index.ts` re-exports all prompt APIs for consumers of `@dzupagent/core`.
- Consumer boundary:
- runtime integration is designed through `PromptStore` (`findTemplate`, `findAllTemplates`) supplied by consuming packages/apps.
- In-module usage:
- prompt implementation files primarily call each other; prompt utilities are not currently wired through a dedicated facade entrypoint.

Based on current `packages/core/src` references, prompt APIs are primarily validated through direct tests and root-barrel exports rather than broad cross-module runtime usage inside `@dzupagent/core`.

## Testing and Observability
Testing currently present in `packages/core`:
- `src/__tests__/template-engine.test.ts` covers:
- `flattenContext` conversions and camelCase/snake_case aliasing.
- variable substitution behavior, defaults, strict-mode required checks.
- control-flow directives (`#if`, `#unless`, `#each`) and partial handling.
- `extractVariables` behavior including control keyword filtering.
- `validateTemplate` behavior for undeclared/unused/standard variables.

Current visible gap:
- no dedicated test files were found for:
- `template-resolver.ts`
- `template-cache.ts`
- `fragment-composer.ts`
- `prompt-fragments.ts`

Observability:
- this subsystem does not emit events or metrics directly.
- diagnostics are returned via pure function results (for example, `ComposeResult.warnings` and `validateTemplate` output).

## Risks and TODOs
Current code-level risks and follow-ups:
- `ResolutionLevel` and `hierarchy` are modeled in `PromptResolver`, but non-override hierarchy traversal is delegated to `PromptStore.findTemplate(query)` rather than explicitly iterated in resolver logic.
- `PromptCache.preload` assumes incoming templates are already ordered by priority; first-seen wins with no internal ranking.
- `resolveTemplate` `#each` uses comma-split string semantics after flattening; list items containing commas cannot be represented losslessly.
- missing partials render as HTML-comment text (`<!-- partial "..." not found -->`), which may leak markers into model prompts unless callers sanitize or pre-validate.
- prompt module tests are currently concentrated in `template-engine`; resolver/cache/fragment composer behavior has no direct unit tests in this package.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

