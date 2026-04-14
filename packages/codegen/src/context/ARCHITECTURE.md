# `packages/codegen/src/context` Architecture

## Scope
This folder currently contains one module:

- `token-budget.ts`: phase-aware file-context selection for code generation prompts.

It is exported publicly via `@dzupagent/codegen` from `packages/codegen/src/index.ts`.

## What This Module Solves
`token-budget.ts` manages prompt context pressure when many files are available in a VFS snapshot.

It provides:

- file role detection (`model`, `service`, `component`, `test`, etc.),
- phase-specific inclusion policy (`full`, `interface`, `summary`),
- heuristic token budgeting,
- graceful degradation from full file content to compact summaries.

This lets higher-level generation flows keep useful context while reducing token usage.

## Public API

### Types and extension points

- `FileRoleDetector`: pluggable role classification by path.
- `PhasePriorityMatrix`: pluggable phase x role priority policy.
- `FileEntry`: `{ path, content }` output entry.
- `TokenBudgetOptions`: config for budget and custom strategies.

### Built-in implementations

- `DefaultRoleDetector`: path-pattern-based role inference.
- `DefaultPriorityMatrix`: built-in phase policy for:
  - `generate_db`
  - `generate_backend`
  - `generate_frontend`
  - `generate_tests`
  - `fix`
  - fallback for other phases (`full` for all roles)

### Helper functions

- `summarizeFile(path, content)`: one-line summary (`exports + line count`).
- `extractInterfaceSummary(path, content)`: keeps imports, exported type/interface blocks, and exported function signatures.

### Main orchestrator

- `TokenBudgetManager`:
  - estimates tokens (`charsPerToken`, default `4`),
  - applies priority policy,
  - returns selected `FileEntry[]` via `selectFiles(vfs, phase)`.

## Feature Breakdown

### 1. Role-driven context shaping
The manager does not treat all files equally. It first classifies each file with `DefaultRoleDetector`.

Important built-in rules:

- `*.prisma` or paths containing `/schema` -> `model`
- `*.test.*`, `*.spec.*`, `__tests__` -> `test`
- `*.types.*`, `/types/`, `*.dto.*`, `/dto/` -> `type`
- `*.validator.*`, `*.schema.*`, `/validators/`, `/schemas/` -> `validator`
- route/controller/service/component/store/composable/api-client/config patterns
- otherwise -> `other`

### 2. Phase-aware priorities
`DefaultPriorityMatrix` maps `(phase, role)` to one of:

- `full`: include full file content if budget allows.
- `interface`: include extracted interface summary.
- `summary`: include one-line summary.

Examples:

- `generate_db`: prefers `model`, `type`, `config`; de-emphasizes UI.
- `generate_backend`: emphasizes `route/controller/service/model/type/validator`.
- `generate_frontend`: emphasizes `component/store/composable/api-client`.
- `fix` and `generate_tests`: broad full-context bias.
- unknown phases (`review`, `validate`, etc.) default to `full` for all roles.

### 3. Progressive downgrade behavior
When budget is tight, selection downgrades:

1. try full content,
2. fallback to interface summary,
3. fallback to one-line summary.

This gives predictable "most-useful-first" compression.

### 4. Pluggable strategy model
Both role detection and phase policy are dependency-injected.

You can replace:

- how files are classified,
- how priorities are assigned.

This supports language/framework/domain-specific context packing.

## Selection Flow

`TokenBudgetManager.selectFiles(vfs, phase)` executes this flow:

1. Convert VFS map to list of `{ path, content, role, priority }`.
2. Sort by priority order: `full` -> `interface` -> `summary`.
3. Iterate files in sorted order.
4. For `full`:
   - include full content if it fits,
   - else try interface summary,
   - else include one-line summary.
5. For `interface`:
   - include interface summary if it fits,
   - else include one-line summary.
6. For `summary`:
   - include one-line summary.
7. Return selected entries.

### Important behavior notes

- Budget estimation is heuristic, not tokenizer-accurate.
- Summary fallback is always included, even when remaining budget is near zero, so budget is "soft" rather than strict hard-stop.
- Files with the same priority rely on input ordering from `Object.entries(vfs)` (insertion order semantics).

## Usage Examples

### 1. Default usage

```ts
import { TokenBudgetManager } from '@dzupagent/codegen'

const manager = new TokenBudgetManager({
  budgetTokens: 16_000,
  charsPerToken: 4,
})

const selected = manager.selectFiles(vfsSnapshot, 'generate_backend')
// selected is FileEntry[] with mixed full/interface/summary content
```

