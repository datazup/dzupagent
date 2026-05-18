# Prompt Architecture (`packages/core/src/prompt`)

## Scope
This document describes the prompt subsystem in `@dzupagent/core` under `packages/core/src/prompt`.

In scope:
- `src/prompt/prompt-fragments.ts`
- `src/prompt/fragment-composer.ts`
- `src/prompt/template-engine.ts`
- `src/prompt/template-types.ts`
- `src/prompt/template-resolver.ts`
- `src/prompt/template-cache.ts`
- Prompt exports wired through `src/index.ts` and `src/llm.ts`
- Package metadata and published entrypoints in `packages/core/package.json`
- Package-level usage references in `packages/core/README.md`

Out of scope:
- Consumer-specific `PromptStore` implementations (database or service layer)
- Product-specific prompt catalogs or governance policies
- Prompt-adjacent logic implemented outside `src/prompt` (for example skill injection)

## Responsibilities
The module provides reusable primitives for prompt composition and template resolution:
- Static prompt fragment catalog plus simple concatenation.
- Advanced fragment composition with condition gating, dependency resolution, conflict eviction by priority, and token-budget trimming.
- Generic template rendering with variable interpolation, control-flow blocks (`#if`, `#unless`, `#each`), and partial inclusion.
- Context flattening and normalization (`camelCase` + `snake_case` aliases) for template substitution.
- Delimiter escaping for non-raw user/context values to reduce reflected `{{...}}` injection across multi-pass prompt rendering.
- Storage-agnostic prompt resolution and optional TTL cache.
- Prompt type contracts (`TemplateVariable`, `StoredTemplate`, `PromptResolveQuery`, `PromptStore`, etc.).

## Structure
| File | Purpose | Main exports |
| --- | --- | --- |
| `prompt-fragments.ts` | Canonical fragment text blocks and simple ordered composition | `FRAGMENT_*` constants, `PROMPT_FRAGMENTS`, `composeFragments(...)` |
| `fragment-composer.ts` | Advanced composition with dependency/conflict/priority/budget logic | `ComposableFragment`, `ComposeResult`, `validateFragments(...)`, `composeAdvancedFragments(...)` |
| `template-engine.ts` | Template resolution, control flow, variable extraction, and declaration checks | `flattenContext(...)`, `resolveTemplate(...)`, `extractVariables(...)`, `validateTemplate(...)` |
| `template-types.ts` | Shared contracts for context, storage, and resolved output | `TemplateVariable`, `TemplateContext`, `ResolvedPrompt`, `PromptResolveQuery`, `StoredTemplate`, `BulkPromptQuery`, `PromptStore` |
| `template-resolver.ts` | Store-backed prompt lookup plus template application | `PromptResolver`, `ResolutionLevel`, `PromptStore` re-export |
| `template-cache.ts` | In-memory TTL cache with bulk preload path | `PromptCache` |

Export surface:
- `src/index.ts` exports the full prompt API from the main `@dzupagent/core` entrypoint.
- `src/llm.ts` re-exports the same prompt API from `@dzupagent/core/llm`.
- `package.json` does not publish a dedicated `./prompt` subpath; prompt APIs are consumed through `.` or `./llm`.

## Runtime and Control Flow
### Static fragments (`prompt-fragments.ts`)
1. Caller passes fragment IDs to `composeFragments(...names)`.
2. Each ID is looked up in `PROMPT_FRAGMENTS`.
3. Unknown IDs are dropped (`filter(Boolean)`).
4. Included fragments are joined with `\n\n---\n\n`.

### Advanced fragments (`fragment-composer.ts`)
1. Optional pre-check: `validateFragments(...)` reports duplicate IDs, missing dependencies, self-conflicts, and asymmetric conflict declarations.
2. `composeAdvancedFragments(...)` evaluates each fragment `condition` against `options.context`.
3. Dependency resolution runs transitively; dependency cycles are skipped with warnings.
4. If dependency conditions fail, the dependency is still included and a warning is emitted.
5. Conflicts are resolved pairwise by priority (higher `priority` wins; tie favors current fragment in traversal).
6. Survivors are sorted by priority descending, then original input order.
7. Token budget trimming uses `defaultTokenizerRegistry.resolve(model ?? 'heuristic').countTokens(content)`.
8. Result contains `content`, `included`, `excluded`, and `warnings`.

### Template rendering (`template-engine.ts`)
1. `flattenContext(...)` converts unknown values to strings (`null`/`undefined` => `''`, arrays => comma-joined, objects => JSON).
2. Keys are available under original key and snake_case alias.
3. Non-raw values are sanitized by replacing `{{`/`}}` delimiters (`rawVariables` can bypass this for trusted system values).
4. `resolveTemplate(...)` applies variable declaration defaults and required checks (throws only when `strictMode` is true).
5. Control flow is processed first: partials (`{{> name}}`), loops (`{{#each}}`), conditionals (`{{#if}}`, `{{#unless}}`, optional `{{else}}`).
6. Remaining `{{var}}` tokens are replaced from the flattened map; unresolved placeholders become empty strings.

