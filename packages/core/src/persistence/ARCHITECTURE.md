# Persistence Architecture (`packages/core/src/persistence`)

## Scope and Purpose

This module provides persistence primitives used by DzupAgent runtime orchestration:

- Run lifecycle storage (`RunStore` + implementations)
- Agent definition storage (`AgentStore` + implementations)
- Event-sourced run timeline (`EventLogStore` + `EventLogSink`)
- LangGraph checkpoint factory (`createCheckpointer`)
- Deterministic session/thread identity helper (`SessionManager`)

Core exports interfaces and in-memory implementations for development/testing, while `@dzupagent/server` provides production PostgreSQL implementations for the primary interfaces.

## Module Inventory

| File | Responsibility | Notes |
| --- | --- | --- |
| `store-interfaces.ts` | Main runtime persistence contracts (`RunStore`, `AgentStore`) | Primary contract used by `@dzupagent/server` and `@dzupagent/agent` |
| `in-memory-store.ts` | In-memory impl for `RunStore` + `AgentStore` | Retention limits + warnings for unbounded opt-out |
| `event-log.ts` | Event-sourced run events (`EventLogStore`), in-memory impl, event-bus sink | Retention limits for runs/events |
| `checkpointer.ts` | LangGraph checkpointer factory (`postgres` or `memory`) | Calls `setup()` for Postgres checkpointer |
| `session.ts` | Deterministic thread-id + `RunnableConfig` builder | Stable hash from sorted scope keys |
| `run-store.ts` | Alternate run-record persistence interface (`RunRecord`/`StoredRunEvent`) | Separate from main runtime `RunStore`; currently not consumed outside core tests/exports |
| `in-memory-run-store.ts` | In-memory impl of alternate run-record interface | Same class name (`InMemoryRunStore`) as main store implementation |
| `index.ts` | Local re-export surface | Re-exports only `createCheckpointer` + `SessionManager` |

## Public API Surface (Root `@dzupagent/core`)

From `packages/core/src/index.ts`:

- Main persistence API:
  - `createCheckpointer`, `SessionManager`
  - `InMemoryRunStore`, `InMemoryAgentStore`
  - `RunStore`, `Run`, `CreateRunInput`, `RunFilter`, `RunStatus`, `LogEntry`
  - `AgentStore`, `AgentDefinition`, `AgentFilter`
  - `InMemoryEventLog`, `EventLogSink`, `RunEvent`, `EventLogStore`
- Alternate run-record API:
  - `InMemoryRunRecordStore`
  - `RunRecordStore`, `RunRecord`, `StoredRunEvent`, `RunFilters`, `RunRecordStatus`

## Feature Breakdown

### 1) Main Run Persistence (`store-interfaces.ts` + `in-memory-store.ts`)

#### Capabilities

- Create, update, fetch, list run records with metadata.
- Attach structured logs per run (`addLog`, `addLogs`, `getLogs`).
- Filter list by `agentId`, `status`, with pagination (`limit`, `offset`).
- Default retention in in-memory mode:
  - max runs: `10_000`
  - max logs/run: `1_000`
- Explicit `Infinity` opt-out allowed with warning emission and metadata marker (`__dzupagentRetention.explicitUnbounded`).

#### Run status model

`queued | running | awaiting_approval | approved | completed | failed | rejected | cancelled`

This status set is the canonical runtime status model used by server routes/workers and agent delegation.

### 2) Agent Persistence (`store-interfaces.ts` + `in-memory-store.ts`)

#### Capabilities

- Save and retrieve agent definitions (instructions, model tier, guardrails, approval mode, metadata).
- List by `active` filter.
- Delete semantics in in-memory store: hard delete from map.
- PostgreSQL implementation in server uses soft-delete (`active=false`).

### 3) Event-Sourced Run History (`event-log.ts`)

#### Capabilities

- Append run events with monotonic per-run sequence (`seq`) and timestamp.
- Retrieve full stream (`getEvents`), incremental stream (`getEventsSince`), and latest event (`getLatest`).
- `EventLogSink` auto-captures all event-bus events for a run.
- Retention controls:
  - max runs: `10_000`
  - max events/run: `5_000`
  - same explicit unbounded opt-out warning pattern as run store.

#### Notes

- `EventLogSink.attach()` is fire-and-forget; append failures are intentionally non-fatal to avoid impacting main execution path.

### 4) LangGraph Checkpointer Factory (`checkpointer.ts`)

#### Capabilities

- `type: 'memory'` -> returns `new MemorySaver()`.
- `type: 'postgres'` -> requires `connectionString`, creates `PostgresSaver`, and calls `setup()` before returning.

#### Operational intent

