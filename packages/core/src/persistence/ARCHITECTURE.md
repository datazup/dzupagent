# Persistence Architecture (`packages/core/src/persistence`)

## Scope

This document covers persistence-related code in `packages/core/src/persistence` and the package-level export wiring that exposes this surface (`src/persistence.ts`, `src/index.ts`, and `src/facades/orchestration.ts`).

In scope:
- Canonical run persistence contracts and in-memory implementations (`RunStore`, `InMemoryRunStore`, `AgentExecutionSpecStore`, `InMemoryAgentStore`).
- Event history capture (`EventLogStore`, `InMemoryEventLog`, `EventLogSink`).
- Run journal contracts and in-memory implementation (`RunJournal*`, `InMemoryRunJournal`) plus dual-write bridge (`RunJournalBridgeRunStore`).
- Run snapshot stores (`DzupRunStateStore`, `InMemoryRunStateStore`, `DeltaRunStateStore`).
- Stage-aware context artifact backend (`VersionedContextBackend`, `InMemoryVersionedContextBackend`).
- Session-scoped typed memory (`WorkingMemory` and related types).
- LangGraph session/checkpoint helpers (`SessionManager`, `createCheckpointer`).
- Legacy run-record compatibility interfaces (`RunRecordStore`, `InMemoryRunRecordStore`).

Out of scope:
- Durable database-backed implementations (implemented in other packages, not here).
- Agent orchestration logic and runtime execution loops outside persistence contracts.

## Responsibilities

The persistence layer in `@dzupagent/core` is responsible for:

1. Defining canonical contracts for runs, run logs, event timelines, snapshots, and agent execution specs.
2. Providing default in-memory implementations for local development, tests, and single-process flows.
3. Capturing append-only execution history through both event logs and journal entries.
4. Supporting resumability through full and delta-based run-state snapshot stores.
5. Exposing process-local working memory with TTL, LRU eviction, snapshot, and restore behavior.
6. Providing deterministic session/thread ID derivation and LangGraph checkpointer creation.
7. Maintaining backward compatibility for the legacy run-record API while keeping `RunStore` as the canonical run interface.

## Structure

| Path | Purpose |
| --- | --- |
| `store-interfaces.ts` | Canonical run and agent-execution store contracts (`RunStore`, `Run`, `RunFilter`, `RunStatus`, `AgentExecutionSpecStore`). |
| `in-memory-store.ts` | In-memory `RunStore` and `AgentExecutionSpecStore` implementations with retention controls. |
| `event-log.ts` | Event timeline model and store (`RunEvent`, `EventLogStore`, `InMemoryEventLog`) plus `EventLogSink` bridge. |
| `run-journal-types.ts` | Journal entry union, query/page types, journal config, and `RunJournal` contract. |
| `run-journal.ts` | Journal helper utilities (`createEntryBase`, `isTerminalEntry`, `deserializeEntry`) and type re-exports. |
| `in-memory-run-journal.ts` | In-memory append-only journal with per-run sequence counters and compaction. |
| `run-journal-bridge.ts` | `RunStore` wrapper that optionally dual-writes selected lifecycle changes into a `RunJournal`. |
| `run-state-store.ts` | `DzupRunState` snapshot contract and supporting snapshot sub-types. |
| `in-memory-run-state-store.ts` | Clone-on-save/load full snapshot store. |
| `delta-run-state-store.ts` | Delta-encoded snapshot store with periodic full checkpoints and replay. |
| `versioned-context-backend.ts` | Stage-aware artifact backend (`dev`/`staging`/`prod`) with promotion and tenant scoping. |
| `working-memory-types.ts` | `WorkingMemoryConfig` and `WorkingMemorySnapshot` definitions. |
| `working-memory.ts` | `WorkingMemory<T>` implementation (`set/get/delete/restore/snapshot/keys/size`) and factory. |
| `checkpointer.ts` | `createCheckpointer` factory for LangGraph memory/postgres checkpoint savers. |
| `session.ts` | `SessionManager` thread ID derivation and `RunnableConfig` builder. |
| `run-store.ts` | Legacy run-record interfaces (`RunRecordStore`, `RunRecord`, `StoredRunEvent`, filters). |
| `in-memory-run-store.ts` | In-memory implementation of legacy `RunRecordStore`. |
| `index.ts` | Local barrel exporting checkpointer/session/working memory/journal APIs only. |
| `__tests__/` | Persistence-specific tests for journal, bridge, delta snapshots, and versioned context backend. |

## Runtime and Control Flow

1. Canonical run writes and reads:
- `InMemoryRunStore.create()` generates run IDs (`crypto.randomUUID()`), sets initial status to `queued`, initializes logs, then enforces run retention.
- `update()`, `get()`, `list()`, and `count()` apply agent/status/tenant/owner filters; list results are sorted by `startedAt` desc and paginated via `offset` + `limit`.
- `addLog()` and `addLogs()` append timestamped entries and enforce per-run log retention.

