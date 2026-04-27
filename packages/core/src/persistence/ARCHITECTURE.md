# Persistence Architecture (`packages/core/src/persistence`)

## Scope

This document covers the persistence-related code under `packages/core/src/persistence`:

- Canonical run and agent execution spec contracts (`RunStore`, `AgentExecutionSpecStore`) and in-memory implementations.
- Event log storage plus event-bus sink (`EventLogStore`, `InMemoryEventLog`, `EventLogSink`).
- Append-only run journal primitives (`RunJournal*`, `InMemoryRunJournal`) and bridge adapter (`RunJournalBridgeRunStore`).
- Session-scoped in-process working memory (`WorkingMemory`).
- LangGraph checkpoint and thread config helpers (`createCheckpointer`, `SessionManager`).
- Legacy low-level run-record API (`RunRecordStore`, `InMemoryRunRecordStore`) kept for compatibility.

It does not include server-side durable implementations; those are implemented outside this package.

## Responsibilities

The persistence module provides three different persistence layers used by core orchestration:

1. Runtime run/agent persistence contracts:
- `RunStore` tracks run lifecycle state, metadata, and structured logs.
- `AgentExecutionSpecStore` tracks runnable agent specs.

2. Execution history persistence:
- `EventLogStore` captures high-volume timeline events for replay/debug.
- `RunJournal` captures append-only lifecycle/state entries with compaction support.

3. Local process/session state:
- `WorkingMemory<T>` stores typed per-session key/value state with TTL and LRU options.
- `SessionManager` provides deterministic LangGraph `thread_id` derivation.
- `createCheckpointer` creates LangGraph checkpoint savers.

## Structure

| File | Purpose |
| --- | --- |
| `store-interfaces.ts` | Canonical `RunStore`, `Run`, `RunStatus`, `AgentExecutionSpecStore` contracts. |
| `in-memory-store.ts` | `InMemoryRunStore` and `InMemoryAgentStore` reference implementations with retention limits. |
| `event-log.ts` | `RunEvent` model, `EventLogStore` interface, `InMemoryEventLog`, and `EventLogSink`. |
| `run-journal-types.ts` | Run-journal entry/query/config types and `RunJournal` interface. |
| `run-journal.ts` | Type re-exports and helpers (`createEntryBase`, `isTerminalEntry`, `deserializeEntry`). |
| `in-memory-run-journal.ts` | In-memory `RunJournal` implementation with auto-compaction and optional state-schema validation. |
| `run-journal-bridge.ts` | `RunStore` wrapper that dual-writes lifecycle transitions to `RunJournal` when enabled. |
| `working-memory-types.ts` | `WorkingMemoryConfig` and `WorkingMemorySnapshot<T>`. |
| `working-memory.ts` | `WorkingMemory<T>` implementation and `createWorkingMemory` factory. |
| `checkpointer.ts` | `createCheckpointer` factory for `MemorySaver` or `PostgresSaver`. |
| `session.ts` | `SessionManager` for deterministic thread IDs and `RunnableConfig` construction. |
| `run-store.ts` | Legacy `RunRecordStore` interface for provider/model/token-centric execution records. |
| `in-memory-run-store.ts` | `InMemoryRunRecordStore` legacy in-memory implementation. |
| `index.ts` | Persistence-only barrel exports (checkpointer/session/working-memory/run-journal surface). |

Root package exports in `src/index.ts` also expose persistence symbols, including both canonical and legacy store APIs.

## Runtime and Control Flow

Primary run persistence flow:

1. Caller creates a run through `RunStore.create(input)`.
2. `InMemoryRunStore.create` assigns `id` (`crypto.randomUUID()`), sets initial status to `queued`, stamps `startedAt`, and initializes log storage.
3. Callers mutate state with `RunStore.update(id, patch)` and write diagnostics via `addLog`/`addLogs`.
4. Read paths use `get`, `list`, and optional `count`.

Event log flow:

1. Runtime emits domain events on an event bus.
2. `EventLogSink.attach(eventBus, runId)` subscribes via `onAny`.
3. Each event is appended to `EventLogStore` as `{ runId, type, payload }`, with per-run monotonic `seq` and wall clock `timestamp`.
4. Consumers query with `getEvents`, `getEventsSince`, or `getLatest`.

Run journal flow:

1. `RunJournalBridgeRunStore` wraps any `RunStore`.
2. When bridge is enabled, `create()` writes `run_started` after store create succeeds.
3. On `update()`, lifecycle statuses are mapped to journal entries (`run_completed`, `run_failed`, `run_cancelled`, `run_paused`, `run_suspended`, `run_resumed`).
4. Journal writes are best-effort and non-fatal; wrapped `RunStore` remains source of truth for reads.
5. `InMemoryRunJournal` appends entries with per-run sequence assignment and triggers compaction when non-snapshot entries reach threshold (default `500`).

Working memory flow:

1. `WorkingMemory.set` stores values with optional per-key TTL and optional global TTL default.
2. Reads (`get`, `has`, `keys`, `size`) prune expired entries.
3. Optional LRU eviction runs when `maxKeys` is exceeded.
4. `snapshot()` returns deep-cloned immutable data; `restore()` replaces full state and emits `onChange` callbacks for changed keys.

Checkpoint/session helpers:

1. `createCheckpointer({ type: 'memory' })` returns `MemorySaver`.
2. `createCheckpointer({ type: 'postgres', connectionString })` creates `PostgresSaver`, runs `setup()`, and returns it.
3. `SessionManager.getThreadId(scope)` sorts scope keys, hashes `k:v|...` with SHA-256, and truncates to 32 hex chars.
4. `SessionManager.getConfig(threadId, callbacks?)` returns LangGraph `RunnableConfig` with `configurable.thread_id`.