- Encapsulates initialization safety (`setup()`) at factory call-site.

### 5) Session/Thread Management (`session.ts`)

#### Capabilities

- Deterministic thread ID from scope object:
  - sort keys alphabetically
  - join as `k:v|k:v`
  - SHA-256 hash, first 32 hex chars
- Build `RunnableConfig` with `configurable.thread_id` and optional callbacks.

#### Operational intent

- Stable mapping of business scope (tenant/project/session) to LangGraph thread IDs.

### 6) Alternate Run-Record Store (`run-store.ts` + `in-memory-run-store.ts`)

#### Capabilities

- Separate interface with different schema and method set:
  - `createRun`, `updateRun`, `getRun`, `listRuns`
  - `storeEvent`, `getEvents`, `deleteRun`
- Supports provider/model/token/cost/duration/tags/correlation filters.

#### Current position

- Exported by core root as `RunRecordStore` and `InMemoryRunRecordStore`.
- Not referenced by non-test code outside core exports (as of 2026-04-03).

## End-to-End Runtime Flow (Primary Store)

### Flow A: API run request -> queued job -> completion

1. `POST /api/runs` validates agent and creates run via `runStore.create(...)`.
2. If queue enabled, route enqueues job and logs queue metadata (`runStore.addLog(...)`).
3. `startRunWorker(...)`:
   - marks run `running`
   - writes operational logs (`queue`, `approval`, `context-transfer`, `run`, `reflection`, etc.)
   - invokes executor
   - updates terminal state (`completed`/`failed`/`cancelled`/`rejected`) with output and metrics
4. Routes expose persisted state/logs:
   - `GET /api/runs/:id`
   - `GET /api/runs/:id/logs`
   - `GET /api/runs/:id/trace`
   - `GET /api/runs/:id/stream`

### Flow B: Approval-gated run

1. Worker sets status to `awaiting_approval` and emits `approval:requested`.
2. `/api/runs/:id/approve` or `/api/runs/:id/reject` updates run + adds log.
3. Worker resumes (`approved`) or finalizes as `rejected`.

### Flow C: Delegation (agent package)

1. `SimpleDelegationTracker.delegate(...)` creates child run via core `RunStore`.
2. Executor processes delegated task.
3. Tracker polls/fetches run state, then writes final status/output/token usage.
4. Delegation lifecycle events are emitted over event bus.

## Cross-Package References and Usage

### Production/store implementations in `@dzupagent/server`

- `packages/server/src/persistence/postgres-stores.ts`
  - `PostgresRunStore implements RunStore`
  - `PostgresAgentStore implements AgentStore`
  - Maps core contracts to Drizzle schema (`forge_runs`, `forge_run_logs`, `dzip_agents`).

### Runtime orchestration in `@dzupagent/server`

- `packages/server/src/app.ts`
  - `ForgeServerConfig` requires `runStore` + `agentStore`.
  - Starts worker with these stores.
  - Reads in-memory retention metadata to warn on explicit unbounded settings.
- `packages/server/src/runtime/run-worker.ts`
  - Heavy operational usage of `runStore.update/get/addLog/addLogs` and `agentStore.get/save`.
- `packages/server/src/runtime/default-run-executor.ts`
  - Logs LLM usage/invocation via `runStore.addLog`.
- `packages/server/src/routes/runs.ts`
  - Primary CRUD/list/log/stream API over `RunStore`.
- `packages/server/src/routes/approval.ts`
  - Approval transitions and audit logs via `RunStore`.
- `packages/server/src/routes/routing-stats.ts`
  - Analytics aggregation from `runStore.list(...)` metadata.
- `packages/server/src/lifecycle/graceful-shutdown.ts`
  - Best-effort cancellation updates through `runStore.update(...)`.
- `packages/server/src/cli/dev-command.ts`
  - Default dev bootstrap uses core in-memory stores.

### Orchestration usage in `@dzupagent/agent`

- `packages/agent/src/orchestration/delegation.ts`
  - Consumes `RunStore` to persist delegated run state machine.

### Test helper usage in `@dzupagent/test-utils`

- `packages/test-utils/src/test-helpers.ts`
  - Factory methods for `InMemoryRunStore` and `InMemoryAgentStore` used across package tests.

### Not currently adopted outside core exports/tests

- `SessionManager`
- `createCheckpointer`
- `RunRecordStore`/`InMemoryRunRecordStore` alternate API
- `EventLogSink`/`InMemoryEventLog` in non-test runtime code

## Usage Examples

### Example 1: Minimal in-memory run + agent setup

