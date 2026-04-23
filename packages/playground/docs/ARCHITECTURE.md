# @dzupagent/playground Architecture

## 1. Purpose and Scope

`@dzupagent/playground` is the browser-based operator UI for DzupAgent.
It is a Vue 3 + Pinia + Vue Router SPA that provides:

- Interactive agent chat with streamed assistant output.
- Real-time operational observability (trace timeline, live events, tool/memory telemetry).
- Operational management workflows (runs, evals, benchmarks, agent definitions, marketplace).

The package is private to this monorepo and communicates with backend services through HTTP + WebSocket/SSE contracts. It does not directly depend on runtime internals from `@dzupagent/core` or `@dzupagent/agent`.

## 2. High-Level Architecture

### 2.1 Layered design

1. UI Shell and Routing
- `src/main.ts`, `src/App.vue`, `src/router/index.ts`
- Provides app shell, navigation, responsive layout, and top-level connectivity/health indicators.

2. Domain Views
- `src/views/*.vue`
- Route-level workflows for chat, runs, evals, benchmarks, agent definitions, and marketplace.

3. Reusable Components
- `src/components/**`
- Chat widgets, inspector tabs, timeline cards, marketplace cards.

4. State Layer (Pinia stores)
- `src/stores/*.ts`
- Domain state ownership, mutations, server calls, and derived/computed state.

5. Composables and Protocol Utilities
- `src/composables/*.ts`
- Typed API access, WebSocket/event-stream handling, live trace analytics, replay controls, memory analytics querying.

6. Shared Contracts and Formatting
- `src/types.ts`, `src/utils/format.ts`, `src/assets/main.css`

### 2.2 Route map

`src/router/index.ts` defines:

- `/` -> chat + inspector (`PlaygroundView.vue`)
- `/runs/:id` -> run detail (`RunDetailView.vue`)
- `/benchmarks` + `/benchmarks/:runId`
- `/evals` + `/evals/:id`
- `/agent-definitions`
- `/agents` (legacy redirect)
- `/marketplace`

## 3. Core Runtime Flow

### 3.1 App bootstrap and connectivity

On mount (`App.vue`):

1. Connect WebSocket (`wsStore.connect(toWsUrl())`).
2. Start health polling (`healthStore.startPolling()`).
3. Watch incoming WS events and push them to:
- `chatStore.handleRealtimeEvent(...)` for stream updates.
- `traceStore.addEvent(...)` for observability timeline.

Fallback behavior:

- If WS state becomes `error`, app starts SSE fallback at `/api/events/stream`.
- SSE events are normalized into the same event shape and passed through identical handlers.

### 3.2 Chat request lifecycle

Chat flow (`chat-store.ts`) for a sent prompt:

1. User prompt appended optimistically to local message list.
2. `POST /api/runs` with selected `agentId` and message input.
3. Store sets `activeRunId` and WS subscription filter:
- `runId`
- eventTypes (agent lifecycle, stream, tool, memory, pipeline events)
4. Streaming events (`agent:stream_delta`, `agent:stream_done`) incrementally build/finish assistant message.
5. Completion is resolved by:
- WS terminal event watcher first, with
- REST polling fallback (`GET /api/runs/:id`) until terminal status.
6. Final trace sync (`GET /api/runs/:id/trace`) refreshes inspector timeline.

### 3.3 Trace and replay flow

Trace paths:

- Live: WS/SSE events -> `useEventStream` -> `useLiveTrace` -> `traceStore` -> `TraceTimeline`.
- Historical/full replay: `useTraceReplay.loadTrace(runId)` -> `GET /api/runs/:id/messages` -> mapped to `TraceEvent[]`.

Replay controls (`useReplayControls`):

- `play`, `pause`, `stepForward`, `stepBack`, `reset`, speed multipliers (`0.5x`, `1x`, `2x`).
- Timeline can auto-highlight current replay step and auto-scroll to it.

### 3.4 Inspector data flow

Inspector tabs (`InspectorPanel.vue`) include:

- `TraceTab`: live feed + replay controls + token/cost estimate.
- `MemoryTab`: namespace browse/search + schema + import/export + live memory ops.
- `MemoryAnalyticsTab`: DuckDB-backed analytics views (decay, namespace stats, expiring, agents, usage, duplicates).
- `ConfigTab`: selected agent detail/edit.
- `HistoryTab`: run list with status filters.
- `ToolStatsTab`: aggregated + live tool performance analytics.

## 4. Feature Inventory

## 4.1 Chat and run execution

- Agent selection and isolation on switch.
- Stream-safe assistant message handling (upsert + finalize semantics).
- Terminal reconciliation to ensure final assistant content reflects run output.
- Run status/error system messages for non-happy paths.

Primary modules:

- `src/components/chat/*`
- `src/stores/chat-store.ts`
- `src/stores/ws-store.ts`

## 4.2 Realtime observability

