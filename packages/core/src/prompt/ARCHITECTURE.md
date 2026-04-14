# Prompt Architecture (`packages/core/src/prompt`)

## Scope
This document describes the prompt subsystem implemented in:

- `template-types.ts`
- `template-engine.ts`
- `template-resolver.ts`
- `template-cache.ts`
- `prompt-fragments.ts`
- `fragment-composer.ts`

It covers features, flow, usage patterns, in-repo references, and current test coverage.

## Why This Module Exists
The prompt module provides reusable prompt-building primitives for DzupAgent runtimes:

- deterministic template rendering (`{{var}}`, control flow, partials)
- hierarchical template lookup through pluggable storage
- caching for high-frequency prompt resolution paths
- reusable prompt fragments for code-generation/system-prompt assembly
- advanced fragment orchestration (dependencies, conflicts, token budget)

## Module Responsibilities

| File | Responsibility |
| --- | --- |
| `template-types.ts` | Prompt/template contracts (`TemplateVariable`, `TemplateContext`, store query/response types). |
| `template-engine.ts` | String rendering engine: context flattening, control flow, interpolation, variable extraction and validation. |
| `template-resolver.ts` | Runtime resolver that fetches a `StoredTemplate` from a `PromptStore` and applies `template-engine`. |
| `template-cache.ts` | TTL cache + bulk preload for `type|category` and fallback `type|` lookups. |
| `prompt-fragments.ts` | Canonical static prompt fragments + simple composition helper. |
| `fragment-composer.ts` | Advanced composition: dependency resolution, conflict arbitration, conditionals, token budget trimming. |

## Feature Set

### 1. Typed prompt contracts
`template-types.ts` defines the API boundary for prompt resolution and storage:

- author-time declarations: `TemplateVariable`
- runtime context: `TemplateContext`
- storage payload: `StoredTemplate`
- lookup query types: `PromptResolveQuery`, `BulkPromptQuery`
- output contract: `ResolvedPrompt`

This keeps the renderer generic and storage-agnostic.

### 2. Template rendering engine
`resolveTemplate()` in `template-engine.ts` supports:

- direct placeholders: `{{name}}`
- control flow blocks:
  - `{{#if var}}...{{/if}}`
  - `{{#unless var}}...{{/unless}}`
  - `{{#each items}}...{{this}}...{{/each}}`
- partial includes: `{{> partial_name}}`
- required/default variable handling via `TemplateVariable[]`
- optional strict mode to throw on missing required vars

### 3. Context normalization for template ergonomics
`flattenContext()` converts arbitrary values to string-friendly values and maps keys twice:

- original key (`userName`)
- snake alias (`user_name`)

This allows templates to use either style without duplicate context wiring.

### 4. Template static analysis
`extractVariables()` and `validateTemplate()` support authoring-time checks:

- find used placeholders
- detect undeclared placeholders
- detect required variables declared but not used
- allow approved "standard" variables without per-template declaration

### 5. Hierarchical prompt resolution
`PromptResolver` provides a runtime path that can support override/user/tenant/builtin resolution via `PromptStore`.

Current behavior in resolver class:

1. optional explicit override (`templateId`)
2. optional cache read (`PromptCache`)
3. store lookup (`findTemplate`)
4. rendering via `resolveTemplate`
5. empty fallback (`{ content: '', config: {} }`)

### 6. TTL cache + bulk preload
`PromptCache` can preload templates in bulk (`findAllTemplates`) and serve fast lookups by:

- exact `type|category`
- fallback `type|` (general)

Cache invalidation is coarse-grained and TTL-based (`loadedAt + ttlMs`).

### 7. Reusable prompt fragments
`prompt-fragments.ts` ships policy/system fragments (core principles, security checklist, scope boundary, verification mindset, etc.) and a simple string composer.

### 8. Advanced fragment composition
`composeAdvancedFragments()` adds production controls missing in simple concatenation:

- condition predicates
- transitive dependency inclusion
- conflict handling (higher priority wins)
- stable ordering by priority + declaration order
- approximate token-budget trimming
- diagnostic output (`included`, `excluded`, `warnings`)

## Execution Flows

