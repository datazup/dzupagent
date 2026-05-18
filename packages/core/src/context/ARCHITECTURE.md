# Context Architecture (`packages/core/src/context`)

## Scope
This document describes the current implementation in `packages/core/src/context`, which currently contains:
- `src/context/run-context-transfer.ts`

Verification basis for this refresh:
- implementation: `src/context/run-context-transfer.ts`
- tests: `src/__tests__/run-context-transfer.test.ts`
- exports and packaging: `src/index.ts`, `src/llm.ts`, `src/stable.ts`, `src/advanced.ts`, `package.json`, `tsup.config.ts`
- package-level context: `README.md`, `docs/ARCHITECTURE.md`

This scope is intentionally narrow. `@dzupagent/core` does not implement full context-engineering workflows here; this directory provides persistent cross-intent context handoff only.

## Responsibilities
`RunContextTransfer` is a persistence adapter for intent context snapshots. It is responsible for:
- writing a `PersistedIntentContext` keyed by session and source intent,
- loading a specific prior-intent snapshot,
- selecting a prior snapshot for a current intent using `INTENT_CONTEXT_CHAINS`,
- listing and clearing stored snapshots within one session namespace,
- rejecting stale snapshots according to `maxAgeMs`,
- protecting `search` loops with explicit page limits.

It does not summarize messages, decide what context should be extracted, or inject context into prompts. Those concerns live outside this module.

## Structure
`run-context-transfer.ts` defines:
- `PersistedIntentContext`
- `INTENT_CONTEXT_CHAINS`
- `RunContextTransferConfig`
- `RunContextTransfer`

`PersistedIntentContext` fields:
- `fromIntent: string`
- `summary: string`
- `decisions: string[]`
- `relevantFiles: string[]`
- `workingState: Record<string, unknown>`
- `transferredAt: number`
- `tokenEstimate: number`

Internal constants:
- `DEFAULT_NAMESPACE_PREFIX = ['_run_context']`
- `DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000` (24 hours)
- `SEARCH_PAGE_SIZE = 100`
- `MAX_SEARCH_PAGES = 1000`

Internal helpers:
- `findContextItem(namespace, key)` does paginated lookup for one key.
- `searchAllContextItems(namespace)` does paginated full-namespace scanning.

## Runtime and Control Flow
1. Construction
- `new RunContextTransfer({ store, namespacePrefix?, maxAgeMs? })` stores the `BaseStore` and resolves defaults.

2. Save path
- `save(sessionId, context)` targets namespace `[...namespacePrefix, sessionId]`.
- Key format is `intent:${context.fromIntent}`.
- Payload overwrites existing data for the same key.
- `transferredAt` is backfilled with `Date.now()` when missing or falsy.

3. Load path by explicit intent
- `load(sessionId, fromIntent)` finds `intent:${fromIntent}` via paginated search.
- Returns `null` when key is missing.
- Returns `null` when `transferredAt` is absent.
- Returns `null` when snapshot age exceeds `maxAgeMs`.
- Returns the stored snapshot otherwise.

4. Load path by intent chain
- `loadForIntent(sessionId, currentIntent)` reads `INTENT_CONTEXT_CHAINS[currentIntent]`.
- It calls `load(...)` in chain order and returns the first non-stale match.
- Returns `null` when no chain exists or no candidate resolves.

5. Session-scoped management
- `listContexts(sessionId)` scans the namespace and returns entries with both `fromIntent` and `transferredAt`.
- `clear(sessionId)` scans all keys in the namespace and deletes each one.

6. Search guardrails
- Both lookup helpers stop after `MAX_SEARCH_PAGES`.
- If this limit is reached, the module throws an explicit error rather than looping indefinitely.

## Key APIs and Types
Primary class:
- `RunContextTransfer`
- `save(sessionId: string, context: PersistedIntentContext): Promise<void>`
- `load(sessionId: string, fromIntent: string): Promise<PersistedIntentContext | null>`
- `loadForIntent(sessionId: string, currentIntent: string): Promise<PersistedIntentContext | null>`
- `listContexts(sessionId: string): Promise<PersistedIntentContext[]>`
- `clear(sessionId: string): Promise<void>`

Config type:
- `RunContextTransferConfig`
- `store: BaseStore` (required)
- `namespacePrefix?: string[]`
- `maxAgeMs?: number`

Current static intent chain map:
- `edit_feature -> ['generate_feature', 'create_feature']`
- `configure -> ['generate_feature', 'create_feature', 'edit_feature']`
- `create_template -> ['generate_feature']`
- `generate_feature -> ['configure']`

## Dependencies
Direct implementation dependency:
- `BaseStore` from `@langchain/langgraph`

Package dependency posture (`packages/core/package.json`):
- `@langchain/langgraph` is declared as a peer dependency.
- It is also declared in `devDependencies` for local development and tests.

Build/export context:
- `src/context` is not a dedicated package subpath export.
- The context transfer API is exposed through:
- root barrel (`src/index.ts`) -> `@dzupagent/core`
- llm barrel (`src/llm.ts`) -> `@dzupagent/core/llm`
- advanced barrel (`src/advanced.ts`) -> `@dzupagent/core/advanced` (re-exports root)

## Integration Points
In-package exports:
- `src/index.ts` exports `RunContextTransfer`, `INTENT_CONTEXT_CHAINS`, and related types.
- `src/llm.ts` exports the same symbols for the `@dzupagent/core/llm` subpath.
- `src/advanced.ts` re-exports `src/index.ts`, so these symbols are also available via `@dzupagent/core/advanced`.
- `src/stable.ts` re-exports facade namespaces only, so `RunContextTransfer` is not provided by `@dzupagent/core/stable`.

Known downstream use in this monorepo:
- `packages/server/src/runtime/run-stages-execution.ts` consumes `RunContextTransfer` type from `@dzupagent/core/llm` and calls `loadForIntent(...)`.
- `packages/server/src/__tests__/e2e-run-pipeline.test.ts` constructs `RunContextTransfer` with a LangGraph store.

Architectural boundary:
- `@dzupagent/core` intentionally avoids re-exporting full `@dzupagent/context` and `@dzupagent/memory` layers from the root surface.
- `RunContextTransfer` stays in core as a narrow persistence bridge for cross-intent handoff.

## Testing and Observability
Test coverage in `src/__tests__/run-context-transfer.test.ts` includes:
- save/load success and missing-key behavior,
- stale-context rejection using `maxAgeMs`,
- chain-based resolution (`loadForIntent`),
- unknown-intent behavior,
- session listing and clearing behavior,
- pagination behavior beyond one page (`120` saved contexts),
- namespace/session isolation,
- baseline assertions for `INTENT_CONTEXT_CHAINS`.

Observability behavior:
- no direct event emission, metrics, or structured logging in this module,
- operational failures surface as thrown errors (notably page-limit guard failures in search loops).

## Risks and TODOs
- `INTENT_CONTEXT_CHAINS` is static code configuration and requires a release for policy changes.
- Reads depend on paginated `store.search` scans and can become expensive with large per-session keysets.
- Expiration is enforced at read time only; stale keys remain stored until explicit cleanup.
- Stored values are cast from `unknown` with minimal runtime validation beyond presence checks for `fromIntent` and `transferredAt`.
- Per-intent history is not retained: writes overwrite by `sessionId + intent` key.
- `clear(sessionId)` performs one delete call per key, which may be slow for very large namespaces.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js