## Key APIs and Types

Canonical run store (`store-interfaces.ts`):

- `RunStatus`:
`pending | queued | running | executing | awaiting_approval | approved | paused | suspended | completed | halted | failed | rejected | cancelled`
- `RunStore`:
`create`, `update`, `get`, `list`, optional `count`, `addLog`, `addLogs`, `getLogs`
- `Run` includes run data plus optional tenant-scoping fields (`ownerId`, `tenantId`).
- `AgentExecutionSpecStore`:
`save`, `get`, `list`, `delete`

Event log (`event-log.ts`):

- `RunEvent`: `{ runId, seq, timestamp, type, payload }`
- `EventLogStore`: `append`, `getEvents`, `getEventsSince`, `getLatest`
- `InMemoryEventLog` default retention: `maxRuns=10_000`, `maxEventsPerRun=5_000`
- `EventLogSink.attach(...)` returns an unsubscribe function.

Run journal (`run-journal-types.ts`, `in-memory-run-journal.ts`, `run-journal-bridge.ts`):

- `RunJournalEntryType` includes lifecycle, step, state update, snapshot, and unknown forward-compat entry types.
- `RunJournal.append/query/getAll/compact/needsCompaction`.
- `InMemoryRunJournal` supports optional `stateSchema.parse(...)` validation for `state_updated` entries; validation warnings are non-fatal.
- `RunJournalBridgeRunStore` dual-writes lifecycle transitions when enabled and exposes `count()` fallback behavior if wrapped store lacks `count`.

Working memory (`working-memory.ts`):

- `WorkingMemory<T>`:
`set`, `get`, `has`, `delete`, `clear`, `snapshot`, `restore`, `keys`, `size`
- `WorkingMemoryConfig`: `maxKeys`, `defaultTtlMs`, `onChange`
- `createWorkingMemory<T>(config?)` convenience constructor.

Legacy API (`run-store.ts`, `in-memory-run-store.ts`):

- `RunRecordStore` and `InMemoryRunRecordStore` are explicitly marked deprecated in favor of canonical `RunStore`.

## Dependencies

External dependencies directly imported by persistence code:

- `@langchain/langgraph` (`MemorySaver`, `BaseCheckpointSaver` type).
- `@langchain/langgraph-checkpoint-postgres` (`PostgresSaver`).
- `@langchain/core/runnables` and `@langchain/core/callbacks/manager` (`RunnableConfig`, `Callbacks`).

Node and internal dependencies:

- `node:crypto` (`createHash`) for deterministic thread IDs.
- `../utils/logger.js` for retention warning logs in in-memory stores/event log.

Package-level dependency notes from `packages/core/package.json`:

- Runtime deps: `@dzupagent/agent-types`, `@dzupagent/runtime-contracts`.
- Peer deps include `@langchain/core`, `@langchain/langgraph`, `zod` (LanceDB/Arrow optional).
- `@langchain/langgraph-checkpoint-postgres` is currently in `devDependencies`, but imported by runtime code in `checkpointer.ts`.

## Integration Points

Inside `@dzupagent/core`:

- `src/index.ts` exports persistence APIs to the main package surface.
- `src/facades/orchestration.ts` re-exports run/agent/event log contracts and in-memory implementations for orchestration-focused imports.
- `src/events/event-bus.ts` integrates with `EventLogSink` through the minimal `onAny` contract.

Cross-package contract points:

- `store-interfaces.ts` comments explicitly identify canonical implementations as `InMemoryRunStore` (core) and `PostgresRunStore` (server package).
- `run-journal-types.ts` declares `InMemoryRunJournal` (core) and `PostgresRunJournal` (server package) as intended implementations.

## Testing and Observability

Persistence-specific test coverage exists in:

- `src/__tests__/in-memory-store.test.ts`
- `src/__tests__/event-log.test.ts`
- `src/__tests__/run-store.test.ts` (legacy API)
- `src/persistence/__tests__/run-journal.test.ts`
- `src/persistence/__tests__/run-journal-bridge.test.ts`
- `src/__tests__/core.integration.test.ts` (event bus + sink + run store flow)
- `src/__tests__/working-memory.test.ts`
- `src/__tests__/w15-h2-branch-coverage.test.ts` (extra branch coverage for bridge/legacy run store paths)

Observability and diagnostics built into persistence code:

- In-memory run store and event log expose non-enumerable `__dzupagentRetention` metadata with configured limits and `explicitUnbounded` marker.
- Explicit unbounded retention (`Infinity`) emits warnings via framework logger.
- `EventLogSink` is fire-and-forget and intentionally swallows append failures to avoid affecting run execution.
- `InMemoryRunJournal` emits schema validation warnings (`console.warn`) instead of rejecting `state_updated` appends.

Notably absent in current core tests:

- No direct unit tests for `checkpointer.ts`.
- No direct unit tests for `session.ts`.

## Risks and TODOs

- `checkpointer.ts` imports `@langchain/langgraph-checkpoint-postgres` but package metadata currently lists it under `devDependencies`; this can break downstream runtime installs where dev dependencies are omitted.
- `SessionManager.getThreadId` can collide if scope values include reserved separators (`:` or `|`) because inputs are concatenated without escaping before hashing.
- `RunJournalBridgeRunStore` only journals status-driven lifecycle transitions and intentionally skips log entries; this limits fidelity if full trace reconstruction is expected from journal alone.
- Two run persistence abstractions remain (`RunStore` vs deprecated `RunRecordStore`), which increases onboarding and naming ambiguity.
- `InMemoryRunJournal` compaction currently scans entries and rewrites run arrays in memory; long-lived runs in single-process mode may still incur memory pressure before compaction points.

## Changelog

- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

