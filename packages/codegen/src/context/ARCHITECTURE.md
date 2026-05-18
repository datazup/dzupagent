# `packages/codegen/src/context` Architecture

## Scope
This document covers `packages/codegen/src/context` inside `@dzupagent/codegen`.

Current scope is a single module:
- `token-budget.ts`

This module is part of the package public surface through the root barrel (`packages/codegen/src/index.ts`), which re-exports:
- `TokenBudgetManager`
- `DefaultRoleDetector`
- `DefaultPriorityMatrix`
- `summarizeFile`
- `extractInterfaceSummary`
- `FileRoleDetector`, `PhasePriorityMatrix`, `FileEntry`, `TokenBudgetOptions`

## Responsibilities
`token-budget.ts` provides phase-aware context shaping for code generation and review workflows by selecting how much file content to include under a token budget heuristic.

Primary responsibilities in current code:
- Classify files by role using `FileRoleDetector` (default: `DefaultRoleDetector` path-based rules).
- Convert `(phase, role)` to inclusion priority via `PhasePriorityMatrix` (default: `DefaultPriorityMatrix`).
- Produce compressed context payloads with three levels:
  - `full`: original file content
  - `interface`: signature/import-focused extraction
  - `summary`: one-line metadata summary
- Iterate through VFS files and emit selected `FileEntry[]` for downstream prompt assembly.

## Structure
Single-file implementation:
- `token-budget.ts`

Exports are organized as:
- Interfaces:
  - `FileRoleDetector`
  - `PhasePriorityMatrix`
  - `FileEntry`
  - `TokenBudgetOptions`
- Default strategy classes:
  - `DefaultRoleDetector`
  - `DefaultPriorityMatrix`
- Helper functions:
  - `summarizeFile(path, content)`
  - `extractInterfaceSummary(path, content)`
- Orchestrator:
  - `TokenBudgetManager`

Built-in role taxonomy used by default matrix:
- `model`
- `type`
- `validator`
- `route`
- `controller`
- `service`
- `component`
- `store`
- `composable`
- `api-client`
- `test`
- `config`
- `other`

Supported priority levels:
- `full`
- `interface`
- `summary`

## Runtime and Control Flow
`TokenBudgetManager.selectFiles(vfs, phase)` runs this pipeline:

1. Convert each VFS entry to `{ path, content, priority }`.
2. Determine `role` via `roleDetector.detect(path)`.
3. Resolve `priority` via `priorityMatrix.getPriority(phase, role)`.
4. Sort entries by priority order: `full` -> `interface` -> `summary`.
5. For each file, estimate tokens using `Math.ceil(text.length / charsPerToken)`.
6. Apply fallback behavior:
   - `full` priority:
     - include full content if within remaining budget
     - otherwise try interface summary
     - otherwise include one-line summary
   - `interface` priority:
     - include interface summary if within remaining budget
     - otherwise include one-line summary
   - `summary` priority:
     - include one-line summary directly
7. Return accumulated `FileEntry[]`.

Key behavior details from implementation:
- Empty input returns `[]`.
- Unknown phases default to `full` for all roles in `DefaultPriorityMatrix`.
- For known phases, unmapped roles default to `summary`.
- Budget enforcement is best-effort rather than hard-capped because fallback summaries are still added even when they push total estimated tokens beyond the configured budget.

Phase maps in `DefaultPriorityMatrix`:
- `generate_db`
- `generate_backend`
- `generate_frontend`
- `generate_tests`
- `fix`

`extractInterfaceSummary` logic is regex/text driven, not AST-driven. It captures:
- `import ...` statements
- exported `type`/`interface` blocks
- exported function signature lines (`export function`, `export async function`)
- exported arrow function signatures (`export const name = ... =>`)

If no extractable lines are found, it falls back to `summarizeFile`.

## Key APIs and Types
Core constructor and methods:
- `new TokenBudgetManager(options?: TokenBudgetOptions)`
- `selectFiles(vfs: Record<string, string>, phase: string): FileEntry[]`
- `summarizeFile(path: string, content: string): string`
- `extractInterfaceSummary(path: string, content: string): string`

Configuration surface (`TokenBudgetOptions`):
- `budgetTokens?: number` (default `16000`)
- `charsPerToken?: number` (default `4`)
- `roleDetector?: FileRoleDetector`
- `priorityMatrix?: PhasePriorityMatrix`

Extension points:
- `FileRoleDetector.detect(path)` lets consumers replace path-based role inference.
- `PhasePriorityMatrix.getPriority(phase, role)` lets consumers redefine priority policy.

Helper APIs:
- `summarizeFile(path, content)` returns `<path>: Exports: ... <lineCount> lines.` format.
- `extractInterfaceSummary(path, content)` returns extracted interface-level text with a module header comment.

## Dependencies
Module-level dependencies (`src/context/token-budget.ts`):
- No imports from other local modules.
- No third-party runtime imports.

Package-level context:
- Package runtime dependency: `@dzupagent/core` (from `packages/codegen/package.json`), but this context module does not currently call it directly.
- Typescript/Vitest toolchain validates behavior in tests.

## Integration Points
Current integration points in `packages/codegen`:
- Public export via `src/index.ts`.
- Direct unit coverage through:
  - `src/__tests__/token-budget.test.ts`
  - `src/__tests__/branch-coverage-misc.test.ts`

Current runtime coupling inside this package is minimal; this module is primarily a reusable utility surface exported for external and internal consumers.

## Testing and Observability
Test coverage includes:
- Role classification branches in `DefaultRoleDetector`.
- Priority resolution paths in `DefaultPriorityMatrix`.
- Summary extraction behavior (`summarizeFile`, `extractInterfaceSummary`).
- `TokenBudgetManager.selectFiles` behavior under:
  - empty VFS
  - enough budget for full files
  - downgrade to interface summary
  - summary-priority inclusion
  - custom detector/matrix injection
  - branch-focused fallback scenarios

Observability status:
- No internal logger, metrics, or tracing hooks in this module.
- Behavior is observable through deterministic return values and tests.

## Risks and TODOs
- Token estimation uses fixed `charsPerToken`; mismatch vs model tokenizer can under/over-estimate actual prompt cost.
- Soft budget behavior can exceed `budgetTokens` after fallback summary insertion.
- Role detection is heuristic/path-based and may misclassify edge naming patterns.
- Interface extraction is regex/text based and may miss complex or unconventional TypeScript exports.
- Unknown phases default to `full`, which can unintentionally inflate prompt context if callers pass non-standard phase names.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js