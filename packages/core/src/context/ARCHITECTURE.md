# Context Runtime Architecture (`packages/core/src/context`)

Last updated: 2026-04-03

## Scope

This document describes the context runtime persistence module in:

- `packages/core/src/context/run-context-transfer.ts`
- related exports in `packages/core/src/index.ts`
- direct runtime usage in `packages/server/src/runtime/run-worker.ts`
- related tests in `packages/core/src/__tests__/run-context-transfer.test.ts` and `packages/server/src/__tests__/e2e-run-pipeline.test.ts`

This module is intentionally small: it provides persistent storage and retrieval for cross-intent context snapshots between runs.

## What This Module Does

`RunContextTransfer` persists lightweight context snapshots keyed by `session + intent`, then resolves the best prior context for a new intent using a deterministic chain.

It bridges:

- `@dzupagent/context` extraction/injection logic (`ContextTransferService`)
- durable or semi-durable storage via LangGraph `BaseStore`
- run lifecycle integration in server worker execution

In short:

1. A completed run saves context (`save`).
2. A future run in the same session requests relevant prior context (`loadForIntent`).
3. Context is injected into run metadata (`priorContext`) by `run-worker`.

## Public Surface

## Types

- `PersistedIntentContext`
  - `fromIntent: string`
  - `summary: string`
  - `decisions: string[]`
  - `relevantFiles: string[]`
  - `workingState: Record<string, unknown>`
  - `transferredAt: number`
  - `tokenEstimate: number`

- `RunContextTransferConfig`
  - `store: BaseStore` (required)
  - `namespacePrefix?: string[]` (default `['_run_context']`)
  - `maxAgeMs?: number` (default `24h`)

## Constants

- `INTENT_CONTEXT_CHAINS: Record<string, string[]>`
  - `edit_feature <- [generate_feature, create_feature]`
  - `configure <- [generate_feature, create_feature, edit_feature]`
  - `create_template <- [generate_feature]`
  - `generate_feature <- [configure]`

## Class

- `RunContextTransfer`
  - `save(sessionId, context): Promise<void>`
  - `load(sessionId, fromIntent): Promise<PersistedIntentContext | null>`
  - `loadForIntent(sessionId, currentIntent): Promise<PersistedIntentContext | null>`
  - `listContexts(sessionId): Promise<PersistedIntentContext[]>`
  - `clear(sessionId): Promise<void>`

## Storage Model

Namespace and key scheme:

- Namespace: `[...namespacePrefix, sessionId]`
- Key: `intent:${fromIntent}`
- Value: serialized `PersistedIntentContext`

Implications:

- One context snapshot per `session + fromIntent`.
- Re-saving the same `fromIntent` overwrites previous value.
- Sessions are isolated by namespace.

## Runtime Flow

### 1) Save Path (end of run)

```text
run-worker completed
  -> build PersistedIntentContext
  -> RunContextTransfer.save(sessionId, context)
      -> namespace = [...prefix, sessionId]
      -> key = intent:${context.fromIntent}
      -> store.put(namespace, key, value)
```

Behavior:

- `transferredAt` is normalized to `Date.now()` if missing.
- Save is best-effort in run-worker; failures are logged and do not fail the run.

### 2) Load Path (start of run)

```text
run-worker before execution
  -> currentIntent resolved
  -> RunContextTransfer.loadForIntent(sessionId, currentIntent)
      -> chain = INTENT_CONTEXT_CHAINS[currentIntent]
      -> for priorIntent in chain:
           load(sessionId, priorIntent)
             -> search key in namespace (paged)
             -> reject if missing/stale/no transferredAt
             -> return first valid context
  -> if found: metadata.priorContext = context
```

Behavior:

- Returns first non-stale match in chain order.
- Unknown intents or intents without chain return `null`.
- Loading is best-effort in run-worker; failures are logged and run still continues.

### 3) Paging and Safety Guards

Both read helpers page through store search:

- page size: `100`
- maximum pages: `1000`

Guardrails:

- `findContextItem` throws if page limit exceeded while searching for a key.
- `searchAllContextItems` throws if page limit exceeded while listing/clearing.

This prevents unbounded loops against misbehaving stores.

## Integration in Other Packages

## Export Path

`@dzupagent/core` re-exports this module from:

- `packages/core/src/index.ts` (`RunContextTransfer`, `INTENT_CONTEXT_CHAINS`, and related types)

## Server Runtime Usage

Direct runtime consumption is in `packages/server/src/runtime/run-worker.ts`:

- Optional dependency: `contextTransfer?: RunContextTransfer`
- Pre-execution:
  - resolves `sessionId` from `job.metadata.sessionId` else falls back to `runId`
  - resolves intent from `job.metadata.intent`, then `agent.metadata.intent`
  - calls `loadForIntent`
  - injects `priorContext` into `metadata` when found
- Post-execution success:
  - derives summary from output
  - sources `decisions`, `relevantFiles`, `workingState` from executor metadata
  - sets `tokenEstimate = tokenUsage.input + tokenUsage.output`
  - calls `save`

