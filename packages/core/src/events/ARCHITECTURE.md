# Events Architecture (`packages/core/src/events`)

Last updated: 2026-04-03

## Scope

This document covers the event subsystem in `@dzupagent/core` under:

- `packages/core/src/events/event-types.ts`
- `packages/core/src/events/event-bus.ts`
- `packages/core/src/events/agent-bus.ts`
- `packages/core/src/events/degraded-operation.ts`
- `packages/core/src/events/index.ts`

It also maps how these APIs are used across other packages (`agent`, `agent-adapters`, `server`, `otel`, `test-utils`) and summarizes direct + integration test coverage.

## Goals

The events subsystem provides three distinct communication contracts:

1. `DzupEventBus`: typed, in-process publish/subscribe for framework lifecycle events.
2. `DzupEvent`: a discriminated union contract for all supported event payloads.
3. `AgentBus`: channel-based peer messaging used by internal protocol routing.

`emitDegradedOperation()` is a helper to standardize degraded-mode signaling.

## Module Map

| File | Responsibility | Key Exports |
| --- | --- | --- |
| `event-types.ts` | Canonical event schema (`DzupEvent` union + helper types) | `DzupEvent`, `DzupEventOf`, `BudgetUsage`, `ToolStatSummary` |
| `event-bus.ts` | Typed bus implementation with `on`, `once`, `onAny`, fire-and-forget error isolation | `createEventBus`, `DzupEventBus` |
| `agent-bus.ts` | Channel-based agent-to-agent message bus with history and subscriber management | `AgentBus`, `AgentMessage`, `AgentMessageHandler` |
| `degraded-operation.ts` | Helper emitting `system:degraded` event with timestamp/recoverable flags | `emitDegradedOperation` |
| `index.ts` | Folder-level barrel for event bus + event types + degraded helper | same as above (excluding `AgentBus`) |

## Public API Surface

### `DzupEvent` and `DzupEventOf`

- `DzupEvent` is a discriminated union keyed by `type`.
- `DzupEventOf<T>` extracts a specific event payload by `type`.
- Current event variants: **85**.

Event categories (from `event-types.ts`):

| Category | Event count |
| --- | ---: |
| Agent lifecycle | 6 |
| Tool lifecycle | 3 |
| Memory | 5 |
| Budget | 2 |
| Pipeline | 2 |
| Approval | 3 |
| MCP | 2 |
| Provider | 3 |
| Identity | 5 |
| Registry | 5 |
| Protocol | 6 |
| Pipeline Runtime | 13 |
| Security | 8 |
| Vector Store | 4 |
| Telemetry | 3 |
| Delegation | 5 |
| Supervisor | 4 |
| Hooks / plugins | 2 |
| Quality metrics feedback loop | 3 |
| Degraded operation | 1 |

### `createEventBus()` / `DzupEventBus`

`DzupEventBus` methods:

- `emit(event: DzupEvent): void`
- `on(type, handler): () => void`
- `once(type, handler): () => void`
- `onAny(handler): () => void`

Behavioral contract:

- Strongly typed per-event handlers (`on('tool:called', e => e.toolName)`).
- Multiple handlers supported per event type.
- Handler errors are isolated/logged (sync and async rejections).
- `emit` does not return completion status and does not await handlers.

### `AgentBus`

`AgentBus` is separate from `DzupEventBus`:

- `publish(fromAgent, channel, payload)`
- `subscribe(channel, agentId, handler)`
- `unsubscribe(channel, agentId)`
- `unsubscribeAll(agentId)`
- `getHistory(channel, limit?)`
- `listChannels()`
- `listSubscribers(channel)`

Design intent:

- point-to-point or topic-style in-process collaboration between agents
- last-N message history (`maxHistory`, default 100)
- per-channel subscription tables keyed by `agentId`

### `emitDegradedOperation()`

Standard helper for optional subsystem failure signaling:

- emits `type: 'system:degraded'`
- sets `timestamp: Date.now()`
- defaults `recoverable = true`

## Export Surfaces

- Package root exports all event APIs including `AgentBus`:
  - `packages/core/src/index.ts`
- Facades:
  - `packages/core/src/facades/orchestration.ts` exports `createEventBus`, event types, and `AgentBus`.
  - `packages/core/src/facades/quick-start.ts` exports `createEventBus` and event types.
- Folder barrel:
  - `packages/core/src/events/index.ts` exports `createEventBus`, event types, `emitDegradedOperation`.
  - `AgentBus` is **not** re-exported from the folder barrel; it is exported from package root and orchestration facade.

## Runtime Flow

### A) Core event flow (`DzupEventBus`)

```text
Producer module emits DzupEvent
  -> event-bus dispatch by exact type
  -> exact handlers execute
  -> wildcard handlers (onAny) execute
  -> handler errors logged, bus remains healthy
```

Common downstream sinks:

- `EventLogSink` (persistent/replay log capture)
- `OTelBridge` (metrics + span events)
- `InMemoryEventGateway` (SSE/WS fan-out)
- `TraceCapture` (replay timeline)
- `ComplianceAuditLogger` / incident responders

### B) Internal protocol flow (`AgentBus`)

```text
InternalAdapter.send(message)
  -> extract target agent id from URI
  -> AgentBus.publish(to target channel)
  -> target handler responds on correlation channel
  -> sender resolves response or times out
```

This flow is used for in-process protocol routing, not telemetry/event observability.

### C) Degraded operation signaling

```text
Optional subsystem unavailable
  -> emitDegradedOperation(eventBus, subsystem, reason, recoverable?)
  -> system:degraded event
  -> observers can warn, adapt behavior, or escalate
```

## Internal Core Consumers

Representative `@dzupagent/core` consumers of the events APIs:

- `persistence/event-log.ts`
  - `EventLogSink.attach()` uses `onAny` to persist all events per run.
- `security/audit/audit-logger.ts`
  - subscribes via `onAny`, converts selected event types to compliance audit entries.
- `security/monitor/safety-monitor.ts`
  - subscribes to `tool:error` and `memory:written`, emits `safety:*` events.
- `plugin/plugin-registry.ts`
  - wires plugin-declared event handlers through `eventBus.on(...)` and emits `plugin:registered`.
- `registry/in-memory-registry.ts`
  - forwards registry events into the shared `DzupEventBus` when configured.
- `protocol/internal-adapter.ts`
  - uses `AgentBus` for in-process message routing with timeout and correlation channels.

## Cross-Package References and Usage

The events subsystem is a central contract across the monorepo.

### Package-level footprint (static reference count)

Reference pattern used: `createEventBus|DzupEventBus|DzupEvent|AgentBus|emitDegradedOperation`.

- `agent-adapters`: 55 files
- `server`: 37 files
- `otel`: 20 files
- `agent`: 17 files
- `test-utils`: 1 file
- plus small compatibility references (`memory`, `codegen`, `cache`)

### `@dzupagent/agent`

- `approval/approval-gate.ts`
  - emits `approval:requested`, waits for `approval:granted`/`approval:rejected`.
- `replay/trace-capture.ts`
  - uses `onAny` to capture full event timelines for replay/debugging.

### `@dzupagent/agent-adapters`

- `registry/event-bus-bridge.ts`
  - maps adapter events (`adapter:*`) to core `DzupEvent` variants.
- `middleware/cost-tracking.ts`
  - emits `budget:warning` / `budget:exceeded`.
- `approval/adapter-approval.ts`
  - approval lifecycle events.
- `persistence/run-manager.ts`, `output/structured-output.ts`, `orchestration/*`
  - extensive event emission; some flows cast custom event shapes into `DzupEventBus.emit` for forward compatibility.

### `@dzupagent/server`

- `events/event-gateway.ts`
  - subscribes to `onAny`, wraps events as envelopes, supports filtered fan-out and backpressure policies.
- `routes/events.ts`
  - streams filtered events over SSE.
- `ws/event-bridge.ts`
  - forwards events to websocket clients by run or type filters.
- `cli/trace-printer.ts`
  - onAny subscriber for human-readable live trace output.
- `security/incident-response.ts`
  - monitors event stream and executes incident playbooks.
- `app.ts`
  - wires `eventBus` into server runtime and event gateway by default.

### `@dzupagent/otel`

- `otel-bridge.ts`
  - core bridge from `DzupEventBus` to metrics/spans.
- `event-metric-map.ts`
  - maps every `DzupEvent['type']` to metric extraction rules (`satisfies Record<...>`).

### `@dzupagent/test-utils`

- `test-helpers.ts`
  - `createTestEventBus()` captures all events via `onAny`.
  - `waitForEvent()` helper provides deterministic typed event waiting.

### Compatibility references (no hard dependency)

- `@dzupagent/memory` `adaptive-retriever.ts`
  - defines a local emitter interface structurally compatible with `DzupEventBus`.
- `@dzupagent/codegen`
  - uses callback listeners for correction events (explicitly avoids direct coupling to core bus).
- `@dzupagent/cache`
  - supports hit/miss callbacks that can emit to event buses externally.

## Usage Examples

### 1) Basic typed usage

```ts
import { createEventBus } from '@dzupagent/core'

const bus = createEventBus()

const unsubTool = bus.on('tool:called', (event) => {
  console.log('Tool:', event.toolName)
})

bus.emit({ type: 'tool:called', toolName: 'read_file', input: { path: 'README.md' } })
unsubTool()
```

### 2) One-shot and wildcard subscribers

```ts
const unsubOnce = bus.once('mcp:connected', (event) => {
  console.log(`Connected to ${event.serverName}`)
})

const unsubAll = bus.onAny((event) => {
  console.log(`[event] ${event.type}`)
})

// later
unsubOnce()
unsubAll()
```