- Event-type normalization into trace categories (`llm`, `tool`, `memory`, `guardrail`, `system`).
- Bounded event logs to avoid unbounded client growth.
- Live token usage and rough cost estimate from stream payloads.
- Tool/memory operation extraction from live event streams.

Primary modules:

- `src/composables/useEventStream.ts`
- `src/composables/useLiveTrace.ts`
- `src/stores/trace-store.ts`

## 4.3 Memory operations and analytics

Memory operations:

- Browse namespace records with scope and search (`/api/memory-browse/:namespace`).
- Optional schema load (`/api/memory/schema`).
- Import/export workflows (`/api/memory/import`, `/api/memory/export`).

Analytics:

- Decay trends
- Namespace stats
- Expiring memories
- Agent performance
- Usage patterns
- Duplicate candidates

via `/api/memory/analytics/*` endpoints, with polling and graceful 503 handling when DuckDB is unavailable.

Primary modules:

- `src/stores/memory-store.ts`
- `src/composables/useMemoryAnalytics.ts`
- `src/components/inspector/MemoryTab.vue`
- `src/components/inspector/MemoryAnalyticsTab.vue`

## 4.4 Runs, approvals, and drill-down

- Run list filtering and status summaries.
- Run detail page with logs, trace events, token usage, cost, and output payload.
- Approval workflow controls (`approve`, `reject`) and cancellation.

Primary modules:

- `src/stores/run-store.ts`
- `src/components/inspector/HistoryTab.vue`
- `src/views/RunDetailView.vue`

## 4.5 Benchmarks and evals operations

Benchmarks:

- Queue runs, inspect run history, compare runs, set baseline.
- Session fallback for recent run IDs when server history endpoint is unavailable.
- Artifact provenance display (suite/dataset/config/build metadata).

Evals:

- Queue suite runs, filter by suite/status, inspect attempt history.
- Retry failed runs and cancel active runs.
- Health and queue stats awareness.

Primary modules:

- `src/stores/benchmark-store.ts`, `src/views/BenchmarksView.vue`, `src/views/BenchmarkRunDetailView.vue`
- `src/stores/eval-store.ts`, `src/views/EvalsView.vue`, `src/views/EvalRunDetailView.vue`

## 4.6 Agent definition management and marketplace

- Agent definition CRUD: list, filter, create, edit, soft-delete.
- Config inspector tab for editing selected agent behavior.
- Marketplace browsing/search/filter/install/uninstall UX.

Primary modules:

- `src/stores/agent-definitions-store.ts`
- `src/stores/marketplace-store.ts`
- `src/views/AgentDefinitionsView.vue`
- `src/views/MarketplaceView.vue`

## 4.7 Health and resiliency

- Periodic health/readiness polling.
- WS reconnect with exponential backoff and bounded retries.
- WS -> SSE failover path.
- Defensive parsing and bounded list retention in multiple stores.

Primary modules:

- `src/stores/health-store.ts`
- `src/stores/ws-store.ts`
- `src/App.vue`

## 5. API Surface Used by Playground

### 5.1 HTTP endpoints

Chat/runs:

- `POST /api/runs`
- `GET /api/runs`
- `GET /api/runs/:id`
- `GET /api/runs/:id/logs`
- `GET /api/runs/:id/trace`
- `GET /api/runs/:id/messages`
- `POST /api/runs/:id/cancel`
- `POST /api/runs/:id/approve`
- `POST /api/runs/:id/reject`

Agents:

- `GET /api/agent-definitions`
- `GET /api/agent-definitions?active=true`
- `GET /api/agent-definitions/:id`
- `POST /api/agent-definitions`
- `PATCH /api/agent-definitions/:id`
- `DELETE /api/agent-definitions/:id`

Health/events:

- `GET /api/health`
- `GET /api/health/ready`
- `GET /api/health/metrics`
- `GET /api/events/stream` (SSE fallback)

Memory:

- `GET /api/memory-browse/:namespace`
- `GET /api/memory/schema`
- `POST /api/memory/export`
- `POST /api/memory/import`
- `GET /api/memory/analytics/decay-trends`
- `GET /api/memory/analytics/namespace-stats`
- `GET /api/memory/analytics/expiring`
- `GET /api/memory/analytics/agent-performance`
- `GET /api/memory/analytics/usage-patterns`
- `GET /api/memory/analytics/duplicates`

Marketplace:

- `GET /api/marketplace/agents`
- `POST /api/marketplace/install`
- `DELETE /api/marketplace/:agentId`

Benchmarks:

- `GET /api/benchmarks/runs`
- `GET /api/benchmarks/runs/:runId`
- `POST /api/benchmarks/runs`
- `POST /api/benchmarks/compare`
- `GET /api/benchmarks/baselines`
- `PUT /api/benchmarks/baselines/:suiteId`

Evals:

- `GET /api/evals/health`
- `GET /api/evals/queue/stats`
- `GET /api/evals/runs`
- `GET /api/evals/runs/:runId`
- `POST /api/evals/runs`
- `POST /api/evals/runs/:runId/cancel`
- `POST /api/evals/runs/:runId/retry`

### 5.2 Realtime endpoint

- WebSocket: `/ws`
- Control messages: `subscribe` / `unsubscribe` with run/agent filters
- Typical event types: `agent:*`, `tool:*`, `memory:*`, `pipeline:*`

## 6. Usage Examples

## 6.1 Local development (playground package)

```bash
yarn workspace @dzupagent/playground dev
```

Default local URL: `http://localhost:5174`.

Vite proxies:

- `/api` -> `http://localhost:4000`
- `/ws` -> `ws://localhost:4000`

Optional env overrides:

```bash
VITE_WS_URL=ws://localhost:8787/ws
VITE_WS_PATH=/ws
```

## 6.2 Build and test

```bash
yarn workspace @dzupagent/playground build
yarn workspace @dzupagent/playground typecheck
yarn workspace @dzupagent/playground lint
yarn workspace @dzupagent/playground test
yarn workspace @dzupagent/playground test:coverage
yarn workspace @dzupagent/playground test:e2e
```

## 6.3 Serve via `@dzupagent/server`

`@dzupagent/server` can mount built static assets from playground:

```ts
import { resolve } from 'node:path'
import { createForgeApp } from '@dzupagent/server'

const app = createForgeApp({
  // ...other runtime config
  playground: {
    distDir: resolve(process.cwd(), 'packages/playground/dist'),
  },
})
```

The SPA is then available at `/playground`.

## 7. Cross-Package References and Usage

`@dzupagent/playground` is referenced operationally (not as a direct package dependency) in:

- `packages/server/src/app.ts`
  - Conditionally mounts static route group: `app.route('/playground', createPlaygroundRoutes(...))`.
- `packages/server/src/routes/playground.ts`
  - Implements static asset serving, MIME handling, SPA fallback, and path traversal protection.
- `packages/server/src/__tests__/playground-routes.test.ts`
  - Verifies static serving behavior and traversal protection.
- `packages/server/README.md`
  - Documents how to mount a built playground distribution.
- Root `README.md`
  - Documents workspace-level dev command for playground.

Important boundary:

- No `package.json` in other packages declares `@dzupagent/playground` as a runtime dependency.
- Integration is through built static assets + HTTP/WS contracts.

## 8. Testing and Coverage

Coverage snapshot captured on **April 4, 2026** via:

```bash
yarn workspace @dzupagent/playground test:coverage
```

Result summary:

- Test files: `27`
- Tests: `335` passing
- Coverage (v8):
  - Statements: `71.28%`
  - Branches: `72.47%`
  - Functions: `62.19%`
  - Lines: `71.28%`

Configured thresholds in `vitest.config.ts`:

- Statements `40%`
- Branches `30%`
- Functions `30%`
- Lines `40%`

### 8.1 Coverage strengths

Well-covered/high-signal areas include:

- Trace and replay infrastructure:
  - `useTraceReplay.ts` `100%` lines
  - `trace-store.ts` `97.26%` lines
  - `TraceTimelineCard.vue` `100%` lines
- Marketplace and agent card UX:
  - `marketplace-store.ts` `100%` lines
  - `AgentCard.vue` `100%` lines
- Benchmark core store:
  - `benchmark-store.ts` `91.1%` lines
- Utilities/composables:
  - `format.ts` `98.03%` lines
  - `useReplayControls.ts` `98.1%` lines
  - `useLiveTrace.ts` `97.48%` lines

### 8.2 Lower-coverage hotspots

Notable low-coverage files:

- `src/App.vue` `0%`
- `src/main.ts` `0%`
- `src/views/AgentDefinitionsView.vue` `0%`
- `src/views/EvalsView.vue` `0%`
- `src/views/PlaygroundView.vue` `0%`
- `src/views/RunDetailView.vue` `0%`
- `src/composables/useWebSocket.ts` `0%`
- `src/stores/health-store.ts` `0%`
- `src/stores/run-store.ts` `55.09%`
- `src/components/inspector/MemoryTab.vue` `62.54%`

This pattern indicates stronger coverage of domain logic/composables than top-level app shell and some route views.

### 8.3 E2E coverage

Playwright e2e currently includes:

- `e2e/chat-streaming.spec.ts`
  - Validates streamed deltas + final assistant message behavior with mocked API and WS events.

## 9. Operational Notes

- The playground assumes a compatible backend contract from `@dzupagent/server` routes and event gateway.
- WebSocket failure does not fully degrade observability due SSE fallback path in `App.vue`.
- Multiple stores use bounded retention or pruning to limit unbounded client memory growth.
- The benchmark store additionally maintains a session-storage fallback history for resilience when server history endpoints are unavailable.