### Flow A: Template rendering
1. Caller provides template string + `TemplateContext`.
2. `flattenContext()` converts values to strings and adds camel/snake aliases.
3. Optional declared variables apply defaults / required checks.
4. Control-flow prepass resolves partials, `#each`, `#if`, `#unless`.
5. Remaining `{{var}}` placeholders are substituted.
6. Unresolved placeholders become empty string.

### Flow B: Resolver path with cache
1. Caller calls `PromptResolver.resolve(query, context, cache?)`.
2. If `query.templateId` exists, resolver attempts explicit template override.
3. If unresolved and cache provided, resolver checks `cache.get(query.type, query.category)`.
4. If still unresolved, resolver calls `store.findTemplate(query)`.
5. On template hit, resolver applies template and returns `{ content, config }`.
6. On miss, returns empty prompt payload.

### Flow C: Cache preload
1. Caller invokes `cache.preload(store, { types, tenantId?, userId? })`.
2. Cache calls `store.findAllTemplates(query)`.
3. For each result, first-seen template wins for:
   - category key (`type|category`)
   - general fallback (`type|`)
4. Cache stamps `loadedAt` for TTL checks.

### Flow D: Advanced fragment composition
1. Candidate fragment set is received.
2. Conditions filter initial candidates.
3. Dependencies are resolved transitively (warnings on cycles).
4. Conflicts are resolved by priority.
5. Remaining fragments are ordered and token-budget trimmed.
6. Output includes content and diagnostic metadata.

## Public API (via `@dzupagent/core`)
Exported from `packages/core/src/index.ts`:

- fragments/constants: `FRAGMENT_*`, `PROMPT_FRAGMENTS`, `composeFragments`
- advanced composer: `composeAdvancedFragments`, `validateFragments`
- engine: `resolveTemplate`, `extractVariables`, `validateTemplate`, `flattenContext`
- resolver/cache: `PromptResolver`, `PromptCache`
- types: `TemplateVariable`, `TemplateContext`, `StoredTemplate`, `ResolvedPrompt`, `PromptResolveQuery`, `BulkPromptQuery`, `PromptStore`, `ResolutionLevel`

## Cross-Package References and Usage

### `@dzupagent/core`
- Prompt API is exported centrally in `packages/core/src/index.ts`.
- Mentioned in package docs:
  - `packages/core/README.md`
  - `packages/core/docs/ARCHITECTURE.md`

### Other packages (current in-repo state)
- No direct runtime imports of core prompt APIs (`PromptResolver`, `PromptCache`, `resolveTemplate`, fragment composers) were found outside `packages/core/**`.
- `packages/agent-adapters` contains a separate workflow-specific resolver (`packages/agent-adapters/src/workflow/template-resolver.ts`) used by `adapter-workflow.ts`. That resolver is independent and narrower (`{{prev}}`, `{{state.x}}`) than core's generic engine.

Implication: prompt module is currently an exported platform capability with strong local implementation, but limited cross-package runtime adoption in this repository snapshot.

## Usage Examples