```ts
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  createEventBus,
  ModelRegistry,
} from '@dzupagent/core'
import { createForgeApp } from '@dzupagent/server'

const app = createForgeApp({
  runStore: new InMemoryRunStore({ maxRuns: 2000, maxLogsPerRun: 500 }),
  agentStore: new InMemoryAgentStore(),
  eventBus: createEventBus(),
  modelRegistry: new ModelRegistry(),
})
```

### Example 2: PostgreSQL-backed production stores

```ts
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createEventBus, ModelRegistry } from '@dzupagent/core'
import { createForgeApp, PostgresRunStore, PostgresAgentStore } from '@dzupagent/server'

const sqlClient = postgres(process.env.DATABASE_URL!)
const db = drizzle(sqlClient)

const app = createForgeApp({
  runStore: new PostgresRunStore(db),
  agentStore: new PostgresAgentStore(db),
  eventBus: createEventBus(),
  modelRegistry: new ModelRegistry(),
})
```

### Example 3: Event bus capture with `EventLogSink`

```ts
import { createEventBus, InMemoryEventLog, EventLogSink } from '@dzupagent/core'

const bus = createEventBus()
const eventLog = new InMemoryEventLog({ maxRuns: 500, maxEventsPerRun: 2000 })
const sink = new EventLogSink(eventLog)

const unsubscribe = sink.attach(bus, 'run-42')
bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'run-42' })

const events = await eventLog.getEvents('run-42')
unsubscribe()
```

### Example 4: LangGraph checkpointer selection

```ts
import { createCheckpointer } from '@dzupagent/core'

const saver = await createCheckpointer(
  process.env.DATABASE_URL
    ? { type: 'postgres', connectionString: process.env.DATABASE_URL }
    : { type: 'memory' },
)
```

### Example 5: Stable thread IDs for graph runs

```ts
import { SessionManager } from '@dzupagent/core'

const sessions = new SessionManager()
const threadId = sessions.getThreadId({ tenantId: 't1', projectId: 'p9', sessionId: 's7' })
const config = sessions.getConfig(threadId)
```

## Test Coverage

Coverage was measured on 2026-04-03 using:

```bash
yarn workspace @dzupagent/core test:coverage -- --coverage.reporter=text --coverage.include='src/persistence/**'
```

### Persistence coverage results

| File | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| `checkpointer.ts` | 53.33% | 100% | 0% | 53.33% |
| `event-log.ts` | 99.03% | 95.55% | 100% | 99.03% |
| `in-memory-run-store.ts` | 93.42% | 87.80% | 80% | 93.42% |
| `in-memory-store.ts` | 95.14% | 93.22% | 90.47% | 95.14% |
| `session.ts` | 67.56% | 100% | 0% | 67.56% |
| **All persistence files** | **92.26%** | **92.41%** | **85.71%** | **92.26%** |

### Direct persistence-focused test suites

- `packages/core/src/__tests__/in-memory-store.test.ts`
- `packages/core/src/__tests__/event-log.test.ts`
- `packages/core/src/__tests__/run-store.test.ts`
- `packages/core/src/__tests__/core.integration.test.ts` (event bus + event log + run store integration)

### Cross-package tests relying on these stores

- Multiple `@dzupagent/server` tests instantiate `InMemoryRunStore` / `InMemoryAgentStore` (routes, worker, e2e flows).
- `@dzupagent/agent` delegation/supervisor tests use `InMemoryRunStore` for orchestration persistence behavior.

### Notable coverage gaps

- `checkpointer.ts`: no explicit unit tests for:
  - `postgres` branch setup behavior
  - missing `connectionString` error path
- `session.ts`: no explicit unit tests for:
  - deterministic hashing behavior across key order
  - callback-inclusive `RunnableConfig` generation

## Architectural Observations

1. There are two different persistence abstractions named around `RunStore`:
   - Primary runtime store (`store-interfaces.ts`)
   - Alternate run-record store (`run-store.ts`)
   This is functional but increases naming ambiguity and onboarding cost.

2. Two classes named `InMemoryRunStore` exist in separate files:
   - `in-memory-store.ts` (primary)
   - `in-memory-run-store.ts` (alternate)
   Root exports alias the alternate one to reduce public ambiguity, but internal discovery is still easy to confuse.

3. Retention metadata (`__dzupagentRetention`) is intentionally non-enumerable and consumed by server startup checks to surface risky unbounded memory configs.

## Suggested Next Improvements

1. Add unit tests for `checkpointer.ts` and `session.ts` to close uncovered branches/functions.
2. Consider renaming the alternate run-record interface/types to reduce collision with primary runtime `RunStore`.
3. Decide whether `EventLogSink` should be wired in server runtime by default (today it is mostly test/facade-exposed).