### 3) Degraded mode signaling

```ts
import { emitDegradedOperation } from '@dzupagent/core'

emitDegradedOperation(
  bus,
  'memory-ipc',
  'peer dependency not installed',
  false,
)
```

### 4) AgentBus for in-process peer messaging

```ts
import { AgentBus } from '@dzupagent/core'

const agentBus = new AgentBus({ maxHistory: 200 })

const unsub = agentBus.subscribe('code-review', 'agent-b', (msg) => {
  console.log(msg.from, msg.payload)
})

agentBus.publish('agent-a', 'code-review', { files: ['src/index.ts'] })
unsub()
```

### 5) Event capture for testing

```ts
import { createTestEventBus, waitForEvent } from '@dzupagent/test-utils'

const { bus, events } = createTestEventBus()

const pending = waitForEvent(bus, 'approval:requested')
bus.emit({ type: 'approval:requested', runId: 'run-1', plan: {} })

const evt = await pending
console.log(evt.runId) // run-1
console.log(events.length) // 1
```

## Test Coverage

## Direct coverage in `@dzupagent/core`

### Files and test counts

- `src/__tests__/event-bus.test.ts`: 7 tests
- `src/__tests__/degraded-operation.test.ts`: 2 tests
- `src/__tests__/event-log.test.ts`: 16 tests (includes `EventLogSink` integration with `DzupEventBus`)

Focused run executed:

- Command: `yarn workspace @dzupagent/core test -- event-bus degraded-operation event-log`
- Result: **3 test files, 25 tests passed**.

### Behavior directly covered

- typed subscription delivery
- type mismatch filtering
- unsubscribe semantics
- `once()` semantics
- wildcard `onAny()` delivery
- sync handler throw isolation
- multiple handlers same event type
- degraded event emission + default recoverability
- event log sequencing, retention, clear/reset
- `EventLogSink` bus capture and detach behavior

## Coverage adjacent to events subsystem

- `protocol/__tests__/adapters.test.ts`
  - exercises `AgentBus` through `InternalAdapter` routing, response channel correlation, timeout, unsubscribe behavior.
- `__tests__/facades.test.ts`
  - verifies export wiring includes `AgentBus`.

## Integration coverage in other packages

- `agent/src/__tests__/approval-gate.test.ts`
  - approval event wait/timeout flow.
- `agent-adapters/src/__tests__/event-bus-bridge.test.ts`
  - adapter event -> `DzupEvent` mapping correctness.
- `server/src/__tests__/event-gateway.test.ts`
  - filtering, envelope semantics, overflow behavior.
- `server/src/__tests__/event-bridge.test.ts`
  - websocket forwarding with run filters.
- `otel/src/__tests__/otel-bridge.test.ts`
  - metrics emitted from runtime events.
- `otel/src/__tests__/event-metric-map.test.ts`
  - validates mapping coverage/shape across full event map.

High-level test footprint (files referencing core event APIs in `__tests__`):

- `agent-adapters`: 29
- `server`: 22
- `otel`: 12
- `core`: 8
- `agent`: 7

## Gaps and Risks

1. `AgentBus` has no dedicated unit test file in `packages/core/src/__tests__`; it is covered indirectly via protocol adapter tests.
2. `event-types.ts` has no direct schema drift test inside `core`; coverage is mostly indirect through `otel` mapping tests and downstream compilation.
3. Several adapter modules cast non-core event shapes into `DzupEventBus.emit` for compatibility; this is flexible but can hide schema drift at compile time.
4. `event-bus.ts` docs mention asynchronous microtask handler execution, but current implementation invokes handlers inline and only async-catches returned promises. If strict async dispatch is required, implementation/docs should be aligned.
5. `emitDegradedOperation()` currently has no known runtime consumers outside its direct tests.

## Design Notes

- Event bus is intentionally fail-soft: handler failures should not cascade into run failures.
- The event schema has become a platform contract shared by observability, transport fan-out, tracing, and governance modules.
- `AgentBus` and `DzupEventBus` are intentionally separate abstractions:
  - `DzupEventBus`: typed lifecycle/telemetry domain events.
  - `AgentBus`: channel-oriented request/reply transport for in-process protocol paths.

## Summary

`packages/core/src/events` is a core control-plane contract for DzupAgent. It combines a large typed event schema (`DzupEvent`), a fail-soft typed bus (`DzupEventBus`), and a separate channel bus (`AgentBus`) used by internal protocol routing. The subsystem is heavily integrated across `agent`, `agent-adapters`, `server`, and `otel`, with strong integration test coverage and solid direct tests for core bus/log/degraded behavior, while `AgentBus` direct unit coverage and strict schema/dispatch contract checks remain the main opportunities for hardening.