2. Event timeline capture:
- `InMemoryEventLog.append()` assigns per-run monotonic `seq`, stamps `timestamp = Date.now()`, appends to run-local arrays, and enforces retention limits.
- Consumers use `getEvents()`, `getEventsSince()`, and `getLatest()` for replay and incremental views.
- `EventLogSink.attach()` subscribes to an event bus `onAny(...)` handler and forwards each event as fire-and-forget appends.

3. Journaled lifecycle dual-write:
- `RunJournalBridgeRunStore` wraps any `RunStore`.
- If enabled, `create()` writes `run_started` after primary store creation.
- On `update()` with status changes, mapped entries are appended:
`completed -> run_completed`, `failed -> run_failed`, `cancelled -> run_cancelled`, `paused -> run_paused`, `suspended -> run_suspended`, `running -> run_resumed`.
- Journal errors are swallowed; primary run-store writes remain authoritative.
- Log writes (`addLog`, `addLogs`) are deliberately not mirrored into the journal.

4. In-memory journal internals:
- `InMemoryRunJournal.append()` assigns sequence numbers synchronously before async boundaries.
- Optional `stateSchema.parse(...)` validates `state_updated` payloads; failures warn but do not reject writes.
- Auto-compaction runs when non-snapshot entries reach `compactionThreshold` (default `500`): a `snapshot` entry is created and older entries are compacted while retaining recent entries.
- `query()` supports cursor pagination (`afterSeq`), type filtering, optional compacted-entry inclusion, and page limits.

5. Run-state snapshots:
- `InMemoryRunStateStore` keeps one cloned snapshot per `runId` and returns cloned state on load.
- `DeltaRunStateStore.save()` appends message/usage deltas plus scalar changes and persists full snapshots every `fullSnapshotInterval` saves (default `10`).
- `DeltaRunStateStore.replay()` reconstructs current state from nearest full snapshot plus subsequent deltas.

6. Versioned context artifacts:
- `InMemoryVersionedContextBackend.put()` upserts stage-specific artifacts while preserving `createdAt` and updating `updatedAt`.
- `list()` enforces tenant matching and optional `kind`, `stage`, and ID-substring filters.
- `promote()` follows `dev -> staging -> prod`, with optional benchmark gating (`requireBenchmark`).

7. Session and checkpointer wiring:
- `SessionManager.getThreadId(scope)` sorts scope keys, builds a deterministic string, hashes with SHA-256, and truncates to 32 hex characters.
- `SessionManager.getConfig(threadId, callbacks?)` returns LangGraph `RunnableConfig` using `configurable.thread_id`.
- `createCheckpointer()` returns:
`MemorySaver` for `type: 'memory'`, or `PostgresSaver` (with mandatory `connectionString` and `setup()`) for `type: 'postgres'`.

## Key APIs and Types

Canonical run/agent APIs:
- `RunStatus`:
`pending | queued | running | executing | awaiting_approval | approved | paused | suspended | completed | halted | failed | rejected | cancelled`
- `RunStore`:
`create`, `update`, `get`, `list`, optional `count`, `addLog`, `addLogs`, `getLogs`
- `RunFilter`:
`agentId`, `status`, `limit`, `offset`, `tenantId`, `ownerId`, `includeLegacyOwnerless`
- `AgentExecutionSpecStore`:
`save`, `get`, `list`, `delete`

Event log APIs:
- `EventLogStore`:
`append`, `getEvents`, `getEventsSince`, `getLatest`
- `RunEvent`:
`{ runId, seq, timestamp, type, payload }`

Run journal APIs:
- `RunJournalEntryType`:
`run_started | step_started | step_completed | step_failed | state_updated | run_completed | run_failed | run_paused | run_resumed | run_suspended | run_cancelled | snapshot | unknown`
- `RunJournal`:
`append`, `query`, `getAll`, `compact`, `needsCompaction`
- `RunJournalConfig`:
`compactionThreshold`, optional `stateSchema`
- Utilities:
`createEntryBase`, `isTerminalEntry`, `deserializeEntry`

Run-state snapshot APIs:
- `DzupRunState` fields:
`version`, `runId`, `agentId`, optional `tenantId`, `messages`, `iteration`, `cumulativeUsage`, optional `budget`, optional `stuckDetector`, optional `pendingApproval`, optional `terminalReason`, `snapshotAt`
- `DzupRunStateStore`:
`save`, `load`, `delete`, `listRunIds`
- `DeltaRunStateStoreOptions`:
`fullSnapshotInterval`

Versioned context APIs:
- `ContextStage`: `dev | staging | prod`
- `ContextKind`: `prompt | skill | memory | policy`
- `VersionedContextBackend`:
`put`, `get`, `list`, `promote`, `delete`

Working memory APIs:
- `WorkingMemory<T>`:
`set`, `get`, `has`, `delete`, `clear`, `snapshot`, `restore`, `keys`, `size`
- `createWorkingMemory<T>(config?)`
- `WorkingMemoryConfig`:
`maxKeys`, `defaultTtlMs`, `onChange`

