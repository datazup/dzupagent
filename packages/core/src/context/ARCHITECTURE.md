# Context Architecture (`packages/core/src/context`)

## Scope
This document covers the context module inside `@dzupagent/core` at:

- `src/context/run-context-transfer.ts`
- exports in `src/index.ts`
- module tests in `src/__tests__/run-context-transfer.test.ts`

In the current codebase, `src/context` contains one runtime module: `RunContextTransfer`.

## Responsibilities
`RunContextTransfer` provides persistent cross-intent context handoff for a run session:

- Save a serialized context snapshot per `sessionId + intent`.
- Load a context snapshot for an exact prior intent.
- Resolve a prior context for a new intent through deterministic intent chains.
- List and clear stored contexts for a session.
- Enforce staleness filtering (`maxAgeMs`) when loading.

This module is storage-focused. It does not extract or inject conversational context itself; it persists and retrieves snapshots that other layers can consume.

## Structure
Current file layout in this scope:

- `run-context-transfer.ts`
- `ARCHITECTURE.md`

Key symbols in `run-context-transfer.ts`:

- `PersistedIntentContext` (persisted payload contract)
- `RunContextTransferConfig` (store + optional namespace/TTL)
- `INTENT_CONTEXT_CHAINS` (static fallback order across intents)
- `RunContextTransfer` (runtime API)

Internal constants:

- `DEFAULT_NAMESPACE_PREFIX = ['_run_context']`
- `DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000`
- `SEARCH_PAGE_SIZE = 100`
- `MAX_SEARCH_PAGES = 1000`

## Runtime and Control Flow
1. Construction:
- `new RunContextTransfer({ store, namespacePrefix?, maxAgeMs? })` stores config and applies defaults.

2. Save path:
- `save(sessionId, context)` writes to namespace `[...namespacePrefix, sessionId]`.
- Key format: `intent:${context.fromIntent}`.
- `transferredAt` is normalized to `Date.now()` when missing/falsy.
- Re-saving the same `sessionId + fromIntent` overwrites previous value.

3. Direct load path:
- `load(sessionId, fromIntent)` paginates over `store.search(...)` until it finds key `intent:${fromIntent}`.
- Returns `null` when key is missing, missing `transferredAt`, or record age exceeds `maxAgeMs`.
- Returns `PersistedIntentContext` when found and fresh.

4. Intent-chain load path:
- `loadForIntent(sessionId, currentIntent)` reads `INTENT_CONTEXT_CHAINS[currentIntent]`.
- It calls `load(...)` in chain order and returns the first non-stale context.
- Unknown intents (or intents without configured chain) return `null`.

5. Session maintenance:
- `listContexts(sessionId)` returns valid-looking records (`fromIntent` and `transferredAt` present).
- `clear(sessionId)` deletes all keys found in the session namespace.

6. Search guardrails:
- `findContextItem(...)` and `searchAllContextItems(...)` cap traversal at 1000 pages.
- If exceeded, methods throw explicit errors instead of looping indefinitely.

## Key APIs and Types
Primary interface:

- `PersistedIntentContext`
  - `fromIntent: string`
  - `summary: string`
  - `decisions: string[]`
  - `relevantFiles: string[]`
  - `workingState: Record<string, unknown>`
  - `transferredAt: number`
  - `tokenEstimate: number`

Configuration:

- `RunContextTransferConfig`
  - `store: BaseStore` (required)
  - `namespacePrefix?: string[]`
  - `maxAgeMs?: number`

Routing constant:

- `INTENT_CONTEXT_CHAINS`
  - `edit_feature -> ['generate_feature', 'create_feature']`
  - `configure -> ['generate_feature', 'create_feature', 'edit_feature']`
  - `create_template -> ['generate_feature']`
  - `generate_feature -> ['configure']`

Class methods:

- `save(sessionId, context): Promise<void>`
- `load(sessionId, fromIntent): Promise<PersistedIntentContext | null>`
- `loadForIntent(sessionId, currentIntent): Promise<PersistedIntentContext | null>`
- `listContexts(sessionId): Promise<PersistedIntentContext[]>`
- `clear(sessionId): Promise<void>`

## Dependencies
Direct runtime dependency in this module:

- `BaseStore` from `@langchain/langgraph` (type import)

Package-level dependency context (`packages/core/package.json`):

- `@langchain/langgraph` is a peer dependency for consumers.
- `@langchain/langgraph` is also present as a dev dependency for local tests/build.

No other imports are used by `run-context-transfer.ts`.

## Integration Points
In-package integration:

- Re-exported from `src/index.ts`:
  - values: `RunContextTransfer`, `INTENT_CONTEXT_CHAINS`
  - types: `RunContextTransferConfig`, `PersistedIntentContext`

Cross-package usage currently visible in the repository:

- `packages/server/src/runtime/run-worker.ts` accepts optional `contextTransfer?: RunContextTransfer` and calls `loadForIntent(...)` before execution.
- The same worker performs best-effort persistence after execution and records context-transfer log entries.
- `packages/server/src/__tests__/e2e-run-pipeline.test.ts` includes end-to-end scenarios proving save-on-run-1 and load-on-run-2 behavior.

Related but separate context layer:

- `@dzupagent/context` is responsible for extracting/injecting context content; this module only persists and resolves snapshots.

## Testing and Observability
Module tests (`src/__tests__/run-context-transfer.test.ts`) cover:

- Save/load roundtrip.
- Missing-context and stale-context behavior.
- `loadForIntent` chain success/failure and unknown intents.
- Multi-record pagination (>100 records) for load/list/clear.
- Session namespace isolation.
- Baseline assertions on `INTENT_CONTEXT_CHAINS` entries.

Integration tests (`packages/server/src/__tests__/e2e-run-pipeline.test.ts`) validate worker-level context transfer behavior across sequential runs.

Observability in this module itself:

- No internal metrics/events are emitted from `RunContextTransfer`.
- On operational failures, it throws explicit bounded-search errors; callers decide how to handle/report them.

## Risks and TODOs
- Intent routing is hardcoded in `INTENT_CONTEXT_CHAINS`; changing flow semantics requires code changes.
- `load()` and session scans rely on paged `search` instead of direct key-get; this may be inefficient on some `BaseStore` implementations.
- Stale records are filtered at read time but not auto-pruned.
- Saved records are cast from store values (`unknown as PersistedIntentContext`) with minimal runtime shape validation.
- Context retention is one record per `session + intent`; there is no built-in version history.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: rewritten from current `packages/core` implementation and tests.