## `@dzupagent/context` Relationship

`RunContextTransfer` handles persistence only.

`ContextTransferService` (`@dzupagent/context`) handles:

- extraction from message history
- relevance/scoping rules
- formatting injected `SystemMessage`
- message injection into new conversation

Common architecture pattern:

1. Use `ContextTransferService.extractContext(...)` at run end.
2. Persist selected fields via `RunContextTransfer.save(...)`.
3. On next run, `RunContextTransfer.loadForIntent(...)`.
4. Convert persisted payload back to `IntentContext` and call `injectContext(...)`.

## Usage Examples

### Example A: Minimal Persistence API

```ts
import { InMemoryStore } from '@langchain/langgraph'
import { RunContextTransfer } from '@dzupagent/core'

const store = new InMemoryStore()
const transfer = new RunContextTransfer({ store, maxAgeMs: 24 * 60 * 60 * 1000 })

await transfer.save('session-1', {
  fromIntent: 'generate_feature',
  summary: 'Implemented auth flow',
  decisions: ['Use JWT', 'Use PostgreSQL'],
  relevantFiles: ['src/auth/login.ts'],
  workingState: { milestone: 'auth-v1' },
  transferredAt: Date.now(),
  tokenEstimate: 420,
})

const prior = await transfer.loadForIntent('session-1', 'edit_feature')
// prior is either the first chain match or null
```

### Example B: Worker Integration (actual runtime pattern)

```ts
import { InMemoryStore } from '@langchain/langgraph'
import { RunContextTransfer } from '@dzupagent/core'
import { startRunWorker } from '@dzupagent/server'

const contextTransfer = new RunContextTransfer({ store: new InMemoryStore() })

startRunWorker({
  runQueue,
  runStore,
  agentStore,
  eventBus,
  modelRegistry,
  runExecutor,
  contextTransfer,
})
```

### Example C: Bridge Back to Message Injection

```ts
import { ContextTransferService, type IntentContext } from '@dzupagent/context'
import { RunContextTransfer } from '@dzupagent/core'

const transferService = new ContextTransferService()
const persisted = await runContextTransfer.loadForIntent(sessionId, 'edit_feature')

if (persisted) {
  const intentContext: IntentContext = {
    ...persisted,
    toIntent: 'edit_feature',
  }
  const enrichedMessages = transferService.injectContext(intentContext, targetMessages)
}
```

## Feature Analysis

## Strengths

- Small, focused API with clear responsibility boundaries.
- Store-agnostic via `BaseStore` interface.
- Deterministic chain ordering for context selection.
- Built-in staleness filtering (`maxAgeMs`) to avoid carrying old state indefinitely.
- Session-level isolation through namespaced keys.
- Read/list/clear pagination avoids partial visibility when many intent snapshots exist.

## Constraints and Tradeoffs

- Hardcoded `INTENT_CONTEXT_CHAINS` requires code change to alter routing.
- Stale records are ignored but not auto-pruned (storage can retain expired entries).
- `search`-based lookup can be more expensive than direct key retrieval depending on store backend.
- One snapshot per `intent` per session (no historical versions).
- Current app factory wiring in `packages/server/src/app.ts` does not expose `contextTransfer` in `ForgeServerConfig`, so usage is currently through direct `startRunWorker(...)` wiring.

## Test Coverage

## Core Module Tests

Test file: `packages/core/src/__tests__/run-context-transfer.test.ts`

Covered behaviors:

- save + load happy path
- missing context returns `null`
- stale context filtering via `maxAgeMs`
- intent chain resolution (`loadForIntent`)
- unknown/unmatched intent behavior
- list all contexts for session
- clear all contexts for session
- pagination beyond 100 entries (load/list/clear)
- session isolation
- chain constant sanity checks

Focused run command (executed):

```bash
yarn workspace @dzupagent/core test src/__tests__/run-context-transfer.test.ts
```

Result:

- 1 test file passed
- 11/11 tests passed

## Module-Level Coverage Snapshot

Focused coverage run command (executed):

```bash
yarn workspace @dzupagent/core test:coverage src/__tests__/run-context-transfer.test.ts
```

Observed coverage for `src/context/run-context-transfer.ts`:

- statements: `97.66%`
- branches: `88.23%`
- functions: `100%`
- lines: `97.66%`
- uncovered lines: `152-153`, `168-169` (page-limit overflow error branches)

Note:

- The coverage command exits non-zero because package-level global thresholds apply across all files when only one test file is run. The module-level numbers above are still valid for this target file.

## Cross-Package Validation

Integration coverage in `packages/server/src/__tests__/e2e-run-pipeline.test.ts` verifies:

- context is saved after run 1
- context is loaded for run 2 when intent chain matches
- no load log appears when no matching prior intent exists

This confirms runtime wiring behavior for `startRunWorker(..., contextTransfer)` beyond unit-level core tests.