Legacy compatibility APIs:
- `RunRecordStore` and `InMemoryRunRecordStore` remain exported for low-level run record usage and are documented as deprecated in favor of `RunStore`.

Export surface notes:
- Root entry (`src/index.ts`) exports the full persistence surface, including `DeltaRunStateStore` and `InMemoryVersionedContextBackend`.
- Public subpath entry (`src/persistence.ts`, consumed as `@dzupagent/core/persistence`) exports canonical run/event/journal APIs and `InMemoryRunStateStore`, plus legacy run-record APIs, but does not export `DeltaRunStateStore` or `InMemoryVersionedContextBackend`.
- Local barrel (`src/persistence/index.ts`) is narrower than both and mostly intended for internal modularization.

## Dependencies

Direct external imports used by this module:
- `@langchain/langgraph` (`MemorySaver`, `BaseCheckpointSaver`).
- `@langchain/langgraph-checkpoint-postgres` (`PostgresSaver`).
- `@langchain/core/runnables` (`RunnableConfig`).
- `@langchain/core/callbacks/manager` (`Callbacks`).
- `@langchain/core/messages` (`BaseMessage`) for run-state message snapshots.
- Node built-in `node:crypto` (`createHash`) for deterministic thread ID generation.

Internal dependencies:
- `../utils/logger.js` is used for unbounded retention warnings in in-memory stores.

Package metadata:
- `package.json` exports `./persistence` -> `dist/persistence.js`.
- `@langchain/langgraph-checkpoint-postgres` is currently declared in `devDependencies` while imported from runtime code in `checkpointer.ts`.

## Integration Points

Within `@dzupagent/core`:
- `src/index.ts` re-exports the complete persistence surface.
- `src/persistence.ts` defines the curated public subpath API.
- `src/facades/orchestration.ts` re-exports canonical run and event-log contracts/implementations for orchestration consumers.
- `EventLogSink` depends only on an `onAny` event-bus shape, keeping coupling minimal.

Across package boundaries:
- Store interfaces are designed for adapter-style replacement by durable implementations in other packages.
- The run journal bridge enables incremental adoption of journal-backed auditing without forcing callers to switch away from the `RunStore` read path.

## Testing and Observability

Persistence-focused tests currently present:
- `src/__tests__/in-memory-store.test.ts`
- `src/__tests__/event-log.test.ts`
- `src/__tests__/run-state-store.test.ts`
- `src/__tests__/working-memory.test.ts`
- `src/__tests__/run-store.test.ts`
- `src/persistence/__tests__/run-journal.test.ts`
- `src/persistence/__tests__/run-journal-bridge.test.ts`
- `src/persistence/__tests__/delta-run-state-store.test.ts`
- `src/persistence/__tests__/versioned-context-backend.test.ts`

Observed diagnostics and introspection hooks:
- `InMemoryRunStore` and `InMemoryEventLog` expose retention limits via `getRetentionLimits()` and attach non-enumerable `__dzupagentRetention` metadata.
- Explicit `Infinity` limits emit warnings through the framework logger.
- `InMemoryEventLog.totalEvents` provides cross-run event count.
- `InMemoryRunStateStore` exposes `size` and `clear()` helpers.
- `InMemoryRunJournal` exposes `_entryCount()` and `_clear()` helpers.
- `DeltaRunStateStore` exposes `deltaCount()` and `snapshotCount()` helpers.
- Event sink append behavior is intentionally fire-and-forget and does not surface append failures to emitters.

Current direct test gaps:
- No dedicated unit tests for `checkpointer.ts`.
- No dedicated unit tests for `session.ts`.
- No explicit export-parity test that enforces expected differences between `src/index.ts`, `src/persistence.ts`, and `src/persistence/index.ts`.

## Risks and TODOs

- Runtime dependency classification:
`checkpointer.ts` imports `@langchain/langgraph-checkpoint-postgres`, but the package is declared under `devDependencies`.

- Export drift:
Three different persistence entry surfaces exist (root, curated subpath, local barrel), which can drift without explicit parity/contract tests.

- Session scope encoding:
`SessionManager.getThreadId()` hashes raw `k:v|...` concatenation; delimiter collisions are unlikely after hashing but the pre-hash key format is not escaped.

- Journal coverage tradeoff:
`RunJournalBridgeRunStore` only journals selected lifecycle transitions; fine-grained logs remain only in `RunStore` log storage.

- In-memory retention limits are finite by default but still process-local:
long-running/high-throughput usage can grow memory pressure, especially when explicit unbounded limits are configured.

- Delta replay assumptions:
`DeltaRunStateStore` assumes append-only growth for `messages` and `cumulativeUsage`; non-append edits are not represented as granular reverse deltas.

- Legacy surface maintenance:
`RunRecordStore` remains available for compatibility, increasing persistence API surface area and potential confusion vs `RunStore`.

## Changelog

- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