### Example 1: Render a template with control flow and partials
```ts
import { resolveTemplate } from '@dzupagent/core'

const template = `
{{> intro}}
{{#if user_name}}Hello {{user_name}}!{{else}}Hello there!{{/if}}
{{#each tags}}- {{this}}\n{{/each}}
`

const rendered = resolveTemplate(
  template,
  { userName: 'Nina', tags: ['core', 'prompt'] },
  { partials: { intro: 'System: Be concise.' } },
)

// Renders user_name from camelCase context alias and expands list.
```

### Example 2: Validate template authoring contracts
```ts
import { validateTemplate, type TemplateVariable } from '@dzupagent/core'

const declared: TemplateVariable[] = [
  { name: 'task', description: 'Task to execute', required: true },
  { name: 'language', description: 'Output language', required: false, defaultValue: 'en' },
]

const result = validateTemplate('Do: {{task}} using {{tool}}', declared)

// result.valid === true/false
// result.undeclaredVariables contains ['tool']
// result.errors contains required-but-unused declaration issues
```

### Example 3: Compose policy fragments with token budget
```ts
import { composeAdvancedFragments, type ComposableFragment } from '@dzupagent/core'

const fragments: ComposableFragment[] = [
  { id: 'core', content: 'Core rules...', priority: 100 },
  { id: 'security', content: 'Security checks...', priority: 90, dependencies: ['core'] },
  { id: 'verbose', content: 'Very long explanations...', priority: 10, conflicts: ['concise'] },
  { id: 'concise', content: 'Keep output concise.', priority: 80, conflicts: ['verbose'] },
]

const composed = composeAdvancedFragments(fragments, { maxTokens: 80 })

// composed.content => selected/ordered fragments joined by separators
// composed.warnings => budget/conflict/dependency notes
```

### Example 4: Plug `PromptResolver` into a custom store + cache
```ts
import {
  PromptResolver,
  PromptCache,
  type PromptStore,
  type PromptResolveQuery,
  type BulkPromptQuery,
  type StoredTemplate,
} from '@dzupagent/core'

class InMemoryPromptStore implements PromptStore {
  constructor(private templates: StoredTemplate[]) {}

  async findTemplate(query: PromptResolveQuery): Promise<StoredTemplate | null> {
    if (query.templateId) {
      return this.templates.find(t => t.id === query.templateId) ?? null
    }
    return this.templates.find(t => t.type === query.type && (!query.category || t.category === query.category)) ?? null
  }

  async findAllTemplates(query: BulkPromptQuery): Promise<StoredTemplate[]> {
    return this.templates.filter(t => query.types.includes(t.type))
  }
}

const store = new InMemoryPromptStore([
  {
    id: 't1',
    type: 'planner',
    category: 'default',
    content: 'Plan for {{feature}}',
    variables: [{ name: 'feature', description: 'Feature name', required: true }],
    config: { temperature: 0.2 },
  },
])

const resolver = new PromptResolver(store)
const cache = new PromptCache(5 * 60 * 1000)
await cache.preload(store, { types: ['planner'] })

const prompt = await resolver.resolve({ type: 'planner', category: 'default' }, { feature: 'agent retries' }, cache)
```

## Testing and Coverage

### Executed checks
- Ran focused prompt test file:
  - `yarn workspace @dzupagent/core test src/__tests__/template-engine.test.ts`
  - Result: `35/35` tests passed.

### Coverage evidence (prompt module)
From `packages/core/coverage/coverage-summary.json` after running:
`yarn workspace @dzupagent/core test:coverage src/__tests__/template-engine.test.ts`

Prompt aggregate:

- lines: `29.11%` (`207/711`)
- statements: `29.11%` (`207/711`)
- functions: `63.64%` (`7/11`)
- branches: `90.14%` (`64/71`)

Per file:

- `template-engine.ts`: lines `100%`, functions `100%`, statements `100%`, branches `95.52%`
- `fragment-composer.ts`: `0%`
- `prompt-fragments.ts`: `0%`
- `template-cache.ts`: `0%`
- `template-resolver.ts`: `0%`

Notes:

- Coverage command exits non-zero due package-level global thresholds when only one test file is run.
- Prompt engine has strong direct unit coverage; resolver/cache/fragment layers currently lack dedicated tests.

## Known Constraints and Gaps

- `PromptResolver.hierarchy` is modeled in types/defaults, but resolver currently delegates most hierarchy behavior to `PromptStore.findTemplate(query)` rather than iterating levels itself (except explicit override gate).
- Cache preload assumes store results are already priority-sorted (first match wins).
- `#each` currently operates on comma-split flattened values; list elements containing commas are not represented losslessly.
- Partial-miss behavior inserts an HTML comment marker string; consumers expecting pure prompt text may want an alternate strategy.

## Recommended Next Coverage Additions

1. `template-resolver.test.ts`
- verify override path, cache-hit short-circuit, store fallback, empty-result fallback.

2. `template-cache.test.ts`
- verify TTL expiry, category/general fallback semantics, preload precedence rules.

3. `fragment-composer.test.ts`
- verify dependency resolution, conflict eviction, cycle warnings, token budget trimming behavior.

4. `prompt-fragments.test.ts`
- verify stable fragment key map and simple composition ordering.
