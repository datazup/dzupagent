# `packages/codegen/src/context` Architecture

## Scope
This subsystem is the `packages/codegen/src/context` folder and currently contains one implementation file:

- `token-budget.ts`

It is exported through the package barrel in `packages/codegen/src/index.ts` under the public `@dzupagent/codegen` API.

## Responsibilities
`token-budget.ts` is a utility layer for shaping prompt context from a file map (`Record<string, string>`) under a token budget.

Current responsibilities in code are:

- classify each file path into a role via `FileRoleDetector` (`DefaultRoleDetector` by default),
- map `(phase, role)` to an inclusion level via `PhasePriorityMatrix` (`DefaultPriorityMatrix` by default),
- compress file content using either:
- full content,
- interface-oriented extraction (`extractInterfaceSummary`),
- one-line summary (`summarizeFile`),
- return selected file entries as `FileEntry[]` from `TokenBudgetManager.selectFiles()`.

## Structure
Single-module structure:

- `token-budget.ts`

Contained exports:

- Interfaces: `FileRoleDetector`, `PhasePriorityMatrix`, `FileEntry`, `TokenBudgetOptions`
- Default implementations: `DefaultRoleDetector`, `DefaultPriorityMatrix`
- Helper functions: `summarizeFile`, `extractInterfaceSummary`
- Main coordinator: `TokenBudgetManager`

Internal model details:

- Built-in file-role taxonomy is string-based (`model`, `type`, `validator`, `route`, `controller`, `service`, `component`, `store`, `composable`, `api-client`, `test`, `config`, `other`).
- Priority levels are fixed to `'full' | 'interface' | 'summary'`.
- `DefaultPriorityMatrix` has explicit maps for `generate_db`, `generate_backend`, `generate_frontend`, `generate_tests`, and `fix`; unknown phases default to `full`.

## Runtime and Control Flow
`TokenBudgetManager.selectFiles(vfs, phase)` flow:

1. Convert VFS map entries to a working list with `{ path, content, priority }`, where priority comes from role detection plus phase matrix lookup.
2. Sort by priority order: `full` first, then `interface`, then `summary`.
3. Iterate in sorted order and estimate token usage via `Math.ceil(text.length / charsPerToken)`.
4. For `full` priority files:
- include full content if it fits,
- otherwise try interface summary,
- otherwise include one-line summary.
5. For `interface` priority files:
- include interface summary if it fits,
- otherwise include one-line summary.
6. For `summary` priority files:
- include one-line summary directly.
7. Return `FileEntry[]`.

Important behavior in current implementation:

- Budget enforcement is soft: summary fallback is still added even if it pushes above `budgetTokens`.
- Interface extraction is textual and signature-oriented (imports, exported type/interface blocks, exported function signatures, exported arrow function signatures), not AST/tokenizer-based.
- Stable ordering for same-priority files follows JavaScript object entry insertion semantics from the incoming `vfs` object.

## Key APIs and Types
Primary API surface:

- `new TokenBudgetManager(options?: TokenBudgetOptions)`
- `TokenBudgetManager.selectFiles(vfs: Record<string, string>, phase: string): FileEntry[]`
- `TokenBudgetManager.summarizeFile(path: string, content: string): string`
- `TokenBudgetManager.extractInterfaceSummary(path: string, content: string): string`

Extension points:

- `FileRoleDetector.detect(path: string): string`
- `PhasePriorityMatrix.getPriority(phase: string, role: string): 'full' | 'interface' | 'summary'`

Standalone helpers:

- `summarizeFile(path, content)` for compact line/exports metadata
- `extractInterfaceSummary(path, content)` for signature-level compression

## Dependencies
Module-level dependencies (`token-budget.ts`):

- no runtime imports from other local modules,
- no direct third-party imports.

Package-level context:

- exported by `@dzupagent/codegen` (`packages/codegen/src/index.ts`),
- distributed through package `exports` in `packages/codegen/package.json` (`"." -> dist/index.js` / `dist/index.d.ts`).

## Integration Points
Current integration points in local codebase:

- public export in `packages/codegen/src/index.ts`,
- direct execution coverage in:
- `packages/codegen/src/__tests__/token-budget.test.ts`,
- `packages/codegen/src/__tests__/branch-coverage-misc.test.ts`.

Based on current source scan, there are no non-test runtime imports of `TokenBudgetManager` within `packages/codegen/src` besides the module itself and barrel export. This indicates it is a published utility surface that is currently validated mainly through tests.

## Testing and Observability
Current tests touching this subsystem:

- dedicated suite: `src/__tests__/token-budget.test.ts`,
- branch coverage extras: `src/__tests__/branch-coverage-misc.test.ts` (token-budget section).

Local verification run:

- command: `yarn workspace @dzupagent/codegen test -- src/__tests__/token-budget.test.ts src/__tests__/branch-coverage-misc.test.ts`
- result: `2` test files passed, `88` tests passed.

Observability:

- no built-in logging/telemetry hooks in `token-budget.ts`,
- behavior is observable through deterministic return values and unit tests only.

## Risks and TODOs
- Token estimation uses a fixed `charsPerToken` heuristic; model-specific tokenizer mismatch can affect real prompt budgets.
- Soft-budget fallback may exceed configured budgets in constrained contexts.
- Role detection is path-pattern based and can misclassify ambiguous naming patterns.
- Unknown phases default to `full` for all roles, which can increase context size unexpectedly.
- Module is currently not wired into another non-test runtime path inside this package; production behavior depends on external consumers invoking it.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