### Resolver and cache (`template-resolver.ts`, `template-cache.ts`)
1. `PromptResolver.resolve(query, context, cache?)` begins with `template = null`.
2. If `query.templateId` is set and hierarchy includes `override`, resolver performs explicit override lookup via `store.findTemplate`.
3. If unresolved and cache provided, resolver checks `cache.get(type, category)` (category-specific first, then general fallback).
4. If still unresolved, resolver calls `store.findTemplate(query)`.
5. If template exists, resolver applies `resolveTemplate(...)` and returns `{ content, config }`.
6. If not found, resolver returns `{ content: '', config: {} }`.
7. `PromptCache.preload(...)` loads `findAllTemplates(...)`, keeps first-seen entries per `type|category` and `type|`, and sets `loadedAt` for TTL evaluation.

## Key APIs and Types
Core functions/classes:
- `composeFragments(...names: string[]): string`
- `validateFragments(fragments: ComposableFragment[]): { valid: boolean; errors: string[] }`
- `composeAdvancedFragments(fragments, options?): ComposeResult`
- `flattenContext(context, rawVariables?)`
- `resolveTemplate(template, context, options?)`
- `extractVariables(template): string[]`
- `validateTemplate(template, declaredVariables, standardVariables?)`
- `new PromptResolver(store, hierarchy?)`
- `promptResolver.resolve(query, context, cache?)`
- `new PromptCache(ttlMs?)`
- `promptCache.preload(store, query)`

Primary types:
- `ComposableFragment`
- `ComposeResult`
- `TemplateVariable`
- `TemplateContext`
- `ResolvedPrompt`
- `PromptResolveQuery`
- `StoredTemplate`
- `BulkPromptQuery`
- `PromptStore`
- `ResolutionLevel` (`override`, `user+category`, `user`, `tenant+category`, `tenant`, `builtin+category`, `builtin`)

Behavior details reflected in code:
- Resolver hierarchy constants exist, but branch-specific store queries are not expanded in resolver code; effective hierarchy semantics depend on store behavior.
- `PromptCache.get(...)` returns `null` when empty/expired and falls back from `type|category` to `type|`.
- `PromptCache.set(...)` seeds a general fallback key for that type if it does not exist.

## Dependencies
Direct dependencies used by this subsystem:
- Internal: `../llm/tokenizer-registry.js` in `fragment-composer.ts` for token counting.
- Internal local prompt modules (`./template-types.js`, `./template-engine.js`, `./template-cache.js`).

External imports used directly by `src/prompt/*`:
- None.

Package-level implications:
- Optional tokenizer backends (`@anthropic-ai/tokenizer`, `js-tiktoken`) are not required by `src/prompt` directly, but can improve token-budget accuracy through `defaultTokenizerRegistry`.
- Published prompt APIs are available through package root and `./llm` exports (`package.json`), not a standalone prompt subpath.

## Integration Points
- `src/index.ts` exposes prompt APIs to general core consumers.
- `src/llm.ts` exposes the same prompt APIs to LLM-focused consumers.
- `fragment-composer.ts` integrates with the LLM tokenizer registry for model-aware budget enforcement.
- `PromptResolver` integrates with consumer-provided storage via the `PromptStore` interface.
- `PromptCache` integrates with the same storage using `findAllTemplates(...)` for warm preload.
- `README.md` references `PromptResolver`, `resolveTemplate`, and related prompt types in public API examples.

## Testing and Observability
Current tests in this scope:
- `src/__tests__/template-engine.test.ts` includes coverage for `flattenContext` value conversion and snake_case aliasing.
- `src/__tests__/template-engine.test.ts` includes coverage for `resolveTemplate` variable interpolation and missing-variable behavior.
- `src/__tests__/template-engine.test.ts` includes coverage for variable declaration defaults and strict/non-strict required variable handling.
- `src/__tests__/template-engine.test.ts` includes coverage for control flow (`#if`, `#unless`, `#each`, `else`) and partial rendering.
- `src/__tests__/template-engine.test.ts` includes coverage for `extractVariables` filtering and deduplication.
- `src/__tests__/template-engine.test.ts` includes coverage for `validateTemplate` required/undeclared variable checks.

Current gaps visible in `src/__tests__`:
- No dedicated tests for `fragment-composer.ts`.
- No dedicated tests for `template-cache.ts`.
- No dedicated tests for `template-resolver.ts`.
- No dedicated tests for static fragment catalog integrity in `prompt-fragments.ts`.

Observability:
- No prompt-specific telemetry/events/logging hooks are emitted from this module.
- Operational introspection is return-value based (`ComposeResult.warnings`, `PromptCache.isExpired()`, `PromptCache.size`).

## Risks and TODOs
- Resolver hierarchy labels suggest multi-level fallback, but resolver currently performs one generic `findTemplate(query)` call after optional override/cache; hierarchy enforcement is delegated to the `PromptStore` implementation.
- `PromptCache.preload(...)` assumes store ordering already reflects priority because first-seen entries win per key.
- Cache is process-local memory only; multi-process deployments require external invalidation/warmup strategy.
- Advanced fragment dependency logic can force-include dependency fragments even when dependency conditions fail.
- Token trimming accuracy depends on tokenizer backend availability/model matching; heuristic fallback may be coarse near strict budgets.
- Missing unit coverage around resolver/cache/advanced composition increases regression risk for conflict and dependency edge cases.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js