### 2. Custom role detector and matrix

```ts
import {
  TokenBudgetManager,
  type FileRoleDetector,
  type PhasePriorityMatrix,
} from '@dzupagent/codegen'

const roleDetector: FileRoleDetector = {
  detect(path) {
    if (path.includes('/migrations/')) return 'migration'
    if (path.includes('/contracts/')) return 'contract'
    return 'other'
  },
}

const priorityMatrix: PhasePriorityMatrix = {
  getPriority(phase, role) {
    if (phase === 'generate_backend' && role === 'contract') return 'full'
    if (phase === 'generate_backend' && role === 'migration') return 'interface'
    return 'summary'
  },
}

const manager = new TokenBudgetManager({ roleDetector, priorityMatrix, budgetTokens: 6_000 })
const selected = manager.selectFiles(vfsSnapshot, 'generate_backend')
```

### 3. Helper-only usage

```ts
import { summarizeFile, extractInterfaceSummary } from '@dzupagent/codegen'

const brief = summarizeFile('src/user.service.ts', fileContent)
const iface = extractInterfaceSummary('src/user.service.ts', fileContent)
```

## Common Use Cases

- Large multi-file generation where only a subset can fit in prompt context.
- Backend phase planning where route/controller/service interfaces are needed before implementation details.
- Frontend regeneration where components and stores should dominate context over backend internals.
- Fix loops where broad context is needed but still benefits from graceful compression.
- Custom domain workflows with organization-specific role taxonomies.

## References and Usage Across Packages

### Direct symbol usage
Current repository scan shows:

- direct usage of `TokenBudgetManager` and helpers is currently inside `@dzupagent/codegen` tests and exports,
- no direct imports of `TokenBudgetManager`, `DefaultRoleDetector`, or `DefaultPriorityMatrix` from other packages.

### Package-level usage of `@dzupagent/codegen`
Other packages consume `@dzupagent/codegen` for other capabilities (not this context module directly), for example:

- `packages/server/src/runtime/tool-resolver.ts`: dynamic import to expose git tools.
- `packages/evals/src/__tests__/sandbox-contracts.test.ts`: conditional imports for sandbox contracts.
- `packages/create-dzupagent/src/templates/codegen.ts`: template dependency declaration.

Implication: this module is available as public API, but appears currently underutilized cross-package.

## Test Coverage

## Test suite
Primary tests are in:

- `packages/codegen/src/__tests__/token-budget.test.ts`

Executed locally with:

- `yarn workspace @dzupagent/codegen test -- src/__tests__/token-budget.test.ts`

Result:

- 1 test file passed
- 48/48 tests passed

### Coverage metrics for `src/context/token-budget.ts`
From `packages/codegen/coverage/coverage-summary.json` (generated via package coverage run):

- lines: `95.09%` (`310/326`)
- statements: `95.09%` (`310/326`)
- functions: `100%` (`11/11`)
- branches: `94.23%` (`98/104`)

### Coverage caveat
The targeted coverage run still exits non-zero because package-global thresholds apply to the entire package, not only this file. Module-level metrics above are still valid for this context module.

### Remaining uncovered behavior (high-value additions)
Likely low-covered paths are narrow fallback branches in `selectFiles()`:

- full -> summary fallback when both full content and interface summary exceed budget.
- interface -> summary fallback under extremely small remaining budget.

Adding explicit tests for these two downgrade paths would close most of the remaining branch gap.

## Design Strengths

- simple and composable architecture (small API, clear extension points),
- deterministic priority-first behavior,
- pragmatic degradation strategy for prompt-size pressure,
- strong focused unit coverage for its size.

## Limitations and Improvement Opportunities

- token estimate uses a fixed chars/token heuristic; this can diverge from model tokenizer reality,
- summary inclusion is soft-budget (can exceed strict limit),
- role detection is path-regex driven and can misclassify edge naming patterns,
- interface extraction is TypeScript-oriented and intentionally shallow (not a semantic parser),
- unknown phases default to `full` for all roles, which may become expensive without custom matrix overrides.

## Recommended Next Steps

1. Integrate `TokenBudgetManager` into a real pipeline executor path (if not already done at application layer) to validate behavior in production-like loops.
2. Add explicit branch tests for both summary fallback branches in `selectFiles()`.
3. Optionally add a strict-budget mode that drops summaries once budget is exhausted.
4. Consider optional tokenizer-backed estimation for models where budget precision is critical.
